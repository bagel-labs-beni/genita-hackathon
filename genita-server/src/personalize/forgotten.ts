/**
 * "Forget that…" must leave no trace the companion can say back (QA post-deploy 11/3: the next call opened with
 * "you told me to forget the leather accessories thing"). Shared by the profile text (do-not-mention list), the
 * call summaries and long-term memory extraction (src/memory/call.ts) and the handed-off turns (session.ts):
 *   - a forget request turn (and the companion's reply to it) is dropped before anything summarizes or seeds it;
 *   - any line that mentions a removed profile line's content is dropped from what the next call is given.
 */
import { FORGET } from "./corrections.ts";

const STOP = new Set("the and you your with for that this from into like likes love loves about very really user users their them they she her his him its just also".split(" "));
/** content words as 5-letter stems: "Likes leather accessories." → ["leath", "acces"] */
export const keyWords = (s: string): string[] => [...new Set((s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 5)))];

export function isForgetRequest(text: string): boolean {
  return FORGET.test(text.replace(/[’‘]/g, "'"));
}

/** A removed line: from a correction (strict: every content word must appear) or a "forget that …" (loose: any). */
export type Removed = string | { text: string; forget?: boolean };
export type AvoidKey = { keys: string[]; loose: boolean };

const GENERIC = new Set(["thing", "thin", "thing", "stuff", "said", "told", "saying", "about", "whole", "anyth", "somet", "every", "earli", "befor", "again", "pleas", "actua", "okay", "remem", "forge", "mention", "menti"].map((w) => w.slice(0, 5)));

export function avoidKeys(removed: Removed[]): AvoidKey[] {
  return removed
    .map((r) => (typeof r === "string" ? { keys: keyWords(r), loose: false } : { keys: r.forget ? keyWords(r.text).filter((k) => k.length >= 4 && !GENERIC.has(k)) : keyWords(r.text), loose: !!r.forget }))
    .filter((k) => k.keys.length > 0);
}

/** strict: carries every content word of a removed line; loose (a forget request): carries any of its words — two of
 * them when the target has three or more (Codex #547 r10: "need" alone must not take an unrelated laptop question) */
export function mentionsAvoided(text: string, keys: AvoidKey[] | string[][]): boolean {
  if (!keys.length) return false;
  const w = new Set(keyWords(text));
  return (keys as Array<AvoidKey | string[]>).some((k) => (Array.isArray(k) ? k.every((x) => w.has(x)) : k.loose ? k.keys.filter((x) => w.has(x)).length >= (k.keys.length >= 3 ? 2 : 1) : k.keys.every((x) => w.has(x))));
}

/** "Actually, forget that I like leather accessories." → "leather accessories" (what to keep out from now on) */
export function forgetTarget(text: string): string {
  const t = text.replace(/[’‘]/g, "'");
  const m = t.match(/\b(?:forget|(?:don'?t|do not) remember)\b\s*(?:about\s+)?(?:that|this|it|what i said)?\s*(?:about\s+)?(?:i\s+(?:said|told you|mentioned)\s+)?(?:(?:that\s+)?i(?:'m|\s+am)?\s+(?:really\s+)?(?:like|love|liked|loved|into|want(?:ed)?|have|had|said)\s+)?(.*)$/i);
  const rest = (m?.[1] ?? "").replace(/\b(?:the|that|this|my|whole)\b|\bthing\b|[.!?,]/gi, " ").replace(/\s+/g, " ").trim();
  return rest.slice(0, 80);
}

type Pair = { user: string; assistant: string };
/** summarizer / extractor input: no forget requests, nothing about what was removed */
export function scrubPairs<T extends Pair>(turns: T[], keys: AvoidKey[] | string[][]): T[] {
  return turns.filter((t) => !isForgetRequest(t.user) && !mentionsAvoided(t.user, keys) && !mentionsAvoided(t.assistant, keys));
}

type Item = { role: "user" | "assistant"; text: string };
/** handed-off turns: a forget request and the reply to it go, and any turn about the removed content */
export function scrubHistory<T extends Item>(items: T[], keys: AvoidKey[] | string[][]): T[] {
  const out: T[] = [];
  let skipReply = false;
  for (const h of items) {
    if (h.role === "user" && isForgetRequest(h.text)) { skipReply = true; continue; }
    if (h.role === "assistant" && skipReply) { skipReply = false; continue; }
    skipReply = false;
    if (mentionsAvoided(h.text, keys)) continue;
    out.push(h);
  }
  return out;
}
