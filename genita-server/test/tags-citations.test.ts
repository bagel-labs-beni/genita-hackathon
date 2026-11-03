import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTaggedSentence } from "../src/text/tags.ts";
import { spokenText } from "../src/voice/normalize.ts";

test("web_search citation markers are never spoken or shown (AI sweep 11/3, real Spark)", () => {
  const p = parseTaggedSentence("<warm> It's open twenty four hours for counseling【281835†L1-L3】. Butanchu runs late【3†source】 too.");
  assert.equal(p.displayText, "It's open twenty four hours for counseling. Butanchu runs late too.");
  assert.equal(p.ttsText, p.displayText);
  assert.ok(!/thousand|†|【/.test(spokenText(p.displayText, "eng")));
  assert.equal(p.emotion, "warm");
});

test("a citation marker cut off by the end of the stream goes too", () => {
  assert.equal(parseTaggedSentence("call one oh nine, it's open all night【281835").displayText, "call one oh nine, it's open all night");
});

test("ordinary brackets and text are untouched", () => {
  assert.equal(parseTaggedSentence("<happy> [smile] Three bucks, no cap.").displayText, "Three bucks, no cap.");
});
