import { test } from "node:test";
import assert from "node:assert/strict";
import { DEPTH_QUESTIONS, buildPersonaRequest, toPersona, validatePrefs, type SetupAnswers } from "../src/prep/personaCard.ts";
import { buildInstructions } from "../src/prompt/persona.ts";

const quick = { help: "Think with me", relationship: "Trusted partner", presence: ["Warm"] };
const right = { ...quick, challenge: 3, pace: 3 };
const deep = { ...right, reachOut: 2, never: ["Message anyone for me", "Mirror my mood"] };

test("PRD F2b: Quick 3, Right 5, Deep 7 questions, no duplicates", () => {
  assert.equal(DEPTH_QUESTIONS.quick.length, 3);
  assert.equal(DEPTH_QUESTIONS.right.length, 5);
  assert.equal(DEPTH_QUESTIONS.deep.length, 7);
  for (const d of Object.values(DEPTH_QUESTIONS)) assert.equal(new Set(d).size, d.length);
});

test("prefs validation: exactly the questions of the depth", () => {
  assert.ok(validatePrefs("quick", quick).ok);
  assert.ok(validatePrefs("right", right).ok);
  assert.ok(validatePrefs("deep", deep).ok);
  assert.ok(validatePrefs("deep", { ...deep, never: [] }).ok); // Never is multi-select, none is allowed
  const bad: Array<[unknown, unknown, RegExp]> = [
    ["medium", quick, /depth/],
    ["quick", right, /not asked at quick: challenge, pace/],
    ["right", quick, /missing: challenge, pace/],
    ["quick", { ...quick, help: "Do my taxes" }, /help/],
    ["quick", { ...quick, presence: ["Calm", "Witty", "Warm"] }, /presence/],
    ["quick", { ...quick, presence: ["Calm", "Calm"] }, /presence/],
    ["quick", { ...quick, presence: [] }, /presence/],
    ["right", { ...right, challenge: 6 }, /challenge/],
    ["right", { ...right, pace: 2.5 }, /pace/],
    ["deep", { ...deep, never: ["Sell my data"] }, /never/],
    ["quick", null, /object/],
  ];
  for (const [d, a, re] of bad) {
    const r = validatePrefs(d, a);
    assert.ok(!r.ok && re.test(r.error), `${String(d)} ${JSON.stringify(a)} → ${JSON.stringify(r)}`);
  }
});

const input = (answers: SetupAnswers) => ({ name: "Mira", kind: "human" as const, voiceId: "v1", depth: "deep" as const, answers });

test("Direct end and Gentle end produce different instructions even if Spark returns nothing", () => {
  const gentle = toPersona(null, input({ ...(deep as SetupAnswers), challenge: 1 }));
  const direct = toPersona(null, input({ ...(deep as SetupAnswers), challenge: 5 }));
  assert.match(gentle.card.speakingStyle!, /very gentle/);
  assert.match(direct.card.speakingStyle!, /very direct/);
  assert.notEqual(buildInstructions({ persona: gentle.card, mode: "chat" }), buildInstructions({ persona: direct.card, mode: "chat" }));
});

test("Never picks become hard rules in the session instructions", () => {
  const p = toPersona(null, input(deep as SetupAnswers));
  assert.equal(p.rules.length, 2);
  const instr = buildInstructions({ persona: p.card, mode: "chat" });
  assert.match(instr, /Never offer to message, email, call or contact anyone/);
  assert.match(instr, /Never mirror the user's mood/);
  assert.match(p.summary.never, /won't|never/i);
  assert.equal(toPersona(null, input(quick as SetupAnswers)).summary.never, "Nothing off-limits yet.");
});

test("Spark output is cleaned: traits merged with presence, user-analysis lines replaced", () => {
  const p = toPersona(
    {
      traits: ["Curious", "steady"],
      speaking_style: "I talk: short and warm, with dry humour.",
      role: "a trusted partner who helps the user think things through",
      summary: { why: "You're an introvert, so I'll keep it calm.", energy: "warm and easy", initiative: "I'll suggest a next step now and then.", never: "x" },
    },
    input(right as SetupAnswers),
  );
  assert.deepEqual(p.card.traits, ["curious", "steady", "warm"]);
  assert.match(p.card.speakingStyle!, /^short and warm, with dry humour; balanced/);
  assert.match(p.card.backstory!, /^A trusted partner who helps the user think things through\./);
  assert.doesNotMatch(p.summary.why, /introvert/);
  assert.equal(p.summary.energy, "Warm and easy.");
  assert.equal(p.card.voice?.id, "v1");
});

test("persona request: survey listed before the profile, profile fenced as data", () => {
  const r = buildPersonaRequest(input(deep as SetupAnswers));
  const s = String(r.input);
  assert.match(s, /Setup answers \(these win over the imported profile\)/);
  assert.match(s, /Never: Message anyone for me; Mirror my mood/);
  assert.doesNotMatch(s, /imported_profile/); // no style → no profile block
  assert.match(String(r.instructions), /never the user/);
});
