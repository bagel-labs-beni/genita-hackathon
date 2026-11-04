/** prompt-100 style (Chelsea 11/4 23:4x): style feedback uses what we know about them, woven in. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { asksColoring, COLORING_QUESTION, isOfferOnly, reasonCategories, STYLE_RETRY_LINE, WHY_NOT_VISIBLE, isStyleTurn, isWhyNotTurn, knowsColoring, usedReasons, styleFollowLine, styleLine, STYLE_FOLLOW_LINE, STYLE_SEARCH_HINT, styleReasonOn, WHY_NOT_LINE } from "../src/convo/styleReason.ts";
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

test("style 11/5 (8/72): 'why not this one?' asks for the other option's own reason; the per-call list rotates", () => {
  for (const t of ["why not this one?", "hmm why not the white one?", "what about the other one?", "why not that one", "isn't the black one better?", "why didn't you pick the navy?"]) assert.ok(isWhyNotTurn(t), t);
  for (const t of ["which one should I wear?", "why not, let's go", "what about dinner?", "why is it so cold"]) assert.ok(!isWhyNotTurn(t), t);
  const profile = "- Personal color: warm (autumn)\n- Taste: Silver jewelry\n- Taste: Dislikes tight, clingy fits\n- Taste: Minimal style";
  const said = ["The cream one, warm tones always look good on you."];
  const why = styleLine({ profile, said, askedColoring: false, whyNot: true }).line;
  assert.ok(why.includes(WHY_NOT_LINE));
  assert.match(why, /Your last verdict \(data\): "The cream one, warm tones always look good on you\."/);
  // 11/5 eval 5c: enforceable — the last verdict's kind of reason is named and banned, one other reason is handed over
  assert.match(why, /Not allowed this turn, it's the reason you just gave: coloring or tones/);
  assert.match(why, /For the other option use this reason \(data\): "Silver jewelry"/);
  assert.doesNotMatch(why, /Already used this call/, "no second reason list on a why-not");
  // unknown coloring: a why-not never carries the once-per-call coloring question
  const unknown = styleLine({ profile: "", said, askedColoring: false, whyNot: true });
  assert.equal(unknown.asks, false);
  assert.ok(!styleLine({ profile, said, askedColoring: false }).line.includes(WHY_NOT_LINE), "only on a why-not");
  // per call, not just the last 4: a reason from the first verdict is still used up five verdicts later
  const long = ["The navy, silver jewelry pops on it.", "Mm, still navy.", "Navy again.", "Keep the navy.", "Navy, done."];
  assert.doesNotMatch(styleLine({ profile, said: long, askedColoring: false }).line, /like one of these \(data\): [^\n]*Silver jewelry/);
  // every fact used once: rotate, the older reasons come back (only the last verdict's stay out)
  const all = ["The cream, warm tones suit you.", "Silver jewelry pops with it.", "It's minimal, your style.", "Not tight or clingy, the relaxed fit you like."];
  const rot = styleLine({ profile, said: all, askedColoring: false }).line;
  assert.match(rot, /like one of these \(data\): "/, `rotates to an older reason: ${rot}`);
  assert.doesNotMatch(rot, /like one of these \(data\): [^\n]*Dislikes tight/, "the last verdict's reason stays out");
  // a why-not after every kind was used: still never the last verdict's kind (fit), an older one comes back
  const rotWhy = styleLine({ profile, said: all, askedColoring: false, whyNot: true }).line;
  assert.match(rotWhy, /Not allowed this turn, it's the reason you just gave: the fit or cut/);
  assert.match(rotWhy, /use this reason \(data\): "(?!Dislikes tight)[^"]+"/);
});

test("style 11/5 eval 5c: reason kinds, the visible fallback, the pick holds, the offer and the coloring question", () => {
  assert.deepEqual(reasonCategories("Yeah that one is a yes, it drapes loose"), ["fit"]);
  assert.deepEqual(reasonCategories("That navy blazer is sharp but it is cut pretty fitted and you hate that clingy feel"), ["fit"]);
  assert.deepEqual(reasonCategories("Yeah, that cream one is elite and totally made for tonight."), ["occasion"]);
  assert.ok(reasonCategories("The blazer one for tonight, Black is just so you.").includes("taste"));
  assert.ok(reasonCategories("you picked camel over grey last week").includes("past"));
  // the only known fact is the reason just given: what they can see on the other option instead
  const only = styleLine({ profile: "- Taste: Minimal style", said: ["The cream knit, so clean and minimal, your style."], askedColoring: true, whyNot: true }).line;
  assert.match(only, /Not allowed this turn, it's the reason you just gave: their usual style/);
  assert.ok(only.includes(WHY_NOT_VISIBLE), only);
  // the call's first pick holds (cool 2/3 flipped): quoted without its questions and offer
  const later = styleLine({ profile: "- Personal color: cool (winter)", said: ["<happy> The navy blazer one, sharp and fitted. Want me to find silver earrings for it?", "Yeah, the cream suits you too."], askedColoring: false, whyNot: true }).line;
  assert.match(later, /Your pick this call \(data\): "The navy blazer one, sharp and fitted\."\. Keep that pick unless they say they don't like it/);
  assert.doesNotMatch(styleLine({ profile: "", said: [], askedColoring: false }).line, /Your pick this call/, "the first verdict has no pick yet");
  for (const t of ["Want me to find dark brown boots for it?", "<happy> Want me to find black heels for it?", "I can find black heels for it too.", "Should I find silver earrings for it?"]) assert.ok(isOfferOnly(t), t);
  for (const t of ["The cream knit, so clean.", "Do warm or cool tones usually work for you?"]) assert.ok(!isOfferOnly(t), t);
  for (const t of ["Warm or cool tones usually work for you?", "do warm or cool tones usually work for you?", "Quick one, do warm or cool tones usually work for you?", "that pick is pristine, do warm tones usually work for you?"]) assert.ok(asksColoring(t), t);
  assert.ok(!asksColoring("The cream knit, warm tones are so you."));
  assert.ok(asksColoring(COLORING_QUESTION));
  assert.match(STYLE_RETRY_LINE, /pick first, with one personal reason/);
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
