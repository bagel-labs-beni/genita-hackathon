/**
 * prompt-100 (11/4): styleProfileText cut a big import at 2,000 chars from the END, so the "Never bring these up" list
 * (what the user asked to forget) and the boundaries went first. Now the lowest-priority lines go first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { styleProfileText, toStyleCard } from "../src/prep/importProfile.ts";

const f = (text: string, label = "explicit", extra: Record<string, unknown> = {}) => ({ text, label, scope: "any", ...extra });
const long = (s: string, i: number) => `${s} ${i}: ${"detail ".repeat(14).trim()}`;

function bigCard() {
  const many = (s: string, n = 8, label = "explicit", extra = {}) => Array.from({ length: n }, (_, i) => f(long(s, i), label, extra));
  const card = toStyleCard({
    sections: {
      likes: many("Likes thing"),
      interests: many("Into topic"),
      communication: [f("Casual, witty; teasing is welcome")],
      response: [f("Give me the answer in one line, then stop")],
      help: many("Help pattern"),
      boundaries: [f("No diet or health advice"), f("Never bring up my ex")],
      support: many("Support move"),
      tendencies: [...many("Thinks like", 8, "inferred"), ...many("Leans toward", 4, "explicit", { direction: "up" })],
      approach: many("Approach note"),
    },
    rules: [{ when: "I'm stressed about work", then: "make me laugh first, then help", label: "explicit" }],
    to_confirm: ["what they do for work"],
  });
  card.removed = [{ text: "K-pop (aespa)", forget: true }, { text: "my old roommate Jess", forget: true }];
  for (const k of ["likes", "interests", "help", "support", "approach"] as const) card.sections[k].push(f(long(`Suggested ${k}`, 0), "suggested"));
  return card;
}

test("a 6000-char import keeps the never-bring-up list, the boundaries, the rules and how to talk, within 2000 chars", () => {
  const card = bigCard();
  const imported = JSON.stringify(card.sections) + JSON.stringify(card.rules);
  assert.ok(imported.length >= 6000, `the import is ${imported.length} chars`);
  const full = styleProfileText(card, 100_000);
  assert.ok(full.length > 3000, `it renders ${full.length} chars untrimmed`);
  // main's cut (from the end) lost the forget list on this card
  const fromEnd = full.slice(0, full.lastIndexOf("\n", 2000));
  assert.doesNotMatch(fromEnd, /Never bring these up/);
  const out = styleProfileText(card, 2000);
  assert.ok(out.length <= 2000, `${out.length} chars`);
  // red on main: everything below was cut (it sat at the end)
  assert.match(out, /Never bring these up/);
  assert.match(out, /- K-pop \(aespa\)/);
  assert.match(out, /- my old roommate Jess/);
  assert.match(out, /Boundaries: No diet or health advice/);
  assert.match(out, /Boundaries: Never bring up my ex/);
  assert.match(out, /Rules:\n- When I'm stressed about work/i);
  assert.match(out, /Casual, witty; teasing is welcome/);
  assert.match(out, /answer in one line, then stop/);
  // what goes first: suggestions and leans, then the extras
  assert.doesNotMatch(out, /Suggestions \(not confirmed/);
  assert.doesNotMatch(out, /Leans \(indirect/);
  // reading order is unchanged: treated → rules → … → never bring up
  assert.ok(out.indexOf("How the user wants to be treated:") < out.indexOf("Rules:"));
  assert.ok(out.indexOf("Rules:") < out.indexOf("Never bring these up"));
  // no orphan heading
  for (const head of out.split("\n").filter((l) => l.endsWith(":"))) assert.ok(out.split("\n")[out.split("\n").indexOf(head) + 1]?.startsWith("- "), head);
});

test("a small import is unchanged by the trim", () => {
  const card = toStyleCard({ sections: { likes: [f("Late-night ramen")], boundaries: [f("No diet advice")] }, rules: [] });
  card.removed = [{ text: "K-pop", forget: true }];
  const out = styleProfileText(card, 2000);
  assert.equal(out, "How the user wants to be treated:\n- Taste: Late-night ramen\n- Boundaries: No diet advice\nNever bring these up, and never say you were asked to forget or drop them; talk as if you never knew them:\n- K-pop");
});
