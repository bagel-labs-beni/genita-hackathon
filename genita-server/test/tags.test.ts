import { test } from "node:test";
import assert from "node:assert/strict";
import { TagFilter, parseTaggedSentence } from "../src/text/tags.ts";

test("TagFilter strips emotion and audio tags from streamed text even when split across deltas", () => {
  const f = new TagFilter();
  let out = "";
  for (const d of ["<hap", "py>Hey", " you! [la", "ughs] That's ", "great."]) out += f.push(d);
  out += f.flush();
  assert.equal(out, "Hey you! That's great.");
});

test("TagFilter releases a lone '<' or '[' that never closes", () => {
  const f = new TagFilter();
  let out = f.push("3 < 5 and [this is long enough to not be a tag at all");
  out += f.flush();
  assert.equal(out, "3 < 5 and [this is long enough to not be a tag at all");
});

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
