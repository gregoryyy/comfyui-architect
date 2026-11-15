// Reads an output file's format and pixel dimensions from its header (TODO 3.7).
//
// The automatic checks compare a run's outputs with the task: count, format and size
// (spec §13.2). Only the header is read, so a probe is cheap and decodes nothing. A file
// whose header can't be parsed is reported as unreadable, never guessed at: the check
// built on it is `unknown` or `fail`, not a pass (spec §7.3).

export type ProbedFormat = "png" | "jpeg" | "webp";

export type MediaProbe =
  | { readable: true; format: ProbedFormat; width: number; height: number }
  | { readable: false; reason: string };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function probePng(b: Buffer): MediaProbe {
  // The first chunk must be IHDR: length 13, then width and height as big-endian u32.
  if (b.length < 24 || b.toString("ascii", 12, 16) !== "IHDR") return { readable: false, reason: "PNG without an IHDR chunk" };
  return { readable: true, format: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// Start-of-frame markers carry the size; DHT (C4), JPG (C8) and DAC (CC) share the range.
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function probeJpeg(b: Buffer): MediaProbe {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return { readable: false, reason: `JPEG marker expected at byte ${i}` };
    const marker = b[i + 1];
    // Fill bytes and markers without a length (RSTn, TEM) carry no segment.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const length = b.readUInt16BE(i + 2);
    if (length < 2) return { readable: false, reason: `JPEG segment with length ${length}` };
    if (JPEG_SOF.has(marker)) {
      if (i + 9 > b.length) break;
      return { readable: true, format: "jpeg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return { readable: false, reason: "JPEG without a start-of-frame segment" };
}

function probeWebp(b: Buffer): MediaProbe {
  if (b.length < 30) return { readable: false, reason: "WebP header truncated" };
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    // Canvas size minus one, as 24-bit little-endian values.
    return { readable: true, format: "webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  if (chunk === "VP8 ") {
    // Lossy: after the 3-byte frame tag and the start code 9d 01 2a, 14-bit sizes.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return { readable: false, reason: "VP8 start code missing" };
    return { readable: true, format: "webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    // Lossless: signature 2f, then width-1 and height-1 as 14-bit fields.
    if (b[20] !== 0x2f) return { readable: false, reason: "VP8L signature missing" };
    const bits = b.readUInt32LE(21);
    return { readable: true, format: "webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  return { readable: false, reason: `WebP chunk ${JSON.stringify(chunk)} not recognised` };
}

/** The format and size of an image file, from its first bytes. */
export function probeMedia(bytes: Buffer): MediaProbe {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return probePng(bytes);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return probeJpeg(bytes);
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return probeWebp(bytes);
  return { readable: false, reason: bytes.length === 0 ? "empty file" : "not a PNG, JPEG or WebP file" };
}
