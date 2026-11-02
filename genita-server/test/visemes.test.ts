import { test } from "node:test";
import assert from "node:assert/strict";
import { alignmentToMouth, alignmentToWords, charViseme } from "../src/lips/visemes.ts";

test("maps letters to the atlas viseme set", () => {
  assert.equal(charViseme("a"), "A");
  assert.equal(charViseme("E"), "E");
  assert.equal(charViseme("o"), "O");
  assert.equal(charViseme("w"), "U");
  assert.equal(charViseme("m"), "M");
  assert.equal(charViseme("v"), "F");
  assert.equal(charViseme("t"), "L");
  assert.equal(charViseme("s"), "S");
  assert.equal(charViseme(" "), "X");
  assert.equal(charViseme("."), "X");
});

test("maps Hangul syllables by their vowel, with a closed mouth first for bilabial initials", () => {
  assert.equal(charViseme("아"), "A");
  assert.equal(charViseme("오"), "O");
  assert.equal(charViseme("우"), "U");
  assert.equal(charViseme("이"), "E");
  assert.equal(charViseme("마"), "M"); // ㅁ initial → closed lips leads
});

test("turns character alignment into merged mouth cues in ms, skipping [audio tags]", () => {
  const chars = [..."[laughs] Mama"];
  const starts = chars.map((_, i) => i * 0.05);
  const ends = chars.map((_, i) => i * 0.05 + 0.05);
  const cues = alignmentToMouth({ chars, startsSec: starts, endsSec: ends }, 1000);
  // tag chars (0..8) contribute nothing; " " at index 8 is rest; M a m a follow
  assert.deepEqual(cues, [
    { t: 1400, v: "X" },
    { t: 1450, v: "M" },
    { t: 1500, v: "A" },
    { t: 1550, v: "M" },
    { t: 1600, v: "A" },
    { t: 1650, v: "X" },
  ]);
});

test("merges repeated visemes and always ends at rest", () => {
  const cues = alignmentToMouth({ chars: ["a", "a", "h"], startsSec: [0, 0.1, 0.2], endsSec: [0.1, 0.2, 0.3] }, 0);
  assert.deepEqual(cues, [
    { t: 0, v: "A" },
    { t: 200, v: "S" },
    { t: 300, v: "X" },
  ]);
});

test("empty alignment yields no cues", () => {
  assert.deepEqual(alignmentToMouth({ chars: [], startsSec: [], endsSec: [] }, 0), []);
});

test("alignmentToWords groups characters into words with ms times, skipping audio tags", () => {
  const chars = [..."[laughs] Hi you."];
  const starts = chars.map((_, i) => i * 0.1);
  const ends = chars.map((_, i) => i * 0.1 + 0.1);
  assert.deepEqual(alignmentToWords({ chars, startsSec: starts, endsSec: ends }, 500), [
    { w: "Hi", s: 1400, e: 1600 },
    { w: "you.", s: 1700, e: 2100 },
  ]);
});
