/**
 * Chelsea 11/3: an answer the companion looked up on the web ("who is that", news, a fact)
 * also lands in the Finds sheet with its sources — speech first, sheet after. No extra
 * Spark call: the card is the spoken answer plus the result pages of the search the reply
 * itself ran (web_search_call sources). Kind "answer": an app that does not know it shows
 * it with the link layout (`.unknown`: takeaways + Sources), so no app build is needed.
 */
import type { FindCard } from "../protocol.ts";
import { domainOf } from "./parse.ts";

export type WebSearch = { query: string; urls: string[] };

const MAX_SOURCES = 3;
const MAX_POINTS = 3;

/** Up to 3 result pages, one per site, in search order. */
export function pickSources(searches: WebSearch[]): FindCard["sources"] {
  const seen = new Set<string>();
  const out: FindCard["sources"] = [];
  for (const s of searches) {
    for (const url of s.urls) {
      const domain = domainOf(url);
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      out.push({ title: domain, url, domain });
      if (out.length >= MAX_SOURCES) return out;
    }
  }
  return out;
}

/** "let me check", "I'll look it up", "checking who won… for you", "pulling the latest now": the line before the search */
const NARRATION = [
  /^\W*(got it|okay|ok|sure|hold on|one sec|give me a sec)\W*$/i,
  /\b(let me|i'?ll|i will|i'm|i am|gonna|going to)\b[^.!?]*\b(check|look|search|pull|find|dig)/i,
  /\b(checking|pulling up|pulling the latest|looking (?:it|that|this) up|searching|digging)\b[^.!?]*\b(now|for you|real quick|quick|the latest)\b/i,
];

/** The spoken answer as up to 3 points, without the "let me check" line before the search. */
export function answerPoints(said: string): string[] {
  const sentences = said
    .replace(/\s+/g, " ")
    // two output messages arrive back to back ("…right now.Hey, it's…"); "U.S. Army" stays whole
    .split(/(?<=[a-z0-9)"'”’%][.!?])\s+(?=[A-Z0-9"“'])|(?<=[a-z0-9)][.!?])(?=[A-Z][a-z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
  const points = sentences.filter((s) => !NARRATION.some((re) => re.test(s)));
  return (points.length ? points : sentences).slice(0, MAX_POINTS).map((s) => (s.length > 160 ? `${s.slice(0, 157).trimEnd()}…` : s));
}

/** "current CEO of Nintendo 2026" → "Current CEO of Nintendo 2026" (≤ 60 chars). */
export function answerTitle(query: string, question: string): string {
  const base = (query || question).replace(/\s+/g, " ").trim().replace(/[?.!]+$/, "");
  const t = base.length > 60 ? `${base.slice(0, 57).trimEnd()}…` : base;
  return t ? t[0].toUpperCase() + t.slice(1) : "From the web";
}

/** The card, or null when the search returned no usable page or nothing was said. */
export function webAnswerCard(o: { id: string; question: string; said: string; searches: WebSearch[]; now?: Date }): FindCard | null {
  const sources = pickSources(o.searches);
  const points = answerPoints(o.said);
  if (!sources.length || !points.length) return null;
  const query = o.searches.find((s) => s.query)?.query ?? "";
  const n = sources.length;
  return {
    id: o.id,
    kind: "answer",
    createdAt: (o.now ?? new Date()).toISOString(),
    eyebrow: "From the web",
    title: answerTitle(query, o.question),
    subtitle: `Web search · ${n} source${n > 1 ? "s" : ""}`,
    status: `${n} source${n > 1 ? "s" : ""}`,
    items: [],
    steps: points.map((text) => ({ text })),
    options: [],
    why: [],
    ask: [],
    sources,
    how: [
      query ? `Searched the web for “${query}”.` : "Searched the web.",
      "Sources are the pages that search returned. Open them to check the details.",
    ],
  };
}
