import { test } from "node:test";
import assert from "node:assert/strict";
import { cameraOffHint } from "../src/convo/cameraAsk.ts";

test("camera off + 'do I look ok' → a hint to say it can't see and ask to flip it on (intel eval 11/4: 0/5, empty replies)", () => {
  for (const t of ["ok do i look ok for this date", "how do I look", "can you see me?", "look at this!", "what am I wearing lol", "rate my fit", "how's my hair"]) {
    assert.match(cameraOffHint(t, false) ?? "", /camera is off/i, t);
  }
});

test("no hint with the camera on, or for lines that aren't about seeing them", () => {
  assert.equal(cameraOffHint("do i look ok", true), null);
  for (const t of ["what should I wear today", "which outfit should I pick", "I look forward to it", "see you tomorrow", "let me see, maybe ramen", "you look at the menu first"]) {
    assert.equal(cameraOffHint(t, false), null, t);
  }
});

test("Codex #541 P2: figures of speech are not asks to be seen", () => {
  for (const t of ["can you see what I mean?", "do I look like I care lol", "look it up"]) assert.equal(cameraOffHint(t, false), null, t);
});

test("Codex #541 r2: 'see what I'm saying' is an idiom; a shared screen answers 'look at this' but not 'do I look ok?'", () => {
  assert.equal(cameraOffHint("can you see what I'm saying?", false), null);
  assert.equal(cameraOffHint("look at this!", false, true), null);
  assert.match(cameraOffHint("do I look ok for this date?", false, true) ?? "", /camera is off/);
});
