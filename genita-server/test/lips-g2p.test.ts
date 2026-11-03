import { test } from "node:test";
import assert from "node:assert/strict";
import { cmuDict, dictKey, g2pOn, relabelPhonemes } from "../src/lips/g2p.ts";

test("cmuDict: loads the bundled dictionary (first pronunciations, no stress)", () => {
  const d = cmuDict();
  assert.ok(d.size > 100_000, `size ${d.size}`);
  assert.deepEqual(d.get("you"), ["Y", "UW"]);
  assert.deepEqual(d.get("warm"), ["W", "AO", "R", "M"]);
  assert.deepEqual(d.get("halloween"), ["HH", "AE", "L", "AH", "W", "IY", "N"]);
  assert.deepEqual(d.get("i'd"), ["AY", "D"]);
});

test("dictKey: punctuation and curly apostrophes", () => {
  assert.equal(dictKey("Halloween,"), "halloween");
  assert.equal(dictKey("I’d"), "i'd");
  assert.equal(dictKey("great."), "great");
});

test("relabelPhonemes: the prod aligner's letter guesses become dictionary labels on the same times", () => {
  // prod 11/3 (t9-peter-2): "You" Y AW, "warm" W AE R M
  const t = {
    words: [{ w: "You", s: 2165, e: 2266 }, { w: "warm", s: 2486, e: 2787 }, { w: "Zorbluk", s: 2800, e: 3000 }],
    phonemes: [
      { p: "Y", s: 2165, e: 2185 }, { p: "AW", s: 2185, e: 2266 },
      { p: "W", s: 2486, e: 2546 }, { p: "AE", s: 2546, e: 2627 }, { p: "R", s: 2627, e: 2687 }, { p: "M", s: 2687, e: 2787 },
      { p: "Z", s: 2800, e: 2900 }, { p: "AO", s: 2900, e: 3000 },
    ],
  };
  const r = relabelPhonemes(t);
  assert.deepEqual(r.phonemes.slice(0, 6), [
    { p: "Y", s: 2165, e: 2185 }, { p: "UW", s: 2185, e: 2266 },
    { p: "W", s: 2486, e: 2546 }, { p: "AO", s: 2546, e: 2627 }, { p: "R", s: 2627, e: 2687 }, { p: "M", s: 2687, e: 2787 },
  ]);
  assert.deepEqual(r.phonemes.slice(6), [{ p: "Z", s: 2800, e: 2900 }, { p: "AO", s: 2900, e: 3000 }], "unknown word keeps the aligner's labels");
  assert.deepEqual(r.words, t.words);
});

test("relabelPhonemes: a different phoneme count re-splits the word span (vowels weighted), in order", () => {
  const t = { words: [{ w: "shoes", s: 4411, e: 4732 }], phonemes: [{ p: "S", s: 4411, e: 4500 }, { p: "H", s: 4500, e: 4560 }, { p: "O", s: 4560, e: 4650 }, { p: "E", s: 4650, e: 4732 }] };
  const r = relabelPhonemes(t);
  assert.deepEqual(r.phonemes.map((p) => p.p), ["SH", "UW", "Z"]);
  assert.equal(r.phonemes[0].s, 4411);
  assert.equal(r.phonemes.at(-1)!.e, 4732);
  for (let i = 1; i < r.phonemes.length; i++) assert.equal(r.phonemes[i].s, r.phonemes[i - 1].e);
  const uw = r.phonemes[1];
  assert.ok(uw.e - uw.s > r.phonemes[0].e - r.phonemes[0].s, "the vowel gets the longer share");
});

test("g2pOn: default on, 0/false/off off", () => {
  assert.equal(g2pOn({}), true);
  for (const v of ["0", "false", "OFF"]) assert.equal(g2pOn({ GENITA_LIPS_G2P: v }), false);
});
