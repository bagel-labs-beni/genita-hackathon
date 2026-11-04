import { test } from "node:test";
import assert from "node:assert/strict";
import { isEchoOf, realWords } from "../src/session/bargeEcho.ts";

test("realWords: tags, punctuation and hums are not words", () => {
  assert.equal(realWords("[noise]"), 0);
  assert.equal(realWords("(music) mm... uh"), 0);
  assert.equal(realWords("Hmm."), 0);
  assert.equal(realWords("wait, stop!"), 2);
  assert.equal(realWords("잠깐만 기다려"), 2);
});

test("isEchoOf: the line playing heard back is echo; the user's own words are not", () => {
  const playing = "Hey Summer! It's so good to see you. How was your day today?";
  assert.equal(isEchoOf("so good to see you", playing), true);
  assert.equal(isEchoOf("how was your day", playing), true);
  assert.equal(isEchoOf("good", playing), true);
  assert.equal(isEchoOf("it's so good to see ya", playing), true, "fuzzy: most words match");
  assert.equal(isEchoOf("wait stop", playing), false);
  assert.equal(isEchoOf("your stop", playing), false, "two words must be in order in the line");
  assert.equal(isEchoOf("actually can you find me shoes", playing), false);
  assert.equal(isEchoOf("[noise]", playing), false);
  assert.equal(isEchoOf("anything", ""), false);
});
