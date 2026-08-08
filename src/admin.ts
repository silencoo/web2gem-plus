import { probeGeminiAccount } from "./admin/account-probe";
import {
	adminSessionAuthorized,
	clearAdminSessionCookie,
	createAdminSessionCookie,
	verifyAdminCredentials,
} from "./admin/auth";
import {
	ADMIN_CSS,
	ADMIN_JS,
	ADMIN_LOGIN_JS,
	adminDashboardPage,
	adminLoginPage,
} from "./admin/ui";
import type { RuntimeConfig, WorkerEnv } from "./config";
import { normalizeGeminiCookieAccounts, RuntimeConfigError } from "./config";
import type {
	AdminLoginThrottle,
	GeminiRoutingStrategy,
	GeminiSessionBulkAction,
} from "./gemini/session-pool";
import {
	bulkUpdateGeminiSessionAccounts,
	checkAdminLoginThrottle,
	clearAdminLoginFailures,
	editGeminiSessionAccount,
	getGeminiSessionAccountLease,
	getGeminiSessionAdminSnapshot,
	importGeminiSessionAccounts,
	previewGeminiSessionAccountImport,
	recordAdminLoginFailure,
	reorderGeminiSessionAccounts,
	restoreGeminiSessionEnvironment,
	setGeminiSessionRoutingStrategy,
} from "./gemini/session-pool";
import { readJsonRequest, readRequestBodyBytes } from "./http/core/json";

const ADMIN_JSON_MAX_BYTES = 4 * 1024 * 1024;
const ADMIN_LOGIN_MAX_BYTES = 16 * 1024;
const ACCOUNT_ID_RE = /^[a-f0-9]{24}$/;

export async function handleAdminRequest(
	request: Request,
	env: WorkerEnv,
	cfg: RuntimeConfig,
): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	if (!cfg.admin_password) return new Response("Not Found", { status: 404 });

	if (path === "/admin/assets/admin.css")
		return adminAsset(request, ADMIN_CSS, "text/css; charset=utf-8");
	if (path === "/admin/assets/admin.js")
		return adminAsset(request, ADMIN_JS, "text/javascript; charset=utf-8");
	if (path === "/admin/assets/login.js")
		return adminAsset(
			request,
			ADMIN_LOGIN_JS,
			"text/javascript; charset=utf-8",
		);
	if (path === "/admin/login")
		return handleAdminLogin(
			request,
			url,
			env,
			cfg.admin_username,
			cfg.admin_password,
		);
	if (path === "/admin/logout") return handleAdminLogout(request, url);

	const authorized = await adminSessionAuthorized(
		request,
		cfg.admin_username,
		cfg.admin_password,
	);
	if (!authorized) {
		if (path === "/admin" || path === "/admin/")
			return adminRedirect("/admin/login");
		return adminJson({ error: "admin_session_required" }, 401);
	}

	if (path === "/admin" || path === "/admin/") {
		if (request.method !== "GET" && request.method !== "HEAD")
			return new Response("Method Not Allowed", { status: 405 });
		return adminPage(request.method === "HEAD" ? null : adminDashboardPage());
	}

	if (request.method !== "GET" && !sameOriginMutation(request, url))
		return adminJson({ error: "origin_mismatch" }, 403);

	try {
		if (path === "/admin/api/accounts" && request.method === "GET")
			return adminJson(await getGeminiSessionAdminSnapshot(cfg, env));
		if (path === "/admin/api/accounts" && request.method === "PATCH")
			return handleAccountAction(request, cfg, env);
		if (
			path === "/admin/api/accounts/import/preview" &&
			request.method === "POST"
		)
			return handleAccountImportPreview(request, cfg, env);
		if (path === "/admin/api/accounts/import" && request.method === "POST")
			return handleAccountImport(request, cfg, env);
		if (path === "/admin/api/accounts/test" && request.method === "POST")
			return handleAccountTest(request, cfg, env);
		if (path === "/admin/api/accounts/edit" && request.method === "POST")
			return handleAccountEdit(request, cfg, env);
		if (path === "/admin/api/accounts/bulk" && request.method === "POST")
			return handleBulkAction(request, cfg, env);
		if (path === "/admin/api/accounts/reorder" && request.method === "POST")
			return handleAccountReorder(request, cfg, env);
		if (path === "/admin/api/settings" && request.method === "PATCH")
			return handleSettingsUpdate(request, cfg, env);
		if (
			path === "/admin/api/configuration/restore" &&
			request.method === "POST"
		)
			return adminJson(await restoreGeminiSessionEnvironment(cfg, env));
	} catch (error) {
		if (error instanceof Error && error.message === "account_not_found")
			return adminJson({ error: "account_not_found" }, 404);
		if (error instanceof Error && error.message === "invalid_account_order")
			return adminJson({ error: "invalid_account_order" }, 400);
		if (error instanceof RuntimeConfigError)
			return adminJson({ error: "invalid_accounts" }, 400);
		throw error;
	}

	if (path.startsWith("/admin/api/"))
		return adminJson({ error: "method_not_allowed" }, 405);
	return adminJson({ error: "not_found" }, 404);
}

async function handleAdminLogin(
	request: Request,
	url: URL,
	env: WorkerEnv,
	username: string,
	password: string,
): Promise<Response> {
	const expectsJson = request.headers
		.get("accept")
		?.toLowerCase()
		.includes("application/json");
	if (request.method === "GET" || request.method === "HEAD") {
		if (await adminSessionAuthorized(request, username, password))
			return adminRedirect("/admin");
		return adminPage(request.method === "HEAD" ? null : adminLoginPage(false));
	}
	if (request.method !== "POST")
		return new Response("Method Not Allowed", { status: 405 });
	if (!sameOriginMutation(request, url))
		return expectsJson
			? adminJson({ error: "origin_mismatch" }, 403)
			: adminPage(adminLoginPage(false), 403);
	const clientKey = await adminLoginClientKey(request);
	let throttle: AdminLoginThrottle;
	try {
		throttle = await checkAdminLoginThrottle(env, clientKey);
	} catch (_) {
		return adminLoginUnavailable(expectsJson);
	}
	if (!throttle.allowed)
		return adminLoginThrottled(expectsJson, throttle.retry_after_seconds);
	const read = await readRequestBodyBytes(request, {
		maxBodyBytes: ADMIN_LOGIN_MAX_BYTES,
	});
	if (read.error !== undefined)
		return expectsJson
			? adminJson({ error: "invalid_login_request" }, read.status)
			: adminPage(adminLoginPage(false), read.status);
	const form = new URLSearchParams(new TextDecoder().decode(read.value));
	const providedUsername = form.get("username") || "";
	const provided = form.get("password") || "";
	if (
		!(await verifyAdminCredentials(
			providedUsername,
			provided,
			username,
			password,
		))
	) {
		try {
			throttle = await recordAdminLoginFailure(env, clientKey);
		} catch (_) {
			return adminLoginUnavailable(expectsJson);
		}
		if (!throttle.allowed)
			return adminLoginThrottled(expectsJson, throttle.retry_after_seconds);
		return expectsJson
			? adminJson({ error: "invalid_credentials" }, 401)
			: adminPage(adminLoginPage("用户名或密码不正确。"), 401);
	}
	try {
		await clearAdminLoginFailures(env, clientKey);
	} catch (_) {
		return adminLoginUnavailable(expectsJson);
	}
	const sessionCookie = await createAdminSessionCookie(username, password, url);
	if (expectsJson)
		return new Response(null, {
			status: 204,
			headers: {
				"Set-Cookie": sessionCookie,
				"Cache-Control": "no-store",
			},
		});
	return new Response(null, {
		status: 303,
		headers: {
			Location: "/admin",
			"Set-Cookie": sessionCookie,
			"Cache-Control": "no-store",
		},
	});
}

async function adminLoginClientKey(request: Request): Promise<string> {
	const forwarded =
		request.headers.get("cf-connecting-ip") ||
		request.headers.get("x-real-ip") ||
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
		"unknown-client";
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`web2gem-admin-login\0${forwarded}`),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	)
		.join("")
		.slice(0, 32);
}

function adminLoginThrottled(
	expectsJson: boolean | undefined,
	retryAfterSeconds: number,
): Response {
	const retryAfter = Math.max(1, Math.ceil(retryAfterSeconds));
	const headers = { "Retry-After": String(retryAfter) };
	if (expectsJson)
		return adminJson(
			{ error: "login_rate_limited", retry_after_seconds: retryAfter },
			429,
			headers,
		);
	return adminPage(
		adminLoginPage(`尝试次数过多，请在 ${retryAfter} 秒后重试。`),
		429,
		headers,
	);
}

function adminLoginUnavailable(expectsJson: boolean | undefined): Response {
	if (expectsJson)
		return adminJson({ error: "login_service_unavailable" }, 503);
	return adminPage(adminLoginPage("登录保护服务暂时不可用，请稍后重试。"), 503);
}

async function handleAccountImportPreview(
	request: Request,
	cfg: RuntimeConfig,
	env: WorkerEnv,
): Promise<Response> {
	const body = await adminJsonBody(request);
	if (body instanceof Response) return body;
	if (body.mode !== "append" && body.mode !== "replace")
		return adminJson({ error: "invalid_import_mode" }, 400);
	try {
		const accounts = normalizeGeminiCookieAccounts(
			body.accounts,
			"ADMIN_ACCOUNTS",
		);
		return adminJson(
			await previewGeminiSessionAccountImport(cfg, env, accounts, body.mode),
		);
	} catch (error) {
		if (error instanceof RuntimeConfigError)
			return adminJson(
				{ error: "invalid_accounts", message: error.reason },
				400,
			);
		throw error;
	}
}

async function handleAccountTest(
	request: Request,
	cfg: RuntimeConfig,
	env: WorkerEnv,
): Promise<Response> {
	const body = await adminJsonBody(request);
	if (body instanceof Response) return body;
	const accountId = validAccountId(body.account_id);
	if (!accountId) return adminJson({ error: "invalid_account_test" }, 400);
	const lease = await getGeminiSessionAccountLease(cfg, env, accountId);
	if (!lease) return adminJson({ error: "account_not_found" }, 404);
	return adminJson(await probeGeminiAccount(cfg, lease));
}

function handleAdminLogout(request: Request, url: URL): Response {
	if (request.method !== "POST")
		return new Response("Method Not Allowed", { status: 405 });
	if (!sameOriginMutation(request, url))
		return adminJson({ error: "origin_mismatch" }, 403);
	return new Response(null, {
		status: 303,
		headers: {
			Location: "/admin/login",
			"Set-Cookie": clearAdminSessionCookie(url),
			"Cache-Control": "no-store",
		},
	});
}

async function handleAccountAction(
	request: Request,
	cfg: RuntimeConfig,
	env: WorkerEnv,
): Promise<Response> {
	const body = await adminJsonBody(request);
	if (body instanceof Response) return body;
	const accountId = validAccountId(body.account_id);
	const action = validBulkAction(body.action, false);
	if (!accountId || !action)
		return adminJson({ error: "invalid_account_action" }, 400);
	return adminJson(
		await bulkUpdateGeminiSessionAccounts(cfg, env, [accountId], action),
	);
}

async function handleAccountImport(
	request: Request,
	cfg: RuntimeConfig,
	env: WorkerEnv,
): Promise<Response> {
	const body = await adminJsonBody(request);
	if (body instanceof Response) return body;
	if (body.mode !== "append" && body.mode !== "replace")
		return adminJson({ error: "invalid_import_mode" }, 400);
	const accounts = normalizeGeminiCookieAccounts(
		body.accounts,
		"ADMIN_ACCOUNTS",
	);
	return adminJson(
		await importGeminiSessionAccounts(cfg, env, accounts, body.mode),
	);
}

async function handleAccountEdit(
	request: Request,
	cfg: RuntimeConfig,
	env: WorkerEnv,
): Promise<Response> {
	const body = await adminJsonBody(request);
	if (body instanceof Response) return body;
	const accountId = validAccountId(body.account_id);
	const label = typeof body.label === "string" ? body.label.trim() : "";
	if (!accountId || !label || label.length > 120)
		return adminJson({ error: "invalid_account_edit" }, 400);
	const patch: { label: string; cookie?: string; sapisid?: string } = { label };
	if (body.cookie !== undefined) {
		if (typeof body.cookie !== "string" || !body.cookie.trim())
			return adminJson({ error: "invalid_account_edit" }, 400);
		const [normalized] = normalizeGeminiCookieAccounts(
			[
				{
					label,
					cookie: body.cookie,
					sapisid: body.sapisid,
				},
			],
			"ADMIN_ACCOUNT",
		);
		if (!normalized) return adminJson({ error: "invalid_account_edit" }, 400);
		patch.cookie = normalized.cookie;
		patch.sapisid = normalized.sapisid;
	} else if (body.sapisid !== undefined) {
		if (typeof body.sapisid !== "string" || body.sapisid.length > 4096)
			return adminJson({ error: "invalid_account_edit" }, 400);
		patch.sapisid = body.sapisid;
	}
	return adminJson(await editGeminiSessionAccount(cfg, env, accountId, patch));
}

async function handleBulkAction(
	request: Request,
	cfg: RuntimeConfig,
	env: WorkerEnv,
): Promise<Response> {
	const body = await adminJsonBody(request);
	if (body instanceof Response) return body;
	const accountIds = validAccountIds(body.account_ids);
	const action = validBulkAction(body.action, true);
	if (!accountIds || !action)
		return adminJson({ error: "invalid_bulk_action" }, 400);
	return adminJson(
		await bulkUpdateGeminiSessionAccounts(cfg, env, accountIds, action),
	);
}

async function handleSettingsUpdate(
	request: Request,
	cfg: RuntimeConfig,
	env: WorkerEnv,
): Promise<Response> {
	const body = await adminJsonBody(request);
	if (body instanceof Response) return body;
	const strategy = body.routing_strategy;
	if (!isRoutingStrategy(strategy))
		return adminJson({ error: "invalid_routing_strategy" }, 400);
	return adminJson(await setGeminiSessionRoutingStrategy(cfg, env, strategy));
}

async function handleAccountReorder(
	request: Request,
	cfg: RuntimeConfig,
	env: WorkerEnv,
): Promise<Response> {
	const body = await adminJsonBody(request);
	if (body instanceof Response) return body;
	const accountIds = validAccountIds(body.account_ids);
	if (!accountIds) return adminJson({ error: "invalid_account_order" }, 400);
	return adminJson(await reorderGeminiSessionAccounts(cfg, env, accountIds));
}

async function adminJsonBody(
	request: Request,
): Promise<Record<string, unknown> | Response> {
	const parsed = await readJsonRequest(request, {
		maxBodyBytes: ADMIN_JSON_MAX_BYTES,
	});
	if (parsed.error !== undefined)
		return adminJson(
			{ error: parsed.status === 413 ? "request_too_large" : "invalid_json" },
			parsed.status,
		);
	return parsed.value;
}

function validAccountId(value: unknown): string | null {
	return typeof value === "string" && ACCOUNT_ID_RE.test(value) ? value : null;
}

function validAccountIds(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length < 1 || value.length > 100)
		return null;
	const ids = value.map(validAccountId);
	if (ids.some((id) => !id)) return null;
	const normalized = ids as string[];
	return new Set(normalized).size === normalized.length ? normalized : null;
}

function validBulkAction(
	value: unknown,
	allowDelete: boolean,
): GeminiSessionBulkAction | null {
	if (value === "enable" || value === "disable" || value === "reset")
		return value;
	return allowDelete && value === "delete" ? value : null;
}

function isRoutingStrategy(value: unknown): value is GeminiRoutingStrategy {
	return (
		value === "round_robin" || value === "priority" || value === "least_used"
	);
}

function sameOriginMutation(request: Request, url: URL): boolean {
	const origin = request.headers.get("origin");
	if (origin && origin !== url.origin) return false;
	const fetchSite = request.headers.get("sec-fetch-site");
	return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

function adminAsset(
	request: Request,
	body: string,
	contentType: string,
): Response {
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response("Method Not Allowed", { status: 405 });
	return new Response(request.method === "HEAD" ? null : body, {
		headers: {
			"Content-Type": contentType,
			"Cache-Control": "public, max-age=3600",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

function adminPage(
	body: string | null,
	status = 200,
	extraHeaders: HeadersInit = {},
): Response {
	return new Response(body, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy":
				"default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			...Object.fromEntries(new Headers(extraHeaders)),
		},
	});
}

function adminRedirect(location: string): Response {
	return new Response(null, {
		status: 303,
		headers: { Location: location, "Cache-Control": "no-store" },
	});
}

function adminJson(
	body: unknown,
	status = 200,
	extraHeaders: HeadersInit = {},
): Response {
	return Response.json(body, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
			"X-Content-Type-Options": "nosniff",
			...Object.fromEntries(new Headers(extraHeaders)),
		},
	});
}
