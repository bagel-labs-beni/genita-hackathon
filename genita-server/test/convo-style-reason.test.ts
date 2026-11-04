/** prompt-100 style (Chelsea 11/4 23:4x): style feedback uses what we know about them, woven in. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isStyleTurn, knowsColoring, usedReasons, styleFollowLine, styleLine, STYLE_FOLLOW_LINE, STYLE_SEARCH_HINT, styleReasonOn } from "../src/convo/styleReason.ts";
import { normalizeEnglish } from "../src/voice/normalize.ts";
import { buildInstructions } from "../src/prompt/persona.ts";
import { GENERAL_REPLY_LINE } from "../src/finds/general.ts";
import { RECONNECT_LINE } from "../src/session/session.ts";

test("style turns, coloring known or not, the once-only question, rotation", () => {
  for (const t of ["Which one should I wear?", "does this suit me?", "which one looks better on me, the white one or the black one?", "hmm why not the white one?", "should I wear this tonight?"]) assert.ok(isStyleTurn(t), t);
  for (const t of ["what can I make with these?", "I'm so tired", "find me some shoes"]) assert.ok(!isStyleTurn(t), t);
  assert.ok(knowsColoring("- Personal color: warm (autumn)"));
  assert.ok(knowsColoring("", ["Summer has cool undertones"]));
  assert.ok(!knowsColoring("- Likes & dislikes: Black basics"));
  const warm = styleLine({ profile: "- Personal color: warm (autumn)", said: [], askedColoring: false });
  assert.equal(warm.asks, false);
  assert.match(warm.line, /one personal reason in the same breath/);
  assert.deepEqual(usedReasons("- Taste: Minimal style", [], ["The navy one, it's minimal and sharper for tonight."]), ["tonight", "minimal"]);
  // one reason in other words is still that reason ("relaxed fit" → the fit group is spent, so the fit fact isn't offered)
  const fit = styleLine({ profile: "- Taste: Dislikes tight, clingy fits\n- Taste: Silver jewelry\n- Personal color: cool", said: ["That knit has the relaxed fit you like."], askedColoring: false }).line;
  assert.doesNotMatch(fit, /like one of these \(data\): "Dislikes tight/);
  assert.match(fit, /like one of these \(data\): "Silver jewelry"/);
  assert.match(warm.line, /Never about their body shape/);
  const unknown = styleLine({ profile: "", said: [], askedColoring: false });
  assert.equal(unknown.asks, true);
  assert.match(unknown.line, /warm or cool tones usually work for you\?/);
  assert.match(unknown.line, /just this once, and use their answer from then on/);
  const later = styleLine({ profile: "", said: ["The cream one, warm tones always look good on you."], askedColoring: true });
  assert.equal(later.asks, false);
  assert.doesNotMatch(later.line, /usually work for you\?/);
  assert.match(later.line, /Already used this call \(data\): "warm", "tones"; give a different personal reason now/);
  assert.match(STYLE_FOLLOW_LINE, /only a reason you actually said, and don't say you found anything yet/);
  assert.match(styleFollowLine("<happy> The cream one, warm tones love you."), /Your verdict was \(data\): "The cream one, warm tones love you\."/);
  assert.match(STYLE_SEARCH_HINT, /Keep the reason/);
  assert.ok(styleReasonOn({}));
  assert.ok(!styleReasonOn({ GENITA_STYLE_REASON: "0" }));
});

test("prod 23:30 items: digits in text, years read naturally, no 'we got cut off', a real answer before the sheet, the card on screen only when asked", () => {
  const p = buildInstructions({ persona: { name: "Mira", kind: "human", traits: ["warm"] }, mode: "chat", style: "v1", onScreen: "Best ramen in Seoul: Oreno Ramen, Yuzu Ramen" });
  assert.match(p, /write numbers in digits, like 1889 or 330, never as words/);
  assert.match(p, /Talk about that card only if their line is about it\./);
  assert.equal(normalizeEnglish("It was built in 1889."), "It was built in eighteen eighty-nine.");
  assert.equal(normalizeEnglish("Back in 2019 it was $40."), "Back in twenty nineteen it was forty dollars.");
  assert.doesNotMatch(RECONNECT_LINE, /cut off/);
  assert.match(GENERAL_REPLY_LINE, /Give your real answer/);
});

test("prod 23:30: the wait line says 'dress', not 'dres'", async () => {
  const { stillHunting } = await import("../src/finds/runner.ts");
  assert.equal(stillHunting("Dress"), "Still hunting for the right dress, one sec.");
  assert.equal(stillHunting("Dresses"), "Still hunting for the right dress, one sec.");
  assert.equal(stillHunting("Watches"), "Still hunting for the right watch, one sec.");
  assert.equal(stillHunting("Jackets"), "Still hunting for the right jacket, one sec.");
  assert.equal(stillHunting("Boots"), "Still hunting for the right pair, one sec.");
});

test("No-AI path: taste said in passing reaches the in-call extraction, and the profile's Taste lines reach the product search", async () => {
  const { mightBeCorrection } = await import("../src/personalize/corrections.ts");
  const { tasteLines } = await import("../src/finds/product.ts");
  for (const t of ["honestly I always wear black", "my favorite color is olive green", "I think I have warm undertones", "I usually go for oversized stuff", "ugh that's not my style", "and I hate anything tight, I like room to move"]) assert.ok(mightBeCorrection(t), t);
  for (const t of ["which one suits me?", "I have a dinner date tonight", "find me some"]) assert.ok(!mightBeCorrection(t), t);
  // red before: "- Taste:" lines were dropped (only Likes / Interests / Support / Thinking were read)
  assert.deepEqual(tasteLines(undefined, "How the user wants to be treated:\n- Taste: Always wears black\n- Taste: Dislikes tight fits\n- Talk: Casual", []), ["Always wears black", "Dislikes tight fits"]);
});
