/**
 * First calls fill the unknowns: each of the first 3 calls asks about ONE
 * still-to-confirm item (or an empty I04 row), naturally, within the first few
 * turns, never as a form. The answer is stored by the post-call extraction
 * (extract.ts, `answered`) as an explicit line, and the item leaves the list.
 */
import type { StyleCard } from "../prep/importProfile.ts";
import { openItems } from "./story.ts";

export const ASK_CALLS = 3;
/** the ask line rides along for the first user turns of the call */
export const ASK_TURNS = 3;

/** Counts the call and picks the item to ask (null after 3 calls or when nothing is open). Pure. */
export function beginCall(card: StyleCard, at: string): { card: StyleCard; ask: string | null } {
  const growth = { calls: card.growth?.calls ?? 0, asked: [...(card.growth?.asked ?? [])] };
  growth.calls += 1;
  let ask: string | null = null;
  if (growth.calls <= ASK_CALLS) {
    const askedBefore = new Set(growth.asked.map((a) => a.item.toLowerCase()));
    ask = openItems(card).find((t) => !askedBefore.has(t.toLowerCase())) ?? null;
    if (ask) growth.asked.push({ item: ask, at });
  }
  return { card: { ...card, growth }, ask };
}

/** One instruction line for the realtime prompt (kept short: every rule costs first-token time). */
export function askLine(item: string): string {
  const topic = item.replace(/[<>\n]/g, " ").slice(0, 80);
  return `Within your first few replies, when it fits, ask one casual question to learn about: ${topic}. Just one, woven into the conversation, never a form or a list; if they already told you, don't ask.`;
}
