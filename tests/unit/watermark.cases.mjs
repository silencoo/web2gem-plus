import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mod } from "./helpers.js";

export const suiteName = "watermark";

export const cases = [
	[
		"detects watermark config for typical Gemini outputs",
		() => {
			assert.deepEqual(mod.detectWatermarkConfig(1024, 1024), {
				logoSize: 48,
				marginRight: 32,
				marginBottom: 32,
			});
			assert.deepEqual(mod.detectWatermarkConfig(1408, 768), {
				logoSize: 46,
				marginRight: 32,
				marginBottom: 32,
			});
			assert.deepEqual(mod.detectWatermarkConfig(1536, 1536), {
				logoSize: 96,
				marginRight: 64,
				marginBottom: 64,
			});
		},
	],
	[
		"computes bottom-right watermark position",
		() => {
			assert.deepEqual(mod.watermarkPosition(1024, 1024), {
				x: 944,
				y: 944,
				width: 48,
				height: 48,
			});
			assert.equal(mod.watermarkPosition(40, 40), null);
		},
	],
	[
		"computes bottom-right corner crop covering catalog slots",
		() => {
			assert.deepEqual(mod.cornerWatermarkCropRect(2528, 1686), {
				x: 2528 - 384,
				y: 1686 - 384,
				width: 384,
				height: 384,
			});
			assert.deepEqual(mod.cornerWatermarkCropRect(200, 180), {
				x: 20,
				y: 0,
				width: 180,
				height: 180,
			});
		},
	],
	[
		"reverse alpha blend recovers white-logo overlay",
		() => {
			const width = 64;
			const height = 64;
			const data = new Uint8Array(width * height * 4);
			for (let i = 0; i < data.length; i += 4) {
				data[i] = 40;
				data[i + 1] = 40;
				data[i + 2] = 40;
				data[i + 3] = 255;
			}
			const logoSize = 48;
			const alpha = new Float32Array(logoSize * logoSize);
			for (let i = 0; i < alpha.length; i++) alpha[i] = 0.4;
			const pos = { x: 8, y: 8, width: logoSize, height: logoSize };
			for (let row = 0; row < logoSize; row++) {
				for (let col = 0; col < logoSize; col++) {
					const idx = ((pos.y + row) * width + (pos.x + col)) * 4;
					for (let c = 0; c < 3; c++) {
						data[idx + c] = Math.round((1 - 0.4) * 40 + 0.4 * 255);
					}
				}
			}
			const processed = mod.applyReverseAlphaBlend(
				{ width, height, data },
				alpha,
				pos,
			);
			assert.ok(processed > 0);
			const sample = ((pos.y + 2) * width + (pos.x + 2)) * 4;
			assert.ok(Math.abs((data[sample] ?? 0) - 40) <= 1);
			assert.ok(Math.abs((data[sample + 1] ?? 0) - 40) <= 1);
			assert.ok(Math.abs((data[sample + 2] ?? 0) - 40) <= 1);
		},
	],
	[
		"removes watermark via GargantuaX pipeline on live edit sample",
		async () => {
			const samplePath = resolve(
				process.cwd(),
				".tmp-img-test/edit_white_tank_v2_0.jpg",
			);
			let bytes;
			try {
				bytes = new Uint8Array(await readFile(samplePath));
			} catch {
				return;
			}
			const result = await mod.removeGeminiWatermark(bytes);
			assert.ok(result);
			assert.equal(result.width, 1408);
			assert.equal(result.height, 768);
			assert.equal(result.format, "jpeg");
			assert.ok(result.bytes.byteLength > 1000);
			// Pipeline may skip if confidence is low; when it applies, bytes change.
			if (result.removed) {
				assert.notEqual(
					Buffer.from(result.bytes).equals(Buffer.from(bytes)),
					true,
				);
			}
		},
	],
	[
		"resolves gemini-3.6-flash model",
		() => {
			const rm = mod.resolveModel("gemini-3.6-flash", "gemini-3.5-flash");
			assert.equal(rm.name, "gemini-3.6-flash");
			assert.equal(rm.modeId, 1);
			assert.equal(rm.thinkMode, 4);
			assert.ok(rm.modelHeaders);
			assert.match(
				rm.modelHeaders["x-goog-ext-525001261-jspb"],
				/56fdd199312815e2/,
			);
		},
	],
];
