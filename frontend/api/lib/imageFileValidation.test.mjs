import assert from "node:assert/strict";
import test from "node:test";

import { inspectImageFile } from "./imageFileValidation.js";

function png(width = 512, height = 512) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpeg(width = 640, height = 480) {
  const buffer = Buffer.alloc(13);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xc0;
  buffer.writeUInt16BE(9, 4);
  buffer[6] = 8;
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  buffer[11] = 0;
  buffer[12] = 0;
  return buffer;
}

function webpV8x(width = 320, height = 240) {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUInt32LE(10, 16);
  const w = width - 1;
  const h = height - 1;
  buffer[24] = w & 0xff;
  buffer[25] = (w >> 8) & 0xff;
  buffer[26] = (w >> 16) & 0xff;
  buffer[27] = h & 0xff;
  buffer[28] = (h >> 8) & 0xff;
  buffer[29] = (h >> 16) & 0xff;
  return buffer;
}

test("detects PNG from file signature and dimensions", () => {
  assert.deepEqual(inspectImageFile(png(), { declaredMime: "image/png" }), {
    mime: "image/png", ext: "png", width: 512, height: 512,
  });
});

test("detects JPEG from SOF dimensions", () => {
  assert.deepEqual(inspectImageFile(jpeg(), { declaredMime: "image/jpeg" }), {
    mime: "image/jpeg", ext: "jpg", width: 640, height: 480,
  });
});

test("detects WEBP VP8X dimensions", () => {
  assert.deepEqual(inspectImageFile(webpV8x(), { declaredMime: "image/webp" }), {
    mime: "image/webp", ext: "webp", width: 320, height: 240,
  });
});

test("rejects declared MIME that does not match file signature", () => {
  assert.throws(() => inspectImageFile(png(), { declaredMime: "image/jpeg" }), /MIME mismatch/);
});

test("rejects unsupported signatures", () => {
  assert.throws(() => inspectImageFile(Buffer.from("not-an-image"), { declaredMime: "image/png" }), /Unsupported image signature/);
});

test("rejects unreasonable dimensions", () => {
  assert.throws(() => inspectImageFile(png(5000, 100), { declaredMime: "image/png" }), /dimensions exceed/);
});
