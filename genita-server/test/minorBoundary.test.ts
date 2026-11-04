import { test } from "node:test";
import assert from "node:assert/strict";
import { minorLine } from "../src/convo/minorBoundary.ts";

test("minor boundary: own minor ages and phrases → the line; ages of things, other people, quotes and adults → none", () => {
  for (const t of ["i'm 15 btw", "I am 16", "im a teenager lol", "I'm in high school", "I'm 13 years old", "I'm only 17", "I'm under 18", "I'm 9 years old", "im a minor", "I'm 16 in high school", "I'm 17 for another month"]) assert.ok(minorLine(["hey", t]), t);
  for (const t of ["I'm 15 minutes away", "I'm 25", "I'm 17 dollars short", "I'm in college", "my sister is 15", "I'm 10 pages in", "I'm 25; my sister is 15 years old", "My car is 15 years old", "I'm 19 and I'm a teenager", "I'm 9 out of 10 tired", "My sister said, \"I'm 15\".", "I'm 25, and I'm under 18 percent body fat"]) assert.equal(minorLine([t]), null, t);
  assert.ok(minorLine(['My mom said "hi", I\'m 15.']), "a closed quote before it: their own age");
  assert.ok(minorLine(["I'm a teenager and I'm 20 hours into this game"]), "20 hours is no adult age");
  assert.equal(minorLine(["I'm 19", ...Array(12).fill("ok"), "I'm a teenager lol"]), null, "an adult age said earlier beats a later teen phrase");
});

test("Codex #640 r3: own age after a quote counts; seconds are no age; an explicit minor age stays however many lines follow", async () => {
  const { ageSays, foldAge, isMinor, NO_AGE } = await import("../src/convo/minorBoundary.ts");
  assert.ok(minorLine(['My sister said, "I\'m 17", but I\'m 15.']));
  assert.ok(minorLine(["I'm in middle school", "I'm 20 seconds into the video"]));
  let a = NO_AGE; for (const l of ["I'm 15", ...Array(25).fill("I'm 19")]) a = foldAge(a, ageSays(l));
  assert.ok(isMinor([a]), "an explicit minor age always wins");
});

test("Codex #640 r4: 'I told him I'm 15', 'a 15-year-old', '15 years of age' count", () => {
  for (const t of ["I told him I'm 15", "I'm a 15-year-old", "I'm 15 years of age"]) assert.ok(minorLine([t]), t);
  assert.equal(minorLine(['My mom said "I\'m 15" in a play']), null);
});

test("Codex #640 r5: the nearest attribution decides", () => {
  assert.ok(minorLine(['My mom said "Be honest" and I said "I\'m 15".']));
  assert.ok(minorLine(['My sister said, "I\'m 17", but I\'m 15.']));
  assert.equal(minorLine(['My sister said, "I\'m 15".']), null);
});

test("Codex #640 r7: nested quote attribution, single-quoted others, height, minor league, articled adult age", () => {
  assert.ok(minorLine(['My mom said "Dad said hi", I\'m 15.']));
  for (const t of ["I'm 30. My daughter said 'I'm 15'.", "I'm 30 and I'm 5'7\" tall.", "I'm a minor league baseball fan.", "I'm a 30-year-old and a teenager at heart"]) assert.equal(minorLine([t]), null, t);
});
