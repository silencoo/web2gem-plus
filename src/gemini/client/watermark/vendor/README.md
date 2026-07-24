# GargantuaX watermark core (vendored)

Source: [GargantuaX/gemini-watermark-remover](https://github.com/GargantuaX/gemini-watermark-remover) userscript (`dist/watermark.js`).

DOM / Tampermonkey hooks are stripped; only `processWatermarkImageData` + `WatermarkEngine` are exported for the Worker image pipeline.

The upstream MIT LICENSE is included at [`LICENSE`](./LICENSE) in this directory, verbatim, so the copyright and permission notices ship with substantial portions of the Software as required by the MIT terms.

To refresh after dropping a new `dist/watermark.js`:

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "fs";
const src = readFileSync("./dist/watermark.js", "utf8");
const start = src.indexOf("(() => {");
let body = src.slice(start).replace(
  /if \(true\) \{\s*void initGeminiWatermarkRemoverUserscript\(\);\s*\}\s*\}\)\(\);?\s*$/,
  `globalThis.__GEMINI_WATERMARK_CORE__ = {
  processWatermarkImageData, WatermarkEngine, getEmbeddedAlphaMap,
  interpolateAlphaMap, removeWatermark,
  detectWatermarkConfig: typeof detectWatermarkConfig === "function" ? detectWatermarkConfig : null,
  calculateWatermarkPosition: typeof calculateWatermarkPosition === "function" ? calculateWatermarkPosition : null,
};
})();
`,
);
writeFileSync(
  "./src/gemini/client/watermark/vendor/gargantua-core.js",
  `/** Vendored GargantuaX core. */\n${body}\nconst __core = globalThis.__GEMINI_WATERMARK_CORE__;\nexport const processWatermarkImageData = __core.processWatermarkImageData;\nexport const WatermarkEngine = __core.WatermarkEngine;\nexport const getEmbeddedAlphaMap = __core.getEmbeddedAlphaMap;\nexport const interpolateAlphaMap = __core.interpolateAlphaMap;\nexport const removeWatermark = __core.removeWatermark;\nexport const detectWatermarkConfig = __core.detectWatermarkConfig;\nexport const calculateWatermarkPosition = __core.calculateWatermarkPosition;\n`,
);
JS
```
