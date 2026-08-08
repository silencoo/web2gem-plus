import type {
	GeminiCookieSeed,
	GeminiRotationStart,
	GeminiSessionFailureIssue,
	GeminiSessionLease,
	GeminiSessionPoolPort,
	GeminiSessionRotation,
	RuntimeConfig,
	WorkerEnv,
} from "../config";

type StoredAccount = {
	account_id: string;
	label: string;
	version: number;
	cookie: string;
	sapisid: string;
	seed_fingerprint: string;
	disabled: boolean;
	disabled_reason: "" | "auth_failed" | "manual";
	issue: "" | GeminiSessionFailureIssue;
	cooldown_until_ms: number;
	consecutive_auth_failures: number;
	last_selected_at_ms: number;
	last_success_at_ms: number;
	last_error_at_ms: number;
	last_cookie_refresh_at_ms: number;
	request_count: number;
	success_count: number;
	auth_failure_count: number;
	refresh_count: number;
	rotation_token: string;
	rotation_started_at_ms: number;
};

export type GeminiSessionAccountSummary = Readonly<{
	account_id: string;
	label: string;
	position: number;
	status: "healthy" | "cooling" | "disabled";
	issue: "" | GeminiSessionFailureIssue;
	cooldown_until_ms: number;
	last_selected_at_ms: number;
	last_success_at_ms: number;
	last_error_at_ms: number;
	last_cookie_refresh_at_ms: number;
	request_count: number;
	success_count: number;
	auth_failure_count: number;
	refresh_count: number;
}>;

export type GeminiSessionAccountAction = "enable" | "disable" | "reset";
export type GeminiSessionBulkAction = GeminiSessionAccountAction | "delete";
export type GeminiRoutingStrategy = "round_robin" | "priority" | "least_used";
export type GeminiSessionConfigurationSource = "environment" | "managed";
export type GeminiSessionAdminSnapshot = Readonly<{
	accounts: readonly GeminiSessionAccountSummary[];
	routing_strategy: GeminiRoutingStrategy;
	configuration_source: GeminiSessionConfigurationSource;
}>;
export type GeminiSessionAccountPatch = Readonly<{
	label?: string;
	cookie?: string;
	sapisid?: string;
}>;
export type GeminiSessionAccountImportMode = "append" | "replace";
export type GeminiSessionImportPreview = Readonly<{
	mode: GeminiSessionAccountImportMode;
	total_input: number;
	unique_accounts: number;
	add_count: number;
	update_count: number;
	remove_count: number;
	duplicate_count: number;
	accounts: readonly Readonly<{
		label: string;
		action: "add" | "update";
	}>[];
}>;
export type AdminLoginThrottle = Readonly<{
	allowed: boolean;
	retry_after_seconds: number;
}>;

type ManagedAccount = {
	account_id: string;
	label: string;
	cookie: string;
	sapisid: string;
};

export class NoAvailableGeminiSessionError extends Error {
	readonly code = "no_available_gemini_account";
	readonly status = 503;

	constructor() {
		super("no available Gemini account");
		this.name = "NoAvailableGeminiSessionError";
	}
}

type PoolState = {
	accounts: Record<string, StoredAccount>;
	order: string[];
	cursor: number;
	routing_strategy?: GeminiRoutingStrategy;
	managed_accounts?: Record<string, ManagedAccount>;
	managed_order?: string[];
	admin_login_attempts?: Record<string, AdminLoginAttempt>;
	schema_version?: number;
};

type AdminLoginAttempt = {
	failures: number;
	last_failure_at_ms: number;
	blocked_until_ms: number;
};

type AcquireBody = {
	seeds: GeminiCookieSeed[];
	exclude?: string[];
	include_status?: boolean;
};
type AcquireResult = {
	lease: GeminiSessionLease | null;
	configured: boolean;
};

const POOL_SCHEMA_VERSION = 6;
const EMPTY_STATE: PoolState = {
	accounts: {},
	order: [],
	cursor: 0,
	routing_strategy: "round_robin",
	schema_version: POOL_SCHEMA_VERSION,
};
const memoryPoolState: PoolState = structuredClone(EMPTY_STATE);
const ROTATION_STALE_MS = 2 * 60 * 1000;
const AUTH_COOLDOWN_BASE_MS = 60 * 1000;
const AUTH_COOLDOWN_MAX_MS = 30 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const TRANSIENT_COOLDOWN_MS = 60 * 1000;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_BASE_DELAY_MS = 30 * 1000;
const ADMIN_LOGIN_MAX_DELAY_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_FAILURE_THRESHOLD = 5;
const ADMIN_LOGIN_MAX_TRACKED_CLIENTS = 5000;

export class GeminiSessionPool {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST") return new Response(null, { status: 405 });
		if (url.pathname === "/acquire") {
			const body = (await request.json()) as AcquireBody;
			const result = await this.acquire(body.seeds, body.exclude || []);
			return Response.json(body.include_status ? result : result.lease);
		}
		if (url.pathname === "/begin-rotation") {
			const body = (await request.json()) as { lease: GeminiSessionLease };
			return Response.json(await this.beginRotation(body.lease));
		}
		if (url.pathname === "/commit-rotation") {
			const body = (await request.json()) as {
				rotation: GeminiSessionRotation;
				cookie: string;
				sapisid: string;
			};
			return Response.json(
				await this.commitRotation(body.rotation, body.cookie, body.sapisid),
			);
		}
		if (url.pathname === "/abort-rotation") {
			const body = (await request.json()) as {
				rotation: GeminiSessionRotation;
			};
			await this.finishRotation(body.rotation, null);
			return Response.json({ ok: true });
		}
		if (url.pathname === "/fail-rotation") {
			const body = (await request.json()) as {
				rotation: GeminiSessionRotation;
				issue?: GeminiSessionFailureIssue;
			};
			await this.finishRotation(body.rotation, body.issue || "auth");
			return Response.json({ ok: true });
		}
		if (url.pathname === "/failure") {
			const body = (await request.json()) as {
				lease: GeminiSessionLease;
				issue: GeminiSessionFailureIssue;
			};
			await this.markFailure(body.lease, body.issue);
			return Response.json({ ok: true });
		}
		if (url.pathname === "/success") {
			const body = (await request.json()) as { lease: GeminiSessionLease };
			await this.markSuccess(body.lease);
			return Response.json({ ok: true });
		}
		if (url.pathname === "/accounts") {
			const body = (await request.json()) as { seeds: GeminiCookieSeed[] };
			return Response.json(await this.accounts(body.seeds));
		}
		if (url.pathname === "/account-action") {
			const body = (await request.json()) as {
				seeds: GeminiCookieSeed[];
				account_id: string;
				action: GeminiSessionAccountAction;
			};
			return Response.json(
				await this.accountAction(body.seeds, body.account_id, body.action),
			);
		}
		if (url.pathname === "/admin-snapshot") {
			const body = (await request.json()) as { seeds: GeminiCookieSeed[] };
			return Response.json(await this.adminSnapshot(body.seeds));
		}
		if (url.pathname === "/account-lease") {
			const body = (await request.json()) as {
				seeds: GeminiCookieSeed[];
				account_id: string;
			};
			return Response.json(
				await this.accountLease(body.seeds, body.account_id),
			);
		}
		if (url.pathname === "/admin-login/check") {
			const body = (await request.json()) as { client_key: string };
			return Response.json(await this.checkAdminLogin(body.client_key));
		}
		if (url.pathname === "/admin-login/failure") {
			const body = (await request.json()) as { client_key: string };
			return Response.json(await this.recordAdminLoginFailure(body.client_key));
		}
		if (url.pathname === "/admin-login/success") {
			const body = (await request.json()) as { client_key: string };
			await this.clearAdminLoginFailures(body.client_key);
			return Response.json({ ok: true });
		}
		if (url.pathname === "/accounts/import") {
			const body = (await request.json()) as {
				seeds: GeminiCookieSeed[];
				accounts: GeminiCookieSeed[];
				mode: GeminiSessionAccountImportMode;
			};
			return Response.json(
				await this.importAccounts(body.seeds, body.accounts, body.mode),
			);
		}
		if (url.pathname === "/account-edit") {
			const body = (await request.json()) as {
				seeds: GeminiCookieSeed[];
				account_id: string;
				patch: GeminiSessionAccountPatch;
			};
			return Response.json(
				await this.editAccount(body.seeds, body.account_id, body.patch),
			);
		}
		if (url.pathname === "/bulk-action") {
			const body = (await request.json()) as {
				seeds: GeminiCookieSeed[];
				account_ids: string[];
				action: GeminiSessionBulkAction;
			};
			return Response.json(
				await this.bulkAction(body.seeds, body.account_ids, body.action),
			);
		}
		if (url.pathname === "/accounts/reorder") {
			const body = (await request.json()) as {
				seeds: GeminiCookieSeed[];
				account_ids: string[];
			};
			return Response.json(
				await this.reorderAccounts(body.seeds, body.account_ids),
			);
		}
		if (url.pathname === "/routing-strategy") {
			const body = (await request.json()) as {
				seeds: GeminiCookieSeed[];
				strategy: GeminiRoutingStrategy;
			};
			return Response.json(
				await this.setRoutingStrategy(body.seeds, body.strategy),
			);
		}
		if (url.pathname === "/restore-environment") {
			const body = (await request.json()) as { seeds: GeminiCookieSeed[] };
			return Response.json(await this.restoreEnvironment(body.seeds));
		}
		return new Response(null, { status: 404 });
	}

	private async acquire(
		seeds: readonly GeminiCookieSeed[],
		exclude: readonly string[],
	): Promise<AcquireResult> {
		return this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			await reconcilePool(pool, seeds);
			const configured = managedConfigurationActive(pool) || seeds.length > 0;
			const now = Date.now();
			clearStaleRotations(pool, now);
			clearExpiredCooldowns(pool, now);
			const excluded = new Set(exclude);
			const selected = selectAccount(pool, excluded, now);
			if (selected) {
				selected.account.last_selected_at_ms = now;
				selected.account.request_count++;
				if (pool.routing_strategy === "round_robin")
					pool.cursor = (selected.index + 1) % pool.order.length;
			}
			await storage.put("pool", pool);
			return {
				lease: selected ? publicLease(selected.account) : null,
				configured,
			};
		});
	}

	private async beginRotation(
		lease: GeminiSessionLease,
	): Promise<GeminiRotationStart> {
		return this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			const account = pool.accounts[lease.account_id];
			const now = Date.now();
			if (!account) return { status: "unavailable" };
			clearStaleRotation(account, now);
			if (account.disabled || account.cooldown_until_ms > now)
				return { status: "unavailable" };
			if (account.rotation_token) return { status: "busy" };
			if (account.version !== lease.version)
				return { status: "updated", lease: publicLease(account) };
			account.version++;
			account.rotation_token = crypto.randomUUID();
			account.rotation_started_at_ms = Date.now();
			await storage.put("pool", pool);
			return {
				status: "acquired",
				lease: publicLease(account),
				rotation: publicRotation(account),
			};
		});
	}

	private async commitRotation(
		rotation: GeminiSessionRotation,
		cookie: string,
		sapisid: string,
	): Promise<GeminiSessionLease | null> {
		return this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			const account = pool.accounts[rotation.account_id];
			if (!rotationMatches(account, rotation))
				return account ? publicLease(account) : null;
			account.cookie = cookie;
			account.sapisid = sapisid;
			account.version++;
			account.last_cookie_refresh_at_ms = Date.now();
			account.refresh_count++;
			clearRotation(account);
			await storage.put("pool", pool);
			return publicLease(account);
		});
	}

	private async finishRotation(
		rotation: GeminiSessionRotation,
		issue: GeminiSessionFailureIssue | null,
	): Promise<void> {
		await this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			const account = pool.accounts[rotation.account_id];
			if (!rotationMatches(account, rotation)) return;
			clearRotation(account);
			if (issue) {
				recordAccountFailure(account, issue, Date.now());
			} else account.version++;
			await storage.put("pool", pool);
		});
	}

	private async markFailure(
		lease: GeminiSessionLease,
		issue: GeminiSessionFailureIssue,
	): Promise<void> {
		await this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			const account = pool.accounts[lease.account_id];
			if (account && account.version === lease.version) {
				recordAccountFailure(account, issue, Date.now());
				await storage.put("pool", pool);
			}
		});
	}

	private async markSuccess(lease: GeminiSessionLease): Promise<void> {
		await this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			const account = pool.accounts[lease.account_id];
			if (account) {
				clearAccountHealth(account);
				account.last_success_at_ms = Date.now();
				account.success_count++;
				await storage.put("pool", pool);
			}
		});
	}

	private async accounts(
		seeds: readonly GeminiCookieSeed[],
	): Promise<GeminiSessionAccountSummary[]> {
		return this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			await reconcilePool(pool, seeds);
			await storage.put("pool", pool);
			return accountSummaries(pool);
		});
	}

	private async accountAction(
		seeds: readonly GeminiCookieSeed[],
		accountId: string,
		action: GeminiSessionAccountAction,
	): Promise<GeminiSessionAccountSummary[]> {
		return this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			await reconcilePool(pool, seeds);
			const account = pool.accounts[accountId];
			if (!account) throw new Error("account_not_found");
			if (action === "disable") {
				account.disabled = true;
				account.disabled_reason = "manual";
			} else if (action === "enable" || action === "reset") {
				account.disabled = false;
				account.disabled_reason = "";
				clearAccountHealth(account);
				if (action === "reset") {
					const seed = await effectiveSeedForAccount(pool, seeds, accountId);
					if (seed) {
						account.cookie = seed.cookie;
						account.sapisid = seed.sapisid;
						account.last_cookie_refresh_at_ms = Date.now();
					}
					account.last_error_at_ms = 0;
					account.auth_failure_count = 0;
				}
			}
			clearRotation(account);
			account.version++;
			await storage.put("pool", pool);
			return accountSummaries(pool);
		});
	}

	private async adminSnapshot(
		seeds: readonly GeminiCookieSeed[],
	): Promise<GeminiSessionAdminSnapshot> {
		return this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			await reconcilePool(pool, seeds);
			await storage.put("pool", pool);
			return adminSnapshot(pool);
		});
	}

	private async accountLease(
		seeds: readonly GeminiCookieSeed[],
		accountId: string,
	): Promise<GeminiSessionLease | null> {
		return this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			await reconcilePool(pool, seeds);
			await storage.put("pool", pool);
			const account = pool.accounts[accountId];
			return account ? publicLease(account) : null;
		});
	}

	private async checkAdminLogin(
		clientKey: string,
	): Promise<AdminLoginThrottle> {
		return this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			const result = checkAdminLoginState(pool, clientKey, Date.now());
			await storage.put("pool", pool);
			return result;
		});
	}

	private async recordAdminLoginFailure(
		clientKey: string,
	): Promise<AdminLoginThrottle> {
		return this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			const result = recordAdminLoginFailureState(pool, clientKey, Date.now());
			await storage.put("pool", pool);
			return result;
		});
	}

	private async clearAdminLoginFailures(clientKey: string): Promise<void> {
		await this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			if (pool.admin_login_attempts)
				delete pool.admin_login_attempts[clientKey];
			await storage.put("pool", pool);
		});
	}

	private async importAccounts(
		seeds: readonly GeminiCookieSeed[],
		accounts: readonly GeminiCookieSeed[],
		mode: GeminiSessionAccountImportMode,
	): Promise<GeminiSessionAdminSnapshot> {
		return this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			await ensureManagedConfiguration(pool, seeds);
			const managedAccounts =
				mode === "replace" ? {} : { ...(pool.managed_accounts || {}) };
			const managedOrder =
				mode === "replace" ? [] : [...(pool.managed_order || [])];
			for (const seed of accounts) {
				const accountId = await accountIdFor(seed);
				managedAccounts[accountId] = {
					account_id: accountId,
					label: seed.label,
					cookie: seed.cookie,
					sapisid: seed.sapisid,
				};
				if (!managedOrder.includes(accountId)) managedOrder.push(accountId);
			}
			pool.managed_accounts = managedAccounts;
			pool.managed_order = managedOrder;
			await reconcilePool(pool, seeds);
			await storage.put("pool", pool);
			return adminSnapshot(pool);
		});
	}

	private async editAccount(
		seeds: readonly GeminiCookieSeed[],
		accountId: string,
		patch: GeminiSessionAccountPatch,
	): Promise<GeminiSessionAdminSnapshot> {
		return this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			await ensureManagedConfiguration(pool, seeds);
			const account = pool.managed_accounts?.[accountId];
			if (!account) throw new Error("account_not_found");
			if (patch.label !== undefined) account.label = patch.label;
			if (patch.cookie !== undefined) account.cookie = patch.cookie;
			if (patch.sapisid !== undefined) account.sapisid = patch.sapisid;
			await reconcilePool(pool, seeds);
			await storage.put("pool", pool);
			return adminSnapshot(pool);
		});
	}

	private async bulkAction(
		seeds: readonly GeminiCookieSeed[],
		accountIds: readonly string[],
		action: GeminiSessionBulkAction,
	): Promise<GeminiSessionAdminSnapshot> {
		return this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			if (action === "delete") await ensureManagedConfiguration(pool, seeds);
			else await reconcilePool(pool, seeds);
			for (const accountId of accountIds)
				if (!pool.accounts[accountId]) throw new Error("account_not_found");
			if (action === "delete") {
				for (const accountId of accountIds)
					delete pool.managed_accounts?.[accountId];
				pool.managed_order = (pool.managed_order || []).filter(
					(accountId) => !accountIds.includes(accountId),
				);
				await reconcilePool(pool, seeds);
			} else {
				for (const accountId of accountIds) {
					const account = pool.accounts[accountId];
					if (!account) continue;
					if (action === "disable") {
						account.disabled = true;
						account.disabled_reason = "manual";
					} else {
						account.disabled = false;
						account.disabled_reason = "";
						clearAccountHealth(account);
						if (action === "reset") {
							const seed = await effectiveSeedForAccount(
								pool,
								seeds,
								accountId,
							);
							if (seed) {
								account.cookie = seed.cookie;
								account.sapisid = seed.sapisid;
								account.last_cookie_refresh_at_ms = Date.now();
							}
							account.last_error_at_ms = 0;
							account.auth_failure_count = 0;
						}
					}
					clearRotation(account);
					account.version++;
				}
			}
			await storage.put("pool", pool);
			return adminSnapshot(pool);
		});
	}

	private async setRoutingStrategy(
		seeds: readonly GeminiCookieSeed[],
		strategy: GeminiRoutingStrategy,
	): Promise<GeminiSessionAdminSnapshot> {
		return this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			await reconcilePool(pool, seeds);
			pool.routing_strategy = normalizeRoutingStrategy(strategy);
			pool.cursor = 0;
			await storage.put("pool", pool);
			return adminSnapshot(pool);
		});
	}

	private async reorderAccounts(
		seeds: readonly GeminiCookieSeed[],
		accountIds: readonly string[],
	): Promise<GeminiSessionAdminSnapshot> {
		return this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			await ensureManagedConfiguration(pool, seeds);
			const existing = new Set(pool.managed_order || []);
			if (
				accountIds.length !== existing.size ||
				accountIds.some((accountId) => !existing.has(accountId))
			)
				throw new Error("invalid_account_order");
			pool.managed_order = [...accountIds];
			pool.cursor = 0;
			await reconcilePool(pool, seeds);
			await storage.put("pool", pool);
			return adminSnapshot(pool);
		});
	}

	private async restoreEnvironment(
		seeds: readonly GeminiCookieSeed[],
	): Promise<GeminiSessionAdminSnapshot> {
		return this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			delete pool.managed_accounts;
			delete pool.managed_order;
			await reconcilePool(pool, seeds);
			await storage.put("pool", pool);
			return adminSnapshot(pool);
		});
	}
}

export async function configWithPooledGeminiSession(
	cfg: RuntimeConfig,
	env: WorkerEnv,
): Promise<RuntimeConfig> {
	const namespace = env.GEMINI_SESSION_POOL;
	const seeds = [...cfg.gemini_cookies];
	let pool: GeminiSessionPoolPort;
	let lease: GeminiSessionLease | null;
	if (namespace) {
		const stub = namespace.getByName("default");
		const response = await durableCall<
			AcquireResult | GeminiSessionLease | null
		>(stub, "/acquire", { seeds, include_status: true });
		const acquisition = isAcquireResult(response)
			? response
			: { lease: response, configured: seeds.length > 0 };
		if (!acquisition.configured) return cfg;
		pool = createDurablePool(stub, seeds);
		lease = acquisition.lease;
	} else {
		if (!seeds.length && !managedConfigurationActive(memoryPoolState))
			return cfg;
		pool = createMemoryPool(seeds);
		lease = await pool.acquire();
	}
	if (!lease) throw new NoAvailableGeminiSessionError();
	return {
		...cfg,
		cookie: lease.cookie,
		sapisid: lease.sapisid,
		gemini_session: lease,
		gemini_session_pool: pool,
		supports_authenticated_session: true,
	};
}

function isAcquireResult(value: unknown): value is AcquireResult {
	return !!value && typeof value === "object" && "configured" in value;
}

function createDurablePool(
	stub: DurableObjectStub,
	seeds: GeminiCookieSeed[],
): GeminiSessionPoolPort {
	const call = async <T>(path: string, body: unknown): Promise<T> => {
		const response = await stub.fetch(`https://gemini-session-pool${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok)
			throw new Error(
				`Gemini session pool failed with HTTP ${response.status}`,
			);
		return response.json<T>();
	};
	return {
		acquire: (excludeAccountIds = []) =>
			call<GeminiSessionLease | null>("/acquire", {
				seeds,
				exclude: excludeAccountIds,
			}),
		beginRotation: (lease) =>
			call<GeminiRotationStart>("/begin-rotation", { lease }),
		commitRotation: (rotation, cookie, sapisid) =>
			call<GeminiSessionLease | null>("/commit-rotation", {
				rotation,
				cookie,
				sapisid,
			}),
		abortRotation: async (rotation) => {
			await call<{ ok: boolean }>("/abort-rotation", { rotation });
		},
		failRotation: async (rotation, issue = "auth") => {
			await call<{ ok: boolean }>("/fail-rotation", { rotation, issue });
		},
		markFailure: async (lease, issue) => {
			await call<{ ok: boolean }>("/failure", { lease, issue });
		},
		markSuccess: async (lease) => {
			await call<{ ok: boolean }>("/success", { lease });
		},
	};
}

function createMemoryPool(seeds: GeminiCookieSeed[]): GeminiSessionPoolPort {
	return {
		acquire: async (excludeAccountIds = []) => {
			await reconcilePool(memoryPoolState, seeds);
			const now = Date.now();
			clearStaleRotations(memoryPoolState, now);
			clearExpiredCooldowns(memoryPoolState, now);
			const excluded = new Set(excludeAccountIds);
			const selected = selectAccount(memoryPoolState, excluded, now);
			if (!selected) return null;
			if (memoryPoolState.routing_strategy === "round_robin")
				memoryPoolState.cursor =
					(selected.index + 1) % memoryPoolState.order.length;
			selected.account.last_selected_at_ms = now;
			selected.account.request_count++;
			return publicLease(selected.account);
		},
		beginRotation: async (lease) => {
			const account = memoryPoolState.accounts[lease.account_id];
			const now = Date.now();
			if (!account) return { status: "unavailable" } as const;
			clearStaleRotation(account, now);
			if (account.disabled || account.cooldown_until_ms > now)
				return { status: "unavailable" } as const;
			if (account.rotation_token) return { status: "busy" } as const;
			if (account.version !== lease.version)
				return { status: "updated", lease: publicLease(account) } as const;
			account.version++;
			account.rotation_token = crypto.randomUUID();
			account.rotation_started_at_ms = Date.now();
			return {
				status: "acquired",
				lease: publicLease(account),
				rotation: publicRotation(account),
			} as const;
		},
		commitRotation: async (rotation, cookie, sapisid) => {
			const account = memoryPoolState.accounts[rotation.account_id];
			if (!rotationMatches(account, rotation))
				return account ? publicLease(account) : null;
			account.cookie = cookie;
			account.sapisid = sapisid;
			account.version++;
			account.last_cookie_refresh_at_ms = Date.now();
			account.refresh_count++;
			clearRotation(account);
			return publicLease(account);
		},
		abortRotation: async (rotation) => {
			const account = memoryPoolState.accounts[rotation.account_id];
			if (!rotationMatches(account, rotation)) return;
			account.version++;
			clearRotation(account);
		},
		failRotation: async (rotation, issue = "auth") => {
			const account = memoryPoolState.accounts[rotation.account_id];
			if (!rotationMatches(account, rotation)) return;
			clearRotation(account);
			recordAccountFailure(account, issue, Date.now());
		},
		markFailure: async (lease, issue) => {
			const account = memoryPoolState.accounts[lease.account_id];
			if (account && account.version === lease.version) {
				recordAccountFailure(account, issue, Date.now());
			}
		},
		markSuccess: async (lease) => {
			const account = memoryPoolState.accounts[lease.account_id];
			if (account) {
				clearAccountHealth(account);
				account.last_success_at_ms = Date.now();
				account.success_count++;
			}
		},
	};
}

async function reconcilePool(
	pool: PoolState,
	seeds: readonly GeminiCookieSeed[],
): Promise<void> {
	const migratePermanentAuthFailures = (pool.schema_version || 1) < 4;
	pool.routing_strategy = normalizeRoutingStrategy(pool.routing_strategy);
	const effectiveSeeds = await resolvedSeedsFor(pool, seeds);
	const nextOrder: string[] = [];
	for (const resolved of effectiveSeeds) {
		const { accountId, seed } = resolved;
		const seedFingerprint = await sha256(`${seed.cookie}\0${seed.sapisid}`);
		const current = pool.accounts[accountId];
		if (!current) {
			pool.accounts[accountId] = {
				account_id: accountId,
				label: seed.label || `Account ${nextOrder.length + 1}`,
				version: 1,
				cookie: seed.cookie,
				sapisid: seed.sapisid,
				seed_fingerprint: seedFingerprint,
				disabled: false,
				disabled_reason: "",
				issue: "",
				cooldown_until_ms: 0,
				consecutive_auth_failures: 0,
				last_selected_at_ms: 0,
				last_success_at_ms: 0,
				last_error_at_ms: 0,
				last_cookie_refresh_at_ms: Date.now(),
				request_count: 0,
				success_count: 0,
				auth_failure_count: 0,
				refresh_count: 0,
				rotation_token: "",
				rotation_started_at_ms: 0,
			};
		} else {
			normalizeStoredAccount(
				current,
				seed.label || `Account ${nextOrder.length + 1}`,
			);
			current.label = seed.label || current.label;
			if (
				migratePermanentAuthFailures &&
				current.disabled &&
				current.disabled_reason === "auth_failed"
			) {
				current.cookie = seed.cookie;
				current.sapisid = seed.sapisid;
				current.disabled = false;
				current.disabled_reason = "";
				current.issue = "";
				current.cooldown_until_ms = 0;
				current.consecutive_auth_failures = 0;
				current.last_cookie_refresh_at_ms = Date.now();
				clearRotation(current);
				current.version++;
			}
		}
		if (current && current.seed_fingerprint !== seedFingerprint) {
			current.cookie = seed.cookie;
			current.sapisid = seed.sapisid;
			current.seed_fingerprint = seedFingerprint;
			current.disabled = false;
			current.disabled_reason = "";
			clearAccountHealth(current);
			current.last_cookie_refresh_at_ms = Date.now();
			clearRotation(current);
			current.version++;
		}
		nextOrder.push(accountId);
	}
	const active = new Set(nextOrder);
	for (const id of Object.keys(pool.accounts))
		if (!active.has(id)) delete pool.accounts[id];
	pool.order = nextOrder;
	if (pool.cursor >= nextOrder.length) pool.cursor = 0;
	pool.schema_version = POOL_SCHEMA_VERSION;
}

type ResolvedSeed = {
	accountId: string;
	seed: GeminiCookieSeed;
};

async function resolvedSeedsFor(
	pool: PoolState,
	seeds: readonly GeminiCookieSeed[],
): Promise<ResolvedSeed[]> {
	if (managedConfigurationActive(pool)) {
		const managedAccounts = pool.managed_accounts || {};
		const order = [...(pool.managed_order || [])];
		for (const accountId of Object.keys(managedAccounts))
			if (!order.includes(accountId)) order.push(accountId);
		pool.managed_order = order.filter(
			(accountId) => !!managedAccounts[accountId],
		);
		return pool.managed_order.flatMap((accountId) => {
			const account = managedAccounts[accountId];
			if (!account) return [];
			return [
				{
					accountId,
					seed: {
						label: account.label,
						cookie: account.cookie,
						sapisid: account.sapisid,
					},
				},
			];
		});
	}
	const resolved: ResolvedSeed[] = [];
	const seen = new Set<string>();
	for (const seed of seeds) {
		const accountId = await accountIdFor(seed);
		if (seen.has(accountId)) continue;
		seen.add(accountId);
		resolved.push({ accountId, seed });
	}
	return resolved;
}

async function ensureManagedConfiguration(
	pool: PoolState,
	seeds: readonly GeminiCookieSeed[],
): Promise<void> {
	if (managedConfigurationActive(pool)) return;
	await reconcilePool(pool, seeds);
	const managedAccounts: Record<string, ManagedAccount> = {};
	for (const accountId of pool.order) {
		const account = pool.accounts[accountId];
		if (!account) continue;
		managedAccounts[accountId] = {
			account_id: accountId,
			label: account.label,
			cookie: account.cookie,
			sapisid: account.sapisid,
		};
	}
	pool.managed_accounts = managedAccounts;
	pool.managed_order = [...pool.order];
}

function managedConfigurationActive(pool: PoolState): boolean {
	return !!pool.managed_accounts && !Array.isArray(pool.managed_accounts);
}

function normalizeRoutingStrategy(value: unknown): GeminiRoutingStrategy {
	return value === "priority" || value === "least_used" ? value : "round_robin";
}

function adminSnapshot(pool: PoolState): GeminiSessionAdminSnapshot {
	return {
		accounts: accountSummaries(pool),
		routing_strategy: normalizeRoutingStrategy(pool.routing_strategy),
		configuration_source: managedConfigurationActive(pool)
			? "managed"
			: "environment",
	};
}

function selectAccount(
	pool: PoolState,
	excluded: ReadonlySet<string>,
	now: number,
): { account: StoredAccount; index: number } | null {
	const eligible = (index: number) => {
		const account = pool.accounts[pool.order[index] || ""];
		return account &&
			!account.disabled &&
			account.cooldown_until_ms <= now &&
			!account.rotation_token &&
			!excluded.has(account.account_id)
			? account
			: null;
	};
	if (pool.routing_strategy === "least_used") {
		let selected: { account: StoredAccount; index: number } | null = null;
		for (let index = 0; index < pool.order.length; index++) {
			const account = eligible(index);
			if (!account) continue;
			if (
				!selected ||
				account.request_count < selected.account.request_count ||
				(account.request_count === selected.account.request_count &&
					account.last_selected_at_ms < selected.account.last_selected_at_ms)
			)
				selected = { account, index };
		}
		return selected;
	}
	const start = pool.routing_strategy === "round_robin" ? pool.cursor : 0;
	for (let offset = 0; offset < pool.order.length; offset++) {
		const index = (start + offset) % pool.order.length;
		const account = eligible(index);
		if (account) return { account, index };
	}
	return null;
}

export async function getGeminiSessionAccounts(
	cfg: RuntimeConfig,
	env: WorkerEnv,
): Promise<GeminiSessionAccountSummary[]> {
	return [...(await getGeminiSessionAdminSnapshot(cfg, env)).accounts];
}

export async function updateGeminiSessionAccount(
	cfg: RuntimeConfig,
	env: WorkerEnv,
	accountId: string,
	action: GeminiSessionAccountAction,
): Promise<GeminiSessionAccountSummary[]> {
	const seeds = [...cfg.gemini_cookies];
	const namespace = env.GEMINI_SESSION_POOL;
	if (!namespace) {
		await reconcilePool(memoryPoolState, seeds);
		const account = memoryPoolState.accounts[accountId];
		if (!account) throw new Error("account_not_found");
		if (action === "disable") {
			account.disabled = true;
			account.disabled_reason = "manual";
		} else {
			account.disabled = false;
			account.disabled_reason = "";
			clearAccountHealth(account);
			if (action === "reset") {
				const seed = await effectiveSeedForAccount(
					memoryPoolState,
					seeds,
					accountId,
				);
				if (seed) {
					account.cookie = seed.cookie;
					account.sapisid = seed.sapisid;
					account.last_cookie_refresh_at_ms = Date.now();
				}
				account.last_error_at_ms = 0;
				account.auth_failure_count = 0;
			}
		}
		clearRotation(account);
		account.version++;
		return accountSummaries(memoryPoolState);
	}
	return durableCall<GeminiSessionAccountSummary[]>(
		namespace.getByName("default"),
		"/account-action",
		{ seeds, account_id: accountId, action },
	);
}

export async function getGeminiSessionAdminSnapshot(
	cfg: RuntimeConfig,
	env: WorkerEnv,
): Promise<GeminiSessionAdminSnapshot> {
	const seeds = [...cfg.gemini_cookies];
	const namespace = env.GEMINI_SESSION_POOL;
	if (!namespace) {
		await reconcilePool(memoryPoolState, seeds);
		return adminSnapshot(memoryPoolState);
	}
	return durableCall<GeminiSessionAdminSnapshot>(
		namespace.getByName("default"),
		"/admin-snapshot",
		{ seeds },
	);
}

export async function getGeminiSessionAccountLease(
	cfg: RuntimeConfig,
	env: WorkerEnv,
	accountId: string,
): Promise<GeminiSessionLease | null> {
	const seeds = [...cfg.gemini_cookies];
	const namespace = env.GEMINI_SESSION_POOL;
	if (namespace)
		return durableCall<GeminiSessionLease | null>(
			namespace.getByName("default"),
			"/account-lease",
			{ seeds, account_id: accountId },
		);
	await reconcilePool(memoryPoolState, seeds);
	const account = memoryPoolState.accounts[accountId];
	return account ? publicLease(account) : null;
}

export async function previewGeminiSessionAccountImport(
	cfg: RuntimeConfig,
	env: WorkerEnv,
	accounts: readonly GeminiCookieSeed[],
	mode: GeminiSessionAccountImportMode,
): Promise<GeminiSessionImportPreview> {
	const snapshot = await getGeminiSessionAdminSnapshot(cfg, env);
	const existing = new Set(
		snapshot.accounts.map((account) => account.account_id),
	);
	const unique = new Map<
		string,
		Readonly<{ label: string; action: "add" | "update" }>
	>();
	let duplicateCount = 0;
	for (const account of accounts) {
		const accountId = await accountIdFor(account);
		if (unique.has(accountId)) duplicateCount++;
		unique.set(accountId, {
			label: account.label,
			action: existing.has(accountId) ? "update" : "add",
		});
	}
	const items = [...unique.values()];
	const incomingIds = new Set(unique.keys());
	return {
		mode,
		total_input: accounts.length,
		unique_accounts: unique.size,
		add_count: items.filter((item) => item.action === "add").length,
		update_count: items.filter((item) => item.action === "update").length,
		remove_count:
			mode === "replace"
				? snapshot.accounts.filter(
						(account) => !incomingIds.has(account.account_id),
					).length
				: 0,
		duplicate_count: duplicateCount,
		accounts: items,
	};
}

export async function checkAdminLoginThrottle(
	env: WorkerEnv,
	clientKey: string,
): Promise<AdminLoginThrottle> {
	const namespace = env.GEMINI_SESSION_POOL;
	if (namespace)
		return durableCall<AdminLoginThrottle>(
			namespace.getByName("default"),
			"/admin-login/check",
			{ client_key: clientKey },
		);
	return checkAdminLoginState(memoryPoolState, clientKey, Date.now());
}

export async function recordAdminLoginFailure(
	env: WorkerEnv,
	clientKey: string,
): Promise<AdminLoginThrottle> {
	const namespace = env.GEMINI_SESSION_POOL;
	if (namespace)
		return durableCall<AdminLoginThrottle>(
			namespace.getByName("default"),
			"/admin-login/failure",
			{ client_key: clientKey },
		);
	return recordAdminLoginFailureState(memoryPoolState, clientKey, Date.now());
}

export async function clearAdminLoginFailures(
	env: WorkerEnv,
	clientKey: string,
): Promise<void> {
	const namespace = env.GEMINI_SESSION_POOL;
	if (namespace) {
		await durableCall<{ ok: boolean }>(
			namespace.getByName("default"),
			"/admin-login/success",
			{ client_key: clientKey },
		);
		return;
	}
	if (memoryPoolState.admin_login_attempts)
		delete memoryPoolState.admin_login_attempts[clientKey];
}

export async function importGeminiSessionAccounts(
	cfg: RuntimeConfig,
	env: WorkerEnv,
	accounts: readonly GeminiCookieSeed[],
	mode: GeminiSessionAccountImportMode,
): Promise<GeminiSessionAdminSnapshot> {
	const seeds = [...cfg.gemini_cookies];
	const namespace = env.GEMINI_SESSION_POOL;
	if (namespace)
		return durableCall<GeminiSessionAdminSnapshot>(
			namespace.getByName("default"),
			"/accounts/import",
			{ seeds, accounts, mode },
		);
	await ensureManagedConfiguration(memoryPoolState, seeds);
	const managedAccounts =
		mode === "replace" ? {} : { ...(memoryPoolState.managed_accounts || {}) };
	const managedOrder =
		mode === "replace" ? [] : [...(memoryPoolState.managed_order || [])];
	for (const seed of accounts) {
		const accountId = await accountIdFor(seed);
		managedAccounts[accountId] = {
			account_id: accountId,
			label: seed.label,
			cookie: seed.cookie,
			sapisid: seed.sapisid,
		};
		if (!managedOrder.includes(accountId)) managedOrder.push(accountId);
	}
	memoryPoolState.managed_accounts = managedAccounts;
	memoryPoolState.managed_order = managedOrder;
	await reconcilePool(memoryPoolState, seeds);
	return adminSnapshot(memoryPoolState);
}

export async function editGeminiSessionAccount(
	cfg: RuntimeConfig,
	env: WorkerEnv,
	accountId: string,
	patch: GeminiSessionAccountPatch,
): Promise<GeminiSessionAdminSnapshot> {
	const seeds = [...cfg.gemini_cookies];
	const namespace = env.GEMINI_SESSION_POOL;
	if (namespace)
		return durableCall<GeminiSessionAdminSnapshot>(
			namespace.getByName("default"),
			"/account-edit",
			{ seeds, account_id: accountId, patch },
		);
	await ensureManagedConfiguration(memoryPoolState, seeds);
	const account = memoryPoolState.managed_accounts?.[accountId];
	if (!account) throw new Error("account_not_found");
	if (patch.label !== undefined) account.label = patch.label;
	if (patch.cookie !== undefined) account.cookie = patch.cookie;
	if (patch.sapisid !== undefined) account.sapisid = patch.sapisid;
	await reconcilePool(memoryPoolState, seeds);
	return adminSnapshot(memoryPoolState);
}

export async function bulkUpdateGeminiSessionAccounts(
	cfg: RuntimeConfig,
	env: WorkerEnv,
	accountIds: readonly string[],
	action: GeminiSessionBulkAction,
): Promise<GeminiSessionAdminSnapshot> {
	const seeds = [...cfg.gemini_cookies];
	const namespace = env.GEMINI_SESSION_POOL;
	if (namespace)
		return durableCall<GeminiSessionAdminSnapshot>(
			namespace.getByName("default"),
			"/bulk-action",
			{ seeds, account_ids: accountIds, action },
		);
	if (action === "delete")
		await ensureManagedConfiguration(memoryPoolState, seeds);
	else await reconcilePool(memoryPoolState, seeds);
	for (const accountId of accountIds)
		if (!memoryPoolState.accounts[accountId])
			throw new Error("account_not_found");
	if (action === "delete") {
		for (const accountId of accountIds)
			if (memoryPoolState.managed_accounts)
				delete memoryPoolState.managed_accounts[accountId];
		memoryPoolState.managed_order = (
			memoryPoolState.managed_order || []
		).filter((accountId) => !accountIds.includes(accountId));
		await reconcilePool(memoryPoolState, seeds);
	} else {
		for (const accountId of accountIds) {
			const account = memoryPoolState.accounts[accountId];
			if (!account) continue;
			if (action === "disable") {
				account.disabled = true;
				account.disabled_reason = "manual";
			} else {
				account.disabled = false;
				account.disabled_reason = "";
				clearAccountHealth(account);
				if (action === "reset") {
					const seed = await effectiveSeedForAccount(
						memoryPoolState,
						seeds,
						accountId,
					);
					if (seed) {
						account.cookie = seed.cookie;
						account.sapisid = seed.sapisid;
						account.last_cookie_refresh_at_ms = Date.now();
					}
					account.last_error_at_ms = 0;
					account.auth_failure_count = 0;
				}
			}
			clearRotation(account);
			account.version++;
		}
	}
	return adminSnapshot(memoryPoolState);
}

export async function setGeminiSessionRoutingStrategy(
	cfg: RuntimeConfig,
	env: WorkerEnv,
	strategy: GeminiRoutingStrategy,
): Promise<GeminiSessionAdminSnapshot> {
	const seeds = [...cfg.gemini_cookies];
	const namespace = env.GEMINI_SESSION_POOL;
	if (namespace)
		return durableCall<GeminiSessionAdminSnapshot>(
			namespace.getByName("default"),
			"/routing-strategy",
			{ seeds, strategy },
		);
	await reconcilePool(memoryPoolState, seeds);
	memoryPoolState.routing_strategy = normalizeRoutingStrategy(strategy);
	memoryPoolState.cursor = 0;
	return adminSnapshot(memoryPoolState);
}

export async function reorderGeminiSessionAccounts(
	cfg: RuntimeConfig,
	env: WorkerEnv,
	accountIds: readonly string[],
): Promise<GeminiSessionAdminSnapshot> {
	const seeds = [...cfg.gemini_cookies];
	const namespace = env.GEMINI_SESSION_POOL;
	if (namespace)
		return durableCall<GeminiSessionAdminSnapshot>(
			namespace.getByName("default"),
			"/accounts/reorder",
			{ seeds, account_ids: accountIds },
		);
	await ensureManagedConfiguration(memoryPoolState, seeds);
	const existing = new Set(memoryPoolState.managed_order || []);
	if (
		accountIds.length !== existing.size ||
		accountIds.some((accountId) => !existing.has(accountId))
	)
		throw new Error("invalid_account_order");
	memoryPoolState.managed_order = [...accountIds];
	memoryPoolState.cursor = 0;
	await reconcilePool(memoryPoolState, seeds);
	return adminSnapshot(memoryPoolState);
}

export async function restoreGeminiSessionEnvironment(
	cfg: RuntimeConfig,
	env: WorkerEnv,
): Promise<GeminiSessionAdminSnapshot> {
	const seeds = [...cfg.gemini_cookies];
	const namespace = env.GEMINI_SESSION_POOL;
	if (namespace)
		return durableCall<GeminiSessionAdminSnapshot>(
			namespace.getByName("default"),
			"/restore-environment",
			{ seeds },
		);
	delete memoryPoolState.managed_accounts;
	delete memoryPoolState.managed_order;
	await reconcilePool(memoryPoolState, seeds);
	return adminSnapshot(memoryPoolState);
}

async function durableCall<T>(
	stub: DurableObjectStub,
	path: string,
	body: unknown,
): Promise<T> {
	const response = await stub.fetch(`https://gemini-session-pool${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok)
		throw new Error(`Gemini session pool failed with HTTP ${response.status}`);
	return response.json<T>();
}

function checkAdminLoginState(
	pool: PoolState,
	clientKey: string,
	now: number,
): AdminLoginThrottle {
	pruneAdminLoginAttempts(pool, now);
	const attempt = pool.admin_login_attempts?.[clientKey];
	if (!attempt || attempt.blocked_until_ms <= now)
		return { allowed: true, retry_after_seconds: 0 };
	return {
		allowed: false,
		retry_after_seconds: Math.max(
			1,
			Math.ceil((attempt.blocked_until_ms - now) / 1000),
		),
	};
}

function recordAdminLoginFailureState(
	pool: PoolState,
	clientKey: string,
	now: number,
): AdminLoginThrottle {
	pruneAdminLoginAttempts(pool, now);
	pool.admin_login_attempts ||= {};
	let attempt = pool.admin_login_attempts[clientKey];
	if (!attempt || now - attempt.last_failure_at_ms > ADMIN_LOGIN_WINDOW_MS) {
		attempt = {
			failures: 0,
			last_failure_at_ms: 0,
			blocked_until_ms: 0,
		};
		pool.admin_login_attempts[clientKey] = attempt;
	}
	attempt.failures++;
	attempt.last_failure_at_ms = now;
	if (attempt.failures < ADMIN_LOGIN_FAILURE_THRESHOLD)
		return { allowed: true, retry_after_seconds: 0 };
	const exponent = Math.min(
		attempt.failures - ADMIN_LOGIN_FAILURE_THRESHOLD,
		10,
	);
	const delay = Math.min(
		ADMIN_LOGIN_MAX_DELAY_MS,
		ADMIN_LOGIN_BASE_DELAY_MS * 2 ** exponent,
	);
	attempt.blocked_until_ms = now + delay;
	return {
		allowed: false,
		retry_after_seconds: Math.ceil(delay / 1000),
	};
}

function pruneAdminLoginAttempts(pool: PoolState, now: number): void {
	const attempts = pool.admin_login_attempts;
	if (!attempts) return;
	for (const [clientKey, attempt] of Object.entries(attempts))
		if (
			attempt.blocked_until_ms <= now &&
			now - attempt.last_failure_at_ms > ADMIN_LOGIN_WINDOW_MS
		)
			delete attempts[clientKey];
	const entries = Object.entries(attempts);
	if (entries.length <= ADMIN_LOGIN_MAX_TRACKED_CLIENTS) return;
	entries
		.sort(
			(left, right) => left[1].last_failure_at_ms - right[1].last_failure_at_ms,
		)
		.slice(0, entries.length - ADMIN_LOGIN_MAX_TRACKED_CLIENTS)
		.forEach(([clientKey]) => {
			delete attempts[clientKey];
		});
}

function normalizeStoredAccount(
	account: StoredAccount,
	fallbackLabel: string,
): void {
	account.label ||= fallbackLabel;
	account.disabled_reason ||= account.disabled ? "auth_failed" : "";
	account.issue ||= "";
	account.cooldown_until_ms ||= 0;
	account.consecutive_auth_failures ||= 0;
	account.last_selected_at_ms ||= 0;
	account.last_success_at_ms ||= 0;
	account.last_error_at_ms ||= 0;
	account.last_cookie_refresh_at_ms ||= 0;
	account.request_count ||= 0;
	account.success_count ||= 0;
	account.auth_failure_count ||= 0;
	account.refresh_count ||= 0;
	account.rotation_token ||= "";
	account.rotation_started_at_ms ||= 0;
}

function accountSummaries(pool: PoolState): GeminiSessionAccountSummary[] {
	const now = Date.now();
	return pool.order.flatMap((id, index) => {
		const account = pool.accounts[id];
		if (!account) return [];
		return [
			{
				account_id: account.account_id,
				label: account.label,
				position: index + 1,
				status: account.disabled
					? "disabled"
					: account.cooldown_until_ms > now
						? "cooling"
						: "healthy",
				issue:
					account.cooldown_until_ms > now || account.disabled
						? account.issue
						: "",
				cooldown_until_ms: account.cooldown_until_ms,
				last_selected_at_ms: account.last_selected_at_ms,
				last_success_at_ms: account.last_success_at_ms,
				last_error_at_ms: account.last_error_at_ms,
				last_cookie_refresh_at_ms: account.last_cookie_refresh_at_ms,
				request_count: account.request_count,
				success_count: account.success_count,
				auth_failure_count: account.auth_failure_count,
				refresh_count: account.refresh_count,
			},
		];
	});
}

async function accountIdFor(seed: GeminiCookieSeed): Promise<string> {
	const root =
		/(?:^|;\s*)__Secure-1PSID=([^;]+)/.exec(seed.cookie)?.[1] || seed.cookie;
	return (await sha256(root)).slice(0, 24);
}

async function sha256(value: string): Promise<string> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function publicLease(account: StoredAccount): GeminiSessionLease {
	return {
		account_id: account.account_id,
		version: account.version,
		cookie: account.cookie,
		sapisid: account.sapisid,
		last_cookie_refresh_at_ms: account.last_cookie_refresh_at_ms,
	};
}

function publicRotation(account: StoredAccount): GeminiSessionRotation {
	return {
		account_id: account.account_id,
		version: account.version,
		token: account.rotation_token,
	};
}

function rotationMatches(
	account: StoredAccount | undefined,
	rotation: GeminiSessionRotation,
): account is StoredAccount {
	return !!(
		account &&
		account.version === rotation.version &&
		account.rotation_token &&
		account.rotation_token === rotation.token
	);
}

function clearRotation(account: StoredAccount): void {
	account.rotation_token = "";
	account.rotation_started_at_ms = 0;
}

function clearStaleRotation(account: StoredAccount, now: number): void {
	if (
		account.rotation_token &&
		now - account.rotation_started_at_ms >= ROTATION_STALE_MS
	) {
		clearRotation(account);
		// The external RotateCookies call may have succeeded before the Worker was
		// interrupted. Never put the possibly invalid old cookie straight back into
		// circulation when its persistence fence expires.
		recordAccountFailure(account, "auth", now);
	}
}

function clearStaleRotations(pool: PoolState, now: number): void {
	for (const account of Object.values(pool.accounts))
		clearStaleRotation(account, now);
}

function clearExpiredCooldowns(pool: PoolState, now: number): void {
	for (const account of Object.values(pool.accounts)) {
		if (
			!account.disabled &&
			account.cooldown_until_ms > 0 &&
			account.cooldown_until_ms <= now
		) {
			account.issue = "";
			account.cooldown_until_ms = 0;
		}
	}
}

function clearAccountHealth(account: StoredAccount): void {
	account.issue = "";
	account.cooldown_until_ms = 0;
	account.consecutive_auth_failures = 0;
}

function recordAccountFailure(
	account: StoredAccount,
	issue: GeminiSessionFailureIssue,
	now: number,
): void {
	account.version++;
	account.issue = issue;
	account.last_error_at_ms = now;
	if (issue === "auth") {
		account.auth_failure_count++;
		account.consecutive_auth_failures++;
		const factor = 2 ** Math.min(account.consecutive_auth_failures - 1, 5);
		account.cooldown_until_ms =
			now + Math.min(AUTH_COOLDOWN_BASE_MS * factor, AUTH_COOLDOWN_MAX_MS);
		return;
	}
	account.cooldown_until_ms =
		now +
		(issue === "rate_limit" ? RATE_LIMIT_COOLDOWN_MS : TRANSIENT_COOLDOWN_MS);
}

async function seedForAccount(
	seeds: readonly GeminiCookieSeed[],
	accountId: string,
): Promise<GeminiCookieSeed | null> {
	for (const seed of seeds)
		if ((await accountIdFor(seed)) === accountId) return seed;
	return null;
}

async function effectiveSeedForAccount(
	pool: PoolState,
	seeds: readonly GeminiCookieSeed[],
	accountId: string,
): Promise<GeminiCookieSeed | null> {
	if (managedConfigurationActive(pool)) {
		const account = pool.managed_accounts?.[accountId];
		return account
			? {
					label: account.label,
					cookie: account.cookie,
					sapisid: account.sapisid,
				}
			: null;
	}
	return seedForAccount(seeds, accountId);
}
