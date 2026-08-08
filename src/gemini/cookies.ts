import type { GeminiSessionFailureIssue, RuntimeConfig } from "../config";
import { errorLogSummary, log } from "../shared/runtime";
import { GEMINI_WEB_USER_AGENT } from "./constants";
import { httpFetch } from "./transport";

export type ActiveCookieState = {
	cookie: string;
	sapisid: string;
	secure1psid: string;
	secure1psidts: string;
	updatedAtMs: number;
	lastRotateAtMs: number;
	sourceKey: string;
	sourceCookie: string;
	sourceSapisid: string;
};

export type CookieRotationReason =
	| "missing_cookie"
	| "missing_secure_1psid"
	| "recent_rotation"
	| "rotation_rejected"
	| "rotation_failed"
	| "rotation_no_update"
	| "rotation_error"
	| "rotation_updated";

export type CookieRotationRetryResult = {
	config: RuntimeConfig | null;
	reason: CookieRotationReason;
	upstreamStatus?: number;
};

export type MergeSetCookieOptions = Readonly<{
	responseUrl?: string;
	targetUrl?: string;
	nowMs?: number;
}>;

type CookieRotationAttempt = {
	state: ActiveCookieState;
	updated: boolean;
	credentialInvalidated: boolean;
	reason: CookieRotationReason;
	upstreamStatus?: number;
};

export const COOKIE_ROTATE_MIN_INTERVAL_MS = 60 * 1000;
export const COOKIE_ROTATE_STALE_MS = 10 * 60 * 1000;

const GOOGLE_ROTATE_COOKIES_URL = "https://accounts.google.com/RotateCookies";
const GEMINI_COOKIE_TARGET_URL = "https://gemini.google.com/app";

let activeCookieState: ActiveCookieState | null = null;
let rotatePromise: Promise<CookieRotationAttempt | null> | null = null;
let lastRotationReason: CookieRotationReason = "missing_cookie";
let lastRotationUpstreamStatus = 0;

export function parseCookieHeader(cookieHeader: unknown): Map<string, string> {
	const map = new Map<string, string>();
	const raw = String(cookieHeader || "");
	for (const part of raw.split(";")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const name = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim();
		if (name) map.set(name, value);
	}
	return map;
}

export function serializeCookieMap(cookies: Map<string, string>): string {
	return Array.from(cookies.entries())
		.filter(([name]) => !!name)
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

export function extractCookieValue(
	cookieHeader: unknown,
	name: string,
): string {
	return parseCookieHeader(cookieHeader).get(name) || "";
}

export function splitSetCookieHeader(header: unknown): string[] {
	const raw = String(header || "").trim();
	if (!raw) return [];
	const out: string[] = [];
	let start = 0;
	let inQuote = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch === '"' && raw[i - 1] !== "\\") inQuote = !inQuote;
		if (ch !== "," || inQuote || !looksLikeCookiePair(raw, i + 1)) continue;
		const part = raw.slice(start, i).trim();
		if (part) out.push(part);
		start = i + 1;
	}
	const tail = raw.slice(start).trim();
	if (tail) out.push(tail);
	return out;
}

export function setCookieHeaders(headers: Headers): string[] {
	return headers.getSetCookie().flatMap(splitSetCookieHeader);
}

export function mergeSetCookieHeaders(
	cookieHeader: unknown,
	setCookieValues: readonly string[],
	options: MergeSetCookieOptions = {},
): string {
	const cookies = parseCookieHeader(cookieHeader);
	for (const setCookie of setCookieValues) {
		const mutation = parseSetCookieMutation(setCookie, options);
		if (!mutation) continue;
		if (mutation.remove) cookies.delete(mutation.name);
		else cookies.set(mutation.name, mutation.value);
	}
	return serializeCookieMap(cookies);
}

export function configWithActiveGeminiCookie(
	cfg: RuntimeConfig,
): RuntimeConfig {
	if (cfg.gemini_session_pool) return cfg;
	const state = ensureActiveCookieState(cfg);
	if (!state) return cfg;
	return {
		...cfg,
		cookie: state.cookie,
		sapisid: state.sapisid || cfg.sapisid,
	};
}

export async function configWithFreshGeminiCookie(
	cfg: RuntimeConfig,
): Promise<RuntimeConfig> {
	if (cfg.gemini_rotation) return cfg;
	if (cfg.gemini_session_pool && cfg.gemini_session) {
		// A pooled credential is refreshed only after an authenticated request is
		// actually rejected. Proactive RotateCookies calls can stall a healthy
		// request and turn a transient rotation timeout into a stale fenced lease.
		return cfg;
	}
	const state = ensureActiveCookieState(cfg);
	if (!state) return cfg;
	if (Date.now() - state.updatedAtMs > COOKIE_ROTATE_STALE_MS) {
		const attempt = await rotateGeminiCookie(cfg, { force: false });
		if (attempt?.updated) {
			const next = {
				...cfg,
				cookie: attempt.state.cookie,
				sapisid: attempt.state.sapisid || cfg.sapisid,
			};
			return next;
		}
	}
	return configWithActiveGeminiCookie(cfg);
}

export async function rotateGeminiCookieForRetry(
	cfg: RuntimeConfig,
): Promise<RuntimeConfig | null> {
	return (await rotateGeminiCookieForRetryWithReason(cfg)).config;
}

export async function rotateGeminiCookieForRetryWithReason(
	cfg: RuntimeConfig,
): Promise<CookieRotationRetryResult> {
	if (cfg.gemini_session_pool && cfg.gemini_session) {
		if (cfg.gemini_rotation) {
			setRotationReason("rotation_rejected");
			return rotationRetryResult(null, "rotation_rejected");
		}
		return rotatePooledGeminiCookie(cfg);
	}
	const current = configWithActiveGeminiCookie(cfg);
	const attempt = await rotateGeminiCookie(current, { force: true });
	if (!attempt?.updated) {
		return rotationRetryResult(
			null,
			attempt?.reason || lastRotationReason,
			attempt?.upstreamStatus,
		);
	}
	return rotationRetryResult(
		{
			...cfg,
			cookie: attempt.state.cookie,
			sapisid: attempt.state.sapisid || cfg.sapisid,
		},
		attempt.reason,
		attempt.upstreamStatus,
	);
}

export async function switchGeminiSessionForRetry(
	cfg: RuntimeConfig,
	excludeAccountIds: readonly string[] = [],
	issue: GeminiSessionFailureIssue | null = "auth",
): Promise<RuntimeConfig | null> {
	const pool = cfg.gemini_session_pool;
	const lease = cfg.gemini_session;
	if (!pool || !lease) return null;
	if (cfg.gemini_rotation) {
		try {
			const committed = await commitRotationCandidate(
				pool,
				cfg.gemini_rotation,
				cfg.cookie,
				cfg.sapisid,
			);
			if (committed && issue) await pool.markFailure(committed, issue);
		} catch (error) {
			// RotateCookies is an external, irreversible mutation. Keep the fence in
			// place when persistence is unavailable instead of restoring a cookie
			// that Google may already have invalidated.
			log(
				cfg,
				`gemini session rotated cookie persistence failed ${errorLogSummary(error)}`,
			);
		}
	} else if (issue) await pool.markFailure(lease, issue);
	const excluded = new Set(excludeAccountIds);
	excluded.add(lease.account_id);
	const next = await pool.acquire([...excluded]);
	if (!next) return null;
	const nextCfg = withoutRotation(cfg);
	return {
		...nextCfg,
		cookie: next.cookie,
		sapisid: next.sapisid,
		gemini_session: next,
	};
}

export async function markGeminiSessionSuccess(
	cfg: RuntimeConfig,
): Promise<void> {
	if (!cfg.gemini_session_pool || !cfg.gemini_session) return;
	try {
		let lease = cfg.gemini_session;
		if (cfg.gemini_rotation) {
			const committed = await commitRotationCandidate(
				cfg.gemini_session_pool,
				cfg.gemini_rotation,
				cfg.cookie,
				cfg.sapisid,
			);
			if (!committed) return;
			if (!leaseHasRefreshedAuth(committed, lease.cookie)) {
				await cfg.gemini_session_pool.markFailure(committed, "auth");
				return;
			}
			lease = committed;
		}
		await cfg.gemini_session_pool.markSuccess(lease);
	} catch (error) {
		log(cfg, `gemini session success metric failed ${errorLogSummary(error)}`);
	}
}

export async function abortGeminiSessionRotation(
	cfg: RuntimeConfig,
): Promise<void> {
	if (!cfg.gemini_session_pool || !cfg.gemini_rotation) return;
	try {
		// A successful RotateCookies response has already mutated Google's state.
		// Disposal must persist that state; aborting would resurrect the old value.
		const committed = await commitRotationCandidate(
			cfg.gemini_session_pool,
			cfg.gemini_rotation,
			cfg.cookie,
			cfg.sapisid,
		);
		if (
			committed &&
			cfg.gemini_session &&
			!leaseHasRefreshedAuth(committed, cfg.gemini_session.cookie)
		)
			await cfg.gemini_session_pool.markFailure(committed, "auth");
	} catch (error) {
		log(
			cfg,
			`gemini session rotated cookie persistence failed ${errorLogSummary(error)}`,
		);
	}
}

async function rotatePooledGeminiCookie(
	cfg: RuntimeConfig,
): Promise<CookieRotationRetryResult> {
	const pool = cfg.gemini_session_pool;
	const originalLease = cfg.gemini_session;
	if (!pool || !originalLease)
		return rotationRetryResult(null, "missing_cookie");
	const start = await pool.beginRotation(originalLease);
	if (start.status === "updated") {
		setRotationReason("rotation_updated");
		return rotationRetryResult(
			configWithLease(cfg, start.lease),
			"rotation_updated",
		);
	}
	if (start.status === "busy") {
		setRotationReason("recent_rotation");
		return rotationRetryResult(null, "recent_rotation");
	}
	if (start.status !== "acquired") {
		setRotationReason("rotation_failed");
		return rotationRetryResult(null, "rotation_failed");
	}
	const fencedCfg = configWithLease(cfg, start.lease);
	const state = stateFromCookie(
		fencedCfg.cookie,
		cookieSourceKey(fencedCfg),
		Date.now(),
		fencedCfg.sapisid,
		fencedCfg.cookie,
		fencedCfg.sapisid,
	);
	if (!state) {
		await pool.failRotation(start.rotation, "auth");
		setRotationReason("missing_cookie");
		return rotationRetryResult(null, "missing_cookie");
	}
	if (!state.secure1psid) {
		await pool.failRotation(start.rotation, "auth");
		setRotationReason("missing_secure_1psid");
		return rotationRetryResult(null, "missing_secure_1psid");
	}
	const attempt = await rotateGeminiCookieOnce(fencedCfg, state, false);
	if (!attempt.updated) {
		if (attempt.credentialInvalidated) {
			try {
				const committed = await commitRotationCandidate(
					pool,
					start.rotation,
					attempt.state.cookie,
					attempt.state.sapisid,
				);
				if (committed) await pool.markFailure(committed, "auth");
			} catch (error) {
				log(
					cfg,
					`gemini session invalidated cookie persistence failed ${errorLogSummary(error)}`,
				);
				scheduleRotationPersistence(
					cfg,
					pool,
					start.rotation,
					attempt.state.cookie,
					attempt.state.sapisid,
					state.cookie,
					"auth",
				);
			}
		} else {
			// The triggering Gemini request already proved this credential invalid.
			// Record that failure while releasing the rotation fence.
			await pool.failRotation(start.rotation, "auth");
		}
		return rotationRetryResult(null, attempt.reason, attempt.upstreamStatus);
	}

	const candidateCfg: RuntimeConfig = {
		...fencedCfg,
		cookie: attempt.state.cookie,
		sapisid: attempt.state.sapisid || fencedCfg.sapisid,
		gemini_rotation: start.rotation,
	};
	try {
		const committed = await commitRotationCandidate(
			pool,
			start.rotation,
			candidateCfg.cookie,
			candidateCfg.sapisid,
		);
		if (committed) {
			if (!leaseHasRefreshedAuth(committed, state.cookie)) {
				log(cfg, "gemini session pool did not persist the rotated cookie");
				await pool.markFailure(committed, "auth");
				setRotationReason("rotation_failed");
				return rotationRetryResult(null, "rotation_failed");
			}
			return rotationRetryResult(
				configWithLease(cfg, committed),
				attempt.reason,
				attempt.upstreamStatus,
			);
		}
	} catch (error) {
		log(
			cfg,
			`gemini session rotated cookie persistence failed ${errorLogSummary(error)}`,
		);
	}
	scheduleRotationPersistence(
		cfg,
		pool,
		start.rotation,
		candidateCfg.cookie,
		candidateCfg.sapisid,
		state.cookie,
	);
	// Preserve the candidate and its fencing token as a last-resort recovery path.
	// Success, failure, and provider disposal all retry the idempotent commit.
	return rotationRetryResult(
		candidateCfg,
		attempt.reason,
		attempt.upstreamStatus,
	);
}

async function commitRotationCandidate(
	pool: NonNullable<RuntimeConfig["gemini_session_pool"]>,
	rotation: NonNullable<RuntimeConfig["gemini_rotation"]>,
	cookie: string,
	sapisid: string,
): Promise<NonNullable<RuntimeConfig["gemini_session"]> | null> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			return await pool.commitRotation(rotation, cookie, sapisid);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}

function leaseHasRefreshedAuth(
	lease: NonNullable<RuntimeConfig["gemini_session"]>,
	previousCookie: string,
): boolean {
	const secure1psid = extractCookieValue(lease.cookie, "__Secure-1PSID");
	const secure1psidts = extractCookieValue(lease.cookie, "__Secure-1PSIDTS");
	const previous1psidts = extractCookieValue(
		previousCookie,
		"__Secure-1PSIDTS",
	);
	return !!secure1psid && !!secure1psidts && secure1psidts !== previous1psidts;
}

function scheduleRotationPersistence(
	cfg: RuntimeConfig,
	pool: NonNullable<RuntimeConfig["gemini_session_pool"]>,
	rotation: NonNullable<RuntimeConfig["gemini_rotation"]>,
	cookie: string,
	sapisid: string,
	previousCookie: string,
	issue?: GeminiSessionFailureIssue,
): void {
	if (!cfg.execution_ctx) return;
	cfg.execution_ctx.waitUntil(
		(async () => {
			try {
				const committed = await commitRotationCandidate(
					pool,
					rotation,
					cookie,
					sapisid,
				);
				if (!committed) return;
				if (issue) await pool.markFailure(committed, issue);
				else if (!leaseHasRefreshedAuth(committed, previousCookie))
					await pool.markFailure(committed, "auth");
			} catch (error) {
				log(
					cfg,
					`gemini session background cookie persistence failed ${errorLogSummary(error)}`,
				);
			}
		})(),
	);
}

function configWithLease(
	cfg: RuntimeConfig,
	lease: NonNullable<RuntimeConfig["gemini_session"]>,
): RuntimeConfig {
	const nextCfg = withoutRotation(cfg);
	return {
		...nextCfg,
		cookie: lease.cookie,
		sapisid: lease.sapisid,
		gemini_session: lease,
	};
}

function withoutRotation(cfg: RuntimeConfig): RuntimeConfig {
	const { gemini_rotation: _rotation, ...rest } = cfg;
	return rest;
}

async function rotateGeminiCookie(
	cfg: RuntimeConfig,
	options: { force: boolean },
): Promise<CookieRotationAttempt | null> {
	const state = ensureActiveCookieState(cfg);
	if (!state) {
		setRotationReason("missing_cookie");
		return null;
	}
	if (!state.secure1psid) {
		log(cfg, "gemini cookie rotation skipped reason=missing_secure_1psid");
		return cookieRotationAttempt(state, "missing_secure_1psid");
	}
	if (rotatePromise) return rotatePromise;

	const now = Date.now();
	if (
		!options.force &&
		now - state.lastRotateAtMs < COOKIE_ROTATE_MIN_INTERVAL_MS
	) {
		return cookieRotationAttempt(state, "recent_rotation");
	}
	if (
		options.force &&
		now - state.lastRotateAtMs < COOKIE_ROTATE_MIN_INTERVAL_MS
	) {
		log(cfg, "gemini cookie rotation skipped reason=recent_rotation");
		return cookieRotationAttempt(state, "recent_rotation");
	}

	state.lastRotateAtMs = now;
	rotatePromise = rotateGeminiCookieOnce(cfg, state).finally(() => {
		rotatePromise = null;
	});
	return rotatePromise;
}

async function rotateGeminiCookieOnce(
	cfg: RuntimeConfig,
	state: ActiveCookieState,
	updateGlobal = true,
): Promise<CookieRotationAttempt> {
	try {
		const resp = await httpFetch(GOOGLE_ROTATE_COOKIES_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "https://accounts.google.com",
				Referer: "https://accounts.google.com/",
				"User-Agent": GEMINI_WEB_USER_AGENT,
				"Accept-Language": "en-US,en;q=0.9",
				Cookie: state.cookie,
			},
			body: '[000,"-0000000000000000000"]',
			timeoutMs: Math.min(
				Math.max(Number(cfg.request_timeout_sec) || 30, 1) * 1000,
				30000,
			),
			socket: cfg.upstream_socket,
			socketFallback: "never",
			cfg,
		});
		if (resp.status === 401 || resp.status === 403) {
			log(cfg, `gemini cookie rotation rejected upstreamStatus=${resp.status}`);
			return cookieRotationAttempt(
				state,
				"rotation_rejected",
				false,
				false,
				resp.status,
			);
		}
		if (!resp.ok) {
			log(cfg, `gemini cookie rotation failed upstreamStatus=${resp.status}`);
			return cookieRotationAttempt(
				state,
				"rotation_failed",
				false,
				false,
				resp.status,
			);
		}

		const setCookies = setCookieHeaders(resp.headers);
		const mergeOptions = {
			responseUrl: GOOGLE_ROTATE_COOKIES_URL,
			targetUrl: GEMINI_COOKIE_TARGET_URL,
		};
		const mergedCookie = mergeSetCookieHeaders(
			state.cookie,
			setCookies,
			mergeOptions,
		);
		const sapisidMutated = setCookies.some(
			(value) =>
				parseSetCookieMutation(value, mergeOptions)?.name === "SAPISID",
		);
		const next = stateFromCookie(
			mergedCookie,
			state.sourceKey,
			state.lastRotateAtMs,
			sapisidMutated ? "" : state.sapisid || cfg.sapisid,
			state.sourceCookie,
			state.sourceSapisid,
			true,
		);
		if (!next) return cookieRotationAttempt(state, "rotation_no_update");
		const targetUpdated =
			!!next.secure1psid &&
			!!next.secure1psidts &&
			next.secure1psidts !== state.secure1psidts;
		const credentialInvalidated =
			next.cookie !== state.cookie &&
			((!!state.secure1psid && !next.secure1psid) ||
				(!!state.secure1psidts && !next.secure1psidts));
		if (!targetUpdated) {
			if (credentialInvalidated && updateGlobal) activeCookieState = next;
			log(
				cfg,
				credentialInvalidated
					? "gemini cookie rotation invalidated an authentication cookie"
					: "gemini cookie rotation completed without target cookie update",
			);
			return cookieRotationAttempt(
				credentialInvalidated ? next : state,
				"rotation_no_update",
				false,
				credentialInvalidated,
			);
		}
		if (updateGlobal) activeCookieState = next;
		log(cfg, "gemini cookie rotation updated active cookie");
		return cookieRotationAttempt(next, "rotation_updated", true);
	} catch (e) {
		log(cfg, `gemini cookie rotation error ${errorLogSummary(e)}`);
		return cookieRotationAttempt(state, "rotation_error");
	}
}

function ensureActiveCookieState(cfg: RuntimeConfig): ActiveCookieState | null {
	if (!cfg.cookie) {
		activeCookieState = null;
		return null;
	}
	const normalizedCookie = serializeCookieMap(parseCookieHeader(cfg.cookie));
	if (!normalizedCookie) {
		activeCookieState = null;
		return null;
	}
	const sourceKey = cookieSourceKey(cfg);
	const sourceSapisid = String(cfg.sapisid || "");
	if (activeCookieState && activeCookieState.sourceKey === sourceKey) {
		if (normalizedCookie === activeCookieState.cookie) return activeCookieState;
		if (
			normalizedCookie === activeCookieState.sourceCookie &&
			sourceSapisid === activeCookieState.sourceSapisid
		)
			return activeCookieState;
	}
	activeCookieState = stateFromCookie(
		normalizedCookie,
		sourceKey,
		0,
		cfg.sapisid,
		normalizedCookie,
		sourceSapisid,
	);
	return activeCookieState;
}

function stateFromCookie(
	cookie: string,
	sourceKey: string,
	lastRotateAtMs: number,
	sapisidOverride?: unknown,
	sourceCookie?: string,
	sourceSapisid?: string,
	allowEmpty = false,
): ActiveCookieState | null {
	const cookies = parseCookieHeader(cookie);
	const normalizedCookie = serializeCookieMap(cookies);
	if (!normalizedCookie && !allowEmpty) return null;
	// The cookie jar is authoritative after RotateCookies. An explicit SAPISID is
	// only a fallback for compact configurations that omit it from the header.
	const sapisid = String(cookies.get("SAPISID") || sapisidOverride || "");
	return {
		cookie: normalizedCookie,
		sapisid,
		secure1psid: cookies.get("__Secure-1PSID") || "",
		secure1psidts: cookies.get("__Secure-1PSIDTS") || "",
		updatedAtMs: Date.now(),
		lastRotateAtMs,
		sourceKey,
		sourceCookie:
			serializeCookieMap(parseCookieHeader(sourceCookie || normalizedCookie)) ||
			normalizedCookie,
		sourceSapisid: String(sourceSapisid || ""),
	};
}

function cookieSourceKey(cfg: RuntimeConfig): string {
	const secure1psid = extractCookieValue(cfg.cookie, "__Secure-1PSID");
	return secure1psid || serializeCookieMap(parseCookieHeader(cfg.cookie)) || "";
}

function cookieRotationAttempt(
	state: ActiveCookieState,
	reason: CookieRotationReason,
	updated = false,
	credentialInvalidated = false,
	upstreamStatus = 0,
): CookieRotationAttempt {
	setRotationReason(reason, upstreamStatus);
	const attempt: CookieRotationAttempt = {
		state,
		updated,
		credentialInvalidated,
		reason,
	};
	if (upstreamStatus) attempt.upstreamStatus = upstreamStatus;
	return attempt;
}

export function resetActiveGeminiCookieForTest(): void {
	activeCookieState = null;
	rotatePromise = null;
	setRotationReason("missing_cookie");
}

function parseSetCookieMutation(
	setCookie: unknown,
	options: MergeSetCookieOptions,
): { name: string; value: string; remove: boolean } | null {
	const parts = String(setCookie || "")
		.split(";")
		.map((part) => part.trim());
	const first = parts.shift() || "";
	const eq = first.indexOf("=");
	if (eq <= 0) return null;
	const name = first.slice(0, eq).trim();
	const value = first.slice(eq + 1).trim();
	if (!name) return null;

	let domain = "";
	let path = "";
	let secure = false;
	let maxAge: number | null = null;
	let expiresAtMs: number | null = null;
	for (const part of parts) {
		if (!part) continue;
		const attrEq = part.indexOf("=");
		const attrName = (attrEq < 0 ? part : part.slice(0, attrEq))
			.trim()
			.toLowerCase();
		const attrValue =
			attrEq < 0 ? "" : unquoteCookieAttribute(part.slice(attrEq + 1).trim());
		if (attrName === "domain") domain = attrValue.toLowerCase();
		else if (attrName === "path") path = attrValue;
		else if (attrName === "secure") secure = true;
		else if (attrName === "max-age" && /^-?\d+$/.test(attrValue))
			maxAge = Number(attrValue);
		else if (attrName === "expires") {
			const parsed = Date.parse(attrValue);
			if (Number.isFinite(parsed)) expiresAtMs = parsed;
		}
	}

	if (options.responseUrl && options.targetUrl) {
		let responseUrl: URL;
		let targetUrl: URL;
		try {
			responseUrl = new URL(options.responseUrl);
			targetUrl = new URL(options.targetUrl);
		} catch (_) {
			return null;
		}
		const responseHost = responseUrl.hostname.toLowerCase();
		const targetHost = targetUrl.hostname.toLowerCase();
		if (domain) {
			domain = domain.replace(/^\.+/, "");
			if (
				!domain ||
				!domainMatches(responseHost, domain) ||
				!domainMatches(targetHost, domain)
			)
				return null;
		} else if (responseHost !== targetHost) return null;

		const cookiePath = path.startsWith("/")
			? path
			: defaultCookiePath(responseUrl.pathname);
		if (!cookiePathMatches(targetUrl.pathname || "/", cookiePath)) return null;
		if (
			(secure &&
				(responseUrl.protocol !== "https:" ||
					targetUrl.protocol !== "https:")) ||
			(name.startsWith("__Secure-") &&
				(!secure || responseUrl.protocol !== "https:"))
		)
			return null;
	}

	const nowMs = Number.isFinite(options.nowMs)
		? Number(options.nowMs)
		: Date.now();
	const remove =
		maxAge !== null
			? maxAge <= 0
			: expiresAtMs !== null && expiresAtMs <= nowMs;
	return { name, value, remove };
}

function unquoteCookieAttribute(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
		return value.slice(1, -1);
	return value;
}

function domainMatches(host: string, domain: string): boolean {
	return host === domain || host.endsWith(`.${domain}`);
}

function defaultCookiePath(pathname: string): string {
	if (!pathname.startsWith("/") || pathname === "/") return "/";
	const lastSlash = pathname.lastIndexOf("/");
	return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}

function cookiePathMatches(requestPath: string, cookiePath: string): boolean {
	if (requestPath === cookiePath) return true;
	if (!requestPath.startsWith(cookiePath)) return false;
	return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function looksLikeCookiePair(raw: string, from: number): boolean {
	let i = from;
	while (i < raw.length && /\s/.test(raw[i] || "")) i++;
	const nameStart = i;
	while (i < raw.length) {
		const ch = raw[i] || "";
		if (ch === "=") return i > nameStart;
		if (ch === ";" || ch === "," || /\s/.test(ch)) return false;
		i++;
	}
	return false;
}

function setRotationReason(
	reason: CookieRotationReason,
	upstreamStatus = 0,
): void {
	lastRotationReason = reason;
	lastRotationUpstreamStatus = upstreamStatus;
}

function rotationRetryResult(
	config: RuntimeConfig | null,
	reason?: CookieRotationReason,
	upstreamStatus?: number,
): CookieRotationRetryResult {
	const resolvedReason = reason || lastRotationReason;
	const resolvedStatus =
		upstreamStatus || (reason === undefined ? lastRotationUpstreamStatus : 0);
	const result: CookieRotationRetryResult = {
		config,
		reason: resolvedReason,
	};
	if (resolvedStatus) result.upstreamStatus = resolvedStatus;
	return result;
}

export function getLastGeminiCookieRotationReasonForTest(): CookieRotationRetryResult {
	return rotationRetryResult(null);
}
