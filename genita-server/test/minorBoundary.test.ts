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

test("Codex #640 r8: adverbs and 'I just turned 15' count", () => {
  for (const t of ["I'm actually 15 years old.", "I just turned 15 yesterday.", "I am literally only 14", "I turn 16 next week"]) assert.ok(minorLine([t]), t);
  for (const t of ["I just turned 25", "I'm actually 30"]) assert.equal(minorLine([t]), null, t);
});

test("coordinator (d): numbers that aren't the user's own age never turn the line on", () => {
  for (const t of ["I'm 15 minutes late", "my 16-year-old son is driving me crazy", "back when I was 14 I loved this song", "I'm 17 points behind in this game", "I'm 12 hours into this shift", "we're 15 minutes out", "I was 16 when I got my first job"]) assert.equal(minorLine([t]), null, t);
});

test("Codex #640 r9: credits / 15,000 dollars are no age, a speaker label before a quote, 'my age is 15', 'aged 15'", () => {
  for (const t of ["I'm 16 credits short of graduating", "I'm 15,000 dollars in debt", 'My 16-year-old son: "I\'m 16, so I can drive now".']) assert.equal(minorLine([t]), null, t);
  for (const t of ["My age is 15", "I am aged 15"]) assert.ok(minorLine([t]), t);
});

test("Codex #640 r10: 'currently 16 years old' counts; kilometers / kilograms / any unit is no age", () => {
  for (const t of ["I am currently 16 years old", "I'm turning 16 next month", "im 15 lol", "I'm 15 😅", "I'm 15 and my mom is strict", "I'm 15.", "i turn 16 in march", "I'm 15 going on 16"]) assert.ok(minorLine([t]), t);
  for (const t of ["I'm 15 kilometers away", "I'm 15 kilograms overweight", "I'm 15 minutes late", "I'm 16 credits short of graduating", "I'm 15,000 dollars in debt", "I'm 12 hours into this shift", "I'm 14 years into my career", "I'm 15 percent sure", "I'm 15% done", "I'm 10 laps behind", "I'm 9 out of 10 tired", "I'm 15 for 20 on free throws"]) assert.equal(minorLine([t]), null, t);
});

test("Codex #640 r10 sweep: scores, streaks and half-units are no age", () => {
  for (const t of ["I'm 16 and a half hours into this", "I'm 12 in a row", "I'm 15 and 0 this season", "I'm 15-0 this season", "I'm 15 in line", "I'm 5'2", "I'm 6 feet tall", "I'm 15 tabs deep", "I'm 10 drinks in"]) assert.equal(minorLine([t]), null, t);
  for (const t of ["im 14 btw", "I'm 15, why?", "I'm 15 is that weird", "I'm 14 in grade 9", "I'm 16 and a half"]) assert.ok(minorLine([t]), t);
});

test("Codex #640 r11: spaced scores, queue / leaderboard spots are no age; '16yo', 'not yet 18' are", () => {
  for (const t of ["I'm 15 / 20 on free throws", "I'm 16 - 0 this season", "I'm 15 in the queue for tickets", "I'm 15 on the leaderboard", "I'm 12 in two games", "I'm 15 in like 3 queues"]) assert.equal(minorLine([t]), null, t);
  for (const t of ["I'm 16yo", "I'm 16yrs old", "im 15y/o", "I'm not yet 18", "I'm 15 in the summer", "I turn 16 on Friday", "I'm 14 in my first year of high school"]) assert.ok(minorLine([t]), t);
});

test("Codex #640 r12: 'N years out of / away from' is a span; 'not quite 18 yet', 'haven't turned 18', '16 from California' are ages", () => {
  for (const t of ["I'm 5 years out of college", "I'm 10 years away from retirement", "I'm 14 years into my career"]) assert.equal(minorLine([t]), null, t);
  for (const t of ["I'm not quite 18 yet", "I haven't turned 18 yet", "I'm 16 from California", "I'm 15 years old.", "I'm 15 years of age"]) assert.ok(minorLine([t]), t);
});

test("Codex #640 r14: 'almost 18', 'turn 18 tomorrow' are minors; '10 or so minutes', '5-ish minutes' are not ages; 'was like' quotes someone else", () => {
  for (const t of ["I'm almost 18", "I turn 18 tomorrow", "I'm turning 18 next month", "I was like, \"I'm 16, leave me alone.\""]) assert.ok(minorLine([t]), t);
  for (const t of ["I'm 10 or so minutes away", "I'm 5-ish minutes away", "My daughter was like, \"I'm 16, leave me alone.\"", "she's like \"I'm 15\" lol", "I'm 25"]) assert.equal(minorLine([t]), null, t);
});

test("Codex #640 r15: '16 looking for my first job' is an age; '18 months sober', '18 minutes late', 'five-foot-eight' are not", () => {
  for (const t of ["I'm 16 looking for my first job.", "I'm 15 living with my mom", "I'm almost 18", "I turn 18 tomorrow", "I'm 15-year-old lol"]) assert.ok(minorLine([t]), t);
  for (const t of ["I'm 30. I'm almost 18 months sober.", "I'm going to be 18 minutes late", "I'm 30. I'm five-foot-eight.", "I'm 5-foot-8", "I'm 15 meetings deep today"]) assert.equal(minorLine([t]), null, t);
});
