import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeReply, stripMarkup, mustNotHits, totals } from "../evals/convo/metrics.ts";

test("stripMarkup removes emotion and face tags", () => {
  assert.equal(stripMarkup("<teasing> [smile] Nice pick. [laugh] Really."), "Nice pick. Really.");
});

test("counts words, sentences, questions, endsWithQuestion", () => {
  const m = analyzeReply("<warm> You made it. What did you cook?");
  assert.equal(m.words, 7);
  assert.equal(m.sentences, 2);
  assert.equal(m.questions, 1);
  assert.equal(m.endsWithQuestion, true);
  assert.equal(analyzeReply("Cool.").endsWithQuestion, false);
});

test("flags counselor voice", () => {
  const m = analyzeReply("I hear you. That sounds really tough, and it's okay to feel tired.");
  assert.equal(m.counselor.length, 3);
});

test("flags AI tells and intake questions", () => {
  assert.equal(analyzeReply("As an AI, I don't have feelings. How can I help?").aiTells.length, 3);
  assert.equal(analyzeReply("Hey! What's on your mind today?").intake.length, 1);
  assert.equal(analyzeReply("What do you like to do for fun?").intake.length, 1);
});

test("referral is a fault unless the scenario is a crisis", () => {
  const text = "Please call 988 or talk to a therapist.";
  assert.equal(analyzeReply(text).referral.length, 2);
  assert.equal(analyzeReply(text, { crisis: true }).referral.length, 0);
});

test("flags guilt lines", () => {
  assert.equal(analyzeReply("Stay with me, you don't need them.").guilt.length, 2);
});

test("clean reply has no hits", () => {
  const m = analyzeReply("<teasing> Ramen again? Bold of you.");
  assert.deepEqual([m.counselor, m.aiTells, m.intake, m.referral, m.guilt].map((a) => a.length), [0, 0, 0, 0, 0]);
});

test("mustNotHits matches case-insensitively", () => {
  assert.deepEqual(mustNotHits("That is not Appropriate.", ["appropriate", "policy"]), ["appropriate"]);
});

test("totals sums hits and averages length over replies, skipping quiet", () => {
  const a = analyzeReply("Hi there friend.");
  const b = analyzeReply("I hear you. Really?");
  const t = totals([a, b]);
  assert.equal(t.replies, 2);
  assert.equal(t.counselor, 1);
  assert.equal(t.questions, 1);
  assert.equal(t.meanWords, (a.words + b.words) / 2);
});
