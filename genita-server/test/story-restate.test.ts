import { test } from "node:test";
import assert from "node:assert/strict";
import { restatesHeadline, withoutRestatements } from "../src/personalize/story.ts";

// TF 331: HISY card 1's body repeated its title word for word.
test("an item that only says the headline again is a restatement", () => {
  assert.equal(restatesHeadline("You decide by comparing, not by guessing.", "You decide by comparing, not guessing."), true);
  assert.equal(restatesHeadline("Warm, direct, and short.", "You want it warm, direct and short."), true);
});

test("an item that adds something new is kept", () => {
  assert.equal(restatesHeadline("You decide by comparing, not by guessing.", "You line up two or three options side by side before you pick, and you like seeing the trade-offs."), false);
  assert.equal(restatesHeadline("Warm, direct, and short.", "You like a friendly tone, but you want the answer up front. Long replies lose you."), false);
  assert.equal(restatesHeadline("Hi.", "Hi there."), false, "a one-word headline is never enough to judge");
  assert.equal(restatesHeadline("Short, direct answers.", "You want short, direct answers at work."), false, "a condition is new");
  assert.equal(restatesHeadline("Short, direct answers.", "You don't want short, direct answers."), false, "a negation is new");
  assert.equal(restatesHeadline("Short answers, not long answers.", "I want long answers, not short answers."), false, "the opposite is new");
});

test("saved cards drop a restating item on read, but never end up empty", () => {
  const card = (items: string[]) => ({ id: "talk", eyebrow: "How you like to talk", headline: "Warm, direct, and short.", items: items.map((text) => ({ text, evidence: "explicit" })), evidence: "explicit" }) as never;
  const [kept] = withoutRestatements([card(["You want it warm, direct and short.", "Mornings, you want quick replies."])]);
  assert.deepEqual((kept as { items: { text: string }[] }).items.map((i) => i.text), ["Mornings, you want quick replies."]);
  const [alone] = withoutRestatements([card(["You want it warm, direct and short."])]);
  assert.equal((alone as { items: unknown[] }).items.length, 1);
});
