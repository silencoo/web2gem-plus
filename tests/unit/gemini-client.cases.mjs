import { assert } from "./assertions.js";
import {
	createMemoryCache,
	fakeSocketConnect,
	mod,
	withCaches,
	withConsoleLog,
	withFetch,
} from "./helpers.js";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Minimal PNG with patched IHDR dimensions (CRC intentionally ignored by size reader). */
function pngBytes(width, height) {
	const bytes = Uint8Array.from(mod.base64ToBytes(TINY_PNG_BASE64));
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

async function withoutTypedArrayEncodingMethods(run) {
	const base64Descriptor = Object.getOwnPropertyDescriptor(
		Uint8Array.prototype,
		"toBase64",
	);
	Object.defineProperty(Uint8Array.prototype, "toBase64", {
		value: undefined,
		configurable: true,
	});
	try {
		return await run();
	} finally {
		if (base64Descriptor)
			Object.defineProperty(Uint8Array.prototype, "toBase64", base64Descriptor);
		else delete Uint8Array.prototype.toBase64;
	}
}

function wrbLine(texts) {
	const inner = [null, null, null, null, [[null, texts]], "x".repeat(160)];
	return JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
}

function createTestGeminiSessionPool(seeds) {
	let stored;
	const storage = {
		transaction: async (callback) => callback(storage),
		get: async () => stored,
		put: async (_key, value) => {
			stored = structuredClone(value);
		},
	};
	const durablePool = new mod.GeminiSessionPool({ storage });
	const call = async (path, body) => {
		const response = await durablePool.fetch(
			new Request(`https://pool.test${path}`, {
				method: "POST",
				body: JSON.stringify(body),
			}),
		);
		return response.json();
	};
	const port = {
		acquire: (exclude = []) => call("/acquire", { seeds, exclude }),
		beginRotation: (lease) => call("/begin-rotation", { lease }),
		commitRotation: (rotation, cookie, sapisid) =>
			call("/commit-rotation", { rotation, cookie, sapisid }),
		abortRotation: async (rotation) => {
			await call("/abort-rotation", { rotation });
		},
		failRotation: async (rotation, issue = "auth") => {
			await call("/fail-rotation", { rotation, issue });
		},
		markFailure: async (lease, issue) => {
			await call("/failure", { lease, issue });
		},
		markSuccess: async (lease) => {
			await call("/success", { lease });
		},
	};
	return { call, port, stored: () => structuredClone(stored) };
}

function richWrbLine(candidate) {
	const inner = [null, null, null, null, [candidate], "x".repeat(160)];
	return JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
}

function framedWrbRaw(candidate) {
	const inner = [
		null,
		["cid_1", "rid_1", "rcid_meta"],
		null,
		null,
		[candidate],
		"x".repeat(160),
	];
	const payload = JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
	const emptyPayload = JSON.stringify([
		[
			"wrb.fr",
			null,
			JSON.stringify([null, null, null, null, [], "x".repeat(160)]),
		],
	]);
	return `)]}'\n\n${payload.length}\n${payload}${emptyPayload.length}\n${emptyPayload}`;
}

function fatalWrbLine(code, location = "inner") {
	const inner = [null, null, null, null, []];
	const envelope = ["wrb.fr", null, JSON.stringify(inner)];
	const target = location === "envelope" ? envelope : inner;
	target[5] = [];
	target[5][2] = [];
	target[5][2][0] = [];
	target[5][2][0][1] = [code];
	if (location !== "envelope") envelope[2] = JSON.stringify(inner);
	return JSON.stringify([envelope]);
}

function generatedImageEntry(
	url = "https://lh3.googleusercontent.com/generated=s1024-rj",
	id = "img_1",
) {
	const meta = [];
	meta[3] = [];
	meta[3][2] = "generated alt";
	meta[3][3] = url;
	return [meta, [id]];
}

function generatedImageCandidate(
	text = "final text",
	url = "https://lh3.googleusercontent.com/generated=s1024-rj",
	id = "img_1",
) {
	const candidate = [];
	candidate[0] = "rcid_1";
	candidate[1] = [text];
	candidate[8] = [2];
	candidate[12] = [];
	candidate[12][7] = [[generatedImageEntry(url, id)]];
	return candidate;
}

function richGeneratedImageWrbLine(
	url = "https://lh3.googleusercontent.com/gg-dl/AFfU-preview",
	id = "CAESImg_fullsize_1",
) {
	const candidate = generatedImageCandidate("", url, id);
	const inner = [
		null,
		["cid_full", "rid_full", "rcid_meta"],
		null,
		null,
		[candidate],
		"x".repeat(160),
	];
	return JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
}

function webImageEntry(url = "https://images.example/web.png") {
	const meta = [];
	meta[0] = [url];
	meta[4] = "web alt";
	const entry = [];
	entry[0] = meta;
	entry[7] = ["web title"];
	return entry;
}

function webImageCandidate(
	text = "web result",
	url = "https://images.example/web.png",
) {
	const candidate = [];
	candidate[22] = [text];
	candidate[8] = [2];
	candidate[12] = [];
	candidate[12][1] = [[webImageEntry(url)]];
	return candidate;
}

function baseGeminiClientConfig(overrides = {}) {
	return {
		gemini_origin: "https://gemini.example",
		gemini_bl: "boq_test",
		cookie: "",
		sapisid: "",
		request_timeout_sec: 180,
		retry_attempts: 1,
		retry_delay_sec: 0,
		current_input_file_min_bytes: 1000000,
		upstream_socket: false,
		log_requests: false,
		...overrides,
	};
}

function textResponse(text) {
	return new Response(text);
}

async function assertRejectsWithCode(run, code) {
	try {
		await run();
	} catch (err) {
		assert.equal(err.code, code);
		return;
	}
	throw new Error(`expected rejection with code ${code}`);
}

export const suiteName = "gemini client";
export const cases = [
	[
		"strips generated code artifacts from Gemini text",
		async () => {
			const source = [
				"keep",
				"```python?code_reference&code_event_index=1",
				"drop",
				"```",
				"http://googleusercontent.com/card_content/123",
				"http://googleusercontent.com/image_generation_content/0",
			].join("\n");
			assert.equal(mod.stripArtifacts(source).trim(), "keep");
			assert.equal(mod.cleanText(`  ${source}  `), "keep");
		},
	],
	[
		"extracts longest response text from WRB lines",
		async () => {
			const line = wrbLine(["short", "longer response"]);
			assert.deepEqual(mod.extractTextsFromLine(line), [
				"short",
				"longer response",
			]);
			assert.deepEqual(mod.extractTextsFromLine(` \t${line}`), [
				"short",
				"longer response",
			]);
			assert.deepEqual(
				mod.extractTextsFromLine(
					JSON.stringify([
						[
							"wrb.fr",
							null,
							JSON.stringify([null, null, null, null, [[null, ["tiny"]]]]),
						],
					]),
				),
				["tiny"],
			);
			assert.deepEqual(mod.extractTextsFromLine("not json"), []);
			assert.deepEqual(
				mod.extractTextsFromLine(`${"x".repeat(220)} "wrb.fr"`),
				[],
			);
			assert.deepEqual(
				mod.extractTextsFromLine(JSON.stringify([["wrb.fr", null, "{"]])),
				[],
			);
			assert.match(
				mod.wrbResponseShapeSummary(JSON.stringify([["wrb.fr", null, "{"]])),
				/topIssue=invalid_inner_json:1/,
			);

			const raw = [wrbLine(["first"]), wrbLine(["first plus more"])].join("\n");
			assert.equal(mod.extractResponseText(raw), "first plus more");
			assert.match(mod.wrbResponseShapeSummary(raw), /wrbLines=2/);
			assert.match(mod.wrbResponseShapeSummary(raw), /textParts=2/);
		},
	],
	[
		"extracts rich generated image parts without changing text extraction",
		async () => {
			const raw = richWrbLine(generatedImageCandidate("image ready"));
			const parts = mod.extractResponseParts(raw);
			assert.equal(mod.extractResponseText(raw), "image ready");
			assert.equal(parts.text, "image ready");
			assert.equal(parts.generatedImageCount, 1);
			assert.equal(parts.webImageCount, 0);
			assert.equal(parts.images[0].source, "generated");
			assert.equal(
				parts.images[0].url,
				"https://lh3.googleusercontent.com/generated=s1024-rj",
			);
			assert.equal(parts.images[0].imageId, "img_1");
			assert.match(mod.richResponseShapeSummary(raw), /generatedImages=1/);
		},
	],
	[
		"extracts rich web image metadata and card text",
		async () => {
			const raw = richWrbLine(webImageCandidate("card answer"));
			const parts = mod.extractResponseParts(raw);
			assert.equal(parts.text, "card answer");
			assert.equal(parts.generatedImageCount, 0);
			assert.equal(parts.webImageCount, 1);
			assert.equal(parts.images[0].source, "web");
			assert.equal(parts.images[0].url, "https://images.example/web.png");
			assert.equal(parts.images[0].alt, "web alt");
			assert.equal(parts.images[0].title, "web title");
		},
	],
	[
		"strips generated-image placeholder text while keeping rich images",
		async () => {
			const raw = richWrbLine(
				generatedImageCandidate(
					"http://googleusercontent.com/image_generation_content/0",
				),
			);
			const parts = mod.extractResponseParts(raw);
			assert.equal(parts.text, "");
			assert.equal(parts.generatedImageCount, 1);
			assert.equal(
				parts.images[0].url,
				"https://lh3.googleusercontent.com/generated=s1024-rj",
			);
		},
	],
	[
		"prefers completed or richer repeated candidate states",
		async () => {
			const incompleteTextOnly = [];
			incompleteTextOnly[1] = ["draft"];

			const completedGenerated = generatedImageCandidate("final");
			const completedFirst = [
				richWrbLine(incompleteTextOnly),
				richWrbLine(completedGenerated),
			].join("\n");
			const completedParts = mod.extractResponseParts(completedFirst);
			assert.equal(completedParts.text, "final");
			assert.equal(completedParts.generatedImageCount, 1);

			const laterIncomplete = generatedImageCandidate(
				"later incomplete with longer text",
			);
			laterIncomplete[8] = [1];
			const keepCompleted = [
				richWrbLine(completedGenerated),
				richWrbLine(laterIncomplete),
			].join("\n");
			const keepCompletedParts = mod.extractResponseParts(keepCompleted);
			assert.equal(keepCompletedParts.text, "final");
			assert.equal(keepCompletedParts.generatedImageCount, 1);

			const richerIncomplete = generatedImageCandidate("richer");
			richerIncomplete[8] = [1];
			const richerParts = mod.extractResponseParts(
				[richWrbLine(incompleteTextOnly), richWrbLine(richerIncomplete)].join(
					"\n",
				),
			);
			assert.equal(richerParts.text, "richer");
			assert.equal(richerParts.generatedImageCount, 1);
		},
	],
	[
		"handles malformed rich envelopes and invalid framed chunks without throwing",
		async () => {
			assert.equal(mod.extractResponseParts(null).text, "");
			assert.equal(
				mod.extractResponseParts(JSON.stringify([["wrb.fr", null, null]]))
					.candidateCount,
				0,
			);
			assert.equal(
				mod.extractResponseParts(JSON.stringify([["wrb.fr", null, "{"]]))
					.candidateCount,
				0,
			);
			assert.equal(
				mod.extractResponseParts(
					JSON.stringify([
						[
							"wrb.fr",
							null,
							JSON.stringify([null, null, null, null, ["not an array"]]),
						],
					]),
				).candidateCount,
				1,
			);
			assert.equal(mod.extractResponseParts(")]}'\n\n0\n[]").candidateCount, 0);
			assert.equal(
				mod.extractResponseParts(")]}'\n\n999\n[]").candidateCount,
				0,
			);
			assert.equal(
				mod.extractResponseParts(")]}'\n\n5\nnot-json").candidateCount,
				0,
			);
			assert.equal(
				mod.extractResponseParts(")]}'\n\n1x\n[]").candidateCount,
				0,
			);
		},
	],
	[
		"extracts image-to-image generated image path and does not merge alternatives",
		async () => {
			const first = [];
			first[1] = ["first candidate"];
			first[8] = [2];
			first[12] = [];
			first[12][0] = {
				8: [
					[
						generatedImageEntry(
							"https://lh3.googleusercontent.com/first=s1024-rj",
							"first-id",
						),
					],
				],
			};

			const second = generatedImageCandidate("second candidate");
			second[12][7] = [
				[
					generatedImageEntry(
						"https://lh3.googleusercontent.com/second=s1024-rj",
						"second-id",
					),
				],
			];

			const inner = [null, null, null, null, [first, second], "x".repeat(160)];
			const raw = JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
			const parts = mod.extractResponseParts(raw);
			assert.equal(parts.text, "first candidate");
			assert.equal(parts.generatedImageCount, 1);
			assert.equal(
				parts.images[0].url,
				"https://lh3.googleusercontent.com/first=s1024-rj",
			);
		},
	],
	[
		"does not attach alternative candidate text to selected image-only candidate",
		async () => {
			const imageOnly = generatedImageCandidate("");
			const textOnly = [];
			textOnly[1] = ["alternative candidate text"];
			textOnly[8] = [2];

			const inner = [
				null,
				null,
				null,
				null,
				[imageOnly, textOnly],
				"x".repeat(160),
			];
			const raw = JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
			const parts = mod.extractResponseParts(raw);
			assert.equal(parts.text, "");
			assert.equal(parts.generatedImageCount, 1);
			assert.equal(
				parts.images[0].url,
				"https://lh3.googleusercontent.com/generated=s1024-rj",
			);
		},
	],
	[
		"keeps default first-candidate selection even when alternatives contain images",
		async () => {
			const selectedTextOnly = [];
			selectedTextOnly[1] = ["selected text only"];
			selectedTextOnly[8] = [2];

			const alternativeImage = generatedImageCandidate("alternative image");
			alternativeImage[12][7] = [
				[
					generatedImageEntry(
						"https://lh3.googleusercontent.com/alternative=s1024-rj",
						"alt-id",
					),
				],
			];

			const inner = [
				null,
				null,
				null,
				null,
				[selectedTextOnly, alternativeImage],
				"x".repeat(160),
			];
			const raw = JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
			const parts = mod.extractResponseParts(raw);
			assert.equal(parts.text, "selected text only");
			assert.equal(parts.generatedImageCount, 0);
			assert.equal(parts.images.length, 0);
		},
	],
	[
		"extracts rich generated images from length-prefixed frames",
		async () => {
			const candidate = generatedImageCandidate("image 🟦 ready");
			candidate[0] = "rcid_1";
			const raw = framedWrbRaw(candidate);
			const parts = mod.extractResponseParts(raw);
			assert.equal(parts.text, "image 🟦 ready");
			assert.equal(parts.generatedImageCount, 1);
			assert.equal(
				parts.images[0].url,
				"https://lh3.googleusercontent.com/generated=s1024-rj",
			);
			assert.equal(parts.images[0].cid, "cid_1");
			assert.equal(parts.images[0].rid, "rid_1");
			assert.equal(parts.images[0].rcid, "rcid_1");
		},
	],
	[
		"maps numeric Gemini fatal part codes from inner payloads and envelopes",
		async () => {
			assert.equal(
				mod.extractResponseParts(fatalWrbLine(1013)).fatalCode,
				"1013",
			);
			assert.equal(
				mod.extractResponseParts(fatalWrbLine(1052, "envelope")).fatalCode,
				"1052",
			);
			assert.match(
				mod.richResponseShapeSummary(fatalWrbLine(1060)),
				/fatalCode=1060/,
			);
		},
	],
	[
		"dedupes repeated rich generated image frames",
		async () => {
			const raw = [
				richWrbLine(generatedImageCandidate("progress")),
				richWrbLine(generatedImageCandidate("progress done")),
			].join("\n");
			const parts = mod.extractResponseParts(raw);
			assert.equal(parts.text, "progress done");
			assert.equal(parts.generatedImageCount, 1);
		},
	],
	[
		"resolves full-size generated image urls before CDN preview variants",
		async () => {
			assert.deepEqual(
				mod.fullSizeImageRefsFromParsed({
					url: "https://lh3.googleusercontent.com/gg-dl/preview",
					source: "generated",
					cid: "cid",
					rid: "rid",
					rcid: "rcid",
					imageId: "img_real",
				}),
				{ cid: "cid", rid: "rid", rcid: "rcid", imageId: "img_real" },
			);
			// Web download uses synthetic image_generation_content ids with real refs.
			assert.deepEqual(
				mod.fullSizeImageRefsFromParsed({
					url: "https://lh3.googleusercontent.com/gg-dl/preview",
					source: "generated",
					cid: "c_c8098be7357bbc2c",
					rid: "rid",
					rcid: "rcid",
					imageId: "http://googleusercontent.com/image_generation_content/0",
				}),
				{
					cid: "c_c8098be7357bbc2c",
					rid: "rid",
					rcid: "rcid",
					imageId: "http://googleusercontent.com/image_generation_content/0",
				},
			);
			assert.equal(
				mod.fullSizeImageRefsFromParsed({
					url: "https://lh3.googleusercontent.com/gg-dl/preview",
					source: "generated",
					cid: "",
					rid: "rid",
					rcid: "rcid",
					imageId: "img_real",
				}),
				null,
			);
			assert.equal(
				mod.fullSizeSourcePath("c_c8098be7357bbc2c"),
				"/app/c8098be7357bbc2c",
			);
			assert.deepEqual(
				mod.fullSizeDownloadProbeUrls(
					"https://lh3.googleusercontent.com/gg/ACRw-full",
				),
				[
					"https://lh3.googleusercontent.com/gg/ACRw-full=s0-d-I?alr=yes",
					"https://lh3.googleusercontent.com/gg/ACRw-full=d-I?alr=yes",
					"https://lh3.googleusercontent.com/gg/ACRw-full?alr=yes",
					"https://lh3.googleusercontent.com/rd-gg/ACRw-full=s0-d-I?alr=yes",
					"https://lh3.googleusercontent.com/rd-gg/ACRw-full=d-I?alr=yes",
					"https://lh3.googleusercontent.com/rd-gg/ACRw-full?alr=yes",
				],
			);
			assert.equal(
				mod.rewriteGoogleusercontentGgToRdGg(
					"https://lh3.googleusercontent.com/gg/ACRw-full?alr=yes",
				),
				"https://lh3.googleusercontent.com/rd-gg/ACRw-full?alr=yes",
			);
			assert.equal(
				mod.fullSizeDownloadTransformUrl(
					"https://lh3.googleusercontent.com/gg/ACRw-full",
				),
				"https://lh3.googleusercontent.com/gg/ACRw-full=s0-d-I?alr=yes",
			);

			const refs20 = {
				cid: "c_c8098be7357bbc2c",
				rid: "r_1",
				rcid: "rc_1",
				imageId: "http://googleusercontent.com/image_generation_content/364",
				mediaToken: "$AVtesttoken0123456789abcdefghijk",
				mediaId: "bd48xubd48xubd48",
			};
			const payload19 = mod.buildFullSizeImageRpcPayload(refs20, { mode: 19 });
			assert.equal(payload19[0][3][0], 19);
			assert.equal(payload19[0][9], "");
			const payload20 = mod.buildFullSizeImageRpcPayload(refs20, {
				mode: 20,
			});
			assert.equal(payload20[0][3][0], 20);
			assert.equal(payload20[0][3][1], "");
			assert.equal(payload20[0][3][18], "imagen_default.complaintflow");
			assert.equal(payload20[0][0][3][5], refs20.mediaToken);
			assert.equal(payload20[0][9], refs20.mediaId);
			assert.equal(payload20[1][4], refs20.mediaId);
			const payload20Upscale = mod.buildFullSizeImageRpcPayload(refs20, {
				mode: 20,
				upscalePrompt: "Upscale this image to true 4K resolution",
			});
			assert.match(String(payload20Upscale[0][3][1]), /4K/i);
			assert.deepEqual(
				mod.extractGeneratedImageMediaMeta([
					[{}, ["http://googleusercontent.com/image_generation_content/1"]],
					[
						"$AVtesttoken0123456789abcdefghijk",
						"bd48xubd48xubd48",
						"image/png",
					],
				]),
				{
					mediaToken: "$AVtesttoken0123456789abcdefghijk",
					mediaId: "bd48xubd48xubd48",
				},
			);
			const primaryMeta = [];
			primaryMeta[3] = "https://lh3.googleusercontent.com/gg/preview-a";
			primaryMeta[5] = "$AVprimarytoken0123456789abcdefgh";
			const secondaryMeta = [];
			secondaryMeta[3] = "https://lh3.googleusercontent.com/gg/preview-b";
			secondaryMeta[5] = "$AVsecondarytoken0123456789abcdef";
			const historyEntry = [
				[null, null, null, primaryMeta, secondaryMeta],
				["http://googleusercontent.com/image_generation_content/364"],
			];
			assert.equal(
				mod.extractGeneratedImageMediaMeta(historyEntry).mediaToken,
				"$AVprimarytoken0123456789abcdefgh",
			);
			assert.equal(
				mod.normalizeConversationId("c8098be7357bbc2c"),
				"c_c8098be7357bbc2c",
			);
			assert.equal(
				mod.normalizeConversationId("c_c8098be7357bbc2c"),
				"c_c8098be7357bbc2c",
			);
			assert.deepEqual(
				mod.buildConversationHistoryRpcPayload("c8098be7357bbc2c"),
				["c_c8098be7357bbc2c", 10, null, 1, [0], [4], null, 1],
			);
			assert.deepEqual(
				mod.fullSizeResolveModesForImage({
					url: "https://lh3.googleusercontent.com/gg/x",
					source: "generated",
					mediaToken: "$AVtoken",
				}),
				[20, 19],
			);
			assert.deepEqual(
				mod.fullSizeResolveModesForImage({
					url: "https://lh3.googleusercontent.com/gg/x",
					source: "generated",
				}),
				[19],
			);

			const historyInner = [
				[["c_c8098be7357bbc2c", "r_1", "rc_1", historyEntry]],
			];
			const historyPayload = JSON.stringify([
				["wrb.fr", "hNvQHb", JSON.stringify(historyInner)],
			]);
			const historyBody = `)]}'\n${historyPayload.length}\n${historyPayload}`;
			const fromHistory =
				mod.extractGeneratedImagesFromConversationHistory(historyBody);
			assert.equal(fromHistory.length >= 1, true);
			assert.equal(
				fromHistory[0].mediaToken,
				"$AVprimarytoken0123456789abcdefgh",
			);
			assert.equal(
				fromHistory[0].imageId,
				"http://googleusercontent.com/image_generation_content/364",
			);
			const merged = mod.mergeConversationHistoryMediaIntoImages(
				[
					{
						url: "https://lh3.googleusercontent.com/gg/preview-a?alr=yes",
						source: "generated",
						imageId:
							"http://googleusercontent.com/image_generation_content/364",
						cid: "c_c8098be7357bbc2c",
					},
				],
				fromHistory,
			);
			assert.equal(merged[0].mediaToken, "$AVprimarytoken0123456789abcdefgh");

			// StreamGenerate synthetic /0 id + different URL still picks newest history token.
			const mismatched = mod.mergeConversationHistoryMediaIntoImages(
				[
					{
						url: "https://lh3.googleusercontent.com/gg-dl/stream-preview",
						source: "generated",
						imageId: "http://googleusercontent.com/image_generation_content/0",
						cid: "c_c8098be7357bbc2c",
					},
				],
				[
					{
						url: "https://lh3.googleusercontent.com/gg/old",
						source: "generated",
						imageId:
							"http://googleusercontent.com/image_generation_content/100",
						mediaToken: "$AVoldtoken0123456789abcdefghijkl",
					},
					{
						url: "https://lh3.googleusercontent.com/gg/new",
						source: "generated",
						imageId:
							"http://googleusercontent.com/image_generation_content/364",
						mediaToken: "$AVnewtoken0123456789abcdefghijkl",
					},
				],
			);
			assert.equal(
				mismatched[0].mediaToken,
				"$AVnewtoken0123456789abcdefghijkl",
			);
			assert.equal(
				mismatched[0].imageId,
				"http://googleusercontent.com/image_generation_content/364",
			);

			// hNvQHb nests identity tuples as siblings of the image body.
			const siblingHistory = [
				[
					["c_siblingcid", "r_siblingrid", "rc_siblingrcid"],
					null,
					null,
					historyEntry,
				],
			];
			const siblingPayload = JSON.stringify([
				["wrb.fr", "hNvQHb", JSON.stringify(siblingHistory)],
			]);
			const siblingBody = `)]}'\n${siblingPayload.length}\n${siblingPayload}`;
			const fromSibling =
				mod.extractGeneratedImagesFromConversationHistory(siblingBody);
			assert.equal(fromSibling[0]?.cid, "c_siblingcid");
			assert.equal(fromSibling[0]?.rid, "r_siblingrid");
			assert.equal(fromSibling[0]?.rcid, "rc_siblingrcid");
			assert.equal(
				fromSibling[0]?.mediaToken,
				"$AVprimarytoken0123456789abcdefgh",
			);

			const framed = `)]}'\n18\n${JSON.stringify([["wrb.fr", null, JSON.stringify(["https://lh3.googleusercontent.com/full-orig"])]])}`;
			const frames = mod.extractBatchExecuteFrames(framed);
			assert.equal(Array.isArray(frames[0]), true);
			assert.equal(
				JSON.parse(frames[0][2])[0],
				"https://lh3.googleusercontent.com/full-orig",
			);

			const cfg = {
				...baseGeminiClientConfig(),
				cookie: "__Secure-1PSID=psid; SAPISID=sapi",
				log_requests: false,
			};
			const previewUrl = "https://lh3.googleusercontent.com/gg-dl/AFfU-preview";
			const fullPng = pngBytes(2048, 1536);
			const smallPng = pngBytes(512, 512);
			const calls = [];
			await withFetch(
				async (url, init) => {
					const target = String(url);
					calls.push(target);
					if (target.includes("/app") && init?.method !== "POST") {
						return new Response(
							'{"SNlM0e":"at-test","FdrFJe":"sid-test","qKIAYe":"push"}',
							{ status: 200 },
						);
					}
					if (target.includes("batchexecute")) {
						assert.match(target, /source-path=%2Fapp%2Fcid_full/);
						const body = JSON.stringify([
							[
								"wrb.fr",
								null,
								JSON.stringify([
									"https://lh3.googleusercontent.com/gg/ACRw-full-orig",
								]),
							],
						]);
						return new Response(`)]}'\n${body.length}\n${body}`, {
							status: 200,
						});
					}
					// Web-style /gg/?alr=yes → text URL hops → final image URL
					if (
						target ===
						"https://lh3.googleusercontent.com/gg/ACRw-full-orig?alr=yes"
					) {
						return new Response(
							"https://lh3.google.com/rd-gg/ACRw-step-2?alr=yes",
							{ status: 200, headers: { "content-type": "text/plain" } },
						);
					}
					if (target === "https://lh3.google.com/rd-gg/ACRw-step-2?alr=yes") {
						return new Response(
							"https://lh3.googleusercontent.com/rd-gg/ACRw-final?alr=yes",
							{ status: 200, headers: { "content-type": "text/plain" } },
						);
					}
					if (
						target ===
						"https://lh3.googleusercontent.com/rd-gg/ACRw-final?alr=yes"
					) {
						return new Response(fullPng, {
							status: 200,
							headers: { "content-type": "image/png" },
						});
					}
					if (target.includes("StreamGenerate")) {
						return new Response(richGeneratedImageWrbLine(previewUrl), {
							status: 200,
						});
					}
					if (target.startsWith(previewUrl)) {
						return new Response(smallPng, { status: 200 });
					}
					return new Response("not found", { status: 404 });
				},
				async () => {
					const rich = await mod.generateRich(
						cfg,
						"draw image",
						1,
						4,
						null,
						null,
					);
					assert.equal(rich.images.length, 1);
					assert.deepEqual(
						mod.readImageSize(mod.base64ToBytes(rich.images[0].base64)),
						{ width: 2048, height: 1536 },
					);
				},
			);
			assert.equal(
				calls.some((url) => url.includes("batchexecute")),
				true,
			);
			assert.equal(
				calls.includes(
					"https://lh3.googleusercontent.com/gg/ACRw-full-orig?alr=yes",
				),
				true,
			);
			assert.equal(
				calls.includes(
					"https://lh3.googleusercontent.com/rd-gg/ACRw-final?alr=yes",
				),
				true,
			);
		},
	],
	[
		"keeps CDN 4K early-stop before full-size upgrade",
		async () => {
			const cfg = {
				...baseGeminiClientConfig(),
				cookie: "__Secure-1PSID=psid; SAPISID=sapi",
				log_requests: false,
			};
			const previewUrl = "https://lh3.googleusercontent.com/gg-dl/AFfU-maxhunt";
			const fullPng = pngBytes(2048, 1536);
			const fourKPng = pngBytes(3840, 2160);
			const calls = [];
			await withFetch(
				async (url, init) => {
					const target = String(url);
					calls.push(target);
					if (target.includes("/app") && init?.method !== "POST") {
						return new Response(
							'{"SNlM0e":"at-test","FdrFJe":"sid-test","qKIAYe":"push"}',
							{ status: 200 },
						);
					}
					if (target.includes("batchexecute")) {
						const body = JSON.stringify([
							[
								"wrb.fr",
								null,
								JSON.stringify([
									"https://lh3.googleusercontent.com/full-orig-2k",
								]),
							],
						]);
						return new Response(`)]}'\n${body.length}\n${body}`, {
							status: 200,
						});
					}
					if (
						target ===
							"https://lh3.googleusercontent.com/full-orig-2k?alr=yes" ||
						target.includes("=s0-d-I?alr=yes") ||
						target.includes("=d-I?alr=yes")
					) {
						return new Response(
							"https://lh3.googleusercontent.com/full-final-2k.jpg",
							{ status: 200, headers: { "content-type": "text/plain" } },
						);
					}
					if (
						target === "https://lh3.googleusercontent.com/full-final-2k.jpg"
					) {
						return new Response(fullPng, {
							status: 200,
							headers: { "content-type": "image/png" },
						});
					}
					if (target.includes("StreamGenerate")) {
						return new Response(richGeneratedImageWrbLine(previewUrl), {
							status: 200,
						});
					}
					if (target === `${previewUrl}=s4096-rj`) {
						return new Response(fourKPng, { status: 200 });
					}
					if (target.startsWith(previewUrl)) {
						return new Response(fullPng, { status: 200 });
					}
					return new Response("not found", { status: 404 });
				},
				async () => {
					const rich = await mod.generateRich(
						cfg,
						"draw image",
						1,
						4,
						null,
						null,
					);
					assert.deepEqual(
						mod.readImageSize(mod.base64ToBytes(rich.images[0].base64)),
						{ width: 3840, height: 2160 },
					);
				},
			);
			// CDN-first early-stops on preferred 4K; full-size upgrade is skipped.
			assert.equal(calls.includes(`${previewUrl}=s4096-rj`), true);
			assert.equal(
				calls.includes("https://lh3.googleusercontent.com/full-final-2k.jpg"),
				false,
			);
		},
	],
	[
		"preserves generated image URL candidates and browser headers",
		async () => {
			const previewUrl = "https://lh3.googleusercontent.com/generated=s1024-rj";
			const previewCandidates = mod.generatedImagePreviewFetchUrls(previewUrl);
			assert.equal(
				previewCandidates[0],
				"https://lh3.googleusercontent.com/generated=s4096-rj",
			);
			assert.equal(
				previewCandidates[1],
				"https://lh3.googleusercontent.com/generated=s2048-rj",
			);
			assert.equal(previewCandidates.includes(previewUrl), true);
			assert.equal(
				mod.stripGoogleusercontentSizeSuffix(previewUrl),
				"https://lh3.googleusercontent.com/generated",
			);

			const directUrl =
				"https://lh3.googleusercontent.com/gg-dl/AFfU-direct-image";
			const directCandidates = mod.generatedImagePreviewFetchUrls(directUrl);
			assert.equal(directCandidates[0], `${directUrl}=s4096-rj`);
			assert.equal(directCandidates[1], `${directUrl}=s2048-rj`);
			assert.equal(directCandidates.includes(directUrl), true);
			assert.equal(
				directCandidates.indexOf(`${directUrl}=s4096-rj`) <
					directCandidates.indexOf(directUrl),
				true,
			);

			const alreadyLarge =
				"https://lh3.googleusercontent.com/generated=s2048-rj";
			const largeCandidates = mod.generatedImagePreviewFetchUrls(alreadyLarge);
			assert.equal(
				largeCandidates[0],
				"https://lh3.googleusercontent.com/generated=s4096-rj",
			);
			assert.equal(largeCandidates.includes(alreadyLarge), true);

			assert.equal(
				mod.isPreferredGeneratedImage({
					width: 1024,
					height: 1024,
					pixels: 1024 * 1024,
				}),
				false,
			);
			assert.equal(
				mod.isPreferredGeneratedImage({
					width: 2048,
					height: 2048,
					pixels: 2048 * 2048,
				}),
				false,
			);
			assert.equal(
				mod.isPreferredGeneratedImage({
					width: 3840,
					height: 2160,
					pixels: 3840 * 2160,
				}),
				true,
			);
			assert.equal(
				mod.isPreferredGeneratedImage({
					width: 512,
					height: 512,
					pixels: 512 * 512,
				}),
				false,
			);

			const headers = mod.generatedImageFetchHeaders({
				cookie: "__Secure-1PSID=value",
			});
			assert.equal(
				headers.Accept,
				"image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
			);
			assert.equal(headers["Accept-Language"], "en-US,en;q=0.9");
			assert.equal(headers.Origin, "https://gemini.google.com");
			assert.equal(headers.Referer, "https://gemini.google.com/app");
			assert.match(headers["User-Agent"], /Mozilla\/5\.0/);
			assert.equal(headers.Cookie, "__Secure-1PSID=value");
			assert.equal(headers.Authorization, undefined);
			assert.equal(
				mod.generatedImageFetchHeaders({ cookie: "" }).Cookie,
				undefined,
			);
		},
	],
	[
		"prefers high-res CDN variants over raw gg-dl preview URLs",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const imageUrl =
				"https://lh3.googleusercontent.com/gg-dl/AFfU-direct-image";
			const largePng = pngBytes(2048, 2048);
			const smallPng = mod.base64ToBytes(TINY_PNG_BASE64);
			const calls = [];
			await withFetch(
				async (url) => {
					calls.push(String(url));
					if (String(url).includes("StreamGenerate")) {
						return new Response(
							richWrbLine(generatedImageCandidate("", imageUrl)),
							{ status: 200 },
						);
					}
					if (String(url) === `${imageUrl}=s4096-rj`) {
						return new Response(largePng, {
							status: 200,
							headers: { "content-type": "image/png" },
						});
					}
					if (String(url) === imageUrl) {
						return new Response(smallPng, {
							status: 200,
							headers: { "content-type": "image/png" },
						});
					}
					return new Response("not found", { status: 404 });
				},
				async () => {
					const rich = await mod.generateRich(
						cfg,
						"draw image",
						1,
						4,
						null,
						null,
					);
					assert.equal(rich.text, "");
					assert.equal(rich.images.length, 1);
					assert.equal(rich.images[0].url, imageUrl);
					assert.equal(rich.images[0].outputFormat, "png");
					assert.deepEqual(
						mod.readImageSize(mod.base64ToBytes(rich.images[0].base64)),
						{
							width: 2048,
							height: 2048,
						},
					);
				},
			);
			assert.match(
				calls[0],
				/^https:\/\/gemini\.example\/_\/BardChatUi\/data\/assistant\.lamda\.BardFrontendService\/StreamGenerate\?/,
			);
			assert.equal(calls[1], `${imageUrl}=s4096-rj`);
			assert.equal(calls.includes(`${imageUrl}=s2048-rj`), true);
		},
	],
	[
		"keeps the largest generated image when early CDN sizes are tiny previews",
		async () => {
			const cfg = baseGeminiClientConfig();
			const imageUrl =
				"https://lh3.googleusercontent.com/gg-dl/AFfU-keep-largest";
			const tiny = pngBytes(512, 512);
			const better = pngBytes(1280, 1280);
			const calls = [];
			await withFetch(
				async (url) => {
					calls.push(String(url));
					if (String(url).includes("StreamGenerate")) {
						return new Response(
							richWrbLine(generatedImageCandidate("", imageUrl)),
							{ status: 200 },
						);
					}
					if (String(url).endsWith("=s4096-rj")) {
						return new Response(tiny, { status: 200 });
					}
					if (String(url).endsWith("=s2048-rj")) {
						return new Response(better, { status: 200 });
					}
					return new Response("not found", { status: 404 });
				},
				async () => {
					const rich = await mod.generateRich(
						cfg,
						"draw image",
						1,
						4,
						null,
						null,
					);
					assert.deepEqual(
						mod.readImageSize(mod.base64ToBytes(rich.images[0].base64)),
						{ width: 1280, height: 1280 },
					);
				},
			);
			assert.equal(calls.includes(`${imageUrl}=s4096-rj`), true);
			assert.equal(calls.includes(`${imageUrl}=s2048-rj`), true);
		},
	],
	[
		"bounds individual and aggregate generated image hydration",
		async () => {
			assert.deepEqual(mod.DEFAULT_GENERATED_IMAGE_HYDRATION_LIMITS, {
				maxImageBytes: 16 * 1024 * 1024,
				maxTotalBytes: 48 * 1024 * 1024,
			});
			const cfg = baseGeminiClientConfig();
			const tinyPng = mod.base64ToBytes(TINY_PNG_BASE64);
			let canceled = false;
			let calls = 0;
			await withFetch(
				async () => {
					calls += 1;
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(tinyPng);
							},
							cancel() {
								canceled = true;
							},
						}),
						{ status: 200 },
					);
				},
				async () => {
					const oversized = await mod.hydrateGeneratedImages(
						cfg,
						cfg,
						[
							{
								url: "https://images.example/oversized.png",
								source: "generated",
							},
						],
						{ maxImageBytes: tinyPng.byteLength - 1, maxTotalBytes: 1000 },
					);
					assert.equal(oversized[0].base64, undefined);
				},
			);
			assert.equal(calls, 1);
			assert.equal(canceled, true);

			calls = 0;
			await withFetch(
				async () => {
					calls += 1;
					return new Response(tinyPng, { status: 200 });
				},
				async () => {
					const images = await mod.hydrateGeneratedImages(
						cfg,
						cfg,
						[
							{ url: "https://images.example/one.png", source: "generated" },
							{ url: "https://images.example/two.png", source: "generated" },
						],
						{
							maxImageBytes: tinyPng.byteLength,
							maxTotalBytes: tinyPng.byteLength + 1,
						},
					);
					assert.equal(images[0].base64, TINY_PNG_BASE64);
					assert.equal(images[1].base64, undefined);
				},
			);
			// First image probes CDN size variants; second image is skipped after
			// the aggregate byte budget is nearly exhausted.
			const firstImageCandidates = mod.generatedImagePreviewFetchUrls(
				"https://images.example/one.png",
			).length;
			assert.equal(calls, firstImageCandidates + 1);
		},
	],
	[
		"fetches s1024 generated image fallback URLs and detects jpeg bytes",
		async () => {
			const cfg = baseGeminiClientConfig();
			const imageUrl = "https://lh3.googleusercontent.com/generated=s1024-rj";
			const calls = [];
			await withFetch(
				async (url) => {
					calls.push(String(url));
					if (String(url).includes("StreamGenerate")) {
						return new Response(
							richWrbLine(generatedImageCandidate("", imageUrl)),
							{ status: 200 },
						);
					}
					if (
						String(url).endsWith("=s4096-rj") ||
						String(url).endsWith("=s2048-rj") ||
						String(url).endsWith("=s0") ||
						String(url).endsWith("=d")
					) {
						return new Response("preview not ready", { status: 404 });
					}
					if (String(url) === imageUrl || String(url).endsWith("/generated")) {
						return new Response(
							Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00]),
							{ status: 200, headers: { "content-type": "image/jpeg" } },
						);
					}
					return new Response("not found", { status: 404 });
				},
				async () => {
					const rich = await mod.generateRich(
						cfg,
						"draw image",
						1,
						4,
						null,
						null,
					);
					assert.equal(rich.images.length, 1);
					assert.equal(rich.images[0].outputFormat, "jpeg");
				},
			);
			assert.equal(
				calls[1],
				"https://lh3.googleusercontent.com/generated=s4096-rj",
			);
			assert.equal(
				calls.includes(imageUrl) ||
					calls.includes("https://lh3.googleusercontent.com/generated"),
				true,
			);
		},
	],
	[
		"detects gif and webp generated image bytes",
		async () => {
			const cfg = baseGeminiClientConfig();
			const imageCases = [
				{
					url: "https://lh3.googleusercontent.com/generated-gif=s2048-rj",
					bytes: new TextEncoder().encode("GIF89a...."),
					format: "gif",
				},
				{
					url: "https://lh3.googleusercontent.com/generated-webp=s2048-rj",
					bytes: Uint8Array.from([
						0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42,
						0x50,
					]),
					format: "webp",
				},
			];
			for (const item of imageCases) {
				await withFetch(
					async (url) => {
						if (String(url).includes("StreamGenerate")) {
							return new Response(
								richWrbLine(generatedImageCandidate("", item.url)),
								{ status: 200 },
							);
						}
						if (String(url) === item.url) {
							return new Response(item.bytes, { status: 200 });
						}
						return new Response("not found", { status: 404 });
					},
					async () => {
						const rich = await mod.generateRich(
							cfg,
							`draw ${item.format}`,
							1,
							4,
							null,
							null,
						);
						assert.equal(rich.images.length, 1);
						assert.equal(rich.images[0].outputFormat, item.format);
					},
				);
			}
		},
	],
	[
		"keeps web-only rich images without fetching image bytes",
		async () => {
			const cfg = baseGeminiClientConfig();
			const calls = [];
			await withFetch(
				async (url) => {
					calls.push(String(url));
					if (String(url).includes("StreamGenerate")) {
						return new Response(
							richWrbLine(
								webImageCandidate("", "https://images.example/web-only.png"),
							),
							{ status: 200 },
						);
					}
					throw new Error(
						"web image URLs should not be fetched by generateRich",
					);
				},
				async () => {
					const rich = await mod.generateRich(
						cfg,
						"show web image",
						1,
						4,
						null,
						null,
					);
					assert.equal(rich.images.length, 1);
					assert.equal(rich.images[0].source, "web");
					assert.equal(
						rich.images[0].url,
						"https://images.example/web-only.png",
					);
					assert.equal(rich.images[0].base64, undefined);
				},
			);
			assert.equal(calls.length, 1);
		},
	],
	[
		"maps rich fatal and empty upstream responses to image-specific errors",
		async () => {
			const cfg = baseGeminiClientConfig();
			await withFetch(
				async () => new Response(fatalWrbLine(1013), { status: 200 }),
				async () => {
					await assertRejectsWithCode(
						() => mod.generateRich(cfg, "draw image", 1, 4, null, null),
						"upstream_image_provider_error",
					);
				},
			);

			await withFetch(
				async (url) => {
					if (String(url).includes("/app"))
						return new Response("no fresh build label");
					return new Response(
						JSON.stringify([
							[
								"wrb.fr",
								null,
								JSON.stringify([null, null, null, null, [], "x".repeat(160)]),
							],
						]),
						{ status: 200 },
					);
				},
				async () => {
					await assertRejectsWithCode(
						() => mod.generateRich(cfg, "draw image", 1, 4, null, null),
						"upstream_image_generation_empty",
					);
				},
			);
		},
	],
	[
		"encodes fetched generated image bytes without TypedArray base64 helpers",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const imageUrl = "https://lh3.googleusercontent.com/generated.png";
			await withoutTypedArrayEncodingMethods(async () => {
				await withFetch(
					async (url) => {
						if (String(url).includes("StreamGenerate")) {
							return new Response(
								richWrbLine(generatedImageCandidate("", imageUrl)),
								{ status: 200 },
							);
						}
						if (String(url) === imageUrl) {
							return new Response(mod.base64ToBytes(TINY_PNG_BASE64), {
								status: 200,
								headers: { "content-type": "image/png" },
							});
						}
						return new Response("not found", { status: 404 });
					},
					async () => {
						const rich = await mod.generateRich(
							cfg,
							"draw image",
							1,
							4,
							null,
							null,
						);
						assert.equal(rich.images.length, 1);
						assert.equal(rich.images[0].base64, TINY_PNG_BASE64);
						assert.equal(rich.images[0].outputFormat, "png");
					},
				);
			});
		},
	],
	[
		"rejects non-image generated image bodies even with image content-type",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const imageUrl = "https://lh3.googleusercontent.com/generated.png";
			await withFetch(
				async (url) => {
					if (String(url).includes("StreamGenerate")) {
						return new Response(
							richWrbLine(generatedImageCandidate("", imageUrl)),
							{ status: 200 },
						);
					}
					if (String(url) === imageUrl) {
						return new Response("<html>not an image</html>", {
							status: 200,
							headers: { "content-type": "image/png" },
						});
					}
					return new Response("not found", { status: 404 });
				},
				async () => {
					const rich = await mod.generateRich(
						cfg,
						"draw image",
						1,
						4,
						null,
						null,
					);
					assert.equal(rich.images.length, 1);
					assert.equal(rich.images[0].url, imageUrl);
					assert.equal(rich.images[0].base64, undefined);
					assert.equal(rich.images[0].outputFormat, undefined);
				},
			);
		},
	],
	[
		"keeps StreamGenerate on socket while generated image bytes use fetch",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: true,
				log_requests: false,
			};
			const imageUrl =
				"https://lh3.googleusercontent.com/gg-dl/AFfU-direct-image";
			const raw = richWrbLine(generatedImageCandidate("", imageUrl));
			const socketState = {};
			const socketResponse = `HTTP/1.1 200 OK\r\nContent-Length: ${new TextEncoder().encode(raw).byteLength}\r\n\r\n${raw}`;
			mod._setConnectForTest(fakeSocketConnect([socketResponse], socketState));
			const fetchCalls = [];
			try {
				await withFetch(
					async (url) => {
						fetchCalls.push(String(url));
						if (String(url) === imageUrl) {
							return new Response(mod.base64ToBytes(TINY_PNG_BASE64), {
								status: 200,
								headers: { "content-type": "image/png" },
							});
						}
						return new Response("not found", { status: 404 });
					},
					async () => {
						const rich = await mod.generateRich(
							cfg,
							"draw image",
							1,
							4,
							null,
							null,
						);
						assert.equal(rich.images.length, 1);
						assert.equal(rich.images[0].base64, TINY_PNG_BASE64);
					},
				);
			} finally {
				mod._setConnectForTest(null);
			}
			const socketRequestText = socketState.writes
				.map((chunk) => new TextDecoder().decode(chunk))
				.join("");
			assert.match(socketRequestText, /StreamGenerate/);
			assert.doesNotMatch(socketRequestText, /gg-dl/);
			assert.equal(fetchCalls.includes(imageUrl), true);
		},
	],
	[
		"summarizes WRB parse issue branches without throwing",
		async () => {
			const parseIssueInputs = [
				JSON.stringify({ not: "an array" }),
				JSON.stringify([["wrb.fr", null, null]]),
				JSON.stringify([["wrb.fr", null, JSON.stringify([null])]]),
				JSON.stringify([
					[
						"wrb.fr",
						null,
						JSON.stringify([null, null, null, null, "not parts"]),
					],
				]),
				JSON.stringify([
					[
						"wrb.fr",
						null,
						JSON.stringify([null, null, null, null, [[null, []]]]),
					],
				]),
			];
			const summary = mod.wrbResponseShapeSummary(parseIssueInputs.join("\n"));
			assert.match(summary, /wrbLines=4/);
			assert.match(summary, /parsedEnvelopes=4/);
			assert.match(summary, /parsedInnerPayloads=3/);
			assert.deepEqual(
				parseIssueInputs.map((item) => mod.extractTextsFromLine(item)),
				[[], [], [], [], []],
			);
		},
	],
	[
		"bounds app page marker scanning for unterminated quoted values",
		async () => {
			const oversized = `"qKIAYe":"${"x".repeat(10 * 1024)}`;
			assert.deepEqual(
				await mod.extractGeminiAppPageTokens(textResponse(oversized)),
				{},
			);
			assert.equal(await mod.extractGeminiPushId(textResponse(oversized)), "");

			const buildLabel = "boq_assistant-bard-web-server_20260709.09_p0";
			assert.equal(
				await mod.extractGeminiBuildLabel(
					textResponse(`${oversized}\n${buildLabel}`),
				),
				buildLabel,
			);
		},
	],
	[
		"streams only new text deltas from repeated WRB lines",
		async () => {
			const extractor = mod.createStreamTextExtractor();
			assert.deepEqual(
				[...extractor.consumeLine(wrbLine([" hello"]))],
				["hello"],
			);
			assert.deepEqual(
				[...extractor.consumeLine(wrbLine([" hello world"]))],
				[" world"],
			);
			assert.deepEqual(
				[...extractor.consumeLine(wrbLine([" hello world"]))],
				[],
			);
		},
	],
	[
		"streams long cumulative WRB text without losing append state",
		async () => {
			const extractor = mod.createStreamTextExtractor();
			let cumulative = "";
			let emitted = "";
			for (let i = 0; i < 512; i++) {
				cumulative += `${String(i).padStart(4, "0")}:${"x".repeat(123)}\n`;
				emitted += [...extractor.consumeLine(wrbLine([cumulative]))].join("");
			}
			assert.equal(emitted, cumulative.trimStart());
			assert.deepEqual(
				[...extractor.consumeLine(wrbLine([cumulative.slice(0, -256)]))],
				[],
			);
			assert.deepEqual(
				[...extractor.consumeLine(wrbLine([`${cumulative}tail`]))],
				["tail"],
			);
		},
	],
	[
		"streams visible deltas after artifact-bearing cumulative chunks",
		async () => {
			const extractor = mod.createStreamTextExtractor();
			const artifact = [
				"answer",
				"```python?code_reference&code_event_index=1",
				"print('hidden')",
				"```",
			].join("\n");
			assert.equal(
				[...extractor.consumeLine(wrbLine([artifact]))].join(""),
				"answer\n",
			);
			assert.deepEqual(
				[...extractor.consumeLine(wrbLine([`${artifact}\nmore visible`]))],
				["more visible"],
			);
		},
	],
	[
		"builds Gemini payload with file refs and extra fields",
		async () => {
			const payload = mod.buildPayload(
				"prompt",
				123,
				2,
				[{ ref: "file-ref", name: "doc.txt" }],
				{ 31: 2, 80: 3 },
				"req-test",
			);
			const outer = JSON.parse(new URLSearchParams(payload).get("f.req"));
			const inner = JSON.parse(outer[1]);
			assert.equal(inner.length, 102);
			assert.equal(inner[0][0], "prompt");
			assert.equal(inner[0][3][0][0][0], "file-ref");
			assert.equal(inner[0][3][0][1], "doc.txt");
			assert.equal(inner[3], null);
			assert.equal(inner[31], 2);
			assert.equal(inner[59], "REQ-TEST");
			assert.equal(inner[79], 123);
			assert.equal(inner[80], 3);
			await assert.rejects(
				() => mod.buildPayload("prompt", 123, 2, null, { 79: 999 }),
				/Unsupported Gemini model extra payload field/,
			);
		},
	],
	[
		"builds Gemini request URL and browser headers",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example/",
				gemini_bl: "boq test",
				cookie: "SID=ok",
			};
			const url = mod.getUrl(cfg);
			assert.match(
				url,
				/^https:\/\/gemini\.example\/_\/BardChatUi\/data\/assistant\.lamda\.BardFrontendService\/StreamGenerate\?/,
			);
			assert.match(url, /bl=boq%20test/);

			const headers = await mod.buildHeaders(
				cfg,
				{
					"x-goog-ext-525001261-jspb":
						'[1,null,null,null,"model-id",null,null,0,[4],null,null,1]',
				},
				"request-id",
			);
			assert.equal(headers.Cookie, "SID=ok");
			assert.equal(headers.Origin, "https://gemini.google.com");
			assert.equal(headers["X-Same-Domain"], "1");
			assert.equal(
				headers["x-goog-ext-525001261-jspb"],
				'[1,null,null,null,"model-id",null,null,0,[4],null,null,1]',
			);
			assert.equal(headers["x-goog-ext-525005358-jspb"], '["REQUEST-ID",1]');
			assert.equal(headers.Authorization, undefined);
		},
	],
	[
		"parses and merges cookie headers with quoted values",
		async () => {
			const parsed = Object.fromEntries(
				mod.parseCookieHeader("SID=ok; SAPISID=sapi; __Secure-1PSID=psid"),
			);
			assert.deepEqual(parsed, {
				SID: "ok",
				SAPISID: "sapi",
				"__Secure-1PSID": "psid",
			});

			const split = mod.splitSetCookieHeader(
				[
					"__Secure-1PSIDTS=new; Path=/; Secure",
					"NID=x; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
				].join(", "),
			);
			assert.equal(split.length, 2);

			const merged = mod.mergeSetCookieHeaders(
				"__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
				split,
			);
			assert.equal(
				merged,
				"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi; NID=x",
			);

			const quoted = mod.splitSetCookieHeader(
				[
					'A="x,y"; Path=/',
					"B=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
					"C=3; Path=/",
				].join(", "),
			);
			assert.deepEqual(quoted, [
				'A="x,y"; Path=/',
				"B=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
				"C=3; Path=/",
			]);
		},
	],
	[
		"applies Set-Cookie deletion domain and path rules for Gemini",
		async () => {
			const scope = {
				responseUrl: "https://accounts.google.com/RotateCookies",
				targetUrl: "https://gemini.google.com/app",
				nowMs: Date.parse("2026-08-08T00:00:00Z"),
			};
			const merged = mod.mergeSetCookieHeaders(
				"SID=ok; __Secure-1PSIDTS=old; SAPISID=sapi",
				[
					"__Secure-1PSIDTS=new; Domain=.google.com; Path=/; Secure",
					"NID=host-only; Path=/; Secure",
					"SAPISID=wrong-path; Domain=.google.com; Path=/accounts; Secure",
					"SID=wrong-domain; Domain=.example.com; Path=/; Secure",
				],
				scope,
			);
			assert.equal(merged, "SID=ok; __Secure-1PSIDTS=new; SAPISID=sapi");

			const deleted = mod.mergeSetCookieHeaders(
				merged,
				[
					"__Secure-1PSIDTS=gone; Domain=.google.com; Path=/; Max-Age=0; Secure",
					"SID=gone; Domain=.google.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure",
				],
				scope,
			);
			assert.equal(deleted, "SAPISID=sapi");
		},
	],
	[
		"derives active Gemini cookie config without mutating input",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			const cfg = {
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
				sapisid: "",
			};
			const active = mod.configWithActiveGeminiCookie(cfg);
			assert.equal(
				active.cookie,
				"__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
			);
			assert.equal(active.sapisid, "sapi");
			assert.equal(cfg.sapisid, "");
		},
	],
	[
		"reloads active Gemini cookie when only 1PSIDTS changes",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			mod.configWithActiveGeminiCookie({
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
				sapisid: "",
			});

			const active = mod.configWithActiveGeminiCookie({
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
				sapisid: "",
			});

			assert.equal(
				active.cookie,
				"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
			);
		},
	],
	[
		"rotates Gemini cookie with safe RotateCookies headers",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			let calls = 0;
			const cfg = {
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
				sapisid: "",
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async (url, init) => {
					calls += 1;
					assert.equal(
						String(url),
						"https://accounts.google.com/RotateCookies",
					);
					assert.equal(init.method, "POST");
					assert.equal(init.headers.Cookie, cfg.cookie);
					assert.equal(init.headers.Origin, "https://accounts.google.com");
					assert.equal(init.headers.Referer, "https://accounts.google.com/");
					assert.equal(init.headers["Accept-Language"], "en-US,en;q=0.9");
					assert.match(init.headers["User-Agent"], /Mozilla\/5\.0/);
					return new Response("", {
						status: 200,
						headers: {
							"set-cookie":
								"__Secure-1PSIDTS=new; Domain=.google.com; Path=/; Secure",
						},
					});
				},
				async () => {
					const rotated = await mod.rotateGeminiCookieForRetry(cfg);
					assert.equal(calls, 1);
					assert.equal(
						rotated.cookie,
						"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
					);
					assert.equal(rotated.sapisid, "sapi");
					mod.configWithActiveGeminiCookie(rotated);
					const nextRequest = mod.configWithActiveGeminiCookie(cfg);
					assert.match(nextRequest.cookie, /__Secure-1PSIDTS=new/);
					assert.doesNotMatch(nextRequest.cookie, /__Secure-1PSIDTS=old/);
				},
			);
		},
	],
	[
		"uses the SAPISID returned by RotateCookies instead of a stale override",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			const cfg = {
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=old-sapi",
				sapisid: "old-sapi",
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () =>
					new Response("", {
						status: 200,
						headers: {
							"set-cookie":
								"__Secure-1PSIDTS=new; Domain=.google.com; Path=/; Secure, SAPISID=new-sapi; Domain=.google.com; Path=/; Secure",
						},
					}),
				async () => {
					const rotated = await mod.rotateGeminiCookieForRetry(cfg);
					assert.equal(rotated.sapisid, "new-sapi");
					assert.match(rotated.cookie, /SAPISID=new-sapi/);
				},
			);
		},
	],
	[
		"debounces failed cookie rotation after upstream rejection",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			const cfg = {
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
				sapisid: "",
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () => new Response("", { status: 401 }),
				async () => {
					assert.equal(await mod.rotateGeminiCookieForRetry(cfg), null);
					const rotated = await mod.rotateGeminiCookieForRetryWithReason(cfg);
					assert.equal(rotated.config, null);
					assert.equal(rotated.reason, "recent_rotation");
				},
			);
		},
	],
	[
		"rejects cookie rotation when no updated cookie returns",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			const cfg = {
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
				sapisid: "",
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () => new Response("", { status: 200 }),
				async () => {
					assert.equal(await mod.rotateGeminiCookieForRetry(cfg), null);
				},
			);
		},
	],
	[
		"does not accept unrelated or host-only Set-Cookie updates as rotation",
		async () => {
			for (const setCookie of [
				"NID=unrelated; Domain=.google.com; Path=/; Secure",
				"__Secure-1PSIDTS=new; Path=/; Secure",
			]) {
				mod.resetActiveGeminiCookieForTest();
				const cfg = {
					cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
					sapisid: "",
					request_timeout_sec: 180,
					upstream_socket: false,
					log_requests: false,
				};
				await withFetch(
					async () =>
						new Response("", {
							status: 200,
							headers: { "set-cookie": setCookie },
						}),
					async () => {
						const result = await mod.rotateGeminiCookieForRetryWithReason(cfg);
						assert.equal(result.config, null);
						assert.equal(result.reason, "rotation_no_update");
						assert.match(
							mod.configWithActiveGeminiCookie(cfg).cookie,
							/__Secure-1PSIDTS=old/,
						);
					},
				);
			}
		},
	],
	[
		"coalesces concurrent cookie rotation requests",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			let calls = 0;
			let release;
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			const cfg = {
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
				sapisid: "",
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () => {
					calls += 1;
					await gate;
					return new Response("", {
						status: 200,
						headers: {
							"set-cookie":
								"__Secure-1PSIDTS=new; Domain=.google.com; Path=/; Secure",
						},
					});
				},
				async () => {
					const first = mod.rotateGeminiCookieForRetry(cfg);
					const second = mod.rotateGeminiCookieForRetry(cfg);
					release();
					const results = await Promise.all([first, second]);
					assert.equal(calls, 1);
					assert.equal(
						results[0].cookie,
						"__Secure-1PSID=psid; __Secure-1PSIDTS=new",
					);
					assert.equal(
						results[1].cookie,
						"__Secure-1PSID=psid; __Secure-1PSIDTS=new",
					);
				},
			);
		},
	],
	[
		"persists pooled rotation before returning the retry config",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			const seeds = [
				{
					label: "one",
					cookie: "__Secure-1PSID=one; __Secure-1PSIDTS=old",
					sapisid: "",
				},
			];
			const pool = createTestGeminiSessionPool(seeds);
			const lease = await pool.port.acquire();
			const cfg = {
				cookie: lease.cookie,
				sapisid: lease.sapisid,
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
				gemini_session: lease,
				gemini_session_pool: pool.port,
			};

			await withFetch(
				async () =>
					new Response("", {
						status: 200,
						headers: {
							"set-cookie":
								"__Secure-1PSIDTS=new; Domain=.google.com; Path=/; Secure",
						},
					}),
				async () => {
					const result = await mod.rotateGeminiCookieForRetryWithReason(cfg);
					assert.equal(result.reason, "rotation_updated");
					assert.match(result.config.cookie, /__Secure-1PSIDTS=new/);
					assert.equal(result.config.gemini_rotation, undefined);
					assert.equal(
						result.config.gemini_session.version > lease.version,
						true,
					);

					const concurrent = await pool.port.acquire();
					assert.match(concurrent.cookie, /__Secure-1PSIDTS=new/);
					assert.equal(
						pool.stored().accounts[lease.account_id].rotation_token,
						"",
					);
				},
			);
		},
	],
	[
		"retries pooled rotation persistence with waitUntil after transient failures",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			const seeds = [
				{
					label: "one",
					cookie: "__Secure-1PSID=one; __Secure-1PSIDTS=old",
					sapisid: "",
				},
			];
			const pool = createTestGeminiSessionPool(seeds);
			const lease = await pool.port.acquire();
			const durableCommit = pool.port.commitRotation;
			let commitCalls = 0;
			const flakyPort = {
				...pool.port,
				async commitRotation(...args) {
					commitCalls += 1;
					if (commitCalls <= 2) throw new Error("temporary pool failure");
					return durableCommit(...args);
				},
			};
			const pending = [];
			const cfg = {
				cookie: lease.cookie,
				sapisid: lease.sapisid,
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
				gemini_session: lease,
				gemini_session_pool: flakyPort,
				execution_ctx: {
					waitUntil(promise) {
						pending.push(promise);
					},
				},
			};

			await withFetch(
				async () =>
					new Response("", {
						status: 200,
						headers: {
							"set-cookie":
								"__Secure-1PSIDTS=new; Domain=.google.com; Path=/; Secure",
						},
					}),
				async () => {
					const result = await mod.rotateGeminiCookieForRetryWithReason(cfg);
					assert.match(result.config.cookie, /__Secure-1PSIDTS=new/);
					assert.equal(result.config.gemini_rotation === undefined, false);
					assert.equal(pending.length, 1);
					await Promise.all(pending);
					assert.equal(commitCalls, 3);
					const available = await pool.port.acquire();
					assert.match(available.cookie, /__Secure-1PSIDTS=new/);
				},
			);
		},
	],
	[
		"persists target-cookie deletion and cools the pooled account",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			const seeds = [
				{
					label: "one",
					cookie: "__Secure-1PSID=one; __Secure-1PSIDTS=old",
					sapisid: "",
				},
			];
			const pool = createTestGeminiSessionPool(seeds);
			const lease = await pool.port.acquire();
			const cfg = {
				cookie: lease.cookie,
				sapisid: lease.sapisid,
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
				gemini_session: lease,
				gemini_session_pool: pool.port,
			};

			await withFetch(
				async () =>
					new Response("", {
						status: 200,
						headers: {
							"set-cookie":
								"__Secure-1PSID=; Domain=.google.com; Path=/; Max-Age=0; Secure, __Secure-1PSIDTS=; Domain=.google.com; Path=/; Max-Age=0; Secure",
						},
					}),
				async () => {
					const result = await mod.rotateGeminiCookieForRetryWithReason(cfg);
					assert.equal(result.config, null);
					assert.equal(result.reason, "rotation_no_update");
					assert.equal(pool.stored().accounts[lease.account_id].cookie, "");
					const accounts = await pool.call("/accounts", { seeds });
					assert.equal(accounts[0].status, "cooling");
					assert.equal(accounts[0].issue, "auth");
					assert.equal(await pool.port.acquire(), null);
				},
			);
		},
	],
	[
		"cools a pooled account when rotation returns no auth update",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			const seeds = [
				{
					label: "one",
					cookie: "__Secure-1PSID=one; __Secure-1PSIDTS=old",
					sapisid: "",
				},
			];
			const pool = createTestGeminiSessionPool(seeds);
			const lease = await pool.port.acquire();
			const cfg = {
				cookie: lease.cookie,
				sapisid: lease.sapisid,
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
				gemini_session: lease,
				gemini_session_pool: pool.port,
			};

			await withFetch(
				async () =>
					new Response("", {
						status: 200,
						headers: {
							"set-cookie": "NID=unrelated; Domain=.google.com; Path=/; Secure",
						},
					}),
				async () => {
					const result = await mod.rotateGeminiCookieForRetryWithReason(cfg);
					assert.equal(result.config, null);
					assert.equal(result.reason, "rotation_no_update");
					const stored = pool.stored().accounts[lease.account_id];
					assert.match(stored.cookie, /__Secure-1PSIDTS=old/);
					assert.equal(stored.rotation_token, "");
					const accounts = await pool.call("/accounts", { seeds });
					assert.equal(accounts[0].status, "cooling");
					assert.equal(accounts[0].issue, "auth");
				},
			);
		},
	],
	[
		"honors retry attempt limits",
		async () => {
			const cfg = { retry_attempts: 2, retry_delay_sec: 0, log_requests: true };
			const err = new Error("boom secret");
			err.code = "retry_test";
			err.status = 502;
			const logs = [];
			await withConsoleLog(
				(line) => logs.push(String(line)),
				async () => {
					assert.equal(await mod.waitBeforeRetry(cfg, 0, err, "Retry"), true);
					assert.equal(await mod.waitBeforeRetry(cfg, 1, err, "Retry"), false);
				},
			);
			assert.deepEqual(logs, [
				"[web2gem-plus] Retry 1/2 type=Error code=retry_test status=502",
			]);
			assert.doesNotMatch(logs[0], /boom secret/);
		},
	],
	[
		"caches Gemini build labels in the Workers cache API",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "configured-bl",
				log_requests: false,
			};
			const cache = createMemoryCache();
			await withCaches(cache, async () => {
				assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "");
				await mod.setCachedGeminiBuildLabel(cfg, "cached-bl");
				assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "cached-bl");
				assert.equal(cache.stats.match, 1);

				const active = await mod.configWithCachedGeminiBuildLabel(cfg);
				assert.equal(active.gemini_bl, "cached-bl");
				assert.equal(cfg.gemini_bl, "configured-bl");
				assert.equal(cache.stats.match, 1);
			});
		},
	],
	[
		"persists Gemini build labels with waitUntil when available",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "configured-bl",
				log_requests: false,
			};
			const cache = createMemoryCache();
			const pending = [];
			await withCaches(cache, async () => {
				await mod.setCachedGeminiBuildLabel(
					{
						...cfg,
						execution_ctx: {
							waitUntil(promise) {
								pending.push(promise);
							},
						},
					},
					"waituntil-bl",
				);
				assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "waituntil-bl");
				assert.equal(cache.stats.match, 0);
				assert.equal(pending.length, 1);
				await Promise.all(pending);
				assert.equal(cache.stats.put, 1);
			});
		},
	],
	[
		"drops stale cached Gemini build labels",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "configured-bl",
				log_requests: false,
			};
			const cache = createMemoryCache();
			await cache.put(
				new Request(
					`https://internal-cache/gemini-bl/${encodeURIComponent("https://gemini.example")}`,
				),
				new Response(
					JSON.stringify({
						gemini_bl: "stale-bl",
						created_at_ms: Date.now() - 13 * 60 * 60 * 1000,
					}),
				),
			);
			await withCaches(cache, async () => {
				assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "");
				assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "");
			});
		},
	],
	[
		"refreshes Gemini build labels once for concurrent callers",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				cookie: "SID=ok",
				upstream_socket: false,
				log_requests: false,
			};
			const cache = createMemoryCache();
			let calls = 0;
			let release;
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			await withCaches(cache, async () => {
				await withFetch(
					async (url, init) => {
						calls += 1;
						assert.equal(String(url), "https://gemini.example/app");
						assert.equal(init.headers.Cookie, "SID=ok");
						await gate;
						return new Response('<script>{"cfb2h":"fresh-bl"}</script>', {
							status: 200,
						});
					},
					async () => {
						const first = mod.getFreshGeminiBuildLabel(cfg);
						const second = mod.getFreshGeminiBuildLabel(cfg);
						release();
						assert.deepEqual(await Promise.all([first, second]), [
							"fresh-bl",
							"fresh-bl",
						]);
						assert.equal(calls, 1);
						assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "fresh-bl");
					},
				);
			});
		},
	],
	[
		"reports rejected cookie rotation reason and upstream status",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			const cfg = {
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
				sapisid: "",
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () => new Response("", { status: 403 }),
				async () => {
					const rotated = await mod.rotateGeminiCookieForRetryWithReason(cfg);
					assert.equal(rotated.config, null);
					assert.equal(rotated.reason, "rotation_rejected");
					assert.equal(rotated.upstreamStatus, 403);
				},
			);
		},
	],
	[
		"redacts cookies from invalid cookie diagnostics",
		async () => {
			const err = mod.invalidGeminiCookieError(
				{ cookie: "SID=bad" },
				403,
				null,
				"rotation_no_update",
			);
			assert.equal(err.code, "invalid_gemini_cookie");
			assert.equal(
				err.reason,
				"RotateCookies completed but did not return an updated cookie",
			);
			assert.match(
				err.message,
				/Diagnostic: RotateCookies completed but did not return an updated cookie\./,
			);
			assert.doesNotMatch(err.message, /SID=bad/);
		},
	],
	[
		"redacts redirect credentials, query, and fragment from diagnostics",
		async () => {
			assert.equal(
				mod.safeRedirectTarget(
					"https://user:secret@example.test/login/path?token=secret#fragment",
					"https://gemini.example",
				),
				"https://example.test/login/path",
			);
			assert.equal(
				mod.safeRedirectTarget("/app?auth=secret", "https://gemini.example"),
				"https://gemini.example/app",
			);
			assert.equal(
				mod.safeRedirectTarget("javascript:alert(1)", "https://gemini.example"),
				"",
			);
		},
	],
	[
		"invalidates page token cache after cookie rotation",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			mod.resetGeminiUploadCachesForTest();
			const cfg = {
				gemini_origin: "https://gemini.example",
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
				sapisid: "",
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
			};
			const pageCookies = [];
			let appCalls = 0;
			await withFetch(
				async (url, init) => {
					const href = String(url);
					if (href === "https://gemini.example/app") {
						appCalls += 1;
						pageCookies.push(init.headers.Cookie);
						return new Response(`{"SNlM0e":"at-${appCalls}"}`, { status: 200 });
					}
					if (href === "https://accounts.google.com/RotateCookies") {
						return new Response("", {
							status: 200,
							headers: {
								"set-cookie":
									"__Secure-1PSIDTS=new; Domain=.google.com; Path=/; Secure",
							},
						});
					}
					throw new Error(`unexpected fetch ${href}`);
				},
				async () => {
					const first = await mod.getPageTokens(cfg);
					assert.equal(first.at, "at-1");
					const rotated = await mod.rotateGeminiCookieForRetry(cfg);
					assert.equal(
						rotated.cookie,
						"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
					);
					const second = await mod.getPageTokens(cfg);
					assert.equal(second.at, "at-2");
					assert.deepEqual(pageCookies, [
						"__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
						"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
					]);
					assert.equal(appCalls, 2);
				},
			);
		},
	],
	[
		"deduplicates repeated active cookie names",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			const active = mod.configWithActiveGeminiCookie({
				cookie:
					"__Secure-1PSID=psid; __Secure-1PSIDTS=old; __Secure-1PSIDTS=new; SAPISID=sapi",
				sapisid: "",
			});
			assert.equal(
				active.cookie,
				"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
			);
		},
	],
	[
		"generates text with page auth token appended for cookie requests",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			mod.resetGeminiUploadCachesForTest();
			const calls = [];
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "__Secure-1PSID=psid; SAPISID=sapi",
				sapisid: "sapi",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async (url, init = {}) => {
					calls.push({ url: String(url), init });
					if (String(url) === "https://gemini.example/app") {
						return new Response('{"SNlM0e":"at-test"}', { status: 200 });
					}
					assert.match(String(url), /StreamGenerate/);
					assert.match(String(init.body), /&at=at-test/);
					return new Response(
						[
							JSON.stringify([
								[
									"wrb.fr",
									null,
									JSON.stringify([
										null,
										null,
										null,
										null,
										[[null, ["hello"]]],
										"x".repeat(160),
									]),
								],
							]),
						].join("\n"),
						{ status: 200 },
					);
				},
				async () => {
					const text = await mod.generate(cfg, "prompt", 1, 4, null, null);
					assert.equal(text, "hello");
				},
			);
			assert.equal(calls.length, 2);
			assert.equal(calls[0].init.headers.Cookie, cfg.cookie);
		},
	],
	[
		"uses the current app page build label for the first cookie RPC",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			mod.resetGeminiUploadCachesForTest();
			mod.resetGeminiBuildLabelCacheForTest();
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "stale-configured-bl",
				cookie: "__Secure-1PSID=psid; SAPISID=sapi",
				sapisid: "sapi",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const cache = createMemoryCache();
			await withCaches(cache, async () => {
				await withFetch(
					async (url) => {
						const href = String(url);
						if (href === "https://gemini.example/app") {
							return new Response(
								'{"SNlM0e":"at-test","cfb2h":"fresh-app-bl"}',
								{ status: 200 },
							);
						}
						assert.match(href, /StreamGenerate/);
						assert.match(href, /bl=fresh-app-bl/);
						assert.doesNotMatch(href, /stale-configured-bl/);
						return new Response(wrbLine(["fresh first request"]), {
							status: 200,
						});
					},
					async () => {
						assert.equal(
							await mod.generate(cfg, "prompt", 1, 4, null, null),
							"fresh first request",
						);
					},
				);
			});
		},
	],
	[
		"rejects cookie requests when Gemini page auth token is missing",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			mod.resetGeminiUploadCachesForTest();
			const calls = [];
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "SID=ok",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async (url) => {
					calls.push(String(url));
					if (String(url) === "https://gemini.example/app")
						return new Response("<html>no at token</html>", { status: 200 });
					throw new Error(`unexpected fetch ${url}`);
				},
				async () => {
					try {
						await mod.generate(cfg, "prompt", 1, 4, null, null);
						throw new Error("expected missing page token failure");
					} catch (err) {
						assert.equal(err.code, "invalid_gemini_cookie");
						assert.match(err.message, /GEMINI_COOKIE/);
					}
				},
			);
			assert.deepEqual(calls, ["https://gemini.example/app"]);
		},
	],
	[
		"reports cookie rotation failure when StreamGenerate rejects the cookie",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			mod.resetGeminiUploadCachesForTest();
			const calls = [];
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "__Secure-1PSID=psid; SAPISID=sapi",
				sapisid: "sapi",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async (url) => {
					const href = String(url);
					calls.push(href);
					if (href === "https://gemini.example/app")
						return new Response('{"SNlM0e":"at-test"}', { status: 200 });
					if (href === "https://accounts.google.com/RotateCookies")
						return new Response("", { status: 200 });
					assert.match(href, /StreamGenerate/);
					return new Response("rejected", { status: 401 });
				},
				async () => {
					try {
						await mod.generate(cfg, "prompt", 1, 4, null, null);
						throw new Error("expected invalid cookie failure");
					} catch (err) {
						assert.equal(err.code, "invalid_gemini_cookie");
						assert.equal(
							err.reason,
							"RotateCookies completed but did not return an updated cookie",
						);
						assert.equal(err.upstreamStatus, 401);
					}
				},
			);
			assert.equal(
				calls.some(
					(href) => href === "https://accounts.google.com/RotateCookies",
				),
				true,
			);
		},
	],
	[
		"uses a separate account budget to fail over beyond normal retries",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			mod.resetGeminiUploadCachesForTest();
			mod.resetGeminiBuildLabelCacheForTest();
			const leases = ["one", "two", "three"].map((id, index) => ({
				account_id: id,
				version: 1,
				cookie: `__Secure-1PSID=${id}`,
				sapisid: "",
				last_cookie_refresh_at_ms: Date.now(),
				index,
			}));
			const failures = [];
			const pool = {
				beginRotation: async () => ({ status: "unavailable" }),
				commitRotation: async () => null,
				abortRotation: async () => {},
				failRotation: async () => {},
				markFailure: async (lease, issue) => {
					failures.push([lease.account_id, issue]);
				},
				markSuccess: async () => {},
				acquire: async (excluded = []) =>
					leases.find((lease) => !excluded.includes(lease.account_id)) || null,
			};
			const cfg = baseGeminiClientConfig({
				cookie: leases[0].cookie,
				gemini_session: leases[0],
				gemini_session_pool: pool,
				gemini_account_max_attempts: 3,
				retry_attempts: 1,
			});
			let streamCalls = 0;
			await withFetch(
				async (url, init = {}) => {
					const href = String(url);
					if (href === "https://gemini.example/app")
						return new Response('{"SNlM0e":"at-test"}', { status: 200 });
					assert.match(href, /StreamGenerate/);
					streamCalls++;
					if (!String(init.headers?.Cookie).includes("three"))
						return new Response("rejected", { status: 401 });
					return new Response(wrbLine(["third account works"]), {
						status: 200,
					});
				},
				async () => {
					assert.equal(
						await mod.generate(cfg, "prompt", 1, 4, null, null),
						"third account works",
					);
				},
			);
			assert.equal(streamCalls, 3);
			assert.deepEqual(failures, [
				["one", "auth"],
				["two", "auth"],
			]);
		},
	],
	[
		"retries generate after successful cookie rotation",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			mod.resetGeminiUploadCachesForTest();
			const calls = [];
			let appCalls = 0;
			let streamCalls = 0;
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 2,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async (url, init = {}) => {
					const href = String(url);
					calls.push({
						href,
						cookie: init.headers?.Cookie,
						body: String(init.body || ""),
					});
					if (href === "https://gemini.example/app") {
						appCalls += 1;
						return new Response(`{"SNlM0e":"at-${appCalls}"}`, { status: 200 });
					}
					if (href === "https://accounts.google.com/RotateCookies") {
						assert.match(init.headers.Cookie, /__Secure-1PSIDTS=old/);
						return new Response("", {
							status: 200,
							headers: {
								"set-cookie":
									"__Secure-1PSIDTS=new; Domain=.google.com; Path=/; Secure",
							},
						});
					}
					assert.match(href, /StreamGenerate/);
					streamCalls += 1;
					if (streamCalls === 1)
						return new Response("cookie rejected", { status: 401 });
					assert.match(init.headers.Cookie, /__Secure-1PSIDTS=new/);
					assert.match(String(init.body), /&at=at-2/);
					return new Response(wrbLine(["after cookie rotation"]), {
						status: 200,
					});
				},
				async () => {
					const text = await mod.generate(cfg, "prompt", 1, 4, null, null);
					assert.equal(text, "after cookie rotation");
				},
			);
			assert.equal(streamCalls, 2);
			assert.equal(
				calls.some(
					(call) => call.href === "https://accounts.google.com/RotateCookies",
				),
				true,
			);
		},
	],
	[
		"refreshes Gemini build label and retries empty non-stream responses",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "old-bl",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 2,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const streamUrls = [];
			await withFetch(
				async (url) => {
					const href = String(url);
					if (href === "https://gemini.example/app") {
						return new Response('<html>{"cfb2h":"fresh-bl"}</html>', {
							status: 200,
						});
					}
					streamUrls.push(href);
					if (streamUrls.length === 1)
						return new Response("no parseable text", { status: 200 });
					return new Response(wrbLine(["after refresh"]), { status: 200 });
				},
				async () => {
					const text = await mod.generate(cfg, "prompt", 1, 4, null, null);
					assert.equal(text, "after refresh");
				},
			);
			assert.match(streamUrls[0], /bl=old-bl/);
			assert.match(streamUrls[1], /bl=fresh-bl/);
		},
	],
	[
		"throws explicit non-stream upstream error when refresh cannot recover",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "stale-bl",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const calls = [];
			await withFetch(
				async (url) => {
					const href = String(url);
					calls.push(href);
					if (href === "https://gemini.example/app")
						return new Response("<html>no fresh build label</html>", {
							status: 200,
						});
					return new Response("upstream failure without wrb text", {
						status: 502,
					});
				},
				async () => {
					try {
						await mod.generate(cfg, "prompt", 1, 4, null, null);
						throw new Error("expected non-stream upstream failure");
					} catch (err) {
						assert.match(err.message, /HTTP 502 returned no parseable text/);
					}
				},
			);
			assert.equal(
				calls.some((href) => href === "https://gemini.example/app"),
				true,
			);
		},
	],
	[
		"throws explicit non-stream upstream empty error for HTTP 200 responses",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "stale-bl",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async (url) => {
					if (String(url) === "https://gemini.example/app")
						return new Response("<html>no fresh build label</html>", {
							status: 200,
						});
					return new Response("upstream completed without wrb text", {
						status: 200,
					});
				},
				async () => {
					try {
						await mod.generate(cfg, "prompt", 1, 4, null, null);
						throw new Error("expected upstream empty response");
					} catch (err) {
						assert.equal(err.code, "upstream_empty_response");
						assert.equal(err.status, 502);
						assert.equal(err.upstreamStatus, 200);
						assert.equal(
							err.rawLength,
							"upstream completed without wrb text".length,
						);
					}
				},
			);
		},
	],
	[
		"classifies data-analysis empty responses for uploaded files",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () =>
					new Response("data_analysis_tool returned no final text", {
						status: 200,
					}),
				async () => {
					try {
						await mod.generate(cfg, "prompt", 1, 4, null, [
							{ ref: "file-ref", name: "data.csv" },
						]);
						throw new Error("expected data-analysis empty response");
					} catch (err) {
						assert.equal(err.code, "data_analysis_empty_response");
						assert.match(err.message, /data_analysis_tool/);
					}
				},
			);
		},
	],
	[
		"classifies large prompt empty responses before generic retry exhaustion",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 10,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () => new Response("no parseable text", { status: 200 }),
				async () => {
					try {
						await mod.generate(cfg, "x".repeat(20), 1, 4, null, null);
						throw new Error("expected large prompt empty response");
					} catch (err) {
						assert.equal(err.code, "large_prompt_empty_response");
						assert.equal(err.thresholdBytes, 10);
						assert.equal(err.promptBytes > err.thresholdBytes, true);
					}
				},
			);
		},
	],
	[
		"aborts Gemini streams before starting upstream fetch",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const ac = new AbortController();
			ac.abort("stop now");
			await withFetch(
				async () => {
					throw new Error("fetch should not run");
				},
				async () => {
					try {
						for await (const _delta of mod.generateStream(
							cfg,
							"prompt",
							1,
							4,
							null,
							null,
							{ signal: ac.signal },
						)) {
							throw new Error("stream should not yield");
						}
						throw new Error("expected abort");
					} catch (err) {
						assert.equal(err.name, "AbortError");
						assert.equal(err.code, "request_aborted");
						assert.match(err.message, /stop now/);
					}
				},
			);
		},
	],
	[
		"throws for stream responses with no body and no parseable fallback text",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () => new Response(null, { status: 502 }),
				async () => {
					try {
						for await (const _delta of mod.generateStream(
							cfg,
							"prompt",
							1,
							4,
							null,
							null,
						)) {
							throw new Error("stream should not yield");
						}
						throw new Error("expected empty stream error");
					} catch (err) {
						assert.equal(err.code, "upstream_empty_response");
						assert.equal(err.status, 502);
						assert.equal(err.upstreamStatus, 502);
						assert.equal(err.rawLength, 0);
					}
				},
			);
		},
	],
	[
		"streams fallback text when Gemini response has no body",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			mod.resetGeminiUploadCachesForTest();
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () =>
					new Response(
						JSON.stringify([
							[
								"wrb.fr",
								null,
								JSON.stringify([
									null,
									null,
									null,
									null,
									[[null, ["stream fallback"]]],
									"x".repeat(160),
								]),
							],
						]),
						{ status: 200 },
					),
				async () => {
					const chunks = [];
					for await (const delta of mod.generateStream(
						cfg,
						"prompt",
						1,
						4,
						null,
						null,
					))
						chunks.push(delta);
					assert.deepEqual(chunks, ["stream fallback"]);
				},
			);
		},
	],
	[
		"streams fallback text from response-like objects with no body",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () => ({
					ok: true,
					status: 200,
					body: null,
					async text() {
						return wrbLine(["response-like fallback"]);
					},
				}),
				async () => {
					const chunks = [];
					for await (const delta of mod.generateStream(
						cfg,
						"prompt",
						1,
						4,
						null,
						null,
					))
						chunks.push(delta);
					assert.deepEqual(chunks, ["response-like fallback"]);
				},
			);
		},
	],
	[
		"throws when streamed Gemini body has no parseable text",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const calls = [];
			await withFetch(
				async (url) => {
					const href = String(url);
					calls.push(href);
					if (href === "https://gemini.example/app")
						return new Response("<html>no fresh build label</html>", {
							status: 200,
						});
					return new Response("not parseable", { status: 502 });
				},
				async () => {
					try {
						for await (const _delta of mod.generateStream(
							cfg,
							"prompt",
							1,
							4,
							null,
							null,
						)) {
							throw new Error("stream should not yield");
						}
						throw new Error("expected parse failure");
					} catch (err) {
						assert.equal(err.code, "upstream_empty_response");
						assert.equal(err.status, 502);
						assert.equal(err.upstreamStatus, 502);
						assert.equal(err.rawLength, "not parseable".length);
					}
				},
			);
			assert.equal(
				calls.some((href) => href === "https://gemini.example/app"),
				true,
			);
		},
	],
	[
		"throws explicit stream upstream empty error for HTTP 200 responses",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "stale-stream-bl",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async (url) => {
					if (String(url) === "https://gemini.example/app")
						return new Response("<html>no fresh build label</html>", {
							status: 200,
						});
					return new Response("stream completed without wrb text", {
						status: 200,
					});
				},
				async () => {
					try {
						for await (const _delta of mod.generateStream(
							cfg,
							"prompt",
							1,
							4,
							null,
							null,
						)) {
							throw new Error("stream should not yield");
						}
						throw new Error("expected upstream empty stream response");
					} catch (err) {
						assert.equal(err.code, "upstream_empty_response");
						assert.equal(err.status, 502);
						assert.equal(err.upstreamStatus, 200);
						assert.equal(
							err.rawLength,
							"stream completed without wrb text".length,
						);
					}
				},
			);
		},
	],
	[
		"refreshes Gemini build label and retries empty stream bodies",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "old-stream-bl",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 2,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const streamUrls = [];
			await withFetch(
				async (url) => {
					const href = String(url);
					if (href === "https://gemini.example/app")
						return new Response('<html>{"cfb2h":"fresh-stream-bl"}</html>', {
							status: 200,
						});
					streamUrls.push(href);
					if (streamUrls.length === 1)
						return new Response("not parseable yet", { status: 200 });
					return new Response(wrbLine(["after stream refresh"]), {
						status: 200,
					});
				},
				async () => {
					const chunks = [];
					for await (const delta of mod.generateStream(
						cfg,
						"prompt",
						1,
						4,
						null,
						null,
					))
						chunks.push(delta);
					assert.deepEqual(chunks, ["after stream refresh"]);
				},
			);
			assert.match(streamUrls[0], /bl=old-stream-bl/);
			assert.match(streamUrls[1], /bl=fresh-stream-bl/);
		},
	],
	[
		"adapts resolved models through the Gemini completion provider",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const provider = mod.createGeminiCompletionProvider(cfg);
			const rm = mod.resolveModel("gemini-3.1-pro", "gemini-3.5-flash");
			await withFetch(
				async (url, init) => {
					assert.match(String(url), /StreamGenerate/);
					const payload = new URLSearchParams(String(init.body)).get("f.req");
					const outer = JSON.parse(payload);
					const inner = JSON.parse(outer[1]);
					assert.match(payload, /provider prompt/);
					assert.match(payload, /file-ref/);
					assert.equal(
						init.headers["x-goog-ext-525001261-jspb"],
						'[1,null,null,null,"9d8ca3786ebdfbea",null,null,0,[4],null,null,1]',
					);
					assert.equal(init.headers["x-goog-ext-73010989-jspb"], "[0]");
					assert.equal(init.headers["x-goog-ext-73010990-jspb"], "[0]");
					assert.equal(
						JSON.parse(init.headers["x-goog-ext-525005358-jspb"])[0],
						inner[59],
					);
					return new Response(wrbLine(["provider answer"]), { status: 200 });
				},
				async () => {
					const text = await provider.generateText({
						prompt: "provider prompt",
						rm,
						fileRefs: [{ ref: "file-ref", name: "doc.txt" }],
					});
					assert.equal(text, "provider answer");
				},
			);
		},
	],
	[
		"logs Gemini routing fields through the completion provider",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: true,
			};
			const provider = mod.createGeminiCompletionProvider(cfg);
			const rm = mod.resolveModel(
				"gemini-3.1-pro-enhanced",
				"gemini-3.5-flash",
			);
			const logs = [];
			await withConsoleLog(
				(line) => logs.push(String(line)),
				async () => {
					await withFetch(
						async () =>
							new Response(wrbLine(["provider answer"]), { status: 200 }),
						async () => {
							const text = await provider.generateText({
								prompt: "secret prompt",
								rm,
								fileRefs: null,
							});
							assert.equal(text, "provider answer");
						},
					);
				},
			);
			const routeLog = logs.find((line) => line.includes("stage=gemini_route"));
			assert.match(routeLog, /model=gemini-3\.1-pro-enhanced/);
			assert.match(routeLog, /modelFamily=3/);
			assert.match(routeLog, /thinkingMode=4/);
			assert.match(routeLog, /enhancedMode=2/);
			assert.match(routeLog, /enhancedRouting=3/);
			assert.match(routeLog, /webModelHeader=true/);
			assert.equal(
				logs.some((line) => line.includes("secret prompt")),
				false,
			);
		},
	],
	[
		"streams text through the Gemini completion provider and rejects unresolved models",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const provider = mod.createGeminiCompletionProvider(cfg);
			await withFetch(
				async () =>
					new Response(
						[wrbLine(["hello"]), wrbLine(["hello world"])].join("\n"),
						{ status: 200 },
					),
				async () => {
					const deltas = [];
					for await (const delta of provider.streamText(
						{
							prompt: "stream prompt",
							rm: {
								name: "gemini-3.5-flash",
								modeId: 1,
								thinkMode: 4,
								extra: null,
							},
							fileRefs: null,
						},
						{ signal: new AbortController().signal },
					)) {
						deltas.push(delta);
					}
					assert.deepEqual(deltas, ["hello", " world"]);
				},
			);
			await assert.rejects(
				() =>
					provider.generateText({
						prompt: "bad model",
						rm: { error: "model_not_found" },
						fileRefs: null,
					}),
				/model_not_found/,
			);
		},
	],
	[
		"forwards image resolution and text uploads through the Gemini completion provider",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const provider = mod.createGeminiCompletionProvider(cfg);
			assert.deepEqual(
				await provider.resolveAttachments(mod.createAttachmentPlan()),
				{
					fileRefs: null,
					imageFileRefs: null,
					genericFileRefs: null,
					promptText: "",
					droppedNote: "",
					supportsFileRefs: false,
					usage: {
						uploadedFiles: 0,
						dedupedFiles: 0,
						uploadedBytes: 0,
						fileRefBytes: 0,
						inlinedFiles: 0,
						inlinedBytes: 0,
						droppedFiles: 0,
						multipartUploads: 0,
					},
				},
			);

			const calls = [];
			await withFetch(
				async (url, init) => {
					calls.push({ url: String(url), body: init?.body });
					if (String(url) === "https://gemini.example/app") {
						return new Response('{"qKIAYe":"push-provider"}', { status: 200 });
					}
					if (String(url) === "https://content-push.googleapis.com/upload") {
						assert.equal(init.method, "POST");
						assert.equal(init.headers["X-Tenant-Id"], "bard-storage");
						assert.equal(init.headers.Cookie, undefined);
						assert.equal(init.headers.Authorization, undefined);
						assert.match(
							init.headers["Content-Type"],
							/^multipart\/form-data; boundary=/,
						);
						assert.match(
							new TextDecoder().decode(await bodyBytes(init.body)),
							/name="file"; filename="context\.txt"/,
						);
						return new Response("/uploaded/context-file", { status: 200 });
					}
					throw new Error(`unexpected upload URL: ${url}`);
				},
				async () => {
					const uploaded = await provider.uploadTextFile(
						"context text",
						"context.txt",
					);
					assert.deepEqual(uploaded, {
						ref: "/uploaded/context-file",
						name: "context.txt",
					});
				},
			);
			assert.deepEqual(
				calls.map((call) => call.url),
				[
					"https://gemini.example/app",
					"https://content-push.googleapis.com/upload",
				],
			);
		},
	],
];

async function bodyBytes(body) {
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body))
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	return new Response(body).bytes();
}
