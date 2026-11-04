/**
 * Coherence 11/4 (Chelsea's 18:31 call): "Wednesday night, you need food in like fifteen minutes" to a line about
 * nothing of the sort, and a first line that says something random. The winning bake-off prompt
 * (./_qa-scripts/genita-demo/prompt-bakeoff/) answers the last line first, uses the time only when asked, and
 * opens on real context or a plain warm hello. GENITA_COHERENT_PROMPT=0 is the rollback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInstructions, coherentPrompt, timeLineFor } from "../src/prompt/persona.ts";
import { openerBlock } from "../src/convo/opener.ts";
import { localTimeLine } from "../src/personalize/knows.ts";

const mina = { name: "Mina", kind: "human" as const, traits: ["warm"] };

test("coherent prompt is on by default; GENITA_COHERENT_PROMPT=0 turns it off", () => {
  assert.equal(coherentPrompt({}), true);
  assert.equal(coherentPrompt({ GENITA_COHERENT_PROMPT: "0" }), false);
});

test("voice block: the first sentence answers their last line; no new topic, time, food or profile unless they raised it", () => {
  const s = buildInstructions({ persona: mina, mode: "chat", style: "v1" });
  assert.match(s, /Your first sentence answers their last line directly/);
  assert.match(s, /Never open with a new topic, the time of day, food, or something from their profile unless their line is about it/);
  assert.match(s, /never ask about something they already answered/);
  assert.doesNotMatch(s, /a guess, a tease or a pick/, "the old 'add a guess' invited made-up topics");
});

test("the local-time line no longer invites meal talk (the 'you need food in fifteen minutes' non-sequitur)", () => {
  const line = localTimeLine("America/Los_Angeles", new Date("2026-11-05T02:31:00Z"))!;
  assert.match(line, /meals/);
  const s = buildInstructions({ persona: mina, mode: "chat", style: "v1", localTime: line });
  assert.doesNotMatch(s, /Use it only for timing \(meals/);
  assert.match(s, /never bring up the time, the day or meals on your own/);
  assert.equal(timeLineFor(line, false), line, "rollback keeps the old line");
});

test("opener: a plain warm hello or real context, never invented events, facts or advice", () => {
  const back = openerBlock({ hasProfile: true, sinceLastMs: 3 * 86_400_000, hasItem: false, hook: null });
  assert.match(back, /you're back/);
  assert.match(back, /No invented events or plans/);
  assert.match(back, /no random facts, tips or advice in the first line/);
  const first = openerBlock({ hasProfile: true, sinceLastMs: null, hasItem: false, hook: "Film photography" });
  assert.match(first, /warm, simple hi/);
  assert.match(first, /If it fits naturally, add one light question about this one thing from their profile/);
  // prompt-100: "hope that spicy ramen is happening tonight" (an invented plan) on a first call
  assert.match(first, /never a guess about what they're doing or eating today/);
  assert.doesNotMatch(first, /build your first line on/, "the hook is a nod, no longer the whole first line");
  const follow = openerBlock({ hasProfile: true, sinceLastMs: 30 * 3_600_000, hasItem: true, hook: "interview at the design studio Thursday" });
  assert.match(follow, /picking up the thread/);
  assert.match(follow, /No invented events/);
});
