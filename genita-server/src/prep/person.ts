/**
 * Subject matte for the device's background lock (11/3, app #310): SAM 3.1 on the scene still, one_bit mask of the
 * largest match for "the person" / "the animal" / "the character", decoded with meta/samMask.ts and written as an
 * 8-bit grey PNG at the still's own size and coordinates (0 = background, 255 = subject, hard edge; the app erodes
 * ~4 px and feathers ~2.5 px). Manifest: face.images.person. Meta-only: no on-device segmentation fallback.
 */
import { deflateSync } from "node:zlib";
import type { CompanionKind } from "./prompts.ts";
import type { MediaApi } from "./face.ts";
import { decodeSamMask } from "../meta/samMask.ts";
import type { SamBox } from "../meta/sam.ts";

const NOUN: Record<CompanionKind, string> = { human: "person", animal: "animal", character: "character" };

export const personPrompt = (kind: CompanionKind) => `the ${NOUN[kind]}`;

/** Full-frame 0/255 raster (w x h) from the largest SAM box that carries a mask; null when none decodes. */
export function personRaster(boxes: readonly SamBox[], size: [number, number]): Uint8Array | null {
  const [W, H] = size;
  const withMask = boxes.filter((b) => b.mask && b.w && b.h).sort((a, b) => (b.x2 - b.x1) * (b.y2 - b.y1) - (a.x2 - a.x1) * (a.y2 - a.y1));
  for (const b of withMask) {
    let m;
    try {
      m = decodeSamMask(b.mask!);
    } catch {
      continue; // a bad payload: try the next box
    }
    const out = new Uint8Array(W * H);
    // the mask raster is stretched over the box in SAM's pixel space (b.w x b.h); on big boxes SAM sends a raster
    // smaller than the box, so map every still pixel into the box first, then into the raster
    const sx = b.w! / W, sy = b.h! / H;
    const bw = b.x2 - b.x1 + 1, bh = b.y2 - b.y1 + 1;
    let on = 0;
    for (let y = 0; y < H; y++) {
      const fy = ((y + 0.5) * sy - b.y1) / bh;
      if (fy < 0 || fy >= 1) continue;
      const my = Math.min(m.height - 1, Math.floor(fy * m.height));
      for (let x = 0; x < W; x++) {
        const fx = ((x + 0.5) * sx - b.x1) / bw;
        if (fx < 0 || fx >= 1) continue;
        const mx = Math.min(m.width - 1, Math.floor(fx * m.width));
        if (m.bits[my * m.width + mx]) {
          out[y * W + x] = 255;
          on++;
        }
      }
    }
    if (on > 0.01 * W * H) return out;
  }
  return null;
}

/** 8-bit greyscale PNG (no filter), so the server needs no image library. */
export function greyPng(px: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) raw.set(px.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  const chunk = (t: string, d: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(td));
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** SAM 3.1 matte of the subject as a grey PNG at `size`, or null (no match / no mask / undecodable). */
export async function makePersonMatte(o: {
  media: MediaApi;
  metaKey: string;
  sceneDataUrl: string;
  size: [number, number];
  kind: CompanionKind;
  signal?: AbortSignal;
}): Promise<Buffer | null> {
  // live 11/3: "the character" (and "the main subject") miss plush toys, "the toy" hits; tried only on a miss
  for (const prompt of o.kind === "character" ? [personPrompt(o.kind), "the toy"] : [personPrompt(o.kind)]) {
    const boxes = await o.media.samDetect(o.metaKey, o.sceneDataUrl, prompt, o.signal, { masks: true });
    const r = personRaster(boxes, o.size);
    if (r) return greyPng(r, o.size[0], o.size[1]);
  }
  return null;
}

/**
 * 11/4: the subject's face silhouette (SAM 3.1 "the person's face" / "the animal's face" / "the character's face",
 * one_bit mask, largest match) as a grey PNG at `size`, or null. faceflow keeps the mouth blend inside it.
 */
export async function makeFaceSilhouette(o: {
  media: MediaApi;
  metaKey: string;
  sceneDataUrl: string;
  size: [number, number];
  kind: CompanionKind;
  signal?: AbortSignal;
}): Promise<Buffer | null> {
  const boxes = await o.media.samDetect(o.metaKey, o.sceneDataUrl, `the ${NOUN[o.kind]}'s face`, o.signal, { masks: true });
  const r = personRaster(boxes, o.size);
  return r ? greyPng(r, o.size[0], o.size[1]) : null;
}
