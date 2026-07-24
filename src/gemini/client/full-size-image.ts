import type { RuntimeConfig } from "../../config";
import { errorLogSummary } from "../../shared/errors";
import { log } from "../../shared/logging";
import { getPageTokensForConfig } from "../uploads";
import type { GeminiAppPageTokens } from "../app-page";
import { GEMINI_WEB_USER_AGENT } from "../constants";
import { httpFetch } from "../transport";
import type { GeminiParsedImage } from "./parser";

/** Google RPC id for full-size generated image lookup (Gemini-API GRPC.GET_FULL_SIZE_IMAGE). */
export const GET_FULL_SIZE_IMAGE_RPCID = "c8o8Fe";

const BATCH_EXECUTE_PATH = "/_/BardChatUi/data/batchexecute";
/** Live Gemini web "Download full size" first-hop transform (`/gg/…=s0-d-I?alr=yes`). */
const FULL_SIZE_DOWNLOAD_SUFFIX = "=s0-d-I?alr=yes";
/** Older HAR / Gemini-API transform; still probed after `=s0-d-I`. */
const FULL_SIZE_DOWNLOAD_LEGACY_SUFFIX = "=d-I?alr=yes";
const FULL_SIZE_RESOLVE_ATTEMPTS = 2;
const FULL_SIZE_RETRY_DELAY_MS = 500;
const FULL_SIZE_REDIRECT_HOPS = 4;

export type FullSizeImageRefs = {
	cid: string;
	rid: string;
	rcid: string;
	imageId: string;
	mediaToken?: string;
	mediaId?: string;
};

/** Mode 19 = download existing; mode 20 = web 4K / upscale complaintflow. */
export type FullSizeResolveMode = 19 | 20;

export type FullSizeResolveOptions = {
	mode?: FullSizeResolveMode;
	/** User / upscale prompt for mode 20. */
	upscalePrompt?: string;
};

export function fullSizeImageRefsFromParsed(
	image: GeminiParsedImage,
): FullSizeImageRefs | null {
	const cid = String(image.cid || "").trim();
	const rid = String(image.rid || "").trim();
	const rcid = String(image.rcid || "").trim();
	const imageId = String(image.imageId || "").trim();
	if (!cid || !rid || !rcid || !imageId) return null;
	// Gemini web download uses synthetic image_generation_content/* ids with
	// real cid/rid/rcid (confirmed via HAR). Do not skip them.
	const refs: FullSizeImageRefs = { cid, rid, rcid, imageId };
	const mediaToken = String(image.mediaToken || "").trim();
	const mediaId = String(image.mediaId || "").trim();
	if (mediaToken) refs.mediaToken = mediaToken;
	if (mediaId) refs.mediaId = mediaId;
	return refs;
}

/**
 * Build first-hop URLs for the full-size download chain.
 * Prefer `=s0-d-I?alr=yes` (live web Download full size); then legacy `=d-I`.
 * Plain `?alr=yes` on `/gg/` often returns a small `image/*` body instead of
 * the text redirect to `/rd-gg/`.
 */
export function fullSizeDownloadProbeUrls(originalUrl: string): string[] {
	const base = String(originalUrl || "").trim();
	if (!base) return [];
	const out: string[] = [];
	const push = (candidate: string) => {
		if (!candidate || out.includes(candidate)) return;
		out.push(candidate);
	};

	const withAlr = (url: string): string => {
		try {
			const parsed = new URL(url);
			if (parsed.searchParams.get("alr") !== "yes") {
				parsed.searchParams.set("alr", "yes");
			}
			return parsed.toString();
		} catch {
			return url.includes("?") ? `${url}&alr=yes` : `${url}?alr=yes`;
		}
	};

	for (const transform of fullSizeDownloadTransformUrls(base)) {
		push(transform);
	}
	push(withAlr(base));
	const rdGg = rewriteGoogleusercontentGgToRdGg(base);
	if (rdGg) {
		for (const transform of fullSizeDownloadTransformUrls(rdGg)) {
			push(transform);
		}
		push(withAlr(rdGg));
	}
	return out;
}

/** Append `=s0-d-I?alr=yes` (primary web download transform). */
export function fullSizeDownloadTransformUrl(url: string): string | null {
	return appendDownloadSuffix(url, FULL_SIZE_DOWNLOAD_SUFFIX);
}

/** Primary + legacy download transforms for probe / redirect hops. */
export function fullSizeDownloadTransformUrls(url: string): string[] {
	const out: string[] = [];
	const primary = appendDownloadSuffix(url, FULL_SIZE_DOWNLOAD_SUFFIX);
	if (primary) out.push(primary);
	const legacy = appendDownloadSuffix(url, FULL_SIZE_DOWNLOAD_LEGACY_SUFFIX);
	if (legacy) out.push(legacy);
	return out;
}

function appendDownloadSuffix(url: string, suffix: string): string | null {
	const trimmed = String(url || "").trim();
	if (!trimmed || hasFullSizeDownloadTransform(trimmed)) return null;
	try {
		const parsed = new URL(trimmed);
		parsed.search = "";
		parsed.hash = "";
		return `${parsed.toString().replace(/\/$/, "")}${suffix}`;
	} catch {
		return `${trimmed.replace(/[?#].*$/, "")}${suffix}`;
	}
}

function hasFullSizeDownloadTransform(url: string): boolean {
	return /=s0-d-I(?:\?|$)/i.test(url) || /=d-I(?:\?|$)/i.test(url);
}

/** `/gg/` → `/rd-gg/` for the web download hop that serves the large asset. */
export function rewriteGoogleusercontentGgToRdGg(url: string): string | null {
	const trimmed = String(url || "").trim();
	if (!trimmed || trimmed.includes("/rd-gg/") || !trimmed.includes("/gg/")) {
		return null;
	}
	try {
		const parsed = new URL(trimmed);
		if (
			!parsed.pathname.includes("/gg/") ||
			parsed.pathname.includes("/rd-gg/")
		) {
			return null;
		}
		parsed.pathname = parsed.pathname.replace(/\/gg\//, "/rd-gg/");
		return parsed.toString();
	} catch {
		return trimmed.replace("/gg/", "/rd-gg/");
	}
}

/** Default prompt mirroring web 4K download when the caller has no richer text. */
export const DEFAULT_FULL_SIZE_UPSCALE_PROMPT =
	"Upscale this image to true 4K ultra-high resolution based on <IMAGE_0>. " +
	"Keep the exact same composition, subject, colors, and lighting. " +
	"Only increase resolution and fine detail — no crop, no restyle, no extra objects.";

export function buildFullSizeUpscalePrompt(userPrompt?: string): string {
	const stripped = String(userPrompt || "")
		.replace(/IMAGE GENERATION ENABLED:[\s\S]*/i, "")
		.replace(/Image generation was explicitly requested\.[\s\S]*/i, "")
		.trim();
	if (!stripped) return DEFAULT_FULL_SIZE_UPSCALE_PROMPT;
	if (/4k|upscale|ultra.?high|3840|high.?res|超清|高清/i.test(stripped)) {
		return stripped.length >= 40
			? stripped
			: `${stripped}\n\n${DEFAULT_FULL_SIZE_UPSCALE_PROMPT}`;
	}
	return `${stripped}\n\n${DEFAULT_FULL_SIZE_UPSCALE_PROMPT}`;
}

/**
 * Build c8o8Fe RPC payload. Mode 20 matches the Gemini web 4K download HAR
 * (`imagen_default.complaintflow` + upscale prompt).
 */
export function buildFullSizeImageRpcPayload(
	refs: FullSizeImageRefs,
	options: FullSizeResolveOptions = {},
): unknown[] {
	const mode: FullSizeResolveMode = options.mode === 20 ? 20 : 19;
	const mediaToken = String(refs.mediaToken || "");
	const mediaId = String(refs.mediaId || "");

	if (mode === 20) {
		// Live "Download full size" sends mode 20 with an empty prompt.
		// Only inject an upscale prompt when the caller explicitly provides one
		// (userscript-style re-upscale); auto-filling breaks the unlock path.
		const prompt =
			typeof options.upscalePrompt === "string" ? options.upscalePrompt : "";
		const modeBlock: unknown[] = [
			20,
			prompt,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			1,
			null,
			"imagen_default.complaintflow",
		];
		return [
			[
				[null, null, null, [null, null, null, null, null, mediaToken]],
				[refs.imageId, 0],
				null,
				modeBlock,
				null,
				null,
				null,
				null,
				null,
				mediaId,
			],
			[refs.rid, refs.rcid, refs.cid, null, mediaId],
			1,
			0,
			1,
		];
	}

	return [
		[
			[null, null, null, [null, null, null, null, null, ""]],
			[refs.imageId, 0],
			null,
			[19, ""],
			null,
			null,
			null,
			null,
			null,
			"",
		],
		[refs.rid, refs.rcid, refs.cid, null, ""],
		1,
		0,
		1,
	];
}

/**
 * Resolve a downloadable full-size image URL via batchexecute +
 * `=s0-d-I?alr=yes` redirect chain (web Download full size), with legacy
 * `=d-I?alr=yes` / plain `?alr=yes` fallbacks.
 * Returns null when cookie/session metadata is incomplete or upstream fails.
 */
export async function resolveFullSizeGeneratedImageUrl(
	cfg: RuntimeConfig,
	activeCfg: RuntimeConfig,
	image: GeminiParsedImage,
	options: FullSizeResolveOptions = {},
): Promise<string | null> {
	if (!activeCfg.cookie) return null;
	const refs = fullSizeImageRefsFromParsed(image);
	if (!refs) return null;

	try {
		const mode: FullSizeResolveMode = options.mode === 20 ? 20 : 19;
		if (mode === 20 && !refs.mediaToken) {
			log(cfg, "full-size image skipped reason=missing_media_token mode=20");
			return null;
		}

		const tokens = await getPageTokensForConfig(activeCfg);
		if (!tokens.at) {
			log(cfg, "full-size image skipped reason=missing_page_at_token");
			return null;
		}

		let lastErr: unknown = null;
		for (let attempt = 0; attempt < FULL_SIZE_RESOLVE_ATTEMPTS; attempt++) {
			try {
				const originalUrl = await fetchFullSizeImageRpcUrl(
					activeCfg,
					tokens,
					refs,
					{ ...options, mode },
				);
				if (!originalUrl) {
					lastErr = new Error(
						`batchexecute returned empty full-size url mode=${mode}`,
					);
				} else {
					const downloadUrl = await followFullSizeDownloadChain(
						cfg,
						activeCfg,
						originalUrl,
					);
					if (downloadUrl) return downloadUrl;
					lastErr = new Error(
						`full-size download chain returned no url mode=${mode}`,
					);
				}
			} catch (e) {
				lastErr = e;
			}
			if (attempt + 1 < FULL_SIZE_RESOLVE_ATTEMPTS) {
				await sleep(FULL_SIZE_RETRY_DELAY_MS * (attempt + 1));
			}
		}
		log(
			cfg,
			`full-size image resolve failed mode=${mode} ${errorLogSummary(lastErr)}`,
		);
		return null;
	} catch (e) {
		log(cfg, `full-size image resolve errored ${errorLogSummary(e)}`);
		return null;
	}
}

async function fetchFullSizeImageRpcUrl(
	activeCfg: RuntimeConfig,
	tokens: GeminiAppPageTokens,
	refs: FullSizeImageRefs,
	options: FullSizeResolveOptions,
): Promise<string | null> {
	const payload = buildFullSizeImageRpcPayload(refs, options);
	const responseText = await batchexecute(activeCfg, tokens, refs, [
		{
			rpcid: GET_FULL_SIZE_IMAGE_RPCID,
			payload: JSON.stringify(payload),
			identifier: "generic",
		},
	]);
	const frames = extractBatchExecuteFrames(responseText);
	const first = Array.isArray(frames) ? frames[0] : null;
	if (!Array.isArray(first)) return null;
	const encoded = first[2];
	if (typeof encoded !== "string" || !encoded) return null;
	let inner: unknown;
	try {
		inner = JSON.parse(encoded);
	} catch {
		return null;
	}
	const url = Array.isArray(inner) ? inner[0] : null;
	return typeof url === "string" && url.startsWith("http") ? url : null;
}

async function followFullSizeDownloadChain(
	cfg: RuntimeConfig,
	activeCfg: RuntimeConfig,
	originalUrl: string,
): Promise<string | null> {
	const headers = fullSizeFetchHeaders(activeCfg);
	for (const probe of fullSizeDownloadProbeUrls(originalUrl)) {
		const resolved = await resolveDownloadRedirectChain(cfg, probe, headers);
		if (resolved) return resolved;
	}
	return null;
}

/**
 * Follow text-URL redirect hops used by Gemini web download
 * (`/gg/...?alr=yes` → `/rd-gg/...?alr=yes` → final image URL).
 */
async function resolveDownloadRedirectChain(
	cfg: RuntimeConfig,
	startUrl: string,
	headers: Record<string, string>,
): Promise<string | null> {
	let current = startUrl;
	/** `/gg/` may return a small image; keep it if `/rd-gg/` then fails. */
	let fallbackImageUrl: string | null = null;
	for (let hop = 0; hop < FULL_SIZE_REDIRECT_HOPS; hop++) {
		const resp = await httpFetch(current, {
			method: "GET",
			headers,
			timeoutMs: cfg.request_timeout_sec * 1000,
			socket: false,
			cfg,
		});
		if (!resp.ok) {
			return fallbackImageUrl;
		}

		const contentType = String(
			resp.headers.get("content-type") || "",
		).toLowerCase();
		if (contentType.includes("image/")) {
			// Prefer download transforms before accepting a small `/gg/` preview.
			const downloadTransform = fullSizeDownloadTransformUrls(current)[0];
			if (downloadTransform && downloadTransform !== current) {
				fallbackImageUrl = fallbackImageUrl || current;
				current = downloadTransform;
				continue;
			}
			// `/gg/?alr=yes` can return a small preview image directly; web download
			// continues to `/rd-gg/` for the multi-MB asset.
			const rdGg = rewriteGoogleusercontentGgToRdGg(current);
			if (rdGg && rdGg !== current) {
				fallbackImageUrl = fallbackImageUrl || current;
				current = rdGg;
				continue;
			}
			return current;
		}

		const text = (await resp.text()).trim();
		if (!text) return fallbackImageUrl;

		// Some hops return the next URL as a bare text body.
		const next = firstHttpUrlInText(text);
		if (next) {
			if (next === current) return current;
			current = next;
			continue;
		}

		// Defensive: treat obvious image magic as a terminal hop.
		if (looksLikeImageBytes(text)) {
			const downloadTransform = fullSizeDownloadTransformUrls(current)[0];
			if (downloadTransform && downloadTransform !== current) {
				fallbackImageUrl = fallbackImageUrl || current;
				current = downloadTransform;
				continue;
			}
			const rdGg = rewriteGoogleusercontentGgToRdGg(current);
			if (rdGg && rdGg !== current) {
				fallbackImageUrl = fallbackImageUrl || current;
				current = rdGg;
				continue;
			}
			return current;
		}
		return fallbackImageUrl;
	}
	return fallbackImageUrl || current;
}

type BatchRpcCall = {
	rpcid: string;
	payload: string;
	identifier?: string;
};

async function batchexecute(
	activeCfg: RuntimeConfig,
	tokens: GeminiAppPageTokens,
	refs: FullSizeImageRefs,
	calls: BatchRpcCall[],
): Promise<string> {
	const origin = (
		activeCfg.gemini_origin || "https://gemini.google.com"
	).replace(/\/$/, "");
	const reqid = String(Math.floor(Date.now() / 1000) % 1_000_000);
	const sourcePath = fullSizeSourcePath(refs.cid);
	const params = new URLSearchParams({
		rpcids: calls.map((call) => call.rpcid).join(","),
		hl: "en",
		_reqid: reqid,
		rt: "c",
		"source-path": sourcePath,
	});
	if (activeCfg.gemini_bl) params.set("bl", activeCfg.gemini_bl);
	if (tokens.sid) params.set("f.sid", tokens.sid);

	const body = new URLSearchParams({
		at: String(tokens.at || ""),
		"f.req": JSON.stringify([
			calls.map((call) => [
				call.rpcid,
				call.payload,
				null,
				call.identifier || "generic",
			]),
		]),
	});

	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
		Origin: "https://gemini.google.com",
		Referer: "https://gemini.google.com/",
		"X-Same-Domain": "1",
		"User-Agent": GEMINI_WEB_USER_AGENT,
		"Accept-Language": "en-US,en;q=0.9",
		"x-goog-ext-525001261-jspb": "[1,null,null,null,null,null,null,null,[4]]",
		"x-goog-ext-73010989-jspb": "[0]",
	};
	if (activeCfg.cookie) headers.Cookie = activeCfg.cookie;

	const resp = await httpFetch(`${origin}${BATCH_EXECUTE_PATH}?${params}`, {
		method: "POST",
		headers,
		body: body.toString(),
		timeoutMs: activeCfg.request_timeout_sec * 1000,
		socket: false,
		cfg: activeCfg,
	});
	const text = await resp.text();
	if (!resp.ok) {
		throw new Error(`batchexecute HTTP ${resp.status}`);
	}
	return text;
}

/** Match web download: `/app/<cid without leading c_>`. */
export function fullSizeSourcePath(cid: string): string {
	const trimmed = String(cid || "").trim();
	if (!trimmed) return "/app";
	const withoutPrefix = trimmed.startsWith("c_") ? trimmed.slice(2) : trimmed;
	return `/app/${withoutPrefix}`;
}

export function extractBatchExecuteFrames(text: string): unknown[] {
	let content = String(text || "");
	if (content.startsWith(")]}'")) content = content.slice(4);
	content = content.trim();
	if (!content) return [];

	const framed = parseLengthPrefixedJsonFrames(content);
	if (framed.length) return framed;

	try {
		const parsed: unknown = JSON.parse(content);
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		// fall through to NDJSON
	}

	const out: unknown[] = [];
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || /^\d+$/.test(trimmed)) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (Array.isArray(parsed)) out.push(...parsed);
			else out.push(parsed);
		} catch {
			// ignore non-json lines
		}
	}
	return out;
}

function parseLengthPrefixedJsonFrames(content: string): unknown[] {
	const out: unknown[] = [];
	let offset = 0;
	while (offset < content.length) {
		while (offset < content.length && /\s/.test(content[offset] || ""))
			offset += 1;
		if (offset >= content.length) break;
		const match = content.slice(offset).match(/^(\d+)/);
		if (!match) break;
		const marker = match[1] || "";
		const length = Number.parseInt(marker, 10);
		const start = offset + marker.length;
		if (!Number.isFinite(length) || length < 0) break;
		const { end, units } = sliceByUtf16Units(content, start, length);
		if (units < length) break;
		const chunk = content.slice(start, end).trim();
		offset = end;
		if (!chunk) continue;
		try {
			const parsed: unknown = JSON.parse(chunk);
			if (Array.isArray(parsed)) out.push(...parsed);
			else out.push(parsed);
		} catch {
			// skip bad frame
		}
	}
	return out;
}

function sliceByUtf16Units(
	text: string,
	start: number,
	unitCount: number,
): { end: number; units: number } {
	let units = 0;
	let index = start;
	while (index < text.length && units < unitCount) {
		const code = text.charCodeAt(index);
		units += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
		index += 1;
	}
	return { end: index, units };
}

function fullSizeFetchHeaders(cfg: RuntimeConfig): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "*/*",
		"Accept-Language": "en-US,en;q=0.9",
		Origin: "https://gemini.google.com",
		Referer: "https://gemini.google.com/",
		"User-Agent": GEMINI_WEB_USER_AGENT,
	};
	if (cfg.cookie) headers.Cookie = cfg.cookie;
	return headers;
}

function firstHttpUrlInText(value: string): string | null {
	const trimmed = value.trim();
	if (looksLikeHttpUrl(trimmed) && !/\s/.test(trimmed)) return trimmed;
	const match = trimmed.match(/https?:\/\/\S+/i);
	return match ? match[0] : null;
}

function looksLikeHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value.trim());
}

function looksLikeImageBytes(value: string): boolean {
	// Response.text() may mangle binary; only use as a weak fallback.
	return (
		value.startsWith("\x89PNG") ||
		value.startsWith("\xff\xd8") ||
		value.startsWith("GIF8") ||
		value.startsWith("RIFF")
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
