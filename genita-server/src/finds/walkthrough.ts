import type { FindCard } from "../protocol.ts";

/**
 * P0 11/4 (Chelsea): "Walk me through it" on a recipe card starts guided cooking. The companion says one step at a
 * time, briefly, and checks one ingredient ("Do you have eggs?"); "next" / "done" / "okay" moves on. The shipped app
 * (build 13) sends the CTA as a plain text turn with the card's findId, so this is all server-side: one line for the
 * system prompt per turn, and the Finds runner starts no search for these turns.
 */

/** The recipe CTA's words (FindsSheet.cta) and the same ask said out loud. */
const WALK_ASK = /^(?:ok(?:ay)?,?\s+|so,?\s+|can you\s+|could you\s+|please\s+)?(?:walk me through(?: it| this| the (?:recipe|steps))?|let'?s (?:cook|make) (?:it|this|that)(?: together)?|cook (?:it |this )?with me|(?:take me|go) through the steps|start cooking|step by step)\b[^?]{0,20}[.!?]?$/i;
/** Moving on: short lines only, so "okay but what about the onion?" is a question, not "next". */
const NEXT = /^(?:next(?: step| one)?|done|i'?m done|finished|okay|ok|got it|yes|yep|yeah|ready|what'?s next|and then\??|then what\??|did it|all set)[.!?]*$/i;
const STOP = /^(?:stop|that'?s enough|never ?mind|let'?s stop|we'?re done|i'?m finished cooking)[.!]*$/i;

export function isWalkAsk(text: string): boolean { return WALK_ASK.test(text.trim()); }
export function isNextStep(text: string): boolean { return NEXT.test(text.trim().replace(/\s+/g, " ")); }
export function isStopWalk(text: string): boolean { return STOP.test(text.trim()); }

export type WalkState = { findId: string; step: number };
export type WalkPlan = { state: WalkState | null; line: string; quiet: boolean } | null;

/**
 * Pure: what this turn means for guided cooking. `state` is what to keep after the turn (null = walkthrough over),
 * `line` goes into the prompt, `quiet` = the Finds runner starts nothing for this turn. null = not a walkthrough turn.
 */
export function walkPlan(text: string, cur: WalkState | null, card: FindCard | undefined, cardId: string | null): WalkPlan {
  const t = text.trim();
  if (cardId && card && card.kind === "recipe" && card.steps.length && isWalkAsk(t)) {
    return { state: { findId: cardId, step: 0 }, line: stepLine(card, 0, true), quiet: true };
  }
  if (!cur || !card || cardId !== cur.findId) return null;
  if (isStopWalk(t)) return { state: null, line: "They stopped the guided cooking: say okay in a few words, no more steps.", quiet: true };
  if (isNextStep(t)) {
    const next = cur.step + 1;
    if (next >= card.steps.length) return { state: null, line: `Guided cooking: that was the last step of "${card.title}". Tell them it's done in one short, warm sentence (enjoy it). No recap of the steps.`, quiet: true };
    return { state: { findId: cur.findId, step: next }, line: stepLine(card, next, false), quiet: true };
  }
  // a question in between ("how hot should the pan be?"): answer it about the current step, stay on it
  return { state: cur, line: `Guided cooking of "${card.title}", on step ${cur.step + 1} of ${card.steps.length}: ${clean(card.steps[cur.step].text)}. Answer their question about it briefly, then say "next" moves on. Do not read other steps.`, quiet: false };
}

function stepLine(card: FindCard, i: number, first: boolean): string {
  const n = card.steps.length;
  const notSeen = card.items.filter((x) => x.tier === "buy" || x.tier === "maybe").map((x) => x.name);
  const all = card.items.map((x) => x.name);
  const check = notSeen.length ? `prefer one you have not seen on camera (${notSeen.slice(0, 6).join(", ")})` : all.length ? `from this recipe (${all.slice(0, 6).join(", ")})` : "that this step needs";
  return [
    `Guided cooking${first ? ` of "${card.title}" starts now` : ""}: step ${i + 1} of ${n}: ${clean(card.steps[i].text)}.`,
    `Say only this step, in your own words, in one or two short sentences.${first ? " Do not list the other steps." : ""}`,
    i === n - 1 ? "It is the last step: no ingredient question, end with one short line." : `Then ask exactly one ingredient-check question about one ingredient this or the next step needs, like "Do you have eggs?" — ${check}. Tell them to say "next" when they're ready.`,
  ].join(" ");
}

/** a step is "text — source" on some cards: the source name is not spoken */
function clean(s: string): string { return s.replace(/\s+—\s+.*$/, "").slice(0, 300); }
