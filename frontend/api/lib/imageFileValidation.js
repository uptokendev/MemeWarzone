const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_DIMENSION = 4096;
const DEFAULT_MAX_PIXELS = 16_777_216;

function normalizeDeclaredMime(value) {
  const mime = String(value || "").trim().toLowerCase();
  if (mime === "image/jpg") return "image/jpeg";
  return mime;
}

function pngInfo(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") throw new Error("PNG is missing its IHDR header");
  return {
    mime: "image/png",
    ext: "png",
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

function jpegInfo(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      throw new Error("JPEG contains an invalid segment length");
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7 || offset + 7 > buffer.length) throw new Error("JPEG SOF header is truncated");
      return {
        mime: "image/jpeg",
        ext: "jpg",
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  throw new Error("JPEG dimensions could not be determined");
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function webpInfo(buffer) {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) return null;

  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return {
      mime: "image/webp",
      ext: "webp",
      width: 1 + readUInt24LE(buffer, 24),
      height: 1 + readUInt24LE(buffer, 27),
    };
  }
  if (chunk === "VP8L") {
    if (buffer[20] !== 0x2f) throw new Error("WEBP lossless signature is invalid");
    const b1 = buffer[21];
    const b2 = buffer[22];
    const b3 = buffer[23];
    const b4 = buffer[24];
    return {
      mime: "image/webp",
      ext: "webp",
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
    };
  }
  if (chunk === "VP8 ") {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) {
      throw new Error("WEBP lossy frame signature is invalid");
    }
    return {
      mime: "image/webp",
      ext: "webp",
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  throw new Error("Unsupported WEBP frame format");
}

export function inspectImageFile(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("Image file is empty");
  const maxBytes = Number(options.maxBytes) || DEFAULT_MAX_BYTES;
  const maxDimension = Number(options.maxDimension) || DEFAULT_MAX_DIMENSION;
  const maxPixels = Number(options.maxPixels) || DEFAULT_MAX_PIXELS;
  if (buffer.length > maxBytes) throw new Error(`Image exceeds ${maxBytes} byte limit`);

  const detected = pngInfo(buffer) || jpegInfo(buffer) || webpInfo(buffer);
  if (!detected) throw new Error("Unsupported image signature. Use PNG, JPEG, or WEBP");

  const declared = normalizeDeclaredMime(options.declaredMime);
  if (declared && declared !== detected.mime) {
    throw new Error(`Image MIME mismatch: declared ${declared}, detected ${detected.mime}`);
  }
  if (!(detected.width > 0) || !(detected.height > 0)) throw new Error("Image dimensions are invalid");
  if (detected.width > maxDimension || detected.height > maxDimension) {
    throw new Error(`Image dimensions exceed ${maxDimension}x${maxDimension}`);
  }
  if (detected.width * detected.height > maxPixels) throw new Error("Image pixel count is too large");
  return detected;
}

export const ARENA_IMPORT_IMAGE_LIMITS = Object.freeze({
  maxBytes: DEFAULT_MAX_BYTES,
  maxDimension: DEFAULT_MAX_DIMENSION,
  maxPixels: DEFAULT_MAX_PIXELS,
});
