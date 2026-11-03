import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSamBoxes } from "../src/meta/sam.ts";
import {
  SamMaskError,
  decodeLosslessCoverage,
  decodeSamMask,
  downscaleMask,
  encodeOneBit,
  fromRle,
  toRle,
  unpackSamPayload,
  wireMask,
} from "../src/meta/samMask.ts";

const FX = JSON.parse(readFileSync(new URL("./fixtures/sam-masks.json", import.meta.url), "utf8")) as Record<string, { text: string }>;

function only(name: string) {
  const boxes = parseSamBoxes(FX[name].text);
  assert.equal(boxes.length, 1);
  const b = boxes[0];
  assert.ok(b.mask, `${name}: mask token attached to its box`);
  return { box: b, mask: b.mask!, decoded: decodeSamMask(b.mask!) };
}

/** IoU of a decoded box-local mask against a shape function in source pixels. */
function iou(name: string, inside: (x: number, y: number) => boolean, size: number): number {
  const { box, decoded } = only(name);
  let i = 0;
  let u = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const lx = x - box.x1;
      const ly = y - box.y1;
      const p = lx >= 0 && ly >= 0 && lx < decoded.width && ly < decoded.height ? decoded.bits[ly * decoded.width + lx] === 1 : false;
      const g = inside(x, y);
      if (p && g) i++;
      if (p || g) u++;
    }
  }
  return i / u;
}

const shapes: Record<string, (w: number, h: number) => Uint8Array> = {
  empty: (w, h) => new Uint8Array(w * h),
  full: (w, h) => new Uint8Array(w * h).fill(1),
  square: (w, h) => Uint8Array.from({ length: w * h }, (_, i) => +(i % w >= w / 4 && i % w < (3 * w) / 4 && i / w >= h / 4 && i / w < (3 * h) / 4)),
  leftHalf: (w, h) => Uint8Array.from({ length: w * h }, (_, i) => +(i % w < w / 2)),
  line: (w, h) => Uint8Array.from({ length: w * h }, (_, i) => +(Math.floor(i / w) === Math.floor(h / 2))),
  twoBlobs: (w, h) =>
    Uint8Array.from({ length: w * h }, (_, i) => {
      const x = i % w;
      const y = Math.floor(i / w);
      return +((x < w / 3 && y < h / 3) || (x > (2 * w) / 3 && y > (2 * h) / 3));
    }),
  noise: (w, h) => {
    let s = 7;
    return Uint8Array.from({ length: w * h }, () => ((s = (s * 1103515245 + 12345) >>> 0) >>> 16) & 1);
  },
};

test("one_bit: encode → decode round-trips the probe shapes exactly", () => {
  for (const [name, make] of Object.entries(shapes)) {
    for (const [w, h] of [[1, 1], [64, 64], [110, 61], [3, 200]]) {
      const bits = make(w, h);
      const payload = encodeOneBit(bits, w, h);
      assert.ok(payload.startsWith("!"));
      assert.ok(!/[",;<>\\|]/.test(payload), "payload stays inside the token alphabet");
      const d = decodeSamMask({ width: w, height: h, payload });
      assert.equal(d.encoding, "one_bit");
      assert.deepEqual(d.bits, bits, `${name} ${w}x${h}`);
    }
  }
});

test("payload framing: base85 length prefix, short tail", () => {
  // 0x000007ca = 1994 bytes in the 64x64 white-square probe: the prefix counts payload bytes
  const p = encodeOneBit(shapes.square(64, 64), 64, 64).slice(1);
  const bytes = unpackSamPayload(p);
  assert.ok(bytes.length > 4);
  assert.throws(() => unpackSamPayload(p.slice(0, -1)), SamMaskError);
  assert.throws(() => unpackSamPayload("~~~~~"), SamMaskError);
});

test("real SAM 3.1 lossless rectangle decodes to the full box", () => {
  const { box, decoded } = only("rect_lossless");
  assert.deepEqual([box.x1, box.y1, box.x2, box.y2], [30, 40, 99, 59]);
  // the raster covers the box inclusively: W = x2 - x1 + 1
  assert.equal(decoded.width, box.x2 - box.x1 + 1);
  assert.equal(decoded.height, box.y2 - box.y1 + 1);
  assert.equal(decoded.encoding, "lossless");
  assert.ok(decoded.bits.every((b) => b === 1));
});

test("real SAM 3.1 ring keeps its hole (pixel mask, not a box): IoU ≥ 0.97 both encodings", () => {
  const ring = (x: number, y: number) => {
    const r2 = (x - 128) ** 2 + (y - 128) ** 2;
    return r2 <= 90 * 90 && r2 > 45 * 45;
  };
  assert.ok(iou("ring_one_bit", ring, 256) >= 0.97);
  assert.ok(iou("ring_lossless", ring, 256) >= 0.97);
  const a = only("ring_one_bit").decoded;
  const b = only("ring_lossless").decoded;
  assert.deepEqual(a.bits, b.bits, "one_bit equals thresholded lossless");
  assert.equal(a.bits[(128 - 39) * a.width + (128 - 39)], 0, "centre of the hole is outside");
});

test("real dog-mouth sample (sam_dog.json): lossless and one_bit agree, shape is a mouth not a box", () => {
  const l = only("dog_mouth_lossless").decoded;
  const o = only("dog_mouth_one_bit").decoded;
  assert.deepEqual([l.height, l.width], [61, 110]);
  let same = 0;
  let on = 0;
  for (let i = 0; i < l.bits.length; i++) {
    if (l.bits[i] === o.bits[i]) same++;
    on += l.bits[i];
  }
  assert.ok(same / l.bits.length > 0.99, "two separate calls, same picture");
  const fill = on / l.bits.length;
  assert.ok(fill > 0.4 && fill < 0.8, `fill ${fill}`);
  assert.equal(l.bits[0], 0, "corner of the box is outside the mouth");
  // coverage is 8-bit soft: edges sit between 0 and 255
  const cov = decodeLosslessCoverage(only("dog_mouth_lossless").mask.payload, l.width, l.height);
  assert.ok(cov.some((v) => v > 20 && v < 235));
});

test("damaged payloads throw SamMaskError; wireMask turns that into null", () => {
  const { mask } = only("dog_mouth_one_bit");
  const flipped = mask.payload.slice(0, 20) + (mask.payload[20] === "a" ? "b" : "a") + mask.payload.slice(21);
  assert.throws(() => decodeSamMask({ ...mask, payload: flipped }), SamMaskError);
  assert.throws(() => decodeSamMask({ ...mask, payload: "?" + mask.payload.slice(1) }), SamMaskError);
  assert.throws(() => decodeSamMask({ ...mask, width: 0 }), SamMaskError);
  assert.equal(wireMask({ ...mask, payload: flipped }), null);
});

test("wire mask: RLE starts with 0s, sums to w*h, downscaled to ≤ 96 on the long side", () => {
  const { mask, decoded } = only("ring_lossless");
  const wm = wireMask(mask)!;
  assert.ok(Math.max(wm.w, wm.h) <= 96);
  assert.equal(wm.rle.reduce((a, b) => a + b, 0), wm.w * wm.h);
  const bits = fromRle(wm.w, wm.h, wm.rle);
  assert.equal(bits[0], 0);
  assert.equal(bits[Math.floor(wm.h / 2) * wm.w + Math.floor(wm.w / 2)], 0, "hole survives the downscale");
  const small = downscaleMask(decoded, 96);
  assert.deepEqual(bits, small.bits);
  assert.deepEqual(toRle(Uint8Array.from([1, 1, 0])), [0, 2, 1]);
  assert.equal(wireMask({ width: 4, height: 4, payload: encodeOneBit(new Uint8Array(16), 4, 4) }), null, "empty mask → null");
});

test("parseSamBoxes pairs each mask with the box before it (multi-record, confidence field)", () => {
  const m1 = encodeOneBit(shapes.full(3, 2), 3, 2);
  const m2 = encodeOneBit(shapes.line(4, 3), 4, 3);
  const t =
    `<0f>0<|box;x1=1;y1=1;x2=3;y2=2;w=10;h=10|><|mask;x=0;y=0;data=2,3,${m1}|>,` +
    `2<|box;x1=5;y1=5;x2=8;y2=7;w=10;h=10;c=0.9|><|mask;x=0;y=0;c=0.9;data=3,4,${m2}|>,3<|box;x1=0;y1=0;x2=1;y2=1;w=10;h=10|>`;
  const [a, b, c] = parseSamBoxes(t);
  assert.deepEqual(a.mask, { height: 2, width: 3, payload: m1 });
  assert.deepEqual(b.mask, { height: 3, width: 4, payload: m2 });
  assert.equal(c.mask, undefined);
  assert.deepEqual(decodeSamMask(b.mask!).bits, shapes.line(4, 3));
});
