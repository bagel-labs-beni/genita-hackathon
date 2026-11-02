/**
 * First calls fill the unknowns: each of the first 3 calls asks about ONE open
 * topic (HISY-6 / S4: a still-to-confirm item, an empty I04 row or a missing
 * card), naturally, within the first few turns, never as a form. When the reply
 * asks it, the app shows GK-1 "Getting to know you · {topic}"; the answer is
 * saved as an explicit line (in the call: "Noted: …" chip; or by the post-call
 * extraction) and the topic leaves the list.
 */
import type { StyleCard } from "../prep/importProfile.ts";
import { openUnknowns, type UnknownItem } from "./story.ts";

export const ASK_CALLS = 3;
/** the ask line rides along for the first user turns of the call */
export const ASK_TURNS = 3;

/** Counts the call and picks the topic to ask (null after 3 calls or when nothing is open). Pure. */
export function beginCall(card: StyleCard, at: string): { card: StyleCard; ask: UnknownItem | null } {
  const growth = { calls: card.growth?.calls ?? 0, asked: [...(card.growth?.asked ?? [])] };
  growth.calls += 1;
  let ask: UnknownItem | null = null;
  if (growth.calls <= ASK_CALLS) {
    const askedBefore = new Set(growth.asked.map((a) => a.item.toLowerCase()));
    ask = openUnknowns(card).find((u) => !askedBefore.has(u.item.toLowerCase())) ?? null;
    if (ask) growth.asked.push({ item: ask.item, at });
  }
  return { card: { ...card, growth }, ask };
}

/** One instruction line for the realtime prompt (kept short: every rule costs first-token time). */
export function askLine(u: UnknownItem): string {
  const topic = `${u.topic}${u.sub ? ` (${u.sub})` : ""}`.replace(/[<>\n]/g, " ").slice(0, 120);
  return `Within your first few replies, when it fits, ask one casual question to learn about: ${topic}. Just one, woven into the conversation, never a form or a list; if they already told you, don't ask.`;
}

const STOP = new Set("the and you your how what with for are like should calls things".split(" "));
const words = (s: string) => (s.toLowerCase().match(/[\p{L}]{4,}/gu) ?? []).filter((w) => !STOP.has(w));

/** Did this reply ask the planned question? A question that shares a word with the topic. */
export function replyAsks(reply: string, u: UnknownItem): boolean {
  const questions = reply.split(/(?<=[.!?])\s+/).filter((q) => q.trim().endsWith("?"));
  if (!questions.length) return false;
  const keys = new Set(words(`${u.topic} ${u.sub} ${u.item}`).map((w) => w.slice(0, 5)));
  return questions.some((q) => words(q).some((w) => keys.has(w.slice(0, 5))));
}
