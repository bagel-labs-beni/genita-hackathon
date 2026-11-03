import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTaggedSentence, clauseExpression } from "../src/text/tags.ts";

test("parseTaggedSentence pulls the emotion, keeps audio tags for TTS, strips both for display", () => {
  assert.deepEqual(parseTaggedSentence("<teasing> Oh really? [laughs] Prove it."), {
    emotion: "teasing",
    ttsText: "Oh really? [laughs] Prove it.",
    displayText: "Oh really? Prove it.",
    expression: null,
  });
  assert.deepEqual(parseTaggedSentence("No tag here."), { emotion: null, ttsText: "No tag here.", displayText: "No tag here.", expression: null });
});

test("parseTaggedSentence lowercases the emotion and ignores non-word angle content", () => {
  assert.equal(parseTaggedSentence("<Happy>Hi.").emotion, "happy");
  assert.equal(parseTaggedSentence("if a <b then c.").emotion, null);
});

test("expression tags: [smile]/[laugh]/... are never spoken or shown; the first one wins; [neutral] = none", () => {
  assert.deepEqual(parseTaggedSentence("<happy> [smile] That sounds lovely."), {
    emotion: "happy",
    ttsText: "That sounds lovely.",
    displayText: "That sounds lovely.",
    expression: "smile",
  });
  assert.equal(parseTaggedSentence("[Laugh] No way, [surprised] really?").expression, "laugh");
  assert.equal(parseTaggedSentence("[laugh] No way, [surprised] really?").ttsText, "No way, really?");
  assert.equal(parseTaggedSentence("[neutral] Okay.").expression, "neutral");
  assert.equal(parseTaggedSentence("[neutral] Okay.").ttsText, "Okay.");
  // a delivery tag stays a delivery tag (TTS), it is not an expression tag
  assert.equal(parseTaggedSentence("[laughs] Fine.").expression, null);
  assert.equal(parseTaggedSentence("[laughs] Fine.").ttsText, "[laughs] Fine.");
  // a tag alone has nothing to say or show
  assert.equal(parseTaggedSentence("[smile]").displayText, "");
  // a tag cut off by the end of the stream is dropped, not spoken (Codex P2)
  assert.equal(parseTaggedSentence("Hello. [smi").ttsText, "Hello.");
  assert.equal(parseTaggedSentence("[smi").displayText, "");
  assert.equal(parseTaggedSentence("Okay <hap").ttsText, "Okay");
});

test("clauseExpression: inline tag > laugh/concern words > the reply's emotion on its first clause; neutral sends nothing", () => {
  const c = (text: string, emotion: string | null = null, emotionHere = false, tag: string | null = null) =>
    clauseExpression({ ...parseTaggedSentence(text), expression: (tag as never) ?? parseTaggedSentence(text).expression }, emotion, emotionHere);
  assert.deepEqual(c("[concerned] Haha, sure."), { tag: "concerned", intensity: 0.7 });
  assert.deepEqual(c("Haha, that's so you."), { tag: "laugh", intensity: 1 });
  assert.deepEqual(c("[laughs] Fine."), { tag: "laugh", intensity: 1 });
  assert.deepEqual(c("Oh no, I'm sorry about that."), { tag: "concerned", intensity: 0.7 });
  assert.deepEqual(c("That's a long day."), { tag: "concerned", intensity: 0.7 });
  assert.deepEqual(c("Good choice.", "warm", true), { tag: "smile", intensity: 0.7 });
  assert.deepEqual(c("Let's go!", "excited", true), { tag: "smileopen", intensity: 0.7 });
  assert.deepEqual(c("Wait, really?", "surprised", true), { tag: "surprised", intensity: 0.7 });
  assert.deepEqual(c("That's rough.", "sad", true), { tag: "concerned", intensity: 0.7 });
  // the emotion tag shapes only the clause it starts; later clauses stay neutral unless they say something
  assert.equal(c("And then we cook.", "warm", false), null);
  assert.equal(c("Tell me more.", "curious", true), null);
  assert.equal(c("Okay.", "neutral", true), null);
  // an explicit [neutral] wins over the emotion and the words (Codex P3)
  assert.equal(c("[neutral] Haha okay.", "happy", true), null);
});
