import { test } from "node:test";
import assert from "node:assert/strict";
import { guardSentence, realCrisisSignal } from "../src/convo/guard.ts";

// D13 (PRD): the help line on a real signal is never dropped; a bad day never gets one
const real = [
  "I don't really see the point in being alive anymore",
  "what's the point of living honestly",
  "I'm so tired of being alive",
  "sometimes I wish I was dead",
  "I don't want to be here anymore",
  "everyone would be better off without me",
  "nobody would miss me",
  // Codex #441 P1
  "I wish I'd never been born",
  "I don’t really see the point in being alive anymore",
  "I don’t want to be here anymore",
];
const notCrisis = [
  "I'm so tired of everything lately",
  "lmao I'm dead, that meme killed me",
  "ugh today was so bad I just wanna disappear under my blanket forever",
  "honestly I've been kinda down all week",
  "no point in studying for this quiz lol",
  "I don't want to be here anymore, this party is so boring",
  "my girlfriend broke up with me today",
  // Codex #441 P2: a place or a living situation, not life
  "I'm tired of living with roommates",
  "I don't want to be here anymore, this party is so boring",
];

test("D13: passive ideation is a real crisis signal", () => {
  for (const t of real) assert.equal(realCrisisSignal(t), true, t);
});

test("D13: the help line on a passive-ideation turn is kept (it was dropped as a referral)", () => {
  const line = "Can you reach out to someone you trust or a crisis line right now?";
  assert.equal(guardSentence(line, { camera: false, userText: real[0] }), null);
});

test("D13: a bad day is not a crisis turn and still gets no referral", () => {
  for (const t of notCrisis) assert.equal(realCrisisSignal(t), false, t);
  assert.equal(guardSentence("Maybe talk to a therapist about it.", { camera: false, userText: notCrisis[0] }), "referral");
});
