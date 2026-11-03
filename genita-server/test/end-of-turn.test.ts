/**
 * CA-14 end-of-turn policy (src/convo/endOfTurn.ts): a Transcribe final is a candidate end of turn. The finals below
 * are the real ones Muse Transcribe gave for the CA-14 clips (evidence/CA-14/results.json) plus the common shapes of a
 * finished turn that must still be answered at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EOT, judgeEndOfTurn, joinSegments } from "../src/convo/endOfTurn.ts";

const kind = (t: string) => judgeEndOfTurn(t).kind;

test("CA-14 finals that are a thinking pause, not an end: held long (the cue plays inside the hold)", () => {
  for (const t of [
    "So today at work my manager pulled me into this meeting and then he started.", // 3/5 runs: the ASR put a "."
    "so today at work my manager pulled me into this meeting and then he started",
    "So today at work, my manager pulled me into this meeting and then he started",
    "I made soup today and",
    "I made soup today, and",
    "I went to the store because",
    "and then I was like",
    "We were talking about the",
    "So I told him that I wanted to",
    "My sister, um",
    "It was kind of,",
    "and then",
    "so then she",
    "I don't know, I just…",
  ]) {
    const v = judgeEndOfTurn(t);
    assert.equal(v.kind, "incomplete", `${t} → ${v.why}`);
    assert.equal(v.holdMs, EOT.incompleteMs);
  }
});

test("a finished turn is answered at once (no hold, no latency cost)", () => {
  for (const t of [
    "So today at work my manager yelled at me about the deck in front of everyone.",
    "yelling at me about the deck in front of everyone.",
    "Do you think I should talk to him about it?",
    "What would you do if you were me?",
    "Honestly, I just want to sleep for a week.",
    "My sister is coming to visit this weekend.",
    "I got the job!",
    "Hey, I just got home.",
    "I think so.",
    "I hope so.",
    "I really don't want to.",
    "I have to.",
    "That's what it's for.",
    "That's what I was talking about.",
    "That's what she said.",
    "It started.",
    "I did it because she asked.", // Codex P2
    "And then it began.",
    "That was fair and just.",
    "Yeah.",
    "and?",
    "",
  ]) {
    const v = judgeEndOfTurn(t);
    assert.equal(v.kind, "complete", `${JSON.stringify(t)} → ${v.why}`);
    assert.equal(v.holdMs, 0);
  }
});

test("no terminal punctuation (no falling intonation heard) waits a little, without a cue", () => {
  for (const t of ["yelling at me about the deck in front of everyone", "I got the job", "tell me a story", "I think so"]) {
    const v = judgeEndOfTurn(t);
    assert.equal(v.kind, "unpunctuated", `${t} → ${v.why}`);
    assert.equal(v.holdMs, EOT.unpunctuatedMs);
  }
  assert.ok(EOT.unpunctuatedMs < EOT.incompleteMs);
});

test("the hold lengths are tunable per call (env rollback / tuning)", () => {
  assert.equal(judgeEndOfTurn("I made soup and", { incompleteMs: 900 }).holdMs, 900);
  assert.equal(judgeEndOfTurn("I made soup", { unpunctuatedMs: 0 }).holdMs, 0);
});

test("joining a held segment and the next: the ASR's false period goes when the next segment goes on in lower case", () => {
  assert.equal(joinSegments("and then he started.", "yelling at me."), "and then he started yelling at me.");
  assert.equal(joinSegments("and then he started", "yelling at me."), "and then he started yelling at me.");
  assert.equal(joinSegments("I made soup today and", "It was okay."), "I made soup today and It was okay.");
  assert.equal(joinSegments("Wait...", "never mind."), "Wait... never mind.");
  assert.equal(joinSegments("held", ""), "held");
  assert.equal(joinSegments("", "next"), "next");
});
