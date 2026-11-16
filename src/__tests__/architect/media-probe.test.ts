import { describe, expect, it } from "vitest";
import { probeMedia } from "../../services/architect/media-probe.js";

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpeg(width: number, height: number, sof = 0xc0): Buffer {
  // SOI, an APP0 segment of 16 bytes, then the start-of-frame segment.
  const app0 = Buffer.alloc(18);
  app0[0] = 0xff;
  app0[1] = 0xe0;
  app0.writeUInt16BE(16, 2);
  const sofSeg = Buffer.alloc(19);
  sofSeg[0] = 0xff;
  sofSeg[1] = sof;
  sofSeg.writeUInt16BE(17, 2);
  sofSeg[4] = 8;
  sofSeg.writeUInt16BE(height, 5);
  sofSeg.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sofSeg]);
}

function webp(chunk: "VP8X" | "VP8 " | "VP8L", width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write(chunk, 12, "ascii");
  if (chunk === "VP8X") {
    b.writeUIntLE(width - 1, 24, 3);
    b.writeUIntLE(height - 1, 27, 3);
  } else if (chunk === "VP8 ") {
    b[23] = 0x9d;
    b[24] = 0x01;
    b[25] = 0x2a;
    b.writeUInt16LE(width, 26);
    b.writeUInt16LE(height, 28);
  } else {
    b[20] = 0x2f;
    b.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  }
  return b;
}

describe("probeMedia", () => {
  it("reads PNG dimensions from IHDR", () => {
    expect(probeMedia(png(1024, 768))).toEqual({ readable: true, format: "png", width: 1024, height: 768 });
  });

  it("reads JPEG dimensions from the start-of-frame segment, skipping other segments", () => {
    expect(probeMedia(jpeg(1920, 1080))).toEqual({ readable: true, format: "jpeg", width: 1920, height: 1080 });
    expect(probeMedia(jpeg(640, 480, 0xc2))).toEqual({ readable: true, format: "jpeg", width: 640, height: 480 });
  });

  it("doesn't take a Huffman table segment (C4) for a frame", () => {
    const b = jpeg(10, 20, 0xc4);
    expect(probeMedia(b).readable).toBe(false);
  });

  it("reads all three WebP variants", () => {
    expect(probeMedia(webp("VP8X", 1024, 1024))).toEqual({ readable: true, format: "webp", width: 1024, height: 1024 });
    expect(probeMedia(webp("VP8 ", 800, 600))).toEqual({ readable: true, format: "webp", width: 800, height: 600 });
    expect(probeMedia(webp("VP8L", 300, 200))).toEqual({ readable: true, format: "webp", width: 300, height: 200 });
  });

  it("reports unreadable files instead of guessing", () => {
    expect(probeMedia(Buffer.alloc(0))).toEqual({ readable: false, reason: "empty file" });
    expect(probeMedia(Buffer.from("GIF89a....")).readable).toBe(false);
    expect(probeMedia(png(1, 1).subarray(0, 20)).readable).toBe(false);
    expect(probeMedia(jpeg(1, 1).subarray(0, 25)).readable).toBe(false);
    expect(probeMedia(webp("VP8 ", 1, 1).fill(0, 23, 26)).readable).toBe(false);
  });
});
