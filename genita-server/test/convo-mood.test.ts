// #344 (PRD 9A.9, DESIGN §7.3): mood state — persona baseline, tease / tuned-out drift, pacing hint, resting face.
import test from "node:test";
import assert from "node:assert/strict";
import { flatReply, holdsSteady, moodHint, personaBaseline, restingFace, teased } from "../src/convo/moodState.ts";
import { moodFrom, moodLine } from "../src/convo/rhythm.ts";
import { carriedMood } from "../src/convo/callMood.ts";

const H = 3_600_000;
const witty = { traits: ["witty", "curious"], speakingStyle: "short and quick, with jokes" };
const calm = { traits: ["calm", "warm"], speakingStyle: "unhurried" };

test("baseline: the persona's own resting mood, small enough to never trigger a hint alone", () => {
  assert.deepEqual(personaBaseline(null), { valence: 0, energy: 0 });
  assert.deepEqual(personaBaseline({ traits: ["grounded"] }), { valence: 0, energy: -0.2 });
  assert.deepEqual(personaBaseline(witty), { valence: 0, energy: 0.2 });
  assert.deepEqual(personaBaseline(calm), { valence: 0.15, energy: -0.2 });
  for (const p of [witty, calm, { traits: ["bubbly", "warm", "sunny"] }]) assert.equal(moodHint(personaBaseline(p)), null);
});

test("drift: decays toward the persona baseline, not to zero", () => {
  const b = personaBaseline(witty);
  const m = moodFrom(["ugh today was so bad", "so anyway", "anyway what's new", "tell me something", "so", "hmm let me think"], b, b);
  assert.ok(m.energy > 0, `energy rests at the witty baseline side (${m.energy})`);
  assert.equal(moodLine(m), null);
  const settled = moodFrom(Array(20).fill("so anyway"), { valence: 1, energy: 1 }, b);
  assert.ok(Math.abs(settled.energy - b.energy) < 0.01 && Math.abs(settled.valence - b.valence) < 0.01);
});

test("teased → playful", () => {
  for (const line of ["nice try lol", "yeah right", "you're such a nerd", "sure you do 😏", "whatever you say"]) assert.ok(teased(line), line);
  for (const line of ["I'm serious, nice try isn't funny", "right, the meeting is at 5", "you are such a good friend"]) assert.ok(!teased(line), line);
  assert.match(moodLine(moodFrom(["you're such a nerd"]))!, /playful mood: tease back/);
});

test("ignored twice → quieter: two flat replies in a row lower the energy; one is fine", () => {
  for (const line of ["ok", "Yeah.", "k", "mhm", "i guess", "cool"]) assert.ok(flatReply(line), line);
  for (const line of ["no way", "ok so here's the thing", "yeah I loved it", "lol"]) assert.ok(!flatReply(line), line);
  assert.equal(moodLine(moodFrom(["ok"])), null, "one flat reply is just an answer");
  assert.match(moodLine(moodFrom(["ok", "yeah"]))!, /low-key right now: keep it brief/);
  assert.equal(moodLine(moodFrom(["ok", "wait actually I have news", "yeah"])), null, "not in a row");
});

test("hint carries pacing; 'Never mirror my mood' stays steady instead of matching", () => {
  assert.match(moodLine(moodFrom(["ugh today was so bad"]))!, /quieter, matching theirs: short, soft sentences with a comma pause/);
  assert.match(moodLine(moodFrom(["I got the job!!"]))!, /upbeat and playful: a quick, bright burst/);
  const steady = { backstory: "A close companion. Never mirror the user's mood; stay steady when they are down or upset." };
  assert.ok(holdsSteady(steady));
  assert.ok(!holdsSteady(witty));
  const low = moodLine(moodFrom(["ugh today was so bad"]), { steady: true })!;
  assert.match(low, /stay steady and warm/);
  assert.doesNotMatch(low, /matching theirs/);
});

test("scripted arc good news → bad news: the hint flips upbeat → quieter on the turn the news turns", () => {
  const lines = ["hey", "I GOT THE JOB", "thank you!!", "wait my landlord just texted, I got evicted. this is awful"];
  const hints = lines.map((_, i) => moodLine(moodFrom(lines.slice(0, i + 1))));
  assert.equal(hints[0], null);
  assert.match(hints[1]!, /upbeat/);
  assert.match(hints[2]!, /upbeat/, "still up a line later (mood persists, decays slowly)");
  assert.match(hints[3]!, /quieter/);
});

test("resting face: a reply without a face rests on the mood instead of neutral", () => {
  assert.deepEqual(restingFace({ valence: 0.6, energy: 0.5 }), { tag: "smile", intensity: 0.35 });
  assert.deepEqual(restingFace({ valence: -0.6, energy: -0.4 }), { tag: "concerned", intensity: 0.4 });
  assert.deepEqual(restingFace(moodFrom(["you're such a nerd"])), { tag: "smile", intensity: 0.3 }, "playful");
  assert.equal(restingFace({ valence: 0.15, energy: 0.2 }), null, "baseline: neutral");
  assert.equal(restingFace(null), null);
});

test("carry: the last call's mood fades back to the persona baseline, not to zero", () => {
  const b = personaBaseline(calm);
  const state = { revision: 1, call_mood: { valence: 0.8, energy: 0.6, at: 0, rev: 1 } };
  const half = carriedMood(state, 12 * H, b);
  assert.ok(Math.abs(half.valence - (b.valence + (0.8 - b.valence) / 2)) < 0.01);
  assert.deepEqual(carriedMood(state, 200 * H, b), b, "days later: back to the persona's own mood");
  assert.deepEqual(carriedMood(null, 0, b), b, "no carried mood: the baseline");
  assert.deepEqual(carriedMood({ ...state, revision: 2 }, 0, b), b, "a Forget voids it");
});
