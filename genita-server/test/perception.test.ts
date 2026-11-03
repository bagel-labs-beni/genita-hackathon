import { test } from "node:test";
import assert from "node:assert/strict";
import { PERCEPTION_SCHEMA, buildPerceiveRequest, parseSample, safeNotable } from "../src/perception/schema.ts";
import { contextLine, hintFor, initialTracker, observe, stateOf, type Convo } from "../src/perception/rules.ts";
import type { PerceptionSample, PerceptionTrigger } from "../src/perception/types.ts";

const QUIET: Convo = { companionSpeaking: false, lastReplyEndAt: null, userSpeaking: false, lastUserSpeechAt: null };
const S = (o: Partial<PerceptionSample> = {}): PerceptionSample => ({
  expression: "neutral",
  intensity: 0.5,
  gaze: "at_screen",
  engagement: 0.7,
  notable: null,
  confidence: 0.9,
  ...o,
});

/** feed [at ms, sample, convo] steps; collect every trigger */
function run(steps: [number, PerceptionSample, Convo?][]) {
  let t = initialTracker();
  const out: PerceptionTrigger[] = [];
  for (const [at, s, c] of steps) {
    const r = observe(t, s, at, c ?? QUIET);
    t = r.tracker;
    out.push(...r.triggers);
  }
  return { tracker: t, triggers: out, kinds: out.map((x) => x.kind) };
}
/** same sample every `every` ms from `from` to `to` */
const series = (from: number, to: number, every: number, s: PerceptionSample, c?: Convo) => {
  const out: [number, PerceptionSample, Convo?][] = [];
  for (let at = from; at <= to; at += every) out.push([at, s, c]);
  return out;
};

// ───────────────────────── schema ─────────────────────────

test("perceive request: Spark json_schema strict, minimal effort, one image, no persona or history", () => {
  const req = buildPerceiveRequest("data:image/jpeg;base64,AAAA");
  assert.equal(req.effort, "minimal");
  const fmt = (req.text as { format: { type: string; strict: boolean; schema: unknown } }).format;
  assert.equal(fmt.type, "json_schema");
  assert.equal(fmt.strict, true);
  assert.deepEqual(fmt.schema, PERCEPTION_SCHEMA);
  const input = req.input as { role: string; content: { type: string; image_url?: string }[] }[];
  assert.equal(input.length, 1);
  assert.deepEqual(input[0].content.filter((c) => c.type === "input_image").map((c) => c.image_url), ["data:image/jpeg;base64,AAAA"]);
  assert.match(req.instructions!, /never.*(appearance|age)/i);
});

test("parseSample: valid reply → clamped sample; wrong enums or junk → null", () => {
  const s = parseSample(JSON.stringify({ expression: "smile", intensity: 1.7, gaze: "away", engagement: -1, notable: "nodding", confidence: 0.8 }));
  assert.deepEqual(s, { expression: "smile", intensity: 1, gaze: "away", engagement: 0, notable: "nodding", confidence: 0.8 });
  assert.equal(parseSample(JSON.stringify({ expression: "angry", intensity: 1, gaze: "away", engagement: 1, notable: null, confidence: 1 })), null);
  assert.equal(parseSample(JSON.stringify({ expression: "smile", intensity: 1, gaze: "left", engagement: 1, notable: null, confidence: 1 })), null);
  assert.equal(parseSample("no json here"), null);
  assert.equal(parseSample(JSON.stringify({ expression: "smile", intensity: "x", gaze: "away", engagement: 1, notable: null, confidence: 1 })), null);
});

test("notable keeps short visible actions and drops appearance, body, identity, age, ethnicity and health", () => {
  assert.equal(safeNotable("yawning"), "yawning");
  assert.equal(safeNotable("rubbing their eyes"), "rubbing their eyes");
  for (const bad of [
    "wearing a red shirt",
    "has long hair",
    "looks about 30 years old",
    "young woman",
    "Asian man",
    "seems sick",
    "might have depression",
    "pretty smile",
    "overweight",
    "glasses on",
    "makeup",
    "looks like Taylor Swift",
    "bald",
    "a child",
  ])
    assert.equal(safeNotable(bad), null, bad);
  assert.equal(safeNotable("one two three four five six seven eight nine"), null, "≤ 8 words");
  assert.equal(safeNotable(""), null);
  assert.equal(safeNotable(null), null);
});

// ───────────────────────── smoothing ─────────────────────────

test("low-confidence samples are dropped; state needs 2 of the last 3 samples to change", () => {
  let r = run([[0, S({ expression: "smile", confidence: 0.4 })]]);
  assert.equal(stateOf(r.tracker, 0), null, "conf 0.4 is not kept");
  r = run([
    [0, S({ expression: "neutral" })],
    [2000, S({ expression: "neutral" })],
    [4000, S({ expression: "frown" })],
  ]);
  assert.equal(stateOf(r.tracker, 4000)!.expression, "neutral", "one frown is flicker");
  r = run([
    [0, S({ expression: "neutral" })],
    [2000, S({ expression: "frown" })],
    [4000, S({ expression: "frown" })],
  ]);
  const st = stateOf(r.tracker, 4000)!;
  assert.equal(st.expression, "frown");
  assert.equal(st.since, 4000);
});

test("state goes stale after 8 s without a kept sample; contextLine is null then", () => {
  const r = run([[0, S({ expression: "smile" })], [2000, S({ expression: "smile" })]]);
  assert.ok(stateOf(r.tracker, 9000));
  assert.equal(stateOf(r.tracker, 10_001), null);
  assert.equal(contextLine(stateOf(r.tracker, 10_001)), null);
});

test("contextLine: one short live line about expression and gaze, notable only when safe", () => {
  const r = run([[0, S({ expression: "smile", notable: "nodding" })], [2000, S({ expression: "smile", notable: "nodding" })]]);
  const line = contextLine(stateOf(r.tracker, 2000))!;
  assert.match(line, /^Camera \(live/);
  assert.match(line, /smiling/);
  assert.match(line, /looking at you/);
  assert.match(line, /nodding/);
  assert.ok(line.length < 160);
});

// ───────────────────────── triggers ─────────────────────────

test("smiled_at_reply: a smile while the companion speaks or ≤ 4 s after its reply; not 6 s after", () => {
  const speaking: Convo = { ...QUIET, companionSpeaking: true };
  assert.deepEqual(run([[1000, S({ expression: "smile", confidence: 0.8 }), speaking]]).kinds, ["smiled_at_reply"]);
  const ended = (at: number): Convo => ({ ...QUIET, lastReplyEndAt: at });
  assert.deepEqual(run([[5000, S({ expression: "smile" }), ended(2000)]]).kinds, ["smiled_at_reply"]);
  assert.deepEqual(run([[8000, S({ expression: "smile" }), ended(2000)]]).kinds, []);
  assert.deepEqual(run([[1000, S({ expression: "smile", confidence: 0.65 }), speaking]]).kinds, [], "needs conf ≥ 0.7");
});

test("a laugh at the reply is smiled_at_reply (not also laughed); a laugh elsewhere is laughed", () => {
  const speaking: Convo = { ...QUIET, companionSpeaking: true };
  const r = run([[1000, S({ expression: "laugh", intensity: 0.8 }), speaking]]);
  assert.deepEqual(r.kinds, ["smiled_at_reply"]);
  assert.match(hintFor("smiled_at_reply", S({ expression: "laugh" })), /laughed/);
  assert.deepEqual(run([[1000, S({ expression: "laugh", intensity: 0.8 })]]).kinds, ["laughed"]);
  assert.deepEqual(run([[1000, S({ expression: "laugh", intensity: 0.3 })]]).kinds, [], "a faint laugh is not laughed");
});

test("smiled_at_own_joke: smiling while the user speaks or ≤ 3 s after", () => {
  assert.deepEqual(run([[1000, S({ expression: "smile" }), { ...QUIET, userSpeaking: true }]]).kinds, ["smiled_at_own_joke"]);
  assert.deepEqual(run([[4000, S({ expression: "laugh", intensity: 0.9 }), { ...QUIET, lastUserSpeechAt: 2000 }]]).kinds, ["smiled_at_own_joke"]);
  assert.deepEqual(run([[6000, S({ expression: "smile" }), { ...QUIET, lastUserSpeechAt: 2000 }]]).kinds, []);
});

test("looks_tired: tired conf ≥ 0.75 for ≥ 6 s and the user silent ≥ 8 s", () => {
  const tired = S({ expression: "tired", confidence: 0.8 });
  assert.deepEqual(run(series(0, 4000, 2000, tired)).kinds, [], "4 s is too short");
  assert.deepEqual(run(series(0, 6000, 2000, tired)).kinds, ["looks_tired"]);
  assert.deepEqual(run(series(0, 6000, 2000, S({ expression: "tired", confidence: 0.7 }))).kinds, [], "conf 0.7 < 0.75");
  const talked: Convo = { ...QUIET, lastUserSpeechAt: 1000 };
  assert.deepEqual(run(series(0, 8000, 2000, tired, talked)).kinds, [], "user spoke 7 s ago");
  assert.deepEqual(run(series(0, 10_000, 2000, tired, talked)).kinds, ["looks_tired"], "fires once silence reaches 8 s");
});

test("looks_confused: confused conf ≥ 0.65 during or ≤ 6 s after the reply", () => {
  const c = S({ expression: "confused", confidence: 0.7 });
  assert.deepEqual(run([[5000, c, { ...QUIET, lastReplyEndAt: 1000 }]]).kinds, ["looks_confused"]);
  assert.deepEqual(run([[9000, c, { ...QUIET, lastReplyEndAt: 1000 }]]).kinds, []);
  assert.deepEqual(run([[5000, c]]).kinds, [], "no reply to be confused by");
});

test("looked_away: away/down ≥ 10 s, not while the user speaks; re-arms only after looking back", () => {
  const away = S({ gaze: "away" });
  assert.deepEqual(run(series(0, 8000, 2000, away)).kinds, []);
  assert.deepEqual(run(series(0, 10_000, 2000, S({ gaze: "away", engagement: 0.3 }))).kinds, ["looked_away"]);
  assert.deepEqual(run(series(0, 12_000, 2000, away, { ...QUIET, userSpeaking: true })).kinds, [], "talking while looking away is normal");
  const long = run(series(0, 200_000, 2000, away));
  assert.deepEqual(long.kinds, ["looked_away"], "one continuous look-away = one trigger");
  const back = run([...series(0, 10_000, 2000, away), [12_000, S()], [14_000, S()], ...series(80_000, 90_000, 2000, away)]);
  assert.deepEqual(back.kinds, ["looked_away", "looked_away"]);
});

test("looking down never counts as away or as low engagement: reading the screen and a phone look the same (eval 11/3)", () => {
  assert.deepEqual(run(series(0, 30_000, 2000, S({ gaze: "down", engagement: 0.8 }))).kinds, []);
  assert.deepEqual(run(series(0, 30_000, 2000, S({ gaze: "down", engagement: 0.3 }))).kinds, [], "selfie-crop reading stills read down / 0.3");
  assert.deepEqual(run(series(0, 22_000, 2000, S({ gaze: "away", engagement: 0.2 }))).kinds, ["looked_away", "engagement_drop"]);
});

test("gaze counts from conf ≥ 0.4: a turned-away face makes the expression unsure, not the gaze (eval 11/3 selfie crop)", () => {
  assert.deepEqual(run(series(0, 10_000, 2000, S({ gaze: "away", confidence: 0.5 }))).kinds, ["looked_away"]);
  const r = run([[0, S({ expression: "smile", gaze: "away", confidence: 0.5 })]]);
  assert.equal(stateOf(r.tracker, 0), null, "an unsure read does not set the expression state");
});

test("engagement_drop: engagement < 0.35 for ≥ 20 s", () => {
  const low = S({ engagement: 0.2, expression: "focused" });
  assert.deepEqual(run(series(0, 18_000, 2000, low)).kinds, []);
  assert.deepEqual(run(series(0, 22_000, 2000, low)).kinds, ["engagement_drop"]);
  assert.deepEqual(run(series(0, 22_000, 2000, S({ engagement: 0.5 }))).kinds, []);
});

test("cooldown: the same kind fires at most once per 60 s", () => {
  const speaking: Convo = { ...QUIET, companionSpeaking: true };
  const r = run(series(0, 59_000, 3000, S({ expression: "smile" }), speaking));
  assert.deepEqual(r.kinds, ["smiled_at_reply"]);
  const r2 = run(series(0, 61_000, 61_000, S({ expression: "smile" }), speaking));
  assert.deepEqual(r2.kinds, ["smiled_at_reply", "smiled_at_reply"]);
});

test("a faint smile (intensity < 0.45) is a resting face, not a reaction", () => {
  const speaking: Convo = { ...QUIET, companionSpeaking: true };
  assert.deepEqual(run([[1000, S({ expression: "smile", intensity: 0.3 }), speaking]]).kinds, []);
  assert.deepEqual(run([[1000, S({ expression: "smile", intensity: 0.5 }), speaking]]).kinds, ["smiled_at_reply"]);
});

test("reactions are changes: a face that has read confused (or smiling) for ≥ 10 s does not fire again at the reply", () => {
  const confused = S({ expression: "confused", confidence: 0.8 });
  const steady = run([...series(0, 12_000, 2000, confused), [14_000, confused, { ...QUIET, lastReplyEndAt: 13_000 }]]);
  assert.deepEqual(steady.kinds, [], "resting face reads confused: not a reaction to the reply");
  const smiley = S({ expression: "smile", intensity: 0.6 });
  const s2 = run([...series(0, 12_000, 2000, smiley), [14_000, smiley, { ...QUIET, companionSpeaking: true }]]);
  assert.deepEqual(s2.kinds, []);
  const laughs = run([...series(0, 12_000, 2000, smiley), [14_000, S({ expression: "laugh", intensity: 0.9 }), { ...QUIET, companionSpeaking: true }]]);
  assert.deepEqual(laughs.kinds, ["smiled_at_reply"], "a laugh from a resting smile still counts");
  const change = run([...series(0, 12_000, 2000, S()), [14_000, confused, { ...QUIET, lastReplyEndAt: 13_000 }]]);
  assert.deepEqual(change.kinds, ["looks_confused"]);
});

test("false-comment guard: 5 minutes of a neutral or focused face fire nothing", () => {
  assert.deepEqual(run(series(0, 300_000, 2500, S())).kinds, []);
  assert.deepEqual(run(series(0, 300_000, 2500, S({ expression: "focused", engagement: 0.6 }))).kinds, []);
  // a very unsure read (no face in the crop, conf < 0.4) never counts, not even for gaze
  assert.deepEqual(run(series(0, 300_000, 2500, S({ expression: "tired", gaze: "away", engagement: 0.1, confidence: 0.3 }))).kinds, []);
  // an unsure expression (0.4–0.6) never fires an expression trigger
  assert.deepEqual(run(series(0, 300_000, 2500, S({ expression: "tired", engagement: 0.7, confidence: 0.5 }))).kinds, []);
});

test("hints are short, kind, about the moment, never about looks; tired is a soft observation", () => {
  const kinds = ["smiled_at_reply", "laughed", "smiled_at_own_joke", "looks_tired", "looks_confused", "looked_away", "engagement_drop"] as const;
  for (const k of kinds) {
    const h = hintFor(k, S());
    assert.ok(h.length > 10 && h.length < 140, k);
    assert.doesNotMatch(h, /hair|skin|weight|age|old|young|pretty|ugly|sick/i, k);
  }
});

test("observe ignores a sample older than the last kept one (state never goes back in time)", () => {
  const r = run([[4000, S()], [2500, S({ expression: "laugh", intensity: 0.9 })]]);
  assert.deepEqual(r.kinds, []);
  assert.equal(stateOf(r.tracker, 4000)!.at, 4000);
});
