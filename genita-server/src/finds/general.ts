/**
 * Chelsea 11/4 (21:00 demo): "whatever I ask → search, and show the result as a sheet".
 *
 * classifyTurn's fallback: a turn no card kind took (recipe, outfit, product, link) that is an information
 * question ("who won…", "best ramen in Seoul", "look up…", "오늘 뉴스 찾아봐") runs one Spark web search and its
 * results land in the Finds sheet as an "answer" card: the results as takeaways, each page as a tappable source.
 * Kind "answer" is already on the wire (webAnswer.ts); apps that predate it decode it as `.unknown` and show the
 * link layout (takeaways + Sources), so no app build is needed. Chit-chat, feelings, things in view ("is this one
 * better?") and crisis lines never search. Spoken: a short reaction now, "Here's what I found." when the card
 * lands; the results are never read aloud. GENITA_WEB_SEARCH=0 (the companion's web search switch) turns it off.
 */
import type { FindCard } from "../protocol.ts";
import { realCrisisSignal } from "../convo/guard.ts";
import { domainOf, lastJsonObject, str, strList } from "./parse.ts";
import type { PipelineCtx, PipelineResult } from "./pipeline.ts";
import { userMessage, type OutputItem } from "./vendors.ts";
import { answerTitle, isBlockedSite } from "./webAnswer.ts";

/** said instead of a full answer while the search runs (no "let me look that up": tool narration is never said) */
export const GENERAL_ACK = "Ooh, good question.";
/** said when the card lands */
export const GENERAL_SAY = "Here's what I found.";
export const GENERAL_MAX_RESULTS = 5;
export const GENERAL_TIMEOUT_MS = 25_000;

// ───────── which turns search ─────────

/** "hey Jin," / "so," / "Jin," before the ask */
const LEAD_IN = /^(?:(?:hey|hi|hello|ok(?:ay)?|so|um+|uh+|oh|yo|alright|well)\b[,!\s]+)+(?:[a-z]+,\s*)?|^[a-z]+,\s+/;
/** the polite wrapper around the real question: "can you tell me…", "do you know…", "look up…" */
const PREAMBLE =
  /^(?:(?:can|could|would|will) you (?:please )?(?:tell me|let me know|check|find out|look up|search(?: for)?|google)?|do you (?:happen to )?know|(?:please )?tell me|i (?:wonder|want to know|wanna know|'d like to know)|any idea|please|quick question[,:]?)\s*/;
/** an explicit ask to search */
const SEARCH_VERB =
  /\b(?:look (?:up|it up|that up)|search (?:for|the web|online|up)|google (?:it|that|for|what|who|where|when|how|which)|find out|check online|check the web)\b|^(?:search|google)\s+(?:for|up|the|what|who|where|when|how|which|it|that)\b|^look up\b|\b(?:can|could|would|will) you (?:please )?(?:search|google)\b|\bplease (?:search|google)\b/;
/** "don't search", "no need to look it up": a no, not an ask (Codex r1) */
const NO_SEARCH = /\b(?:don'?t|do not|no need to|never|stop|without)\s+(?:\w+\s+)?(?:search\w*|googl\w*|look\w* (?:\w+ )?up)\b|검색\s*(?:하지\s*마|말고)/;
const SEARCH_KO = /검색|찾아\s*봐|찾아\s*줄래|찾아\s*줘|알아\s*봐|알아\s*줘/;
/** words that mean "the web knows this" */
const TOPIC =
  /\b(?:news|latest|headlines?|price|prices|cost|costs|how much|weather|forecast|rain|snow|temperature|score|scores|who won|reviews?|ratings?|best|top \d+|recommend\w*|suggest\w*|near me|open(?:ing)? (?:now|hours)|hours|schedule|release date|showtimes?|population|capital of|tickets?)\b/;
const TOPIC_KO = /뉴스|가격|얼마|날씨|추천|맛집|최신|제일|가장|순위|후기/;
const WH = /^(?:who|who's|what|what's|whats|where|where's|when|when's|which|how)\b/;
/** a short fact question: "who invented penicillin?", "what is photosynthesis?", "where is Seoul?" (Codex r1) */
const SHORT_FACT = /^(?:who|what|where|when) (?:invented|discovered|wrote|founded|painted|directed|created|owns|is|was|are|were) ([a-z][a-z.-]{3,})\s*[?.!]*$/;
/** the last word of a 3-word question that needs the conversation, not the web ("what is next?") */
const CONTEXT_WORD = /^(?:next|now|then|there|here|else|again|today|tonight|dinner|lunch|breakfast|wrong|happening|happened|going|time|deal|point|idea|problem|matter|plan|wrong|first|last|better|best)$/;
const WH_KO = /누구|누가|어디|언제|어떻게|얼마/;
/** a recommendation asked as an order: "recommend a good book", "suggest a podcast" */
const IMPERATIVE = /^(?:recommend|suggest|list|name|give me|show me)\b/;

/** the user or the companion is the subject: chit-chat, not a lookup */
const YOU = /\b(?:you|your|yours|yourself|you're|youre|ur)\b|\bu\b(?!\.)/;
const SELF = /\b(?:i|i'm|im|i've|i'd|i'll|me|my|mine|myself|we|we're|us|our)\b/;
/** "for me" / "show me" / "near me" keep a lookup a lookup */
const BENIGN_ME = /\b(?:for|recommend|suggest|show|tell|give|get|find|send|near) me\b/g;
/** "how do I make kimchi", "where can I get…": a how-to, the web helps */
const HOWTO = /^(?:how (?:do|can|should|would) (?:i|we)\b|how to\b|where (?:can|do|should) (?:i|we)\b)|\bhow to\b/;
const SELF_STATE = /\bhow (?:do|did) (?:i|we) (?:look|seem|sound|do)\b|\bhow am i\b/;
const FEELING = /\b(?:feel|feeling|felt|sad|lonely|bored|tired|stressed|anxious|upset|angry|happy|love|miss|hate|worried|scared)\b/;
const SMALL_TALK = /^(?:how about|what about|what if|how come|thanks|thank you|ok|okay|cool|nice|great|wow|lol|haha|yes|no|yeah|nope|sure|bye|good (?:morning|night)|what'?s up|what'?s new|what'?s going on|how'?s it going|what are you (?:up to|doing))\b/;
const PERSONAL_KO = /(?:^|\s)(?:너|넌|너는|니가|네가|너도|당신|나|난|나는|내가|내|제가|저는|저도|우리)(?:\s|$)|기분|사랑|보고\s*싶|심심|외로|우울|힘들|피곤|지내|안녕|고마워|괜찮아/;

/** about something already in the conversation or on screen ("how long does it take?", "how old is he?"): the companion answers */
const PRONOUN = /\b(?:it|its|it's|they|them|their|they're|he|him|his|he's|she|her|she's)\b/;
/** "how much does it cost to visit the Louvre": a dummy "it" with its subject right after (Codex r1) */
const DUMMY_IT = /\b(?:does|did|will|would|is|was) it (?:take|cost|mean|get)\b[^?]*\bto \w+/;
/** "look it up" / "google that": the thing to search is in the conversation, not in the line */
const LOOK_IT_UP = /\b(?:look (?:it|that|them) up|google (?:it|that)|search (?:it|that))\b/;
/** what's in view, not something to search: "is this one better?", "which of these", "what is it?", "이거 뭐야" */
const DEICTIC = [
  /\b(?:these|those)\b/,
  /^which (?:one|ones)\b/,
  /\b(?:the|a) (?:\w+ )?one\b(?! (?:of|in|on|to|at|who|that|which)\b)/,
  /\b(?:this|that)(?:\s+ones?)?(?=\s*(?:[?.!,]|$)|\s+(?:one|ones|look|looks|better|worse|good|go|goes|with|on|for|or|and|thing|a|an|the|so|too|really|right|true|okay|ok|fine|all|it)\b)/,
  /\b(?:is|was|about|with|of)\s+(?:it|them)\s*[?.!]*$/,
  /^(?:what|who)(?:'s| is| are| was)\s+(?:it|they|he|she)\b/,
];
/** Korean asks: a question ending, "추천", "알려줘" ("서울 날씨 좋다" is a remark, Codex r1) */
const KO_ASK = /[?？]\s*$|(?:야|니|나|까|지|요|래|줘|봐|어때)\s*[?？.!]*$|추천|알려\s*줘/;
const DEICTIC_KO = /이거|이게|이건|저거|저게|저건|그거|그게|그건|이것|저것|이\s*중/;

function words(t: string): number {
  return t.split(/\s+/).filter(Boolean).length;
}

/** The question without "hey Jin," and "can you tell me", lowercased, straight quotes. */
export function coreQuestion(text: string): string {
  let t = text.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  t = t.replace(LEAD_IN, "");
  for (let i = 0; i < 3; i++) {
    const next = t.replace(PREAMBLE, "");
    if (next === t) break;
    t = next;
  }
  return t.trim();
}

/** An information question the web answers better than a chat reply. */
export function isGeneralAsk(text: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.GENITA_WEB_SEARCH === "0") return false;
  if (!text.trim() || text.length > 400 || realCrisisSignal(text)) return false;
  // "the US" / "U.S." is a country, not "us" (lowercased below)
  const country = text.replace(/\bU\.?S\.?(?:A\b\.?)?(?![a-z])/g, "USA");
  const full = country.replace(/[‘’ʼ]/g, "'").toLowerCase();
  const t = coreQuestion(country);
  if (NO_SEARCH.test(full)) return false;
  const searchVerb = SEARCH_VERB.test(full) || SEARCH_KO.test(full);
  if (SMALL_TALK.test(t) && !searchVerb) return false;
  if (DEICTIC.some((re) => re.test(t)) || DEICTIC_KO.test(t)) return false;
  // a pronoun points back into the conversation, unless it's a dummy "it" or a spelled-out search ("look up how much it costs…")
  const pronounFree = DUMMY_IT.test(t) ? t.replace(/\bit\b/, "") : t;
  if (PRONOUN.test(pronounFree) && !(searchVerb && !LOOK_IT_UP.test(full) && words(t) >= 5)) return false;
  if (FEELING.test(t) && !searchVerb) return false;
  if (YOU.test(t) && !searchVerb) return false;
  if (SELF_STATE.test(t)) return false;
  if (SELF.test(t.replace(BENIGN_ME, "")) && !HOWTO.test(t) && !searchVerb) return false;
  if (PERSONAL_KO.test(t) && !searchVerb) return false;
  const n = words(t);
  if (searchVerb) return n >= 2;
  const question = /\?\s*$/.test(t) || WH.test(t) || IMPERATIVE.test(t);
  if (TOPIC.test(t) && question && n >= 3) return true;
  if (WH.test(t) && n >= 4) return true;
  const fact = t.match(SHORT_FACT);
  if (fact && !CONTEXT_WORD.test(fact[1].replace(/[.-]+$/, ""))) return true;
  if (TOPIC_KO.test(t) && n >= 2 && KO_ASK.test(t)) return true;
  if (WH_KO.test(t) && n >= 3 && KO_ASK.test(t)) return true;
  return false;
}

/** classifyTurn's last step: a web search card, or a spoken answer only. */
export function generalIntent(text: string): { kind: "answer" } | null {
  return isGeneralAsk(text) ? { kind: "answer" } : null;
}

// ───────── the search ─────────

type GeneralJson = { title?: unknown; results?: Array<{ title?: unknown; why?: unknown; url?: unknown }>; ask?: unknown };
type Result = { title: string; why: string; url: string; domain: string };

/** every page the search really returned or opened (never a URL the model only wrote) */
export function tracedUrls(output: OutputItem[]): string[] {
  const out: string[] = [];
  for (const o of output) {
    if (o.type !== "web_search_call" || o.status === "failed") continue;
    const a = o.action as { url?: string; sources?: Array<{ url?: string }> } | undefined;
    if (a?.url) out.push(a.url);
    for (const s of a?.sources ?? []) if (s.url) out.push(s.url);
  }
  return out.filter((u) => /^https?:\/\//i.test(u));
}

/** the same page: scheme, www., query, hash and a trailing slash don't matter */
const norm = (u: string) => u.replace(/#.*$/, "").replace(/\?.*$/, "").replace(/\/+$/, "").replace(/^https?:\/\/(?:www\.)?/i, "").toLowerCase();

/** The model's results that are pages of the trace (a summary never goes on another page of the same site); one per site. */
export function pickResults(j: GeneralJson | null, traced: string[]): Result[] {
  const byUrl = new Map(traced.map((u) => [norm(u), u]));
  const seen = new Set<string>();
  const out: Result[] = [];
  const add = (title: string, why: string, url: string) => {
    const domain = domainOf(url);
    if (!domain || seen.has(domain) || isBlockedSite(domain) || out.length >= GENERAL_MAX_RESULTS) return;
    seen.add(domain);
    out.push({ title: title || domain, why, url, domain });
  };
  for (const r of Array.isArray(j?.results) ? j.results : []) {
    const url = str(r?.url, 600);
    if (!url) continue;
    const page = byUrl.get(norm(url));
    if (page) add(str(r?.title, 100), str(r?.why, 160), page);
  }
  // nothing usable from the model: the search's own pages
  if (!out.length) for (const u of traced) add("", "", u);
  return out;
}


function prompt(question: string, timeZone?: string): string {
  return [
    "Search the web for what the user asked and pick the best pages your search returned.",
    `The user asked: "${question.slice(0, 300)}"`,
    ...(timeZone ? [`Their time zone: ${timeZone}.`] : []),
    `Reply with only JSON: {"title": "what this is about, under 8 words", "results": [up to ${GENERAL_MAX_RESULTS} pages, best first: {"title": "the page or place name, under 10 words", "why": "what it says or why it fits, one line under 18 words", "url": "the exact page URL from your search"}], "ask": [2 short follow-up questions, under 5 words]}`,
    "Use only pages your search returned. Never invent a URL. Official sites and large outlets first.",
  ].join("\n");
}

export async function runGeneral(ctx: PipelineCtx): Promise<PipelineResult> {
  const t0 = ctx.now();
  const timings: Record<string, number> = {};
  ctx.emit({ type: "find.started", findId: ctx.findId, utteranceId: ctx.utteranceId, kind: "answer", title: "Looking it up", detail: "Searching the web" });
  let j: GeneralJson | null = null;
  let traced: string[] = [];
  try {
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(GENERAL_TIMEOUT_MS)]);
    const res = await ctx.vendors.spark({ input: userMessage(prompt(ctx.question, ctx.timeZone)), tools: [{ type: "web_search" }], effort: "minimal", maxOutputTokens: 1400 }, signal);
    j = lastJsonObject<GeneralJson>(res.text);
    traced = tracedUrls(res.output);
  } catch (err) {
    if (ctx.signal.aborted) return { card: null, timings };
    ctx.log("find.general_error", { findId: ctx.findId, message: String(err).slice(0, 160) });
  }
  if (ctx.signal.aborted) return { card: null, timings };
  timings.cardJsonMs = Math.round(ctx.now() - t0);
  const results = pickResults(j, traced);
  if (!results.length) {
    ctx.emit({ type: "find.failed", findId: ctx.findId, reason: "search_failed", message: "I couldn't find anything solid on that. Ask me another way?" });
    return { card: null, timings };
  }
  const n = results.length;
  const query = coreQuestion(ctx.question);
  const card: FindCard = {
    id: ctx.findId,
    kind: "answer",
    createdAt: new Date().toISOString(),
    eyebrow: "From the web",
    title: str(j?.title, 80) || answerTitle("", ctx.question),
    subtitle: `Web search · ${n} result${n > 1 ? "s" : ""}`,
    status: `${n} result${n > 1 ? "s" : ""}`,
    say: GENERAL_SAY,
    items: [],
    steps: results.map((r) => ({ text: r.why ? `${r.title} — ${r.why}` : r.title, source: r.url })),
    options: [],
    why: [],
    ask: strList(j?.ask, 2, 40),
    sources: results.map((r) => ({ title: r.title, url: r.url, domain: r.domain })),
    // never taste chips on a looked-up fact
    reasons: [],
    how: [
      query ? `Searched the web for “${query.replace(/[?.!]+$/, "")}”.` : "Searched the web.",
      "Each result is a page that search returned. Open it to check the details.",
    ],
  };
  ctx.emit({ type: "find.created", findId: ctx.findId, card });
  timings.cardMs = Math.round(ctx.now() - t0);
  ctx.log("find.general", { findId: ctx.findId, results: n, traced: traced.length });
  return { card, timings };
}
