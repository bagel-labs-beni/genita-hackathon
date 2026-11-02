import { test } from "node:test";
import assert from "node:assert/strict";
import { SentenceSplitter } from "../src/text/sentences.ts";

function run(deltas: string[]) {
  const s = new SentenceSplitter();
  const out: string[] = [];
  for (const d of deltas) out.push(...s.push(d));
  out.push(...s.flush());
  return out;
}

test("emits the first sentence as soon as its terminator is followed by more text", () => {
  const s = new SentenceSplitter();
  assert.deepEqual(s.push("Oh wow, that's great"), []);
  assert.deepEqual(s.push("! Tell"), ["Oh wow, that's great!"]);
  assert.deepEqual(s.push(" me more."), []);
  assert.deepEqual(s.flush(), ["Tell me more."]);
});

test("does not split on decimals, abbreviations or initials", () => {
  assert.deepEqual(run(["It costs 3.5 dollars at Dr. Kim's place. ", "Nice, right?"]), [
    "It costs 3.5 dollars at Dr. Kim's place.",
    "Nice, right?",
  ]);
  assert.deepEqual(run(["Meet me at 5 p.m. tomorrow, e.g. near the U.S. embassy. Ok?"]), [
    "Meet me at 5 p.m. tomorrow, e.g. near the U.S. embassy.",
    "Ok?",
  ]);
});

test("keeps trailing quotes and ellipses with their sentence", () => {
  assert.deepEqual(run(['She said "no way!" Then left... ', "Wild."]), ['She said "no way!"', "Then left...", "Wild."]);
});

test("splits CJK sentences on full-width terminators without spaces", () => {
  assert.deepEqual(run(["오늘 어땠어？", "나는 좋았어。정말로!"]), ["오늘 어땠어？", "나는 좋았어。", "정말로!"]);
});

test("cuts a long first clause at a comma so the voice can start early", () => {
  const s = new SentenceSplitter({ firstClauseMaxChars: 60 });
  const long = "So I was thinking about what you said yesterday about the trip to Jeju, ";
  const out = s.push(long + "and honestly");
  assert.equal(out.length, 1);
  assert.ok(out[0].endsWith("Jeju,"));
  // later sentences are not clause-cut
  assert.deepEqual(s.push(" it sounds amazing, really amazing, the best idea you have had all year long, I mean it"), []);
});

test("flush returns nothing for whitespace-only remainder", () => {
  assert.deepEqual(run(["Hi there.  ", "  "]), ["Hi there."]);
});
