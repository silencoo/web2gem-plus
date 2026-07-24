/** Minimal PNG RGB/RGBA codec for Workers (zlib via CompressionStream). */

export type RgbaImage = {
	width: number;
	height: number;
	/** RGBA bytes, length = width * height * 4 */
	data: Uint8Array;
};

const PNG_SIGNATURE = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function isPngBytes(bytes: Uint8Array): boolean {
	if (bytes.length < 8) return false;
	for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
	return true;
}

export async function decodePng(bytes: Uint8Array): Promise<RgbaImage> {
	if (!isPngBytes(bytes)) throw new Error("not a PNG");
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	const idatParts: Uint8Array[] = [];
	let offset = 8;
	while (offset + 12 <= bytes.length) {
		const length = readU32(bytes, offset);
		const type = String.fromCharCode(
			bytes[offset + 4] ?? 0,
			bytes[offset + 5] ?? 0,
			bytes[offset + 6] ?? 0,
			bytes[offset + 7] ?? 0,
		);
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		if (dataEnd + 4 > bytes.length) throw new Error("truncated PNG chunk");
		const chunk = bytes.subarray(dataStart, dataEnd);
		if (type === "IHDR") {
			width = readU32(chunk, 0);
			height = readU32(chunk, 4);
			bitDepth = chunk[8] ?? 0;
			colorType = chunk[9] ?? 0;
			if (bitDepth !== 8)
				throw new Error(`unsupported PNG bit depth ${bitDepth}`);
			if (colorType !== 2 && colorType !== 6)
				throw new Error(`unsupported PNG color type ${colorType}`);
		} else if (type === "IDAT") {
			idatParts.push(chunk);
		} else if (type === "IEND") {
			break;
		}
		offset = dataEnd + 4;
	}
	if (!width || !height) throw new Error("PNG missing IHDR");
	const compressed = concatBytes(idatParts);
	const raw = await inflateZlib(compressed);
	const bpp = colorType === 6 ? 4 : 3;
	const stride = width * bpp + 1;
	if (raw.length < stride * height)
		throw new Error("PNG IDAT too short for image size");
	const rgba = new Uint8Array(width * height * 4);
	const prev = new Uint8Array(width * bpp);
	for (let y = 0; y < height; y++) {
		const rowOffset = y * stride;
		const filter = raw[rowOffset] ?? 0;
		const scan = raw.subarray(rowOffset + 1, rowOffset + stride);
		const recon = new Uint8Array(width * bpp);
		for (let i = 0; i < scan.length; i++) {
			const x = scan[i] ?? 0;
			const a = i >= bpp ? (recon[i - bpp] ?? 0) : 0;
			const b = prev[i] ?? 0;
			const c = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
			let value = x;
			if (filter === 1) value = (x + a) & 255;
			else if (filter === 2) value = (x + b) & 255;
			else if (filter === 3) value = (x + ((a + b) >> 1)) & 255;
			else if (filter === 4) value = (x + paeth(a, b, c)) & 255;
			else if (filter !== 0)
				throw new Error(`unsupported PNG filter ${filter}`);
			recon[i] = value;
		}
		for (let x = 0; x < width; x++) {
			const src = x * bpp;
			const dst = (y * width + x) * 4;
			rgba[dst] = recon[src] ?? 0;
			rgba[dst + 1] = recon[src + 1] ?? 0;
			rgba[dst + 2] = recon[src + 2] ?? 0;
			rgba[dst + 3] = bpp === 4 ? (recon[src + 3] ?? 255) : 255;
		}
		prev.set(recon);
	}
	return { width, height, data: rgba };
}

export async function encodePng(image: RgbaImage): Promise<Uint8Array> {
	const { width, height, data } = image;
	const stride = width * 4 + 1;
	const raw = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const rowStart = y * stride;
		raw[rowStart] = 0; // filter None
		raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1);
	}
	const compressed = await deflateZlib(raw);
	const ihdr = new Uint8Array(13);
	writeU32(ihdr, 0, width);
	writeU32(ihdr, 4, height);
	ihdr[8] = 8;
	ihdr[9] = 6; // RGBA
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;
	const chunks = [
		PNG_SIGNATURE,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", compressed),
		pngChunk("IEND", new Uint8Array(0)),
	];
	return concatBytes(chunks);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	writeU32(out, 0, data.length);
	out[4] = type.charCodeAt(0);
	out[5] = type.charCodeAt(1);
	out[6] = type.charCodeAt(2);
	out[7] = type.charCodeAt(3);
	out.set(data, 8);
	const crcInput = out.subarray(4, 8 + data.length);
	writeU32(out, 8 + data.length, crc32(crcInput));
	return out;
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([
		bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer,
	])
		.stream()
		.pipeThrough(new DecompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([
		bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer,
	])
		.stream()
		.pipeThrough(new CompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function readU32(bytes: Uint8Array, offset: number): number {
	return (
		(((bytes[offset] ?? 0) << 24) |
			((bytes[offset + 1] ?? 0) << 16) |
			((bytes[offset + 2] ?? 0) << 8) |
			(bytes[offset + 3] ?? 0)) >>>
		0
	);
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = (value >>> 24) & 255;
	bytes[offset + 1] = (value >>> 16) & 255;
	bytes[offset + 2] = (value >>> 8) & 255;
	bytes[offset + 3] = value & 255;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		const tableValue = CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 255] ?? 0;
		c = tableValue ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}
