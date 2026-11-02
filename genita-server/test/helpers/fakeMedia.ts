/**
 * Fake Muse Image + SAM for prep tests. Images are tiny PNG headers (real
 * IHDR, so size sniffing works) followed by a tag; SAM answers per tag from
 * a script the test writes. No network.
 */
import type { SamBox } from "../../src/meta/sam.ts";
import type { MediaApi } from "../../src/prep/face.ts";

export function fakePng(w: number, h: number, tag: string): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), len, Buffer.from("IHDR"), ihdr, Buffer.alloc(4), Buffer.from(`TAG:${tag}`)]);
}

export const tagOf = (bytes: Buffer) => bytes.toString("latin1").split("TAG:")[1] ?? "";

/** pixel box in a w×h image, SAM-style (with w/h so nx/ny are filled) */
export function box(x1: number, y1: number, x2: number, y2: number, w = 1000, h = 2000): SamBox {
  return { x1, y1, x2, y2, w, h, nx1: x1 / w, ny1: y1 / h, nx2: x2 / w, ny2: y2 / h };
}

export const FACE = box(300, 400, 700, 900);
export const MOUTH = box(420, 760, 580, 820);

export type FakeMediaOpts = {
  /** answer for an edit: by default returns an image tagged `<promptKey>#<n>` */
  size?: [number, number];
  /** SAM boxes for an image tag and part; default FACE / MOUTH */
  sam?: (tag: string, part: "face" | "mouth") => SamBox[];
  /** throw for this edit call (tag = `<key>#<n>`) */
  fail?: (tag: string) => Error | null;
  /** prompt → key, so the fake can name its outputs */
  keyOf: (prompt: string) => string;
  delayMs?: number;
};

export function fakeMedia(o: FakeMediaOpts) {
  const calls = { edits: [] as Array<{ key: string; prompt: string }>, sam: [] as Array<{ tag: string; prompt: string }>, maxInFlight: 0 };
  let inFlight = 0;
  const n = new Map<string, number>();
  const media: MediaApi = {
    async imageEdit(_key, image, prompt) {
      const k = o.keyOf(prompt);
      calls.edits.push({ key: k, prompt });
      inFlight++;
      calls.maxInFlight = Math.max(calls.maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, o.delayMs ?? 1));
        const i = (n.get(k) ?? 0) + 1;
        n.set(k, i);
        const tag = k === "scene" ? "scene" : `${k}#${i}`;
        const err = o.fail?.(tag);
        if (err) throw err;
        if (k !== "scene") assertIsScene(image);
        const [w, h] = o.size ?? [1000, 2000];
        return fakePng(w, h, tag);
      } finally {
        inFlight--;
      }
    },
    async samDetect(_key, dataUrl, prompt) {
      const tag = tagOf(Buffer.from(dataUrl.split(",")[1], "base64"));
      calls.sam.push({ tag, prompt });
      const part = /mouth/.test(prompt) ? "mouth" : "face";
      return o.sam ? o.sam(tag, part) : [part === "face" ? FACE : MOUTH];
    },
  };
  return { media, calls };
}

function assertIsScene(image: Buffer) {
  if (!tagOf(image).startsWith("scene")) throw new Error(`edits must start from the scene, got ${tagOf(image)}`);
}
