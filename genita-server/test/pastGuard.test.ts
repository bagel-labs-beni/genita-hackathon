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

test("Codex #536 r2: 'you got a job' said this call stays; 'your interview last week' with only 'interview' said today goes", () => {
  assert.equal(unbackedPast("You told me that you got a job.", { past: false, userText: "What did I say?", callText: "I got a job." }), "You told me that you got a job.");
  assert.equal(unbackedPast("You told me about your interview last week.", { past: false, userText: "hm", callText: "My interview is tomorrow." }), "");
});

test("Codex #536 r3: help sentences untouched; a number said this call grounds the recall", () => {
  assert.equal(unbackedPast("If you remember when it started, tell the emergency services.", none("My chest hurts.")), "If you remember when it started, tell the emergency services.");
  assert.equal(unbackedPast("You told me that you're 23.", { past: false, userText: "How old am I?", callText: "I'm 23." }), "You told me that you're 23.");
});

test("Codex #536 r4: a question about their memory stays; a 2-letter place they said grounds the recall", () => {
  assert.equal(unbackedPast("Do you remember when it started?", { past: false, userText: "My chest hurts." }), "Do you remember when it started?");
  assert.equal(unbackedPast("Do you remember when we met?", { past: false, userText: "hey" }), "");
  assert.equal(unbackedPast("You told me that you're from LA.", { past: false, userText: "Where am I from?", callText: "I'm from LA." }), "You told me that you're from LA.");
  assert.equal(unbackedPast("You told me that you're from LA.", { past: false, userText: "Where am I from?", callText: "hi there" }), "");
});

test("Codex #536 r5: a police / safety instruction is never cut", () => {
  const t = "Try to remember when you last saw her and call the police now.";
  assert.equal(unbackedPast(t, { past: false, userText: "Someone has taken my daughter." }), t);
});
