const ADMIN_SESSION_COOKIE = "web2gem_admin_session";
const ADMIN_SESSION_VERSION = "v1";
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_SESSION_CLOCK_SKEW_MS = 60 * 1000;
const TEXT_ENCODER = new TextEncoder();

export async function verifyAdminCredentials(
	providedUsername: string,
	providedPassword: string,
	expectedUsername: string,
	expectedPassword: string,
): Promise<boolean> {
	if (!expectedUsername || !expectedPassword) return false;
	const expected = credentialPayload(expectedUsername, expectedPassword);
	const provided = credentialPayload(providedUsername, providedPassword);
	const key = await importHmacKey(`web2gem-admin-credentials\0${expected}`);
	const expectedSignature = await crypto.subtle.sign(
		"HMAC",
		key,
		TEXT_ENCODER.encode(expected),
	);
	return crypto.subtle.verify(
		"HMAC",
		key,
		expectedSignature,
		TEXT_ENCODER.encode(provided),
	);
}

export async function createAdminSessionCookie(
	username: string,
	password: string,
	url: URL,
	now = Date.now(),
): Promise<string> {
	const issuedAt = Math.floor(now / 1000);
	const expiresAt = Math.floor((now + ADMIN_SESSION_TTL_MS) / 1000);
	const nonce = base64UrlEncode(randomBytes(16));
	const payload = `${ADMIN_SESSION_VERSION}.${issuedAt}.${expiresAt}.${nonce}`;
	const key = await sessionKey(username, password);
	const signature = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(payload)),
	);
	return serializeSessionCookie(
		`${payload}.${base64UrlEncode(signature)}`,
		url,
		Math.floor(ADMIN_SESSION_TTL_MS / 1000),
	);
}

export function clearAdminSessionCookie(url: URL): string {
	return serializeSessionCookie("", url, 0);
}

export async function adminSessionAuthorized(
	request: Request,
	username: string,
	password: string,
	now = Date.now(),
): Promise<boolean> {
	if (!username || !password) return false;
	const token = requestCookie(request, ADMIN_SESSION_COOKIE);
	if (!token) return false;
	const match =
		/^(v1)\.(\d{10})\.(\d{10})\.([A-Za-z0-9_-]{20,32})\.([A-Za-z0-9_-]{40,48})$/.exec(
			token,
		);
	if (!match) return false;
	const issuedAt = Number(match[2]) * 1000;
	const expiresAt = Number(match[3]) * 1000;
	if (
		!Number.isSafeInteger(issuedAt) ||
		!Number.isSafeInteger(expiresAt) ||
		issuedAt > now + ADMIN_SESSION_CLOCK_SKEW_MS ||
		expiresAt <= now ||
		expiresAt - issuedAt > ADMIN_SESSION_TTL_MS + ADMIN_SESSION_CLOCK_SKEW_MS
	)
		return false;
	let signature: Uint8Array;
	try {
		signature = base64UrlDecode(match[5] || "");
	} catch (_) {
		return false;
	}
	const payload = match.slice(1, 5).join(".");
	const key = await sessionKey(username, password);
	return crypto.subtle.verify(
		"HMAC",
		key,
		signature,
		TEXT_ENCODER.encode(payload),
	);
}

function sessionKey(username: string, password: string): Promise<CryptoKey> {
	return importHmacKey(
		`web2gem-admin-session\0${credentialPayload(username, password)}`,
	);
}

function credentialPayload(username: string, password: string): string {
	return `${username.length}:${username}\0${password}`;
}

function importHmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		TEXT_ENCODER.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

function serializeSessionCookie(
	value: string,
	url: URL,
	maxAge: number,
): string {
	const attributes = [
		`${ADMIN_SESSION_COOKIE}=${value}`,
		"Path=/admin",
		"HttpOnly",
		"SameSite=Strict",
		`Max-Age=${maxAge}`,
		"Priority=High",
	];
	if (url.protocol === "https:") attributes.push("Secure");
	return attributes.join("; ");
}

function requestCookie(request: Request, name: string): string {
	const header = request.headers.get("cookie") || "";
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
		return part.slice(separator + 1).trim();
	}
	return "";
}

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
	const standard = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
