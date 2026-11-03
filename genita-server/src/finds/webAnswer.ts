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

/** Sites a card never cites: free subdomain hosts, spam TLDs, betting, content farms, SEO aggregators (#413 review 11/3). */
const BLOCKED = /(^|\.)(pp\.ua|pages\.dev|vercel\.app|netlify\.app|web\.app|firebaseapp\.com|github\.io|herokuapp\.com|wixsite\.com|weebly\.com|substack\.com|blogspot\.com|wordpress\.com|medium\.com|quora\.com|pinterest\.com|scribd\.com|slideshare\.net|bet365\.com|draftkings\.com|fanduel\.com|clay\.com|simplywall\.st|ceoinsider\.com)$|\.(xyz|top|click|buzz|icu|loan|win|bid|rest|cfd|sbs)$|(^|[.-])(bet|casino|poker|slots?)[.-]|gamb(?:l|yl)|sportsbook|betting|odds/i;

/** Official and large outlets go first (search order kept within each tier). */
const TRUSTED = /(^|\.)(gov|edu|mil|int|gov\.[a-z]{2}|ac\.[a-z]{2}|go\.[a-z]{2})$|(^|\.)(wikipedia\.org|britannica\.com|reuters\.com|apnews\.com|bbc\.(com|co\.uk)|nytimes\.com|washingtonpost\.com|wsj\.com|bloomberg\.com|ft\.com|cnn\.com|nbcnews\.com|cbsnews\.com|abcnews\.go\.com|npr\.org|theguardian\.com|economist\.com|cnbc\.com|forbes\.com|time\.com|axios\.com|politico\.com|theverge\.com|techcrunch\.com|wired\.com|arstechnica\.com|engadget\.com|espn\.com|nbcsports\.com|si\.com|mlb\.com|nba\.com|nfl\.com|fifa\.com|space\.com|nature\.com|science\.org|who\.int|imdb\.com|variety\.com|hollywoodreporter\.com|billboard\.com|rollingstone\.com|yna\.co\.kr|koreaherald\.com|koreatimes\.co\.kr|kbs\.co\.kr|nhk\.or\.jp)$/i;

/** a site named in the question or the search ("Nintendo" → nintendo.co.jp, "NASA" → nasa.gov): the official page */
function official(domain: string, words: Set<string>): boolean {
  const name = domain.split(".")[0].toLowerCase();
  return name.length >= 3 && words.has(name);
}

/** Up to 3 result pages, one per site: official / large outlets first, blocked sites never. */
export function pickSources(searches: WebSearch[], question = ""): FindCard["sources"] {
  const words = new Set(`${question} ${searches.map((s) => s.query).join(" ")}`.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const seen = new Set<string>();
  const tiers: FindCard["sources"][] = [[], [], []];
  for (const s of searches) {
    for (const url of s.urls) {
      const domain = domainOf(url);
      if (!domain || seen.has(domain) || BLOCKED.test(domain)) continue;
      seen.add(domain);
      const tier = official(domain, words) ? 0 : TRUSTED.test(domain) ? 1 : 2;
      tiers[tier].push({ title: domain, url, domain });
    }
  }
  return tiers.flat().slice(0, MAX_SOURCES);
}

/** "let me check", "I'll look it up", "checking who won… for you", "pulling the latest now": the line before the search */
const NARRATION = [
  // a hold beat or a bare reaction is not a point ("Ooh, okay.", "Got it.", "Mm.")
  /^\W*(?:ooh|oh|mm|mm-hm|hmm|yeah|yes|okay|ok|so|got it|sure|you got it|right)(?:[,\s]+(?:okay|so|then))?\W*$/i,
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
  const sources = pickSources(o.searches, o.question);
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
