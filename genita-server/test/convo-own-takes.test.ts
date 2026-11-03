/**
 * #342 (PRD 9A.9, DESIGN §2.4): the companion has opinions and a verbal habit of its own, the same ones call to call,
 * and brings one in at least once every few replies. Red on origin/main (no src/convo/ownTakes.ts, no take line).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInstructions, type PersonaCard } from "../src/prompt/persona.ts";
import { turnHints } from "../src/convo/rhythm.ts";
import { cardTakes, hasOwnTake, ownTakeLine, parseOwnTakes, OWN_TAKE_NUDGE } from "../src/convo/ownTakes.ts";

const mira: PersonaCard = { name: "Mira", kind: "human", traits: ["dry", "playful", "opinionated"], speakingStyle: "casual, quick", backstory: "A night-owl friend who cooks and loves music." };
const prepped: PersonaCard = { ...mira, backstory: "A trusted partner who helps the user think. Own takes: Cold pizza beats hot pizza; Rainy Sundays are the best Sundays. Quirk: rates things out of ten." };

test("#342 parseOwnTakes reads what prep wrote into the backstory", () => {
  assert.deepEqual(parseOwnTakes(prepped.backstory), { opinions: ["Cold pizza beats hot pizza", "Rainy Sundays are the best Sundays"], quirk: "rates things out of ten" });
  assert.equal(parseOwnTakes(mira.backstory), null);
  assert.equal(parseOwnTakes(undefined), null);
});

test("#342 a card without takes (made before prep wrote them, or a demo card) gets 2 opinions + 1 verbal habit, the same every call", () => {
  const a = cardTakes(mira);
  assert.ok(a);
  assert.equal(a.opinions.length, 2);
  assert.notEqual(a.opinions[0], a.opinions[1]);
  assert.ok(a.quirk && a.quirk.length > 0);
  for (const o of [...a.opinions, a.quirk!]) assert.ok(o.split(/\s+/).length <= 12, `≤ 12 words: ${o}`);
  assert.deepEqual(cardTakes({ ...mira }), a, "deterministic: same card, same takes");
  assert.deepEqual(cardTakes({ ...mira, name: "Mina" }), a, "a rename keeps the takes (seeded by who it is, not its name)");
  const others = ["warm", "calm", "witty", "grounded", "curious", "bold", "shy", "sunny"].map((t) => JSON.stringify(cardTakes({ ...mira, traits: [t] })));
  assert.ok(new Set(others).size >= 4, "different cards get different takes");
  assert.deepEqual(cardTakes(prepped), parseOwnTakes(prepped.backstory), "what prep wrote wins");
});

test("#342 v1 prompt carries the takes as data and says to keep them; legacy prompt unchanged", () => {
  const v1 = buildInstructions({ persona: mira, mode: "chat", style: "v1" });
  assert.match(v1, /Background: A night-owl friend who cooks and loves music\. Own takes: [^.;]+; [^.;]+\. Quirk: [^.]+\./);
  assert.match(v1, /You have your own opinions \(keep your takes call to call; the quirk only now and then\), moods and taste; you are not their assistant/);
  const v1p = buildInstructions({ persona: prepped, mode: "chat", style: "v1" });
  assert.equal((v1p.match(/Own takes:/g) ?? []).length, 1, "prep's takes are not repeated");
  assert.match(v1p, /Own takes: Cold pizza beats hot pizza; Rainy Sundays are the best Sundays\. Quirk: rates things out of ten\./);
  const bare = buildInstructions({ persona: { name: "Bo", kind: "animal", traits: [] }, mode: "chat", style: "v1" });
  assert.match(bare, /Background: Own takes: /, "no backstory at all still gets takes");
  const legacy = buildInstructions({ persona: mira, mode: "chat" });
  assert.doesNotMatch(legacy, /Own takes|Your own takes/);
});

test("#342 hasOwnTake: a first-person stance counts, a bare reaction or question doesn't", () => {
  for (const s of ["<happy> Honestly? Black, easy.", "I'd go with the ramen, no contest.", "Cold pizza is elite and I will die on that hill.", "Hot take: sequels are better.", "My vote's the window seat.", "I'm so not a fan of mornings.", "I love that for you, but I'm team rain."]) assert.ok(hasOwnTake(s), s);
  for (const s of ["<curious> Wait, what happened?", "No way, that's huge!", "Ha, okay, tell me more.", "You did great."]) assert.ok(!hasOwnTake(s), s);
});

test("#342 own-take nudge: three replies in a row with no take of its own → the next turn asks for one", () => {
  const flat = ["<happy> No way, that's huge!", "<curious> Wait, what happened next?", "<warm> Ha, okay, that tracks."];
  assert.equal(ownTakeLine(flat, "it was fine I guess"), OWN_TAKE_NUDGE);
  assert.equal(ownTakeLine(flat.slice(1), "it was fine I guess"), null, "fewer than 3 replies: too early");
  assert.equal(ownTakeLine([...flat.slice(0, 2), "<teasing> Honestly I'd have left."], "lol"), null, "a recent take: no nudge");
  assert.equal(ownTakeLine(flat, "ugh today was so bad"), null, "bad news: no opinions pushed on them");
  assert.equal(ownTakeLine(flat, "I want to die"), null, "never on a crisis line");
  assert.match(turnHints({ userText: "it was fine I guess", remembers: false, recentReplies: flat })!, /This turn: [^\n]*one of your own takes/);
  assert.doesNotMatch(turnHints({ userText: "ok", remembers: false }) ?? "", /takes/, "no replies passed: no nudge");
});
