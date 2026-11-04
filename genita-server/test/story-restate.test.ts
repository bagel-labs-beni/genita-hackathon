import { test } from "node:test";
import assert from "node:assert/strict";
import { restatesHeadline } from "../src/personalize/story.ts";

// TF 331: HISY card 1's body repeated its title word for word.
test("an item that only says the headline again is a restatement", () => {
  assert.equal(restatesHeadline("You decide by comparing, not by guessing.", "You decide by comparing options, not by guessing."), true);
  assert.equal(restatesHeadline("Warm, direct, and short.", "You want it warm, direct and short."), true);
});

test("an item that adds something new is kept", () => {
  assert.equal(restatesHeadline("You decide by comparing, not by guessing.", "You line up two or three options side by side before you pick, and you like seeing the trade-offs."), false);
  assert.equal(restatesHeadline("Warm, direct, and short.", "You like a friendly tone, but you want the answer up front. Long replies lose you."), false);
  assert.equal(restatesHeadline("Hi.", "Hi there."), false, "a one-word headline is never enough to judge");
});
