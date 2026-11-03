import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { encodeOneBit } from "../src/meta/samMask.ts";
import type { SamBox } from "../src/meta/sam.ts";
import { faceManifest, type FaceState } from "../src/prep/face.ts";
import { greyPng, makePersonMatte, personPrompt, personRaster } from "../src/prep/person.ts";

/** A SAM box in SAM's own pixel space (w x h) with a one_bit mask that is a filled disc over the box. */
function discBox(x1: number, y1: number, x2: number, y2: number, w: number, h: number): SamBox {
  const mw = x2 - x1 + 1, mh = y2 - y1 + 1;
  const bits = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) bits[y * mw + x] = ((x - mw / 2) / (mw / 2)) ** 2 + ((y - mh / 2) / (mh / 2)) ** 2 < 1 ? 1 : 0;
  return { x1, y1, x2, y2, w, h, nx1: x1 / w, ny1: y1 / h, nx2: x2 / w, ny2: y2 / h, mask: { width: mw, height: mh, payload: encodeOneBit(bits, mw, mh) } };
}

/** Decode our own grey PNG back to pixels (no filter, one IDAT). */
function readGrey(png: Buffer): { w: number; h: number; px: Uint8Array } {
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  assert.equal(png[24], 8, "8-bit"); assert.equal(png[25], 0, "greyscale");
  const idatLen = png.readUInt32BE(33);
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) px.set(raw.subarray(y * (w + 1) + 1, (y + 1) * (w + 1)), y * w);
  return { w, h, px };
}

test("person matte: largest SAM mask lands at the still's size and coordinates (0 / 255, hard edge)", () => {
  // SAM saw the still at half size (100 x 180); the still is 200 x 360
  const small = discBox(10, 10, 20, 20, 100, 180);
  const big = discBox(20, 40, 80, 170, 100, 180);
  const r = personRaster([small, big], [200, 360])!;
  assert.ok(r);
  assert.equal(r.length, 200 * 360);
  assert.equal(r[(105 * 2) * 200 + 50 * 2], 255, "centre of the big disc is subject");
  assert.equal(r[5 * 200 + 5], 0, "corner is background");
  assert.equal(r[15 * 2 * 200 + 15 * 2], 0, "the smaller match is ignored");
  assert.ok([...new Set(r)].every((v) => v === 0 || v === 255), "hard matte");
});

test("person matte: no mask / undecodable mask / tiny match → null (never throws)", () => {
  const noMask: SamBox = { ...discBox(20, 40, 80, 170, 100, 180), mask: undefined };
  assert.equal(personRaster([noMask], [200, 360]), null);
  const bad: SamBox = { ...discBox(20, 40, 80, 170, 100, 180), mask: { width: 61, height: 131, payload: "!<<<" } };
  assert.equal(personRaster([bad], [200, 360]), null);
  assert.equal(personRaster([discBox(1, 1, 3, 3, 100, 180)], [200, 360]), null, "< 1 % of the frame is not a subject");
});

test("person matte PNG: 8-bit grey, still size, round-trips", () => {
  const px = new Uint8Array(7 * 5).map((_, i) => (i % 3 ? 255 : 0));
  const back = readGrey(greyPng(px, 7, 5));
  assert.deepEqual([back.w, back.h], [7, 5]);
  assert.deepEqual([...back.px], [...px]);
});

test("makePersonMatte: one SAM 3.1 call with masks, kind noun prompt, PNG out", async () => {
  const calls: Array<{ prompt: string; opts?: { masks?: boolean } }> = [];
  const media = {
    imageEdit: async () => Buffer.alloc(0),
    samDetect: async (_k: string, _u: string, prompt: string, _s?: AbortSignal, opts?: { masks?: boolean }) => {
      calls.push({ prompt, opts });
      return [discBox(20, 40, 80, 170, 100, 180)];
    },
  };
  const png = await makePersonMatte({ media, metaKey: "k", sceneDataUrl: "data:image/png;base64,", size: [200, 360], kind: "animal" });
  assert.ok(png);
  assert.deepEqual(calls, [{ prompt: "the animal", opts: { masks: true } }]);
  assert.equal(personPrompt("human"), "the person");
  assert.equal(personPrompt("character"), "the character");
  const g = readGrey(png!);
  assert.deepEqual([g.w, g.h], [200, 360]);
});

test("face manifest: images.person only when the matte was stored", () => {
  const s: FaceState = { size: [200, 360], ref: { face: [0.2, 0.2, 0.8, 0.6], mouth: [0.4, 0.5, 0.6, 0.53] }, items: {}, ms: { total: 0, edits: 0, sam: 0 } };
  const url = (k: string) => `/v1/companion/face/${k}`;
  assert.equal(faceManifest(s, url).images.person, undefined);
  assert.equal(faceManifest({ ...s, person: true }, url).images.person, "/v1/companion/face/person");
});
