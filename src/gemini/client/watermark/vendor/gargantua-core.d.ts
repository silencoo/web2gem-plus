/** Minimal typings for the vendored GargantuaX watermark core. */

export type WatermarkImageData = {
	data: Uint8ClampedArray;
	width: number;
	height: number;
};

export type WatermarkProcessResult = {
	imageData: WatermarkImageData;
	meta?: {
		applied?: boolean;
		skipReason?: string | null;
		size?: number;
		position?: { x: number; y: number; width: number; height: number };
		config?: Record<string, unknown>;
		alphaGain?: number;
		detection?: Record<string, unknown>;
		[key: string]: unknown;
	};
	debugTimings?: unknown;
};

export declare class WatermarkEngine {
	alphaMaps: Record<string | number, Float32Array>;
	static create(): Promise<WatermarkEngine>;
	getAlphaMap(size: number | string): Promise<Float32Array>;
}

export declare function processWatermarkImageData(
	imageData: WatermarkImageData,
	options?: Record<string, unknown>,
): WatermarkProcessResult;

export declare function getEmbeddedAlphaMap(
	size: number | string,
): Float32Array | null;

export declare function interpolateAlphaMap(
	source: Float32Array,
	sourceSize: number,
	targetSize: number,
): Float32Array;

export declare function removeWatermark(
	imageData: WatermarkImageData,
	alphaMap: Float32Array,
	position: { x: number; y: number; width: number; height: number },
	options?: { alphaGain?: number; logoValue?: number },
): void;

export declare function detectWatermarkConfig(
	width: number,
	height: number,
): {
	logoSize: number;
	marginRight: number;
	marginBottom: number;
	alphaVariant?: string;
} | null;

export declare function calculateWatermarkPosition(
	width: number,
	height: number,
	config: {
		logoSize: number;
		marginRight: number;
		marginBottom: number;
	},
): { x: number; y: number; width: number; height: number } | null;
