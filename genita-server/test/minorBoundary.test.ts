import { test } from "node:test";
import assert from "node:assert/strict";
import { minorLine } from "../src/convo/minorBoundary.ts";

test("minor boundary: own minor ages and phrases → the line; ages of things, other people and adults → none", () => {
  for (const t of ["i'm 15 btw", "I am 16", "im a teenager lol", "I'm in high school", "I'm 13 years old", "I'm only 17", "I'm under 18", "I'm 9 years old", "im a minor"]) assert.ok(minorLine(["hey", t]), t);
  for (const t of ["I'm 15 minutes away", "I'm 25", "I'm 17 dollars short", "I'm in college", "my sister is 15", "I'm 10 pages in", "I'm 25; my sister is 15 years old", "My car is 15 years old", "I'm 19 and I'm a teenager", "I'm 9 out of 10 tired"]) assert.equal(minorLine([t]), null, t);
});
