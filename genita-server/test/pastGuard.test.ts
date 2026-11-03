import { test } from "node:test";
import assert from "node:assert/strict";
import { unbackedPast } from "../src/convo/pastGuard.ts";

const none = (userText = "hi") => ({ past: false, userText });

test("CV-01: no past → a habit adverb about them is cut, the sentence kept (eval v2 lines, 11/4)", () => {
  assert.equal(unbackedPast("Well well, look who crawled back, bet you're craving late-night ramen talk again.", none()), "Well well, look who crawled back, bet you're craving late-night ramen talk.");
  assert.equal(unbackedPast("Hey Summer, you back on that one AM aespa spiral again.", none("")), "Hey Summer, you back on that one AM aespa spiral.");
  assert.equal(unbackedPast("You prepped or winging it like usual?", none()), "You prepped or winging it?");
  assert.equal(unbackedPast("<teasing> Ramen o'clock again, huh?", none()), "<teasing> Ramen o'clock, huh?");
});

test("CV-01: no past → a claimed earlier talk is dropped", () => {
  assert.equal(unbackedPast("You were super vague, Summer, spill it again but messier this time.", none("do you remember what I told you about my ex?")), "");
  assert.equal(unbackedPast("Ugh, I remember the vibe was messy, but I blanked on the details.", none("do you remember?")), "");
  assert.equal(unbackedPast("Just like last time, you'll pick the spicy one.", none()), "");
  assert.equal(unbackedPast("Remember when you burned the rice?", none()), "");
});

test("CV-01: kept — a retry 'again', the user's own words, any call with a past", () => {
  assert.equal(unbackedPast("Wait, say that again.", none()), "Wait, say that again.");
  assert.equal(unbackedPast("Try it again.", none()), "Try it again.");
  assert.equal(unbackedPast("Rejected again? That's so annoying.", none("ugh i got rejected again")), "Rejected again? That's so annoying.");
  assert.equal(unbackedPast("Last time, huh? How was it?", none("remember that place from last time")), "Last time, huh? How was it?");
  assert.equal(unbackedPast("Ramen talk again, love it.", { past: true, userText: "hi" }), "Ramen talk again, love it.");
  assert.equal(unbackedPast("Again!", none()), "Again!");
  assert.equal(unbackedPast("I remember the 2014 World Cup final like it was yesterday.", none()), "I remember the 2014 World Cup final like it was yesterday.");
});

test("CV-01 r2 (eval v2 after, 14 left): 'still' with no past; 'like usual' even with memories", () => {
  assert.equal(unbackedPast("You still on that aespa phase?", none()), "You on that aespa phase?");
  assert.equal(unbackedPast("Are you still stuck on the ramen thing?", none()), "Are you stuck on the ramen thing?");
  assert.equal(unbackedPast("Thursday's interview, you prepped or winging it like usual?", { past: true, userText: "lol yeah" }), "Thursday's interview, you prepped or winging it?");
  assert.equal(unbackedPast("You still on that aespa phase?", { past: true, userText: "hi" }), "You still on that aespa phase?");
  assert.equal(unbackedPast("Still raining there?", none()), "Still raining there?");
  assert.equal(unbackedPast("Late again, like usual.", { past: true, userText: "late like usual lol" }), "Late again, like usual.");
});

test("'still' with a plain fact stays (session test: 'You still have that interview tomorrow.')", () => {
  assert.equal(unbackedPast("You still have that interview tomorrow.", none()), "You still have that interview tomorrow.");
  assert.equal(unbackedPast("Are you still making that kimchi thing?", none()), "Are you making that kimchi thing?");
});

test("Codex #536 P2: said in this call → kept; a question about their own past → kept", () => {
  assert.equal(unbackedPast("You told me that your interview is tomorrow.", { past: false, userText: "What is tomorrow?", callText: "My interview is tomorrow." }), "You told me that your interview is tomorrow.");
  assert.equal(unbackedPast("When was the last time you cooked ramen?", none("I feel like ramen tonight.")), "When was the last time you cooked ramen?");
  assert.equal(unbackedPast("You told me about your ex last week.", { past: false, userText: "do you remember?", callText: "hey" }), "");
});
