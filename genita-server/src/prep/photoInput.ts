/**
 * What an uploaded photo has to be before any model sees it (photo polish, 11/4): the type from the bytes, a readable frame header and a usable size.
 * Headers only, no decoder. A photo that fails here never works, so the user is asked for another
 * photo instead of "Try again".
 */
export const MIN_PHOTO_SIDE = 128;
export const MAX_PHOTO_SIDE = 16384;

export type PhotoInput = { ok: true; width: number; height: number } | { ok: false; reason: "unsupported" | "corrupt" | "bad_dimensions" };
type Size = { width: number; height: number };

const tag = (b: Buffer, at: number) => b.toString("latin1", at, at + 4);

function pngSize(b: Buffer): Size | null {
  if (b.length < 24 || tag(b, 12) !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Walks the JPEG segments to the frame header (SOFn), which carries the size. */
function jpegSize(b: Buffer): Size | null {
  let i = 2;
  while (i + 9 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) i += 1;
    else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) i += 2;
    else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    else if (marker === 0xda) return null;
    else i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

function webpSize(b: Buffer): Size | null {
  if (b.length < 30) return null;
  const chunk = tag(b, 12);
  if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return null;
}

export function checkPhotoInput(b: Buffer): PhotoInput {
  let size: Size | null;
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) size = jpegSize(b);
  else if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) size = pngSize(b);
  else if (b.length > 12 && tag(b, 0) === "RIFF" && tag(b, 8) === "WEBP") size = webpSize(b);
  else return { ok: false, reason: "unsupported" };
  if (!size || !size.width || !size.height) return { ok: false, reason: "corrupt" };
  if (Math.min(size.width, size.height) < MIN_PHOTO_SIDE || Math.max(size.width, size.height) > MAX_PHOTO_SIDE) return { ok: false, reason: "bad_dimensions" };
  return { ok: true, ...size };
}
