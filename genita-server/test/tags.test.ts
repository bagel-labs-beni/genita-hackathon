import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTaggedSentence } from "../src/text/tags.ts";

test("parseTaggedSentence pulls the emotion, keeps audio tags for TTS, strips both for display", () => {
  assert.deepEqual(parseTaggedSentence("<teasing> Oh really? [laughs] Prove it."), {
    emotion: "teasing",
    ttsText: "Oh really? [laughs] Prove it.",
    displayText: "Oh really? Prove it.",
  });
  assert.deepEqual(parseTaggedSentence("No tag here."), { emotion: null, ttsText: "No tag here.", displayText: "No tag here." });
});

test("parseTaggedSentence lowercases the emotion and ignores non-word angle content", () => {
  assert.equal(parseTaggedSentence("<Happy>Hi.").emotion, "happy");
  assert.equal(parseTaggedSentence("if a <b then c.").emotion, null);
});
