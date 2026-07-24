import type { RuntimeConfig } from "../../config";
import { errorLogSummary } from "../../shared/errors";
import { log } from "../../shared/logging";
import { getPageTokensForConfig } from "../uploads";
import type { GeminiAppPageTokens } from "../app-page";
import { GEMINI_WEB_USER_AGENT } from "../constants";
import { httpFetch } from "../transport";
import {
	extractBatchExecuteFrames,
	fullSizeSourcePath,
} from "./full-size-image";
import {
	collectGeneratedImagesFromTree,
	type GeminiParsedImage,
} from "./parser";

/** Conversation history RPC — returns generated-image `$AV` mediaTokens. */
export const CONVERSATION_HISTORY_RPCID = "hNvQHb";

const BATCH_EXECUTE_PATH = "/_/BardChatUi/data/batchexecute";
const HISTORY_PAGE_SIZE = 10;
const HISTORY_RESOLVE_ATTEMPTS = 2;
const HISTORY_RETRY_DELAY_MS = 800;
const HISTORY_INITIAL_DELAY_MS = 800;

/**
 * Normalize to the `c_<id>` form used by hNvQHb (web HAR / gargantua).
 */
export function normalizeConversationId(cid: string): string {
	const trimmed = String(cid || "").trim();
	if (!trimmed) return "";
	if (trimmed.startsWith("c_")) return trimmed;
	return `c_${trimmed}`;
}

/** Payload: `["c_<cid>", 10, null, 1, [0], [4], null, 1]` (first page). */
export function buildConversationHistoryRpcPayload(
	cid: string,
	pageSize = HISTORY_PAGE_SIZE,
): unknown[] {
	const conversationId = normalizeConversationId(cid);
	return [conversationId, pageSize, null, 1, [0], [4], null, 1];
}

/**
 * Parse hNvQHb batchexecute text into generated images (with mediaToken when present).
 */
export function extractGeneratedImagesFromConversationHistory(
	responseText: string,
): GeminiParsedImage[] {
	const frames = extractBatchExecuteFrames(responseText);
	const out: GeminiParsedImage[] = [];
	for (const frame of frames) {
		if (!Array.isArray(frame)) continue;
		if (frame[0] === "wrb.fr" && frame[1] !== CONVERSATION_HISTORY_RPCID) {
			// Prefer hNvQHb frames; still accept null rpc id in tests.
			if (frame[1] != null && frame[1] !== "") continue;
		}
		const encoded = frame[2];
		if (typeof encoded !== "string" || !encoded) continue;
		let inner: unknown;
		try {
			inner = JSON.parse(encoded);
		} catch {
			continue;
		}
		out.push(...collectGeneratedImagesFromTree(inner));
	}
	return dedupeByImageKey(out);
}

/**
 * Copy mediaToken / mediaId / canonical imageId from history onto StreamGenerate images.
 * StreamGenerate often uses synthetic `image_generation_content/0` ids and different
 * preview URLs than hNvQHb, so fall back to newest same-conversation history assets.
 */
export function mergeConversationHistoryMediaIntoImages(
	images: GeminiParsedImage[],
	historyImages: GeminiParsedImage[],
): GeminiParsedImage[] {
	if (!images.length || !historyImages.length) return images;

	const tokenizedHistory = historyImages.filter((image) =>
		String(image.mediaToken || "").trim(),
	);
	if (!tokenizedHistory.length) return images;

	const byId = new Map<string, GeminiParsedImage>();
	const byUrl = new Map<string, GeminiParsedImage>();
	for (const hist of tokenizedHistory) {
		if (hist.imageId) byId.set(hist.imageId, hist);
		const urlKey = imageUrlMatchKey(hist.url);
		if (urlKey) byUrl.set(urlKey, hist);
	}

	const usedHistory = new Set<GeminiParsedImage>();
	// Newest-first unused pool for positional fallback.
	const newestUnused = (): GeminiParsedImage | undefined => {
		for (let i = tokenizedHistory.length - 1; i >= 0; i--) {
			const candidate = tokenizedHistory[i];
			if (!candidate || usedHistory.has(candidate)) continue;
			return candidate;
		}
		return undefined;
	};

	return images.map((image) => {
		if (image.source !== "generated") return image;
		if (image.mediaToken) return image;

		let match =
			(image.imageId ? byId.get(image.imageId) : undefined) ||
			byUrl.get(imageUrlMatchKey(image.url)) ||
			undefined;
		if (match && usedHistory.has(match)) match = undefined;
		if (!match) match = newestUnused();
		if (!match?.mediaToken) return image;

		usedHistory.add(match);
		const next: GeminiParsedImage = {
			...image,
			mediaToken: match.mediaToken,
		};
		if (match.mediaId && !next.mediaId) next.mediaId = match.mediaId;
		// Mode 20 needs history imageId / reply ids, not StreamGenerate synthetics.
		if (match.imageId) next.imageId = match.imageId;
		if (match.cid && !next.cid) next.cid = match.cid;
		if (match.rid) next.rid = match.rid;
		if (match.rcid) next.rcid = match.rcid;
		return next;
	});
}

/**
 * After StreamGenerate, reload conversation history so mode-20 can use real `$AV` tokens.
 */
export async function enrichGeneratedImagesWithConversationHistory(
	cfg: RuntimeConfig,
	activeCfg: RuntimeConfig,
	images: GeminiParsedImage[],
): Promise<GeminiParsedImage[]> {
	if (!activeCfg.cookie) return images;
	const needing = images.filter(
		(image) =>
			image.source === "generated" &&
			!String(image.mediaToken || "").trim() &&
			String(image.cid || "").trim(),
	);
	if (!needing.length) return images;

	const cids = [
		...new Set(needing.map((image) => String(image.cid || "").trim())),
	];
	let enriched = images;
	for (const cid of cids) {
		try {
			const historyImages = await fetchConversationHistoryGeneratedImages(
				cfg,
				activeCfg,
				cid,
			);
			if (!historyImages.length) continue;
			enriched = mergeConversationHistoryMediaIntoImages(
				enriched,
				historyImages,
			);
			const stillNeeding = enriched.filter(
				(image) =>
					image.source === "generated" &&
					String(image.cid || "").trim() === cid &&
					!String(image.mediaToken || "").trim(),
			).length;
			const withToken = enriched.filter(
				(image) =>
					image.source === "generated" &&
					String(image.cid || "").trim() === cid &&
					String(image.mediaToken || "").trim(),
			).length;
			log(
				cfg,
				`conversation history media tokens needed=${needing.filter((i) => i.cid === cid).length} with_token=${withToken} still_needing=${stillNeeding}`,
			);
		} catch (e) {
			log(cfg, `conversation history enrich failed ${errorLogSummary(e)}`);
		}
	}
	return enriched;
}

export async function fetchConversationHistoryGeneratedImages(
	cfg: RuntimeConfig,
	activeCfg: RuntimeConfig,
	cid: string,
): Promise<GeminiParsedImage[]> {
	const conversationId = normalizeConversationId(cid);
	if (!conversationId || !activeCfg.cookie) return [];

	try {
		const tokens = await getPageTokensForConfig(activeCfg);
		if (!tokens.at) {
			log(cfg, "conversation history skipped reason=missing_page_at_token");
			return [];
		}

		let lastErr: unknown = null;
		let lastImages: GeminiParsedImage[] = [];
		for (let attempt = 0; attempt < HISTORY_RESOLVE_ATTEMPTS; attempt++) {
			if (attempt === 0 && HISTORY_INITIAL_DELAY_MS > 0) {
				// Fresh StreamGenerate assets often need a beat before hNvQHb
				// exposes `$AV` mediaToken.
				await sleep(HISTORY_INITIAL_DELAY_MS);
			}
			try {
				const responseText = await batchexecuteHistory(
					activeCfg,
					tokens,
					conversationId,
				);
				lastImages =
					extractGeneratedImagesFromConversationHistory(responseText);
				const withToken = lastImages.filter((image) =>
					String(image.mediaToken || "").trim(),
				);
				// Fresh generations may land in history slightly after StreamGenerate.
				if (withToken.length) return lastImages;
				lastErr = new Error("hNvQHb returned no mediaToken images yet");
			} catch (e) {
				lastErr = e;
			}
			if (attempt + 1 < HISTORY_RESOLVE_ATTEMPTS) {
				await sleep(HISTORY_RETRY_DELAY_MS * (attempt + 1));
			}
		}
		if (lastImages.length) return lastImages;
		log(cfg, `conversation history resolve failed ${errorLogSummary(lastErr)}`);
		return [];
	} catch (e) {
		log(cfg, `conversation history resolve errored ${errorLogSummary(e)}`);
		return [];
	}
}

async function batchexecuteHistory(
	activeCfg: RuntimeConfig,
	tokens: GeminiAppPageTokens,
	cid: string,
): Promise<string> {
	const origin = (
		activeCfg.gemini_origin || "https://gemini.google.com"
	).replace(/\/$/, "");
	const reqid = String(Math.floor(Date.now() / 1000) % 1_000_000);
	const params = new URLSearchParams({
		rpcids: CONVERSATION_HISTORY_RPCID,
		hl: "en",
		_reqid: reqid,
		rt: "c",
		"source-path": fullSizeSourcePath(cid),
	});
	if (activeCfg.gemini_bl) params.set("bl", activeCfg.gemini_bl);
	if (tokens.sid) params.set("f.sid", tokens.sid);

	const payload = buildConversationHistoryRpcPayload(cid);
	const body = new URLSearchParams({
		at: String(tokens.at || ""),
		"f.req": JSON.stringify([
			[[CONVERSATION_HISTORY_RPCID, JSON.stringify(payload), null, "generic"]],
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
		throw new Error(`batchexecute hNvQHb HTTP ${resp.status}`);
	}
	return text;
}

function imageUrlMatchKey(url: string): string {
	const trimmed = String(url || "").trim();
	if (!trimmed) return "";
	try {
		const parsed = new URL(trimmed);
		parsed.search = "";
		parsed.hash = "";
		return parsed
			.toString()
			.replace(/=s\d+(?:-[a-z0-9]+)*$/i, "")
			.replace(/=d-I$/i, "")
			.replace(/\/+$/, "");
	} catch {
		return trimmed.replace(/[?#].*$/, "").replace(/=s\d+(?:-[a-z0-9]+)*$/i, "");
	}
}

function dedupeByImageKey(images: GeminiParsedImage[]): GeminiParsedImage[] {
	const out: GeminiParsedImage[] = [];
	const seen = new Set<string>();
	for (const image of images) {
		const key = image.imageId || imageUrlMatchKey(image.url) || image.url;
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(image);
	}
	return out;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
