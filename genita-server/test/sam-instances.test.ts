import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SamBox } from "../src/meta/sam.ts";
import { encodeOneBit, fromRle } from "../src/meta/samMask.ts";
import { MAX_BOX_ITEMS, boxItems, instancesOf, mergeInstances, pickPhrasing } from "../src/finds/instances.ts";

// live SAM 3.1 on a counter photo: 3 tomatoes, 2 red bell peppers, 2 onions, 1 garlic bulb
const FX = JSON.parse(readFileSync(new URL("./fixtures/sam-counter.json", import.meta.url), "utf8")) as Record<string, SamBox[]>;
const pick = (...prompts: string[]) => pickPhrasing(prompts.map((p) => instancesOf(FX[p])).map((i) => (i.length ? { instances: i } : null)))!.instances!;

test("counter photo: one instance per tomato, pepper, onion; garlic is the bulb, not its cloves", () => {
  const tomatoes = pick("tomato", "tomatoes");
  assert.equal(tomatoes.length, 3);
  assert.equal(pick("red bell pepper").length, 2);
  assert.equal(pick("onion").length, 2);
  // "garlics" scores lower and finds the cloves; the singular's bulb wins
  assert.ok(instancesOf(FX.garlics).length > 1);
  assert.equal(pick("garlic", "garlics").length, 1);
  for (const t of tomatoes) {
    assert.ok(t.mask && t.score! >= 0.5);
    const bits = fromRle(t.mask.w, t.mask.h, t.mask.rle);
    const fill = bits.reduce((a, b) => a + b, 0) / bits.length;
    assert.ok(fill > 0.6 && fill < 0.9, `round tomato fills ${fill} of its box`);
  }
  // separate tomatoes do not overlap
  const [a, b] = tomatoes;
  assert.ok(a.box.x2 <= b.box.x1 || b.box.x2 <= a.box.x1 || a.box.y2 <= b.box.y1 || b.box.y2 <= a.box.y1);
});

test("counter photo: 8 items under the cap; at cap 6 the tomatoes merge into one union", () => {
  const groups = [
    { label: "Tomatoes", instances: pick("tomato", "tomatoes") },
    { label: "Red bell peppers", instances: pick("red bell pepper") },
    { label: "Onions", instances: pick("onion") },
    { label: "Garlic", instances: pick("garlic", "garlics") },
  ];
  const all = boxItems(groups);
  assert.equal(all.length, 8);
  assert.ok(all.length <= MAX_BOX_ITEMS);
  const six = boxItems(groups, 6);
  assert.deepEqual(six.map((i) => i.label), ["Tomatoes", "Red bell peppers", "Red bell peppers", "Onions", "Onions", "Garlic"]);
  const u = six[0];
  for (const t of groups[0].instances) assert.ok(u.box.x1 <= t.box.x1 + 1e-3 && u.box.x2 >= t.box.x2 - 1e-3 && u.box.y1 <= t.box.y1 + 1e-3 && u.box.y2 >= t.box.y2 - 1e-3);
  const bits = fromRle(u.mask!.w, u.mask!.h, u.mask!.rle);
  const fill = bits.reduce((a, b) => a + b, 0) / bits.length;
  assert.ok(fill > 0.1 && fill < 0.6, `three tomatoes in one big box: ${fill}`);
});

const sb = (x1: number, y1: number, x2: number, y2: number, score?: number, mask = true): SamBox => {
  const W = x2 - x1 + 1;
  const H = y2 - y1 + 1;
  return {
    x1, y1, x2, y2, w: 100, h: 100, nx1: x1 / 100, ny1: y1 / 100, nx2: x2 / 100, ny2: y2 / 100,
    ...(score === undefined ? {} : { score }),
    ...(mask ? { mask: { width: W, height: H, payload: encodeOneBit(new Uint8Array(W * H).fill(1), W, H) } } : {}),
  };
};

test("instancesOf: score bar, best first, duplicates and inner parts dropped, bad mask keeps the box", () => {
  const got = instancesOf([sb(0, 0, 9, 9, 0.6), sb(50, 50, 69, 69, 0.95), sb(1, 1, 9, 9, 0.55), sb(52, 52, 60, 60, 0.7), sb(80, 0, 89, 9, 0.3), { ...sb(20, 20, 29, 29, 0.8), mask: { width: 10, height: 10, payload: "!!!!!!" } }]);
  assert.deepEqual(got.map((i) => i.score), [0.95, 0.8, 0.6]);
  assert.equal(got[1].mask, null, "undecodable mask → box only");
  // without scores (no include_confidence): all kept, in SAM's order
  assert.equal(instancesOf([sb(0, 0, 9, 9), sb(20, 0, 29, 9)]).length, 2);
});

test("mergeInstances: union mask covers both parts and the gap stays empty", () => {
  const [a, b] = instancesOf([sb(0, 0, 9, 9, 0.9), sb(30, 0, 39, 9, 0.8)]);
  const m = mergeInstances([a, b]);
  assert.deepEqual(m.box, { x1: 0, y1: 0, x2: 0.39, y2: 0.09 });
  const bits = fromRle(m.mask!.w, m.mask!.h, m.mask!.rle);
  assert.equal(m.mask!.w, 40);
  assert.equal(bits[0], 1);
  assert.equal(bits[20], 0, "gap between the two");
  assert.equal(bits[35], 1);
  // one part without a mask → merged item is box only
  const [c] = instancesOf([sb(60, 0, 69, 9, 0.7, false)]);
  assert.equal(mergeInstances([a, c]).mask, null);
});

test("boxItems: never more than the cap, biggest group merges first, order kept", () => {
  const many = (n: number, y: number) => instancesOf(Array.from({ length: n }, (_, i) => sb(i * 8, y, i * 8 + 5, y + 5, 0.9 - i * 0.01)));
  const items = boxItems([{ label: "A", instances: many(3, 0) }, { label: "B", instances: many(10, 20) }, { label: "C", instances: many(2, 40) }]);
  assert.deepEqual(items.map((i) => i.label), ["A", "A", "A", "B", "C", "C"]);
  const tight = boxItems([{ label: "A", instances: many(5, 0) }, { label: "B", instances: many(5, 20) }, { label: "C", instances: many(5, 40) }], 4);
  assert.ok(tight.length <= 4);
});
