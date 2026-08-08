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
	schema_version?: number;
};

type AcquireBody = { seeds: GeminiCookieSeed[]; exclude?: string[] };

const POOL_SCHEMA_VERSION = 4;
const EMPTY_STATE: PoolState = {
	accounts: {},
	order: [],
	cursor: 0,
	schema_version: POOL_SCHEMA_VERSION,
};
const memoryPoolState: PoolState = structuredClone(EMPTY_STATE);
const ROTATION_STALE_MS = 2 * 60 * 1000;
const AUTH_COOLDOWN_BASE_MS = 60 * 1000;
const AUTH_COOLDOWN_MAX_MS = 30 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const TRANSIENT_COOLDOWN_MS = 60 * 1000;

export class GeminiSessionPool {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST") return new Response(null, { status: 405 });
		if (url.pathname === "/acquire") {
			const body = (await request.json()) as AcquireBody;
			return Response.json(await this.acquire(body.seeds, body.exclude || []));
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
		return new Response(null, { status: 404 });
	}

	private async acquire(
		seeds: readonly GeminiCookieSeed[],
		exclude: readonly string[],
	): Promise<GeminiSessionLease | null> {
		return this.state.storage.transaction(async (storage) => {
			const pool =
				(await storage.get<PoolState>("pool")) || structuredClone(EMPTY_STATE);
			await reconcilePool(pool, seeds);
			const now = Date.now();
			clearStaleRotations(pool, now);
			clearExpiredCooldowns(pool, now);
			const excluded = new Set(exclude);
			let selected: StoredAccount | undefined;
			for (let offset = 0; offset < pool.order.length; offset++) {
				const index = (pool.cursor + offset) % pool.order.length;
				const account = pool.accounts[pool.order[index] || ""];
				if (
					!account ||
					account.disabled ||
					account.cooldown_until_ms > now ||
					account.rotation_token ||
					excluded.has(account.account_id)
				)
					continue;
				selected = account;
				account.last_selected_at_ms = now;
				account.request_count++;
				pool.cursor = (index + 1) % pool.order.length;
				break;
			}
			await storage.put("pool", pool);
			return selected ? publicLease(selected) : null;
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
					const seed = await seedForAccount(seeds, accountId);
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
}

export async function configWithPooledGeminiSession(
	cfg: RuntimeConfig,
	env: WorkerEnv,
): Promise<RuntimeConfig> {
	const namespace = env.GEMINI_SESSION_POOL;
	if (!cfg.gemini_cookies.length) return cfg;
	const seeds = [...cfg.gemini_cookies];
	const pool = namespace
		? createDurablePool(namespace.getByName("default"), seeds)
		: createMemoryPool(seeds);
	const lease = await pool.acquire();
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
			clearExpiredCooldowns(memoryPoolState, now);
			const excluded = new Set(excludeAccountIds);
			for (let offset = 0; offset < memoryPoolState.order.length; offset++) {
				const index =
					(memoryPoolState.cursor + offset) % memoryPoolState.order.length;
				const account =
					memoryPoolState.accounts[memoryPoolState.order[index] || ""];
				if (account) clearStaleRotation(account, Date.now());
				if (
					!account ||
					account.disabled ||
					account.cooldown_until_ms > now ||
					account.rotation_token ||
					excluded.has(account.account_id)
				)
					continue;
				memoryPoolState.cursor = (index + 1) % memoryPoolState.order.length;
				account.last_selected_at_ms = now;
				account.request_count++;
				return publicLease(account);
			}
			return null;
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
	const nextOrder: string[] = [];
	for (const seed of seeds) {
		const accountId = await accountIdFor(seed);
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

export async function getGeminiSessionAccounts(
	cfg: RuntimeConfig,
	env: WorkerEnv,
): Promise<GeminiSessionAccountSummary[]> {
	const seeds = [...cfg.gemini_cookies];
	if (!seeds.length) return [];
	const namespace = env.GEMINI_SESSION_POOL;
	if (!namespace) {
		await reconcilePool(memoryPoolState, seeds);
		return accountSummaries(memoryPoolState);
	}
	const stub = namespace.getByName("default");
	return durableCall<GeminiSessionAccountSummary[]>(stub, "/accounts", {
		seeds,
	});
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
				const seed = await seedForAccount(seeds, accountId);
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
