/**
 * Gemini / Nano Banana watermark removal.
 *
 * Uses the GargantuaX gemini-watermark-remover core on a bottom-right corner
 * crop only (sparkle is always corner-placed). Full-frame adaptive scans are
 * too CPU-heavy for Cloudflare Workers on ~2K+ images (Error 1102).
 */

import jpeg from "jpeg-js";
import { decodePng, encodePng, isPngBytes, type RgbaImage } from "./png";
import {
	WatermarkEngine,
	interpolateAlphaMap,
	processWatermarkImageData,
	removeWatermark as gargantuaRemoveWatermark,
} from "./vendor/gargantua-core.js";

/** Bright-corr above this ⇒ treat catalog placement as a safe forced scrub. */
const HIGH_CONFIDENCE_BRIGHT_CORR = 0.65;
/** After GWR, scrub again if this much bright residual remains at 48px slots. */
const POST_GWR_BRIGHT_CORR = 0.2;
/**
 * Corner crop edge length. Covers largest catalog slot (96 + 192 margin) plus
 * padding so detection has local background context.
 */
const CORNER_CROP_EDGE = 384;

export type WatermarkRemovalResult = {
	bytes: Uint8Array;
	width: number;
	height: number;
	format: "png" | "jpeg";
	removed: boolean;
};

export type WatermarkConfig = {
	logoSize: number;
	marginRight: number;
	marginBottom: number;
	alphaVariant?: string;
};

type ImageDataLike = {
	data: Uint8ClampedArray;
	width: number;
	height: number;
};

let enginePromise: Promise<InstanceType<typeof WatermarkEngine>> | null = null;

async function getEngine(): Promise<InstanceType<typeof WatermarkEngine>> {
	if (!enginePromise) {
		enginePromise = WatermarkEngine.create().catch((error: unknown) => {
			enginePromise = null;
			throw error;
		});
	}
	return enginePromise;
}

/** Preferred config when dimensions alone are known (no pixel scoring yet). */
export function detectWatermarkConfig(
	width: number,
	height: number,
): WatermarkConfig {
	if (width === 1408 && height === 768) {
		return { logoSize: 46, marginRight: 32, marginBottom: 32 };
	}
	if (width > 1024 && height > 1024) {
		return { logoSize: 96, marginRight: 64, marginBottom: 64 };
	}
	return { logoSize: 48, marginRight: 32, marginBottom: 32 };
}

export function watermarkConfigCandidates(
	width: number,
	height: number,
): WatermarkConfig[] {
	const out: WatermarkConfig[] = [];
	const push = (config: WatermarkConfig) => {
		if (width < config.marginRight + config.logoSize) return;
		if (height < config.marginBottom + config.logoSize) return;
		if (
			out.some(
				(c) =>
					c.logoSize === config.logoSize &&
					c.marginRight === config.marginRight &&
					c.marginBottom === config.marginBottom &&
					c.alphaVariant === config.alphaVariant,
			)
		) {
			return;
		}
		out.push(config);
	};
	push(detectWatermarkConfig(width, height));
	push({ logoSize: 48, marginRight: 32, marginBottom: 32 });
	push({ logoSize: 48, marginRight: 96, marginBottom: 96 });
	push({ logoSize: 96, marginRight: 64, marginBottom: 64 });
	push({
		logoSize: 96,
		marginRight: 192,
		marginBottom: 192,
		alphaVariant: "20260520",
	});
	return out;
}

export function watermarkPosition(
	width: number,
	height: number,
	config: WatermarkConfig = detectWatermarkConfig(width, height),
): { x: number; y: number; width: number; height: number } | null {
	const x = width - config.marginRight - config.logoSize;
	const y = height - config.marginBottom - config.logoSize;
	if (x < 0 || y < 0) return null;
	return { x, y, width: config.logoSize, height: config.logoSize };
}

/** @deprecated kept for unit tests; GargantuaX pipeline owns production removal. */
export function scoreWatermarkCandidate(
	image: RgbaImage,
	alphaMap: Float32Array,
	position: { x: number; y: number; width: number; height: number },
): number {
	const { data, width: imgW } = image;
	const { x, y, width, height } = position;
	const n = width * height;
	if (alphaMap.length < n || n === 0) return 0;
	const gray = new Float64Array(n);
	const border: number[] = [];
	for (let row = 0; row < height; row++) {
		for (let col = 0; col < width; col++) {
			const imgIdx = ((y + row) * imgW + (x + col)) * 4;
			const g =
				((data[imgIdx] ?? 0) +
					(data[imgIdx + 1] ?? 0) +
					(data[imgIdx + 2] ?? 0)) /
				3;
			gray[row * width + col] = g;
			if (row === 0 || row === height - 1 || col === 0 || col === width - 1) {
				border.push(g);
			}
		}
	}
	border.sort((a, b) => a - b);
	const bg = border[Math.floor(border.length / 2)] ?? 0;
	let sumA = 0;
	let sumE = 0;
	let sumAA = 0;
	let sumEE = 0;
	let sumAE = 0;
	for (let i = 0; i < n; i++) {
		const a = alphaMap[i] ?? 0;
		const excess = Math.max(0, (gray[i] ?? 0) - bg);
		sumA += a;
		sumE += excess;
		sumAA += a * a;
		sumEE += excess * excess;
		sumAE += a * excess;
	}
	const meanA = sumA / n;
	const meanE = sumE / n;
	const cov = sumAE / n - meanA * meanE;
	const varA = sumAA / n - meanA * meanA;
	const varE = sumEE / n - meanE * meanE;
	if (varA <= 1e-12 || varE <= 1e-12) return 0;
	return cov / Math.sqrt(varA * varE);
}

export function selectWatermarkPlacement(_image: RgbaImage): {
	config: WatermarkConfig;
	position: { x: number; y: number; width: number; height: number };
	score: number;
} | null {
	return null;
}

/** Low-level reverse blend kept for unit tests. */
export function applyReverseAlphaBlend(
	image: RgbaImage,
	alphaMap: Float32Array,
	position: { x: number; y: number; width: number; height: number },
	alphaScale = 1,
): number {
	const { data, width: imgW } = image;
	const { x, y, width, height } = position;
	let processed = 0;
	for (let row = 0; row < height; row++) {
		for (let col = 0; col < width; col++) {
			let alpha = (alphaMap[row * width + col] ?? 0) * alphaScale;
			if (alpha < 2e-3) continue;
			alpha = Math.min(alpha, 0.99);
			const oneMinus = 1 - alpha;
			const imgIdx = ((y + row) * imgW + (x + col)) * 4;
			for (let c = 0; c < 3; c++) {
				const watermarked = data[imgIdx + c] ?? 0;
				const original = (watermarked - alpha * 255) / oneMinus;
				data[imgIdx + c] = Math.max(0, Math.min(255, Math.round(original)));
			}
			processed += 1;
		}
	}
	return processed;
}

export async function removeGeminiWatermark(
	bytes: Uint8Array,
): Promise<WatermarkRemovalResult | null> {
	const decoded = await decodeImageBytes(bytes);
	if (!decoded) return null;

	const full: ImageDataLike = {
		data: toClamped(decoded.image.data),
		width: decoded.width,
		height: decoded.height,
	};

	const cropRect = cornerWatermarkCropRect(full.width, full.height);
	const crop = extractImageRect(full, cropRect);

	const engine = await getEngine();
	const alpha48 = await engine.getAlphaMap(48);
	const alpha96 = await engine.getAlphaMap(96);
	const alpha96NewMargin = await engine.getAlphaMap("96-20260520");
	const alpha96OutlineLight = await engine.getAlphaMap("96-outline-light");
	const alpha96OutlineDark = await engine.getAlphaMap("96-outline-dark");
	await engine.getAlphaMap("36-v2");

	/*
	 * Always run GWR on the corner crop — at ≤384² it is cheap enough for
	 * Workers, and skipping to a forced 48px scrub alone can false-positive on
	 * carpet / fabric grain at the extreme corner.
	 */
	let removed = scrubHighConfidenceBrightSlots(crop, alpha48, {
		minBright: HIGH_CONFIDENCE_BRIGHT_CORR,
	});

	const result = processWatermarkImageData(crop, {
		alpha48,
		alpha96,
		alpha96Variants: {
			"20260520": alpha96NewMargin,
			"outline-light": alpha96OutlineLight,
			"outline-dark": alpha96OutlineDark,
		},
		adaptiveMode: "always",
		getAlphaMap: (size: number | string) =>
			engine.alphaMaps[size] || interpolateAlphaMap(alpha96, 96, Number(size)),
	});

	if (result?.meta?.applied === true) removed = true;
	const working: ImageDataLike = result?.imageData
		? {
				data: toClamped(result.imageData.data),
				width: result.imageData.width,
				height: result.imageData.height,
			}
		: crop;

	// Residual cleanup: GWR may stop with residual.visible=true on light bg.
	if (
		scrubHighConfidenceBrightSlots(working, alpha48, {
			minBright: POST_GWR_BRIGHT_CORR,
		})
	) {
		removed = true;
	}

	if (!removed) {
		return {
			bytes,
			width: decoded.width,
			height: decoded.height,
			format: decoded.format,
			removed: false,
		};
	}

	blitImageRect(full, working, cropRect.x, cropRect.y);
	return encodeRemovalResult(decoded, full, true);
}

/** Bottom-right crop covering all known Gemini sparkle catalog placements. */
export function cornerWatermarkCropRect(
	width: number,
	height: number,
): { x: number; y: number; width: number; height: number } {
	const edge = Math.min(width, height, CORNER_CROP_EDGE);
	return {
		x: Math.max(0, width - edge),
		y: Math.max(0, height - edge),
		width: edge,
		height: edge,
	};
}

function extractImageRect(
	source: ImageDataLike,
	rect: { x: number; y: number; width: number; height: number },
): ImageDataLike {
	const data = new Uint8ClampedArray(rect.width * rect.height * 4);
	for (let row = 0; row < rect.height; row++) {
		const srcStart = ((rect.y + row) * source.width + rect.x) * 4;
		const dstStart = row * rect.width * 4;
		data.set(
			source.data.subarray(srcStart, srcStart + rect.width * 4),
			dstStart,
		);
	}
	return { data, width: rect.width, height: rect.height };
}

function blitImageRect(
	dest: ImageDataLike,
	patch: ImageDataLike,
	originX: number,
	originY: number,
): void {
	const copyW = Math.min(patch.width, dest.width - originX);
	const copyH = Math.min(patch.height, dest.height - originY);
	if (copyW <= 0 || copyH <= 0) return;
	for (let row = 0; row < copyH; row++) {
		const srcStart = row * patch.width * 4;
		const dstStart = ((originY + row) * dest.width + originX) * 4;
		dest.data.set(
			patch.data.subarray(srcStart, srcStart + copyW * 4),
			dstStart,
		);
	}
}

type BrightSlot = {
	config: WatermarkConfig;
	position: { x: number; y: number; width: number; height: number };
	bright: number;
};

function standard48Slots(width: number, height: number): WatermarkConfig[] {
	return [
		{ logoSize: 48, marginRight: 96, marginBottom: 96 },
		{ logoSize: 48, marginRight: 32, marginBottom: 32 },
		{ logoSize: 46, marginRight: 32, marginBottom: 32 },
	].filter(
		(c) =>
			width >= c.marginRight + c.logoSize &&
			height >= c.marginBottom + c.logoSize,
	);
}

function measureBrightCorr(
	image: ImageDataLike,
	alphaMap: Float32Array,
	position: { x: number; y: number; width: number; height: number },
): number {
	const { data, width: imgW } = image;
	const { x, y, width, height } = position;
	const n = width * height;
	if (alphaMap.length < n || n === 0) return 0;
	const gray = new Float64Array(n);
	const border: number[] = [];
	for (let row = 0; row < height; row++) {
		for (let col = 0; col < width; col++) {
			const imgIdx = ((y + row) * imgW + (x + col)) * 4;
			const g =
				((data[imgIdx] ?? 0) +
					(data[imgIdx + 1] ?? 0) +
					(data[imgIdx + 2] ?? 0)) /
				3;
			gray[row * width + col] = g;
			if (row === 0 || row === height - 1 || col === 0 || col === width - 1) {
				border.push(g);
			}
		}
	}
	border.sort((a, b) => a - b);
	const bg = border[Math.floor(border.length / 2)] ?? 0;
	let sumA = 0;
	let sumE = 0;
	let sumAA = 0;
	let sumEE = 0;
	let sumAE = 0;
	for (let i = 0; i < n; i++) {
		const a = Math.abs(alphaMap[i] ?? 0);
		const excess = Math.max(0, (gray[i] ?? 0) - bg);
		sumA += a;
		sumE += excess;
		sumAA += a * a;
		sumEE += excess * excess;
		sumAE += a * excess;
	}
	const meanA = sumA / n;
	const meanE = sumE / n;
	const cov = sumAE / n - meanA * meanE;
	const varA = sumAA / n - meanA * meanA;
	const varE = sumEE / n - meanE * meanE;
	if (varA <= 1e-12 || varE <= 1e-12) return 0;
	return cov / Math.sqrt(varA * varE);
}

function findBestBrightSlot(
	image: ImageDataLike,
	alpha48: Float32Array,
): BrightSlot | null {
	let best: BrightSlot | null = null;
	for (const config of standard48Slots(image.width, image.height)) {
		const position = watermarkPosition(image.width, image.height, config);
		if (!position) continue;
		const alpha =
			config.logoSize === 48
				? alpha48
				: interpolateAlphaMap(alpha48, 48, config.logoSize);
		const bright = measureBrightCorr(image, alpha, position);
		if (!best || bright > best.bright) {
			best = { config, position, bright };
		}
	}
	return best;
}

/**
 * Scrub the strongest bright-matching 48px catalog slot in-place.
 * Gain is binary-searched so post-scrub |bright residual| is minimized.
 */
function scrubHighConfidenceBrightSlots(
	image: ImageDataLike,
	alpha48: Float32Array,
	{ minBright }: { minBright: number },
): boolean {
	const best = findBestBrightSlot(image, alpha48);
	if (!best || best.bright < minBright) return false;

	const alpha =
		best.config.logoSize === 48
			? alpha48
			: interpolateAlphaMap(alpha48, 48, best.config.logoSize);

	const snapshot = new Uint8ClampedArray(image.data);
	let lo = 0.35;
	let hi = 0.85;
	let bestGain = 0.5;
	let bestAbs = Number.POSITIVE_INFINITY;

	for (let iter = 0; iter < 8; iter++) {
		const mid = (lo + hi) / 2;
		image.data.set(snapshot);
		gargantuaRemoveWatermark(image, alpha, best.position, { alphaGain: mid });
		const residual = measureBrightCorr(image, alpha, best.position);
		const abs = Math.abs(residual);
		if (abs < bestAbs) {
			bestAbs = abs;
			bestGain = mid;
		}
		// Positive residual ⇒ still too bright ⇒ need more gain.
		if (residual > 0) lo = mid;
		else hi = mid;
	}

	image.data.set(snapshot);
	gargantuaRemoveWatermark(image, alpha, best.position, {
		alphaGain: bestGain,
	});
	return true;
}

async function encodeRemovalResult(
	decoded: Decoded,
	imageData: ImageDataLike,
	removed: boolean,
): Promise<WatermarkRemovalResult> {
	const outImage: RgbaImage = {
		width: imageData.width,
		height: imageData.height,
		data: new Uint8Array(
			imageData.data.buffer.slice(
				imageData.data.byteOffset,
				imageData.data.byteOffset + imageData.data.byteLength,
			),
		),
	};
	const outBytes =
		decoded.format === "jpeg"
			? encodeJpeg(outImage)
			: await encodePng(outImage);
	return {
		bytes: outBytes,
		width: outImage.width,
		height: outImage.height,
		format: decoded.format,
		removed,
	};
}

type Decoded = {
	image: RgbaImage;
	format: "png" | "jpeg";
	width: number;
	height: number;
};

async function decodeImageBytes(bytes: Uint8Array): Promise<Decoded | null> {
	if (isPngBytes(bytes)) {
		const image = await decodePng(bytes);
		return {
			image,
			format: "png",
			width: image.width,
			height: image.height,
		};
	}
	if (isJpegBytes(bytes)) {
		const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
		return {
			image: {
				width: decoded.width,
				height: decoded.height,
				data: decoded.data as Uint8Array,
			},
			format: "jpeg",
			width: decoded.width,
			height: decoded.height,
		};
	}
	return null;
}

function encodeJpeg(image: RgbaImage): Uint8Array {
	const encoded = jpeg.encode(
		{
			data: image.data,
			width: image.width,
			height: image.height,
		},
		92,
	);
	return encoded.data;
}

function isJpegBytes(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff
	);
}

function toClamped(data: Uint8Array): Uint8ClampedArray {
	if (data instanceof Uint8ClampedArray) return data;
	return new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
}
