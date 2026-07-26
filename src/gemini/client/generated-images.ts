import { bytesToBase64 } from "../../attachments/base64";
import { detectUploadMimeFromBytes } from "../../attachments/mime";
import type { RuntimeConfig } from "../../config";
import { errorLogSummary } from "../../shared/errors";
import { log } from "../../shared/logging";
import { GEMINI_WEB_USER_AGENT } from "../constants";
import { httpFetch } from "../transport";
import { enrichGeneratedImagesWithConversationHistory } from "./conversation-history";
import { resolveFullSizeGeneratedImageUrl } from "./full-size-image";
import { upstreamImageFetchFailedError } from "./errors";
import type { GeminiParsedImage } from "./parser";
import { removeGeminiWatermark } from "./watermark";

export type GeminiImageOutputFormat = "png" | "jpeg" | "gif" | "webp";

export type GeminiRichImage = GeminiParsedImage & {
	base64?: string;
	outputFormat?: GeminiImageOutputFormat;
	/** Compact hydrate path summary for live debugging (no secrets). */
	hydrateDebug?: string;
};

export type GeneratedImageHydrationLimits = {
	maxImageBytes: number;
	maxTotalBytes: number;
};

export type GeneratedImageHydrationOptions = {
	/** Forwarded into c8o8Fe mode-20 upscale payload. */
	upscalePrompt?: string;
	/** When true, scrub Gemini watermark on the winning image (default false). */
	removeWatermark?: boolean;
};

export type HydrateDebugInfo = {
	cdn?: string;
	hasCid: boolean;
	hasRid: boolean;
	hasRcid: boolean;
	hasImageId: boolean;
	historyImages: number;
	historyTokens: number;
	mergedToken: boolean;
	modes: string;
	modeResults: string[];
	final?: string;
};

export function formatHydrateDebug(info: HydrateDebugInfo): string {
	return [
		`cdn=${info.cdn || "none"}`,
		`ids=${info.hasCid ? "c" : "-"}${info.hasRid ? "r" : "-"}${info.hasRcid ? "rc" : "-"}${info.hasImageId ? "i" : "-"}`,
		`hist=${info.historyImages}/${info.historyTokens}t`,
		`token=${info.mergedToken ? "yes" : "no"}`,
		`modes=${info.modes || "none"}`,
		`rpc=${info.modeResults.join(",") || "none"}`,
		`final=${info.final || "none"}`,
	].join(";");
}

export const DEFAULT_GENERATED_IMAGE_HYDRATION_LIMITS = Object.freeze({
	maxImageBytes: 16 * 1024 * 1024,
	maxTotalBytes: 48 * 1024 * 1024,
});

/**
 * Stop hunting larger variants once we already have a ~4K-class image.
 * Full-size RPC and CDN suffixes are compared by pixel count; early-stop is only
 * a ceiling so we do not keep probing after a true max-tier asset lands.
 */
export const PREFERRED_GENERATED_IMAGE_MIN_PIXELS = 8_000_000;
export const PREFERRED_GENERATED_IMAGE_MIN_MAX_SIDE = 3840;

const GOOGLEUSERCONTENT_SIZE_SUFFIX_RE = /=s\d+(?:-[a-z0-9]+)*(?=$|[?#&])/i;

/** Prefer larger Googleusercontent size transforms before raw/preview URLs. */
const GENERATED_IMAGE_SIZE_SUFFIXES = [
	"=s4096-rj",
	"=s2048-rj",
	"=s0",
	"=d",
] as const;

type FetchedImageBytes = {
	base64: string;
	outputFormat: GeminiImageOutputFormat;
	byteLength: number;
	width: number;
	height: number;
	pixels: number;
	debug?: string;
};

/** Raw download kept during size hunting; watermark runs once on the winner. */
type RawFetchedImage = {
	bytes: Uint8Array;
	outputFormat: GeminiImageOutputFormat;
	byteLength: number;
	width: number;
	height: number;
	pixels: number;
};

class GeneratedImageLimitError extends Error {}

export async function hydrateGeneratedImages(
	cfg: RuntimeConfig,
	activeCfg: RuntimeConfig,
	images: GeminiParsedImage[],
	limits: GeneratedImageHydrationLimits = DEFAULT_GENERATED_IMAGE_HYDRATION_LIMITS,
	options: GeneratedImageHydrationOptions = {},
): Promise<GeminiRichImage[]> {
	const out: GeminiRichImage[] = [];
	let remainingBytes = Math.max(0, Math.floor(limits.maxTotalBytes));
	for (const image of images) {
		if (image.source !== "generated") {
			out.push(image);
			continue;
		}
		try {
			if (remainingBytes <= 0)
				throw new GeneratedImageLimitError(
					"generated image aggregate byte limit reached",
				);
			const fetched = await fetchGeneratedImageBytes(
				cfg,
				activeCfg,
				image,
				Math.min(remainingBytes, Math.max(0, Math.floor(limits.maxImageBytes))),
				options,
			);
			remainingBytes -= fetched.byteLength;
			const rich: GeminiRichImage = {
				...image,
				base64: fetched.base64,
				outputFormat: fetched.outputFormat,
			};
			if (fetched.debug) {
				rich.hydrateDebug = fetched.debug;
				log(cfg, `hydrate_debug ${fetched.debug}`);
			}
			out.push(rich);
		} catch (e) {
			log(
				cfg,
				`generated image fetch failed; returning source url only ${errorLogSummary(e)}`,
			);
			out.push(image);
		}
	}
	return out;
}

async function fetchGeneratedImageBytes(
	cfg: RuntimeConfig,
	activeCfg: RuntimeConfig,
	image: GeminiParsedImage,
	maxBytes: number,
	options: GeneratedImageHydrationOptions,
): Promise<FetchedImageBytes> {
	const headers = generatedImageFetchHeaders(activeCfg);
	let best: RawFetchedImage | null = null;
	let lastErr: unknown = null;
	const debug: HydrateDebugInfo = {
		hasCid: !!String(image.cid || "").trim(),
		hasRid: !!String(image.rid || "").trim(),
		hasRcid: !!String(image.rcid || "").trim(),
		hasImageId: !!String(image.imageId || "").trim(),
		historyImages: 0,
		historyTokens: 0,
		mergedToken: !!String(image.mediaToken || "").trim(),
		modes: "",
		modeResults: [],
	};

	const consider = (fetched: RawFetchedImage, label: string) => {
		if (!best || fetched.pixels > best.pixels) {
			best = fetched;
			if (cfg.log_requests) {
				log(
					cfg,
					`generated image ${label} accepted ${fetched.width}x${fetched.height} bytes=${fetched.byteLength}`,
				);
			}
		}
	};

	const withDebug = async (
		fetched: FetchedImageBytes,
	): Promise<FetchedImageBytes> => {
		debug.final = `${fetched.width}x${fetched.height}/${fetched.byteLength}`;
		return { ...fetched, debug: formatHydrateDebug(debug) };
	};

	// CDN first: guarantees bytes even if later history/full-size RPCs burn budget.
	const candidates = generatedImagePreviewFetchUrls(image.url);
	for (const target of candidates) {
		try {
			const fetched = await fetchGeneratedImageBytesFromUrl(
				cfg,
				target,
				headers,
				maxBytes,
			);
			consider(fetched, "candidate");
			if (!debug.cdn) {
				debug.cdn = `${fetched.width}x${fetched.height}/${fetched.byteLength}`;
			}
			if (!best) continue;
			if (isPreferredGeneratedImage(best)) {
				return withDebug(await finalizeFetchedImage(cfg, best, options));
			}
		} catch (e) {
			if (e instanceof GeneratedImageLimitError) throw e;
			lastErr = e;
		}
	}
	const winner = best as RawFetchedImage | null;
	if (winner) {
		debug.cdn = `${winner.width}x${winner.height}/${winner.byteLength}`;
	} else if (!debug.cdn) {
		debug.cdn = "none";
	}

	// StreamGenerate often omits `$AV`; load via hNvQHb only after a CDN baseline.
	const [enriched] = await enrichGeneratedImagesWithConversationHistory(
		cfg,
		activeCfg,
		[image],
	);
	const fullSizeImage = enriched || image;
	debug.mergedToken = !!String(fullSizeImage.mediaToken || "").trim();
	debug.hasCid = !!String(fullSizeImage.cid || "").trim();
	debug.hasRid = !!String(fullSizeImage.rid || "").trim();
	debug.hasRcid = !!String(fullSizeImage.rcid || "").trim();
	debug.hasImageId = !!String(fullSizeImage.imageId || "").trim();
	// enrich logs history counts; approximate from merged token for compact debug.
	debug.historyImages = debug.mergedToken ? 1 : 0;
	debug.historyTokens = debug.mergedToken ? 1 : 0;

	const modes = fullSizeResolveModesForImage(fullSizeImage);
	debug.modes = modes.join("+") || "none";
	for (const mode of modes) {
		try {
			const fullSizeUrl = await resolveFullSizeGeneratedImageUrl(
				cfg,
				activeCfg,
				fullSizeImage,
				{
					mode,
					...(options.upscalePrompt !== undefined
						? { upscalePrompt: options.upscalePrompt }
						: {}),
				},
			);
			if (!fullSizeUrl) {
				debug.modeResults.push(`${mode}=empty`);
				continue;
			}
			const fetched = await fetchGeneratedImageBytesFromUrl(
				cfg,
				fullSizeUrl,
				headers,
				maxBytes,
			);
			consider(fetched, `full-size mode=${mode}`);
			debug.modeResults.push(
				`${mode}=${fetched.width}x${fetched.height}/${fetched.byteLength}`,
			);
			if (!best) continue;
			if (isPreferredGeneratedImage(best)) {
				return withDebug(await finalizeFetchedImage(cfg, best, options));
			}
		} catch (e) {
			if (e instanceof GeneratedImageLimitError) throw e;
			lastErr = e;
			debug.modeResults.push(`${mode}=err`);
			log(
				cfg,
				`generated image full-size mode=${mode} failed; continuing ${errorLogSummary(e)}`,
			);
		}
	}

	if (best !== null)
		return withDebug(await finalizeFetchedImage(cfg, best, options));
	if (lastErr) throw lastErr;
	throw upstreamImageFetchFailedError("no generated image URL candidates");
}

/**
 * Download + size only. Watermark scrub is deferred to {@link finalizeFetchedImage}
 * so multi-candidate hunts do not decode/scrub every intermediate image.
 */
async function fetchGeneratedImageBytesFromUrl(
	cfg: RuntimeConfig,
	target: string,
	headers: Record<string, string>,
	maxBytes: number,
): Promise<RawFetchedImage> {
	try {
		if (maxBytes <= 0)
			throw new GeneratedImageLimitError("generated image byte limit reached");
		const resp = await httpFetch(target, {
			method: "GET",
			headers,
			timeoutMs: cfg.request_timeout_sec * 1000,
			socket: false,
			cfg,
		});
		const bytes = await responseBytes(resp, maxBytes);
		if (!resp.ok)
			throw upstreamImageFetchFailedError(
				`upstream HTTP ${resp.status}`,
				resp.status,
			);
		const outputFormat = outputFormatFromMime(detectUploadMimeFromBytes(bytes));
		if (!outputFormat)
			throw upstreamImageFetchFailedError(
				"response body is not a supported image",
				resp.status,
			);
		const size = readImageSize(bytes);
		const width = size?.width ?? 0;
		const height = size?.height ?? 0;
		const pixels =
			width > 0 && height > 0 ? width * height : Math.max(1, bytes.byteLength);
		return {
			bytes,
			outputFormat,
			byteLength: bytes.byteLength,
			width,
			height,
			pixels,
		};
	} catch (e) {
		if (e instanceof GeneratedImageLimitError) throw e;
		throw upstreamImageFetchFailedError(e);
	}
}

async function finalizeFetchedImage(
	cfg: RuntimeConfig,
	image: RawFetchedImage,
	options: GeneratedImageHydrationOptions = {},
): Promise<FetchedImageBytes> {
	try {
		const cleaned =
			options.removeWatermark === true
				? await maybeRemoveGeneratedImageWatermark(cfg, image.bytes)
				: null;
		const finalBytes = cleaned?.bytes ?? image.bytes;
		const finalFormat = cleaned?.format ?? image.outputFormat;
		const width = cleaned?.width ?? image.width;
		const height = cleaned?.height ?? image.height;
		const pixels =
			width > 0 && height > 0
				? width * height
				: Math.max(1, finalBytes.byteLength);
		return {
			base64: bytesToBase64(finalBytes),
			outputFormat: finalFormat,
			byteLength: finalBytes.byteLength,
			width,
			height,
			pixels,
		};
	} catch (e) {
		// Never fail the whole hydrate after a winning download (large mode-20
		// PNGs can OOM watermark); return the raw bytes instead.
		log(
			cfg,
			`generated image finalize failed; returning raw bytes ${errorLogSummary(e)}`,
		);
		return {
			base64: bytesToBase64(image.bytes),
			outputFormat: image.outputFormat,
			byteLength: image.byteLength,
			width: image.width,
			height: image.height,
			pixels: image.pixels,
		};
	}
}

/**
 * Build CDN URL candidates for a generated Gemini image.
 * Larger Googleusercontent transforms are tried before the raw/preview URL so
 * Workers do not stop on a ~512px gg-dl preview when a higher-res variant exists.
 */
export function generatedImagePreviewFetchUrls(url: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (candidate: string) => {
		if (!candidate || seen.has(candidate)) return;
		seen.add(candidate);
		out.push(candidate);
	};

	const base = stripGoogleusercontentSizeSuffix(url);
	for (const suffix of GENERATED_IMAGE_SIZE_SUFFIXES) push(`${base}${suffix}`);
	push(base);
	if (url !== base) push(url);
	return out;
}

export function stripGoogleusercontentSizeSuffix(url: string): string {
	return url.replace(GOOGLEUSERCONTENT_SIZE_SUFFIX_RE, "");
}

export function isPreferredGeneratedImage(image: {
	width: number;
	height: number;
	pixels: number;
}): boolean {
	const maxSide = Math.max(image.width, image.height);
	if (maxSide >= PREFERRED_GENERATED_IMAGE_MIN_MAX_SIDE) return true;
	return image.pixels >= PREFERRED_GENERATED_IMAGE_MIN_PIXELS;
}

/** Mode 20 needs a real mediaToken; without it only try mode 19. */
export function fullSizeResolveModesForImage(
	image: GeminiParsedImage,
): Array<19 | 20> {
	if (String(image.mediaToken || "").trim()) return [20, 19];
	return [19];
}

export function readImageSize(
	bytes: Uint8Array,
): { width: number; height: number } | null {
	if (bytes.length >= 24 && isPng(bytes)) {
		return {
			width: readU32BE(bytes, 16),
			height: readU32BE(bytes, 20),
		};
	}
	if (bytes.length >= 10 && isGif(bytes)) {
		return {
			width: (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8),
			height: (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8),
		};
	}
	if (bytes.length >= 30 && isWebp(bytes)) {
		return readWebpSize(bytes);
	}
	if (bytes.length >= 4 && isJpeg(bytes)) {
		return readJpegSize(bytes);
	}
	return null;
}

export function generatedImageFetchHeaders(
	cfg: RuntimeConfig,
): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.9",
		Origin: "https://gemini.google.com",
		Referer: "https://gemini.google.com/app",
		"User-Agent": GEMINI_WEB_USER_AGENT,
	};
	if (cfg.cookie) headers.Cookie = cfg.cookie;
	return headers;
}

async function maybeRemoveGeneratedImageWatermark(
	cfg: RuntimeConfig,
	bytes: Uint8Array,
): Promise<{
	bytes: Uint8Array;
	width: number;
	height: number;
	format: GeminiImageOutputFormat;
} | null> {
	try {
		const result = await removeGeminiWatermark(bytes);
		if (!result?.removed) return null;
		if (cfg.log_requests) {
			log(
				cfg,
				`generated image watermark removed ${result.width}x${result.height} format=${result.format}`,
			);
		}
		return {
			bytes: result.bytes,
			width: result.width,
			height: result.height,
			format: result.format,
		};
	} catch (e) {
		log(
			cfg,
			`generated image watermark removal failed; keeping original ${errorLogSummary(e)}`,
		);
		return null;
	}
}

async function responseBytes(
	resp: Awaited<ReturnType<typeof httpFetch>>,
	maxBytes: number,
): Promise<Uint8Array> {
	if (!resp.body) return new Uint8Array(0);
	const declaredLength = Number(resp.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await resp.body.cancel().catch(() => undefined);
		throw new GeneratedImageLimitError(
			`generated image exceeds ${maxBytes} byte limit`,
		);
	}
	const reader = resp.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		if (total + value.byteLength > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new GeneratedImageLimitError(
				`generated image exceeds ${maxBytes} byte limit`,
			);
		}
		chunks.push(value);
		total += value.byteLength;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function outputFormatFromMime(mime: string): GeminiImageOutputFormat | "" {
	switch (mime) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpeg";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		default:
			return "";
	}
}

function isPng(bytes: Uint8Array): boolean {
	return (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	);
}

function isGif(bytes: Uint8Array): boolean {
	return (
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x38
	);
}

function isJpeg(bytes: Uint8Array): boolean {
	return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isWebp(bytes: Uint8Array): boolean {
	return (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	);
}

function readJpegSize(
	bytes: Uint8Array,
): { width: number; height: number } | null {
	let offset = 2;
	while (offset + 9 < bytes.length) {
		const b0 = bytes[offset];
		const b1 = bytes[offset + 1];
		const b2 = bytes[offset + 2];
		const b3 = bytes[offset + 3];
		const b5 = bytes[offset + 5];
		const b6 = bytes[offset + 6];
		const b7 = bytes[offset + 7];
		const b8 = bytes[offset + 8];
		if (b0 !== 0xff) return null;
		const marker = b1;
		if (marker === 0xd9 || marker === 0xda) return null;
		if (marker !== undefined && marker >= 0xc0 && marker <= 0xc3) {
			return {
				height: ((b5 ?? 0) << 8) | (b6 ?? 0),
				width: ((b7 ?? 0) << 8) | (b8 ?? 0),
			};
		}
		const length = ((b2 ?? 0) << 8) | (b3 ?? 0);
		if (length < 2) return null;
		offset += 2 + length;
	}
	return null;
}

function readWebpSize(
	bytes: Uint8Array,
): { width: number; height: number } | null {
	// VP8X
	if (
		bytes.length >= 30 &&
		bytes[12] === 0x56 &&
		bytes[13] === 0x50 &&
		bytes[14] === 0x38 &&
		bytes[15] === 0x58
	) {
		const width =
			1 +
			((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16));
		const height =
			1 +
			((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16));
		return { width, height };
	}
	// VP8 lossy
	if (
		bytes.length >= 30 &&
		bytes[12] === 0x56 &&
		bytes[13] === 0x50 &&
		bytes[14] === 0x38 &&
		bytes[15] === 0x20
	) {
		return {
			width: (bytes[26] ?? 0) | (((bytes[27] ?? 0) & 0x3f) << 8),
			height: (bytes[28] ?? 0) | (((bytes[29] ?? 0) & 0x3f) << 8),
		};
	}
	// VP8L lossless
	if (
		bytes.length >= 25 &&
		bytes[12] === 0x56 &&
		bytes[13] === 0x50 &&
		bytes[14] === 0x38 &&
		bytes[15] === 0x4c
	) {
		const bits =
			(bytes[21] ?? 0) |
			((bytes[22] ?? 0) << 8) |
			((bytes[23] ?? 0) << 16) |
			((bytes[24] ?? 0) << 24);
		return {
			width: (bits & 0x3fff) + 1,
			height: ((bits >> 14) & 0x3fff) + 1,
		};
	}
	return null;
}

function readU32BE(bytes: Uint8Array, offset: number): number {
	return (
		(((bytes[offset] ?? 0) << 24) |
			((bytes[offset + 1] ?? 0) << 16) |
			((bytes[offset + 2] ?? 0) << 8) |
			(bytes[offset + 3] ?? 0)) >>>
		0
	);
}
