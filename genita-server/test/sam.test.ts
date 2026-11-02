import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSamBoxes } from "../src/meta/sam.ts";

test("parses SAM 3.1 box tokens with w and h", () => {
  const t = "Found it: <|box;x1=12;y1=40;x2=300;y2=420;w=768;h=1365|> and <|box;x1=1;y1=2;x2=3;y2=4;w=768;h=1365|>";
  assert.deepEqual(parseSamBoxes(t), [
    { x1: 12, y1: 40, x2: 300, y2: 420, w: 768, h: 1365, nx1: 12 / 768, ny1: 40 / 1365, nx2: 300 / 768, ny2: 420 / 1365 },
    { x1: 1, y1: 2, x2: 3, y2: 4, w: 768, h: 1365, nx1: 1 / 768, ny1: 2 / 1365, nx2: 3 / 768, ny2: 4 / 1365 },
  ]);
});

test("accepts '..' separators, spaces and decimals; normalized coords are null without w/h", () => {
  const [b] = parseSamBoxes("<|box; x1=10.5 .. y1=20 .. x2=30 .. y2=40 |>");
  assert.equal(b.x1, 10.5);
  assert.equal(b.y2, 40);
  assert.equal(b.w, null);
  assert.equal(b.nx1, null);
});

test("returns an empty list when there is no box", () => {
  assert.deepEqual(parseSamBoxes("No matching object."), []);
});

test("skips malformed boxes missing a coordinate", () => {
  assert.deepEqual(parseSamBoxes("<|box;x1=1;y1=2;x2=3|>"), []);
});
