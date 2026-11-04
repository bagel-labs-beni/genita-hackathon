import { test } from "node:test";
import assert from "node:assert/strict";
import { toStyleCard, type ImportRaw } from "../src/prep/importProfile.ts";
import { preferenceRows, setupLines, withPreferenceRows } from "../src/prep/preferenceRows.ts";
import type { StoredInsights } from "../src/insights/profile.ts";

const f = (text: string, label: "explicit" | "observed" | "suggested" = "explicit") => ({ text, label, scope: "any" });
const empty = (): ImportRaw["sections"] => ({ tendencies: [], communication: [], response: [], help: [], support: [], interests: [], likes: [], boundaries: [], approach: [] });
/** TF 331 (Chelsea 11/4): a ChatGPT import that only filled Communication style and Likes & dislikes */
const tf331 = () => toStyleCard({ sections: { ...empty(), communication: [f("Direct and plain, no padding.")], likes: [f("Food: leans toward quick, low-effort weeknight meals")] }, rules: [], to_confirm: [] });
const TITLES = ["Communication style", "Response preferences", "How Genita can help", "Interests", "Likes & dislikes", "Boundaries"];
const quick = { depth: "quick" as const, answers: { help: "Think with me" as const, relationship: "Close companion" as const, presence: ["Calm" as const, "Witty" as const] } };
const deep = {
  depth: "deep" as const,
  answers: { help: "Keep me moving" as const, relationship: "Trusted partner" as const, presence: ["Warm" as const], challenge: 4, pace: 2, reachOut: 1, never: ["Message anyone for me" as const, "Mirror my mood" as const] },
};
const lines = (rows: ReturnType<typeof preferenceRows>, key: string) => rows.find((r) => r.key === key)!.items.map((i) => i.text);

test("preference rows: TF 331 import + Quick start → all six rows have a line, import lines first", () => {
  const card = tf331();
  assert.equal(card.display.filter((r) => r.items.length).length, 2, "the import alone fills 2 of 6 (the bug)");
  const rows = preferenceRows(card, quick);
  assert.deepEqual(rows.map((r) => r.title), TITLES);
  for (const r of rows) {
    assert.ok(r.items.length >= 1, `${r.title} is empty`);
    assert.ok(r.items.every((i) => !/not enough information/i.test(i.text)), r.title);
    assert.ok(r.items.length <= 3);
  }
  assert.equal(lines(rows, "communication")[0], "Direct and plain, no padding.");
  assert.ok(lines(rows, "communication").includes("A calm and witty presence."));
  assert.equal(lines(rows, "likes")[0], "Food: leans toward quick, low-effort weeknight meals");
  assert.ok(lines(rows, "help")[0].startsWith("Thinking things through together"));
  assert.ok(lines(rows, "interests")[0].length > 0);
  assert.ok(lines(rows, "response").includes("Likes to get going quickly and fill in the rest by talking."), "the D01 choice is a line");
  assert.deepEqual(lines(rows, "boundaries"), ["No messages or actions without their approval."]);
});

test("preference rows: no import at all (N1–N3 skipped / failed import) → still six rows after the P flow", () => {
  for (const prefs of [quick, deep, { ...deep, depth: "right" as const, answers: { ...quick.answers, challenge: 1, pace: 5 } }]) {
    const rows = preferenceRows(null, prefs);
    assert.equal(rows.length, 6);
    assert.ok(rows.every((r) => r.items.length >= 1), prefs.depth);
  }
});

test("preference rows: every option of every P question has wording (no undefined line)", () => {
  for (const help of ["Think with me", "Keep me moving", "Be there", "Work beside me"] as const)
    for (const relationship of ["Close companion", "Trusted partner", "Creative co-pilot", "Quiet operator"] as const)
      for (const v of [1, 2, 3, 4, 5]) {
        const s = setupLines({ depth: "deep", answers: { help, relationship, presence: ["Grounded"], challenge: v, pace: v, reachOut: v, never: ["Use sensitive memories", "Interrupt focus time"] } });
        for (const [k, l] of Object.entries(s)) {
          assert.ok(l.length >= 1, `${k} empty for ${help}/${relationship}/${v}`);
          assert.ok(l.every((x) => typeof x === "string" && x.length > 3 && !x.includes("undefined")), k);
        }
      }
});

test("preference rows: Deep answers land in their rows (challenge, pace, reach out, never)", () => {
  const rows = preferenceRows(null, deep);
  assert.ok(lines(rows, "response").includes("Plain disagreement and why, said kindly."));
  assert.ok(lines(rows, "communication").includes("An unhurried pace."));
  assert.deepEqual(lines(rows, "boundaries"), ["Never message anyone on their behalf.", "Stay steady instead of mirroring their mood.", "Speak up only when asked."]);
});

test("preference rows: a full import row keeps one slot for the survey; nothing before the P flow changes it", () => {
  const card = toStyleCard({ sections: { ...empty(), help: [f("Plans the week."), f("Edits drafts."), f("Reviews code.")] }, rules: [], to_confirm: [] });
  assert.deepEqual(lines(preferenceRows(card, null), "help"), ["Plans the week.", "Edits drafts.", "Reviews code."]);
  assert.deepEqual(lines(preferenceRows(card, quick), "help"), ["Plans the week.", "Edits drafts.", "Thinking things through together: ideas, decisions and clarity."]);
});

test("preference rows: before the P flow an empty row borrows the import's own related sections", () => {
  const card = toStyleCard({ sections: { ...empty(), tendencies: [f("Thinks out loud.")], support: [f("Likes a nudge on deadlines.")], approach: [f("Lead with the answer.")] }, rules: [], to_confirm: [] });
  const rows = preferenceRows(card, null);
  assert.deepEqual(lines(rows, "communication"), ["Thinks out loud."]);
  assert.deepEqual(lines(rows, "help"), ["Likes a nudge on deadlines."]);
  assert.deepEqual(rows.find((r) => r.key === "response")!.items, [{ text: "Lead with the answer.", label: "suggested" }]);
  // nothing to say yet stays empty (no invented line before the P answers exist)
  assert.deepEqual(lines(rows, "interests"), []);
});

test("preference rows: R1 observations fill their category's row; ones taken back never do", () => {
  const card = tf331();
  card.insights = {
    observations: [
      { id: "o1", category: "interest", claim: "You keep coming back to product design.", verdict: null },
      { id: "o2", category: "boundary", claim: "You want space after work.", verdict: "not_me" },
      { id: "o3", category: "taste", claim: "You dislike small talk.", verdict: null },
      { id: "o4", category: "help", claim: "You want a sounding board.", verdict: null },
    ],
    denied: [{ id: "o4", claim: "You want a sounding board.", category: "help", at: "2026-11-04T00:00:00Z" }],
  } as unknown as StoredInsights;
  const rows = preferenceRows(card, quick);
  assert.equal(lines(rows, "interests")[0], "You keep coming back to product design.");
  assert.ok(lines(rows, "likes").includes("You dislike small talk."));
  assert.ok(!lines(rows, "boundaries").some((l) => l.includes("space after work")));
  assert.ok(!lines(rows, "help").some((l) => l.includes("sounding board")));
});

test("preference rows: withPreferenceRows doesn't touch the stored card and recomputes partial", () => {
  const card = tf331();
  const before = JSON.stringify(card);
  const seen = withPreferenceRows(card, quick);
  assert.equal(JSON.stringify(card), before);
  assert.equal(card.partial, true);
  assert.equal(seen.partial, false);
  assert.equal(seen.sections, card.sections);
  // "Not enough information yet." lines a corrected card may carry are not kept as items
  const odd = tf331();
  odd.display[1].items = [{ text: "Not enough information yet.", label: "suggested" }];
  assert.ok(!lines(preferenceRows(odd, quick), "response").some((l) => /not enough/i.test(l)));
});
