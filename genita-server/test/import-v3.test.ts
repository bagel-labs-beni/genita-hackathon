/**
 * Import prompt v3 (Chelsea 11/2): 10 sections → I04's 6 rows, old 8-section
 * replies still accepted, profile text puts Likes & dislikes first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IMPORT_SCHEMA,
  buildImportRequest,
  importFormat,
  skipStyleCard,
  styleProfileText,
  toStyleCard,
  type ImportRaw,
} from "../src/prep/importProfile.ts";

const TEN = `1. Thinking style
- Thinks out loud and narrows down by comparing two concrete options. [Observed]

2. Communication style
- Warm, casual and direct; light humor is welcome. [Explicit]

3. Response preferences
- Short answers first, detail only when asked. [Explicit]

7. Likes and dislikes
- Loves muted earthy colors and relaxed fits. [Explicit]
- Dislikes cilantro. [Explicit]

10. Preferences still to confirm
- Reminder frequency: unknown whether reminders are welcome.`;

const EIGHT = `1. Personal tendencies and thinking style
- Plans with lists before acting. [Observed]

2. Communication preferences
- Friendly and brief. [Explicit]

3. Useful help and explanations
- Step-by-step explanations with one example. [Explicit]
- Help planning weekly meals. [Observed]

4. Support, feedback, and disagreement
- Honest feedback, said kindly. [Explicit]

5. Recurring interests and priorities
- Home cooking and running. [Observed]

6. Boundaries and initiative
- Ask before giving unsolicited advice. [Explicit]

7. Recommended companion approach
- When I'm cooking, Genita should suggest one dish. [Suggested]

8. Preferences still to confirm
- Humor in serious moments.`;

test("importFormat: numbered v3 headings → ten, old prompt headings → eight, neither → unknown", () => {
  assert.equal(importFormat(TEN), "ten");
  assert.equal(importFormat(EIGHT), "eight");
  // partial v3 replies (2–3 sections) are still recognised
  assert.equal(importFormat("2. Communication style\n- Warm. [Explicit]\n\n7. Likes and dislikes\n- Loves ramen. [Explicit]"), "ten");
  assert.equal(importFormat("6. Boundaries and initiative\n- Ask first. [Explicit]\n\n8. Preferences still to confirm\n- Humor."), "eight");
  assert.equal(importFormat("I like short answers and I love ramen. Please be warm."), "unknown");
});

test("import request: v3 mapping for a 10-section reply, split instruction for an old 8-section reply", () => {
  const ten = String(buildImportRequest(TEN).instructions);
  assert.match(ten, /3 → response/);
  assert.match(ten, /4 → help/);
  assert.match(ten, /7 → likes/);
  assert.match(ten, /9 → approach/);
  assert.match(ten, /10 → to_confirm/);
  const eight = String(buildImportRequest(EIGHT).instructions);
  assert.match(eight, /older 8-section/);
  assert.match(eight, /3 → split/);
  assert.match(eight, /put it in both/);
  assert.match(eight, /8 → to_confirm/);
  assert.doesNotMatch(eight, /10 → to_confirm/);
  const unknown = String(buildImportRequest("I like short answers and I love ramen. Please be warm.").instructions);
  assert.match(unknown, /heading/);
  // the paste is still data in both formats
  for (const t of [ten, eight, unknown]) assert.match(t, /DATA/);
});

test("import schema: nine section keys, all required", () => {
  const s = IMPORT_SCHEMA.properties.sections;
  const keys = ["tendencies", "communication", "response", "help", "support", "interests", "likes", "boundaries", "approach"];
  assert.deepEqual(Object.keys(s.properties), keys);
  assert.deepEqual([...s.required], keys);
});

const f = (text: string, label: "explicit" | "observed" | "memory" | "suggested" = "explicit") => ({ text, label, scope: "any" });

const FULL: ImportRaw = {
  sections: {
    tendencies: [f("Compares two concrete options before deciding.", "observed")],
    communication: [f("Warm, casual and direct."), f("Light humor welcome.", "observed")],
    response: [f("Short answer first, detail on request.")],
    help: [f("Outfit picks from two options."), f("Weeknight dinner ideas.", "observed")],
    support: [f("Honest feedback, said kindly.")],
    interests: [f("Interior design."), f("Ceramics.", "memory")],
    likes: [f("Muted earthy colors, relaxed fits."), f("Korean and Japanese home cooking."), f("Dislikes cilantro."), f("Dislikes loud logos.")],
    boundaries: [f("Ask before giving unasked advice.")],
    approach: [f("Be a calm, practical everyday helper.")],
  },
  rules: [{ when: "When I show two outfits", then: "Genita should pick one and say why", label: "suggested" }],
  to_confirm: ["Reminder frequency"],
};

test("style card v3: six I04 rows in order, each from its own section, max 3 items", () => {
  const card = toStyleCard(FULL);
  assert.deepEqual(
    card.display.map((r) => [r.key, r.title]),
    [
      ["communication", "Communication style"],
      ["response", "Response preferences"],
      ["help", "How Genita can help"],
      ["interests", "Interests"],
      ["likes", "Likes & dislikes"],
      ["boundaries", "Boundaries"],
    ],
  );
  const row = (k: string) => card.display.find((r) => r.key === k)!.items.map((i) => i.text);
  assert.deepEqual(row("communication"), ["Warm, casual and direct.", "Light humor welcome."]);
  // section 3 first, then section 9's rules fill the free slots
  assert.deepEqual(row("response"), ["Short answer first, detail on request.", "When I show two outfits, pick one and say why."]);
  assert.deepEqual(row("help"), ["Outfit picks from two options.", "Weeknight dinner ideas."]);
  assert.deepEqual(row("interests"), ["Interior design.", "Ceramics."]);
  assert.deepEqual(row("likes"), ["Muted earthy colors, relaxed fits.", "Korean and Japanese home cooking.", "Dislikes cilantro."]); // max 3
  assert.deepEqual(row("boundaries"), ["Ask before giving unasked advice."]);
  // tendencies, support and approach are not rows
  const shown = card.display.flatMap((r) => r.items.map((i) => i.text)).join(" ");
  assert.doesNotMatch(shown, /Compares two|Honest feedback|calm, practical/);
  assert.equal(card.partial, false);
  assert.deepEqual(card.toConfirm, ["Reminder frequency"]);
});

test("style card v3: a partial reply (2–3 sections) → partial, other rows empty", () => {
  const card = toStyleCard({
    sections: { communication: [f("Warm and brief.")], likes: [f("Loves ramen.")], response: [f("One option at a time.")] } as ImportRaw["sections"],
    rules: [],
    to_confirm: [],
  });
  assert.equal(card.display.length, 6);
  assert.deepEqual(
    card.display.map((r) => r.items.length),
    [1, 1, 0, 0, 1, 0],
  );
  assert.equal(card.partial, true);
  assert.equal(card.itemCount, 3);
});

test("profile text: the 6 fields + rules on every call, Likes & dislikes first (Finds reads the first 800 chars)", () => {
  const card = toStyleCard(FULL);
  const text = styleProfileText(card);
  for (const label of ["Taste:", "Interests:", "Talk:", "Replies:", "Help:", "Boundaries:"]) assert.ok(text.includes(label), label);
  assert.match(text, /Rules:\n- When I show two outfits, pick one and say why\./);
  assert.match(text, /Dislikes cilantro/);
  assert.ok(text.slice(0, 800).includes("- Taste: Dislikes cilantro."), "likes must sit inside the outfit card's 800-char slice");
  // naming's 1,200 budget still keeps the 6 fields and the rules for a typical card
  for (const max of [1200]) {
    const t = styleProfileText(card, max);
    for (const label of ["Taste:", "Interests:", "Talk:", "Replies:", "Help:", "Boundaries:", "Rules:"]) assert.ok(t.includes(label), `${max}: ${label}`);
  }
});

test("profile text: a long card keeps the 6 fields and rules inside 2,000 chars", () => {
  const many = (p: string) => Array.from({ length: 12 }, (_, i) => f(`${p} item number ${i} with a few more words to fill it.`));
  const raw: ImportRaw = {
    sections: {
      tendencies: many("Thinking"),
      communication: many("Talk"),
      response: many("Reply"),
      help: many("Help"),
      support: many("Support"),
      interests: many("Interest"),
      likes: many("Taste"),
      boundaries: many("Boundary"),
      approach: many("Approach"),
    },
    rules: Array.from({ length: 8 }, (_, i) => ({ when: `case ${i}`, then: `do thing ${i}`, label: "suggested" as const })),
    to_confirm: [],
  };
  const text = styleProfileText(toStyleCard(raw));
  assert.ok(text.length <= 2000, String(text.length));
  for (const label of ["Taste:", "Interests:", "Talk:", "Replies:", "Help:", "Boundaries:", "Rules:"]) assert.ok(text.includes(label), label);
});

test("profile text: a card stored before v3 (no response/likes keys) still renders", () => {
  const old = toStyleCard(FULL);
  const sections = { ...old.sections } as Partial<ImportRaw["sections"]>;
  delete sections.response;
  delete sections.likes;
  const text = styleProfileText({ ...old, sections: sections as ImportRaw["sections"] });
  assert.match(text, /Talk: Warm, casual and direct\./);
});

test("skip card v3: N1 → Interests, N2 → Response preferences, N3 → Boundaries", () => {
  const r = skipStyleCard({ interests: ["Design"], replies: "Start with the answer", avoid: ["Comments on my looks"] });
  assert.ok(r.ok);
  if (!r.ok) return;
  const row = (k: string) => r.card.display.find((x) => x.key === k)!.items;
  assert.deepEqual(row("interests"), [{ text: "Design", label: "explicit" }]);
  assert.deepEqual(row("response"), [{ text: "Start with the answer, then explain.", label: "explicit" }]);
  assert.deepEqual(row("boundaries"), [{ text: "Don't comment on my looks.", label: "explicit" }]);
  assert.deepEqual(r.card.toConfirm, ["Communication style", "How Genita can help", "Likes & dislikes"]);
  assert.match(styleProfileText(r.card), /Replies: Start with the answer/);
});

const MANY_LIKES: ImportRaw = {
  ...FULL,
  sections: {
    ...FULL.sections,
    likes: [
      f("Loves Korean comfort food."),
      f("Loves one-pot meals."),
      f("Loves sheet-pan dinners."),
      f("Keeps tofu, eggs and rice around.", "observed"),
      f("Prefers chicken and fish over red meat."),
      f("Watches cooking shows.", "observed"),
      f("Dislikes cilantro."),
      f("Avoid very spicy food."),
      f("Dislikes recipes with more than ten ingredients."),
    ],
  },
};

test("likes row: a dislike always shows when there is one (2 likes + 1 dislike)", () => {
  const row = toStyleCard(MANY_LIKES).display.find((r) => r.key === "likes")!.items.map((i) => i.text);
  assert.deepEqual(row, ["Loves Korean comfort food.", "Loves one-pot meals.", "Dislikes cilantro."]);
});

test("profile text: every dislike (up to 3) reaches the Taste lines even with many likes", () => {
  const text = styleProfileText(toStyleCard(MANY_LIKES));
  const head = text.slice(0, 800);
  for (const d of ["Dislikes cilantro.", "Avoid very spicy food.", "Dislikes recipes with more than ten ingredients."]) assert.ok(head.includes(`- Taste: ${d}`), d);
  assert.ok(head.includes("- Taste: Prefers chicken and fish over red meat."));
  assert.match(text, /Ask naturally on the first call about: Reminder frequency\./);
});

test("persona card request gets the full profile: Likes & dislikes, all 6 fields and the rules", async () => {
  const { buildPersonaRequest } = await import("../src/prep/personaCard.ts");
  const answers = { help: "Everyday decisions", relationship: "Friend", presence: ["Calm"], warmth: 3, playful: 3, challenge: 3, pace: 3, reachOut: 2, never: [] };
  // a real-size card (v3-parent run, 11/2: profile 1,968 chars)
  const long = (p: string) => Array.from({ length: 4 }, (_, i) => f(`${p} finding ${i} written as one short setting line.`));
  const raw: ImportRaw = {
    sections: { ...MANY_LIKES.sections, communication: long("Talk"), response: long("Reply"), help: long("Help"), interests: long("Interest"), boundaries: long("Boundary") },
    rules: Array.from({ length: 4 }, (_, i) => ({ when: `situation ${i} happens on the call`, then: `do the helpful thing number ${i}`, label: "suggested" as const })),
    to_confirm: ["Reminder frequency"],
  };
  const r = buildPersonaRequest({ name: "Mira", kind: "human", depth: "deep", answers: answers as never, style: toStyleCard(raw) });
  const input = String(r.input);
  for (const label of ["Taste: Dislikes cilantro.", "Interests:", "Talk:", "Replies:", "Help:", "Boundaries:", "Rules:", "do the helpful thing number 3"]) assert.ok(input.includes(label), label);
});
