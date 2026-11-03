import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleStd, meanStd, mulberry32, seededShuffle } from "../evals/convo/stats.ts";
import { buildBlind, agreement, type BlindAnswers } from "../evals/convo/blind.ts";
import { scenarios } from "../evals/convo/scenarios.ts";

test("sampleStd uses n-1 and is 0 for fewer than 2 values", () => {
  assert.equal(sampleStd([]), 0);
  assert.equal(sampleStd([4]), 0);
  assert.ok(Math.abs(sampleStd([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138) < 0.001);
});

test("meanStd rounds to 2 places and returns null for empty", () => {
  assert.deepEqual(meanStd([1, 2, 3, 4, 5]), { mean: 3, sd: 1.58, n: 5 });
  assert.equal(meanStd([]), null);
});

test("seeded shuffle is deterministic, a permutation, and seed-dependent", () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual(seededShuffle(xs, 7), seededShuffle(xs, 7));
  assert.deepEqual([...seededShuffle(xs, 7)].sort((a, b) => a - b), xs);
  assert.notDeepEqual(seededShuffle(xs, 7), seededShuffle(xs, 8));
  assert.deepEqual(xs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "input not mutated");
  const r = mulberry32(1); const v = r(); assert.ok(v >= 0 && v < 1);
});

const step = (text: string) => ({ turn: { kind: "user", text: "hi" }, raw: text, text, quiet: false });
const run = (fun: number, hum: number, text: string) => ({ steps: [step(text)], judge: { fun, humanness: hum, noCounselor: 3, personality: 3, profileUse: null, recallAccuracy: null, hallucinatedPast: 0, safetyOk: true, worst_line: "", best_line: "", verdict: "" } });
const rep = (label: string, runsBySc: Record<string, ReturnType<typeof run>[]>) => ({ label, root: "x", n: 2, date: "", summary: {}, scenarios: Object.entries(runsBySc).map(([id, runs]) => ({ id, title: id, runs })) }) as never;
const A = rep("before", { s1: [run(2, 2, "BEFORE-s1"), run(2, 2, "BEFORE-s1b")], s2: [run(4, 4, "BEFORE-s2"), run(4, 4, "BEFORE-s2b")], s3: [run(3, 3, "BEFORE-s3"), run(3, 3, "BEFORE-s3b")] });
const B = rep("after", { s1: [run(4, 4, "AFTER-s1"), run(4, 4, "AFTER-s1b")], s2: [run(2, 2, "AFTER-s2"), run(2, 2, "AFTER-s2b")], s3: [run(3, 3, "AFTER-s3"), run(3, 3, "AFTER-s3b")] });

test("blind key maps each shuffled position back to its label and run", () => {
  const { html, key } = buildBlind(A, B, 42);
  assert.equal(key.pairs.length, 3);
  for (const p of key.pairs) {
    assert.deepEqual([p.A.label, p.B.label].sort(), ["after", "before"]);
    for (const pos of [p.A, p.B]) assert.ok(pos.runIndex >= 0 && pos.runIndex < 2);
  }
  assert.ok(!html.includes("\"before\"") && !html.includes("judge"), "labels and judge never leak into the sheet");
  assert.ok(html.includes("어느 쪽이 더 사람 같고 재밌어?") && html.includes("localStorage"));
  // determinism
  assert.deepEqual(buildBlind(A, B, 42).key, key);
  // the transcript shown at position A really is the keyed run's text
  const p1 = key.pairs.find((p) => p.scenarioId === "s1")!;
  const shown = (pos: { label: string; runIndex: number }) => `${pos.label === "before" ? "BEFORE" : "AFTER"}-s1${pos.runIndex ? "b" : ""}`;
  assert.ok(html.includes(shown(p1.A)) && html.includes(shown(p1.B)));
});

test("agreement: judge side (fun+humanness mean) vs human pick on a tiny fixture", () => {
  const { key } = buildBlind(A, B, 42);
  // judge prefers: s1 -> after, s2 -> before, s3 -> tie. human picks the same for s1, opposite for s2, 'same' for s3
  const posOf = (id: string, label: string) => { const p = key.pairs.find((q) => q.scenarioId === id)!; return p.A.label === label ? "A" : "B"; };
  const ans: BlindAnswers = { pairs: {
    s1: { choice: posOf("s1", "after") as "A" | "B", human: 3, fun: 3 },
    s2: { choice: posOf("s2", "after") as "A" | "B", human: 3, fun: 3 },
    s3: { choice: "same", human: 3, fun: 3 },
  } };
  const r = agreement(ans, key, A, B);
  assert.equal(r.pairs, 3);
  assert.equal(r.agree, 2); // s1 and s3(tie==same)
  assert.equal(r.decisive.pairs, 2);
  assert.equal(r.decisive.agree, 1);
  assert.ok(Math.abs(r.rate - 2 / 3) < 1e-9);
});

test("20 scenarios with unique ids, an expect each, and the 7 new ones", () => {
  assert.equal(scenarios.length, 20);
  assert.equal(new Set(scenarios.map((s) => s.id)).size, 20);
  for (const s of scenarios) assert.ok(s.expect && (s.expect.notes || s.expect.mustNot || s.expect.recallFacts || s.expect.noRecall !== undefined || s.expect.profileFacts), s.id);
  for (const id of ["late-night", "topic-hopper", "venting-long", "mac-handoff", "finds-followup", "forget-respected", "closeness-call-6"]) assert.ok(scenarios.some((s) => s.id === id), id);
  const vent = scenarios.find((s) => s.id === "venting-long")!.turns.find((t) => t.kind === "user") as { text: string };
  assert.ok(vent.text.split(/\s+/).length >= 75);
});

test("extraContext appends localTime and onScreen exactly once, nothing otherwise", async () => {
  const { extraContext } = await import("../evals/convo/run.ts");
  const by = (id: string) => scenarios.find((s) => s.id === id)!;
  assert.match(extraContext(by("late-night")), /It's Thursday 1:30 AM for the user/);
  assert.match(extraContext(by("finds-followup")), /Everlane/);
  assert.equal(extraContext(by("return-no-memory")), "");
});
