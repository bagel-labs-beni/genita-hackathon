/**
 * Chelsea 11/4 (21:00 demo): "whatever I ask → search, and show the result as a sheet".
 *
 * classifyTurn's fallback: a turn no card kind took (recipe, outfit, product, link) that is an information
 * question ("who won…", "best ramen in Seoul", "look up…", "오늘 뉴스 찾아봐") runs one Spark web search and its
 * results land in the Finds sheet as an "answer" card: the results as takeaways, each page as a tappable source.
 * Kind "answer" is already on the wire (webAnswer.ts); apps that predate it decode it as `.unknown` and show the
 * link layout (takeaways + Sources), so no app build is needed. Chit-chat, feelings, things in view ("is this one
 * better?") and crisis lines never search. GENITA_WEB_SEARCH=0 (the companion's web search switch) turns it off.
 *
 * Spoken (Chelsea 11/4 "섞어"): the turn answers at once in ONE sentence from what the companion already knows (a
 * natural hedge when it doesn't), with no search of its own, while the sheet fills; "I put a few links up for you."
 * when the card lands (after that sentence). The results are never read aloud.
 */
import type { FindCard, FindImage } from "../protocol.ts";
import type { SparkStreamEvent } from "../meta/spark.ts";
import { SentenceSplitter } from "../text/sentences.ts";
import { parseTaggedSentence } from "../text/tags.ts";
import { isInterjectionOnly, isProcessLine, isToolNarration } from "../text/toolNarration.ts";
import { realCrisisSignal } from "../convo/guard.ts";
import { domainOf, lastJsonObject, str, strList } from "./parse.ts";
import type { PipelineCtx, PipelineResult } from "./pipeline.ts";
import { userMessage, type OutputItem } from "./vendors.ts";
import { answerTitle, isBlockedSite } from "./webAnswer.ts";

/** said when the card lands (after the one-sentence answer) */
export const GENERAL_SAY = "I put a few links up for you.";
/** the one sentence when the model has none the voice would say (P0 11/4: never "Sorry, I lost you" on a search turn) */
export const GENERAL_HEDGE = "Not sure off the top of my head, pulling up a few sources.";
/** rides the turn's reply instructions (session.ts) when the sheet is searching */
export const GENERAL_REPLY_LINE =
  "Web results for this question are about to appear on their screen. Answer right now in ONE short sentence (under 20 words) from what you already know. No links, no site names, no lists, and don't say you're searching or looking it up. Give your real answer, like a name, a fact or your pick (prompt-100, prod 23:30: \"Best ramen places in Seoul\" got only a hedge). Only for live facts you can't know (today's news, scores, prices, open hours) make it a natural hedge, like \"Not sure off the top of my head, pulling up a few sources.\"";
export const GENERAL_MAX_RESULTS = 5;
export const GENERAL_TIMEOUT_MS = 25_000;
/** r01: each result's og:image read (and its bytes) is cut off after this; a slow page never holds the sheet */
export const GENERAL_IMAGE_MS = 1500;
/** r01: the searching sheet's title when the question has nothing to show */
export const GENERAL_TITLE_FALLBACK = "Looking it up";

// ───────── which turns search ─────────

/** "hey Jin," / "so," / "Jin," before the ask */
const LEAD_IN = /^(?:(?:hey|hi|hello|ok(?:ay)?|so|um+|uh+|oh|yo|alright|well)\b[,!\s]+)+(?:[a-z]+,\s*)?|^[a-z]+,\s+/;
/** LEAD_IN on the original casing ("Hey Jin, Who…" keeps "Who" capitalised for NAMED) */
const LEAD_IN_ORIG = /^(?:(?:hey|hi|hello|ok(?:ay)?|so|um+|uh+|oh|yo|alright|well)\b[,!\s]+)+(?:[A-Za-z]+,\s*)?|^[A-Za-z]+,\s+/i;
/** the polite wrapper around the real question: "can you tell me…", "do you know…", "look up…" */
const PREAMBLE =
  /^(?:(?:can|could|would|will) you (?:please )?(?:tell me|let me know|check|find out|look up|search(?: for)?|google)?|do you (?:happen to )?know|(?:please )?tell me|i (?:wonder|want to know|wanna know|'d like to know)|any idea|please|quick question[,:]?)\s*/;
/** an explicit ask to search */
const SEARCH_VERB =
  /\b(?:look (?:up|it up|that up)|search (?:for|the web|online|up)|google (?:it|that|for|what|who|where|when|how|which)|find out|check online|check the web)\b|^(?:search|google)\s+(?!(?:is|was|are|has|had|makes|made|knows|'s|results?|engines?|bar|history|it|that)\b)\S|^look up\b|\b(?:can|could|would|will) you (?:please )?(?:search|google)\b|\bplease (?:search|google)\b/;
/** "don't search", "no need to look it up": a no, not an ask (Codex r1) */
const NO_SEARCH = /\b(?:don'?t|do not|no need to|never|stop|without)\s+(?:\w+\s+)?(?:search\w*|googl\w*|look\w* (?:\w+ )?up)\b|검색\s*(?:하지\s*마|말고)/;
const SEARCH_KO = /검색|찾아\s*봐|찾아\s*줄래|찾아\s*줘|알아\s*봐|알아\s*줘/;
/** words that mean "the web knows this" */
/** P0 11/4 (device test: "recommend black or white for me" opened a design-colour sheet): only external, look-up-able
 * facts search. These words are facts on their own */
const TOPIC =
  /\b(?:news|latest|headlines?|price|prices|cost|costs|how much|weather|forecast|rain|snow|temperature|score|scores|who won|open(?:ing)? (?:now|hours)|hours|schedule|release date|showtimes?|population|capital of|tickets?|near me|nearby)\b/;
/** these only with an external category or a place ("best KBBQ in Suwon", "recommend a dinner place near Gangnam") */
const REC = /\b(?:recommend\w*|suggest\w*|best|top \d+|good|great|reviews?|ratings?|popular|famous)\b/;
const EXTERNAL =
  /\b(?:restaurants?|places?|spots?|caf[eé]s?|coffee shops?|bars?|pubs?|bakery|bakeries|shops?|stores?|malls?|markets?|hotels?|hostels?|museums?|galleries|parks?|beaches?|hikes?|trails?|movies?|films?|shows?|series|dramas?|books?|novels?|podcasts?|songs?|albums?|artists?|games?|apps?|phones?|laptops?|tablets?|cameras?|headphones?|earbuds|tvs?|cars?|brands?|products?|kbbq|bbq|barbecue|ramen|sushi|pizza|burgers?|tacos?|galbi|noodles?|pho|brunch|steak(?:house)?s?|dim sum)\b/;
/** a place named after "in / near / around" (checked on the original text: "in Suwon", "near Gangnam") or a known one */
// known places by name only: "in daylight" / "at home" are not places (Codex r1); "in Suwon" is CAPITAL_PLACE on the original
const LOCATION = /\b(?:seoul|suwon|gangnam|hongdae|itaewon|busan|incheon|jeju|tokyo|osaka|new york|nyc|london|paris|san francisco)\b/i;
/** a fact about a role of a thing, any casing ("who is the ceo of nintendo?") */
const ROLE_Q = /^(?:who|what)(?:'s| is| was| are| were)? (?:the )?(?:ceo|president|founder|owner|capital|population|prime minister|mayor|leader|director|author|singer|members?|head|chairman) of \w+/;
/** "where is the eiffel tower" / "who is taylor swift" / "what is the louvre": a thing, not the conversation */
// a name of 2+ words ("the eiffel tower", "taylor swift"): "what's good?" / "what's the vibe?" are chat (Codex r3)
const THING_Q = /^(?:where|who|what|when)(?:'s| is| was| are| were) (?:the |a |an )?([a-z][\w'-]+(?: [a-z][\w'-]+){1,3})\s*[?.!]*$/;
const CHAT_WORD = /^(?:vibe|deal|story|thing|things|tea|plan|step|move|idea|point|problem|matter|news|next|last|first|up|new|going|happening|wrong|good|best|better)$/;
/** "에펠탑은 어디에 있어?": a named thing before 어디 (not "어디까지 얘기했지?" / "행복은 어디서 오는 걸까?", Codex r3) */
const WHERE_THING_KO = /[가-힣A-Za-z]{2,}(?:은|는|이|가)\s*어디(?:에|야|있)/;
const ROLE_KO = /CEO|ceo|대표|사장|회장|대통령|수도|인구|창업자|감독|작가|가수/;
const CAPITAL_PLACE = /\b(?:in|near|around)\s+(?:the\s+)?[A-Z][\w'-]+/;
/** a named real-world thing: a capitalised word that doesn't start the sentence (Nintendo, Eiffel Tower, World Series) */
const NAMED = /(?:^|[^.!?]\s)[A-Za-z][\w'-]*\s+(?:\w+\s+)*?[A-Z][a-zA-Z]{1,}/;
/** a choice between two things with nothing external ("black or white?"): an opinion, spoken */
const CHOICE = /\b\w+ or \w+\b/;
const TOPIC_KO = /뉴스|가격|얼마|날씨|최신/;
const REC_KO = /추천|맛집|제일|가장|순위|후기/;
const EXTERNAL_KO = /맛집|식당|카페|가게|호텔|영화|드라마|책|노래|여행지|관광지|집\s|집[?？]|라멘|고기|갈비|국밥|곳|서울|수원|강남|홍대|부산|제주|근처|에서/;
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
/** "near me" / "show me" keep a lookup a lookup; "recommend … for me" is personal advice (P0 11/4) */
const BENIGN_ME = /\b(?:show|tell|give|get|find|send|near) me\b/g;
/** "how do I make kimchi", "where can I get…": a how-to, the web helps */
const HOWTO = /^(?:how (?:do|can|should|would) (?:i|we)\b|how to\b|where (?:can|do|should) (?:i|we)\b)|\bhow to\b/;
const SELF_STATE = /\bhow (?:do|did) (?:i|we) (?:look|seem|sound|do)\b|\bhow am i\b/;
const FEELING = /\b(?:feel|feeling|felt|sad|lonely|bored|tired|stressed|anxious|upset|angry|happy|love|miss|hate|worried|scared)\b/;
const SMALL_TALK = /^(?:how about|what about|what if|thanks|thank you|ok|okay|cool|nice|great|wow|lol|haha|yes|no|yeah|nope|sure|bye|good (?:morning|night)|what'?s up|what'?s new|what'?s going on|how'?s it going|what are you (?:up to|doing))\b/;
const PERSONAL_KO = /(?:^|\s)(?:너|넌|너는|니가|네가|너도|당신|나|난|나는|내가|내|제가|저는|저도|우리|나한테|내게|저한테|제게|나랑)(?:\s|$)|어울려|어울리|기분|사랑|보고\s*싶|심심|외로|우울|힘들|피곤|지내|안녕|고마워|괜찮아/;

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
const KO_ASK = /[?？]\s*$|(?:야|니|나|까|지|요|래|줘|봐|어때)\s*[?？.!]*$|추천|알려\s*(?:줘|줄래|줄\s*수|주세요|줄래요)|수\s*있(?:어|니|나|을까)\s*[?？]*$|해\s*줄래/;
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

/**
 * What the line itself says: "search" (an information ask: the general card), "spoken" (a rule says talk only:
 * crisis, small talk, feelings, about you / them, a pronoun or a thing in view without a request), or "open" (no rule
 * either way: the find judge may look at the context and the picture, judge.ts).
 */
export type LineVerdict = "search" | "spoken" | "open";

/** a thing in view with a request about it ("where can I get these?", "how much is this one?"): for the judge */
const DEICTIC_REQUEST = /\b(?:where (?:can|could|do|should) (?:i|we) (?:get|buy|find|order)|what brand|how much|price|buy|order|find (?:me )?(?:one like|something like|more like))\b/;
/** a request with nothing named ("find me some", "get one"): the runner's own follow-ups take these */
const BARE_REQUEST = /^(?:(?:please )?(?:find|get|show|grab|pick)(?: me)? (?:some|one|a pair|a couple|them|more))\W*$/;
const JOKE = /^(?:a |another )?(?:joke|story|fun fact|riddle)\b/;
/** a question or a request at all ("Google is great." / "서울 날씨 좋다" are remarks) */
const ASKS = /\?\s*$|^(?:who|what|where|when|which|how|why|is|are|was|were|do|does|did|can|could|would|will|should|any|find|get|show|recommend|suggest|tell|give|list|name)\b/;
const LINKS_ASK = /\b(?:send me (?:the )?links?)\b|링크\s*보내/;

export function assessLine(text: string, env: NodeJS.ProcessEnv = process.env): LineVerdict {
  if (!text.trim() || text.length > 400 || realCrisisSignal(text)) return "spoken";
  // "the US" / "U.S." is a country, not "us" (lowercased below)
  const country = text.replace(/\bU\.?S\.?(?:A\b\.?)?(?![a-z])/g, "USA");
  const full = country.replace(/[‘’ʼ]/g, "'").toLowerCase();
  const t = coreQuestion(country);
  if (NO_SEARCH.test(full)) return "spoken";
  const searchVerb = SEARCH_VERB.test(full) || SEARCH_VERB.test(t) || SEARCH_KO.test(full);
  if ((SMALL_TALK.test(t) || JOKE.test(t) || BARE_REQUEST.test(t)) && !searchVerb) return "spoken";
  if (DEICTIC.some((re) => re.test(t)) || DEICTIC_KO.test(t)) return DEICTIC_REQUEST.test(t) && !FEELING.test(t) ? "open" : "spoken";
  // a pronoun points back into the conversation, unless it's a dummy "it" or a spelled-out search ("look up how much it costs…")
  // ("how long does it take to get there?" still points back: "there" is in the conversation, Codex r2)
  const pronounFree = DUMMY_IT.test(t) && !/\b(?:there|here)\b/.test(t) ? t.replace(/\bit\b/, "") : t;
  if (PRONOUN.test(pronounFree) && !(searchVerb && !LOOK_IT_UP.test(full) && words(t) >= 5)) return "spoken";
  if (FEELING.test(t) && !searchVerb) return "spoken";
  if (YOU.test(t) && !searchVerb) return "spoken";
  if (SELF_STATE.test(t)) return "spoken";
  // "recommend … for me" is advice, unless the ask is a plain outside fact ("a dinner place near Gangnam for me", Codex r1)
  // a choice for them ("black or white for my phone") is advice, whatever the category (Codex judge r4)
  const outside = (REC.test(t) && EXTERNAL.test(t) && !CHOICE.test(t)) || (TOPIC.test(t) && !/\b(?:i|my|me)\b(?! ?(?:near|nearby))/.test(t.replace(/\bfor me\b/, "")));
  if (SELF.test(t.replace(BENIGN_ME, "")) && !HOWTO.test(t) && !searchVerb && !outside) return "spoken";
  if (PERSONAL_KO.test(t) && !searchVerb) return "spoken";
  const n = words(t);
  const webOn = env.GENITA_WEB_SEARCH !== "0";
  if (searchVerb) return n >= 2 && webOn ? "search" : "spoken";
  const original = country.replace(LEAD_IN_ORIG, "");
  const place = CAPITAL_PLACE.test(original) || LOCATION.test(t);
  const named = NAMED.test(original);
  const question = /\?\s*$/.test(t) || WH.test(t) || IMPERATIVE.test(t);
  const external = (REC.test(t) && (EXTERNAL.test(t) || place)) || (EXTERNAL.test(t) && place);
  // "black or white?" / "which is better, A or B?" with nothing external, factual or named: an opinion (P0 11/4)
  if (CHOICE.test(t) && !place && !named && !TOPIC.test(t) && !EXTERNAL.test(t)) return "spoken";
  const fact = t.match(SHORT_FACT);
  const thing = t.match(THING_Q);
  const search =
    (TOPIC.test(t) && question && n >= 3) ||
    (external && (question || n >= 3)) ||
    // a who/what/where question about a named real-world thing ("who's the CEO of Nintendo", "where is the Eiffel Tower")
    (WH.test(t) && n >= 4 && (named || place)) ||
    ROLE_Q.test(t) ||
    // "where is the eiffel tower?" in any casing: a fact about a thing (Codex r2/r3)
    (!!thing && !thing[1].split(" ").some((w) => CONTEXT_WORD.test(w) || CHAT_WORD.test(w))) ||
    // a how-to for a concrete task ("how do I get a red wine stain out of a carpet")
    (HOWTO.test(t) && n >= 6) ||
    (!!fact && !CONTEXT_WORD.test(fact[1].replace(/[.-]+$/, ""))) ||
    (TOPIC_KO.test(t) && n >= 2 && KO_ASK.test(t)) ||
    (REC_KO.test(t) && EXTERNAL_KO.test(t) && n >= 2 && KO_ASK.test(t)) ||
    (WH_KO.test(t) && n >= 3 && KO_ASK.test(t) && (EXTERNAL_KO.test(t) || ROLE_KO.test(country) || WHERE_THING_KO.test(t)));
  if (search) return webOn ? "search" : "open";
  // a short "what is next?" needs the conversation, not a card
  const last = t.replace(/[?.!\s]+$/, "").split(/\s+/).at(-1) ?? "";
  if (WH.test(t) && n <= 3 && CONTEXT_WORD.test(last)) return "spoken";
  // "send me the links" on its own: the runner's product follow-up, never a judged card
  if (LINKS_ASK.test(full)) return "spoken";
  // a Korean wh-question that isn't a search ("어디까지 얘기했지?") needs the conversation: spoken, like the English one
  if (/[가-힣]/.test(t)) return KO_ASK.test(t) && !WH_KO.test(t) && !/어디|뭐야|왜/.test(t) ? "open" : "spoken";
  // a who/what/how question with nothing external or named is an opinion / chat question: spoken (P0 11/4 narrowing)
  if (WH.test(t)) return "spoken";
  return ASKS.test(t) && n >= 2 ? "open" : "spoken";
}

/** An information question the web answers better than a chat reply. */
export function isGeneralAsk(text: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.GENITA_WEB_SEARCH === "0") return false;
  return assessLine(text, env) === "search";
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

const TRACKING = /^(?:utm_\w+|ref|ref_src|fbclid|gclid|mc_cid|mc_eid|si|igshid|source)$/i;
/** the same page: scheme, www., hash, a trailing slash and tracking parameters don't matter; ?v=alpha vs ?v=beta does (Codex r2) */
export function samePageKey(u: string): string {
  try {
    const url = new URL(u);
    const params = [...url.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
    return `${url.hostname.replace(/^www\./i, "").toLowerCase()}${url.pathname.replace(/\/+$/, "")}${query}`;
  } catch {
    return u.toLowerCase();
  }
}

/**
 * Demo 11/4: rows showed bare domains ("maangchi.com") when the model gave no title. An empty title, or one that is
 * only the domain, is filled from the page's own path ("/recipe/kimchi-bokkeumbap" → "Kimchi bokkeumbap"), else the
 * row's line; the domain only when there is nothing else.
 */
export function readableTitle(title: string, why: string, url: string, domain: string): string {
  const t = title.trim();
  const bare = (x: string) => x.toLowerCase().replace(/^www\./, "").replace(/\/$/, "");
  if (t && bare(t) !== bare(domain)) return t;
  let slug = "";
  try {
    const parts = new URL(url).pathname.split("/").map((p) => decodeURIComponent(p)).filter(Boolean);
    for (let i = parts.length - 1; i >= 0 && !slug; i--) {
      const words = parts[i].replace(/\.[a-z]{2,5}$/i, "").split(/[-_+\s]+/).filter((w) => /[a-z]/i.test(w) && !/^\d+$/.test(w) && !/^[a-f0-9]{8,}$/i.test(w));
      if (words.length >= 2 && words.join(" ").length <= 80) slug = words.join(" ");
    }
  } catch { /* not a URL: the line below */ }
  if (slug) return slug.charAt(0).toUpperCase() + slug.slice(1);
  const line = why.trim().replace(/[.!]+$/, "");
  if (line) return line.length > 60 ? `${line.slice(0, 57).replace(/\s+\S*$/, "")}…` : line;
  return t || domain;
}

/** The model's results that are pages of the trace (a summary never goes on another page of the same site); one per site. */
export function pickResults(j: GeneralJson | null, traced: string[]): Result[] {
  const byUrl = new Map<string, string>();
  for (const u of traced) if (!byUrl.has(samePageKey(u))) byUrl.set(samePageKey(u), u);
  const seen = new Set<string>();
  const out: Result[] = [];
  const add = (title: string, why: string, url: string) => {
    const domain = domainOf(url);
    if (!domain || seen.has(domain) || isBlockedSite(domain) || out.length >= GENERAL_MAX_RESULTS) return;
    seen.add(domain);
    out.push({ title: readableTitle(title, why, url, domain), why, url, domain });
  };
  for (const r of Array.isArray(j?.results) ? j.results : []) {
    const url = str(r?.url, 600);
    if (!url) continue;
    const page = byUrl.get(samePageKey(url));
    if (page) add(str(r?.title, 100), str(r?.why, 160), page);
  }
  // nothing usable from the model: the search's own pages
  if (!out.length) for (const u of traced) add("", "", u);
  return out;
}

// ───────── r01 sheet data ─────────

/** "search for" / "look up" left after coreQuestion, and the "what's the" before the thing itself */
const TITLE_VERB = /^(?:look (?:up|it up)|search(?: for| up| the web for)?|google|find out|check)\s+/;
const TITLE_LEAD = /^(?:what(?:'s| is| are|s)|which(?:'s| is| are)|where(?:'s| is| are))\s+(?:the|a|an)\s+/;
const TITLE_HOWTO = /^how (?:do|can|should|would) (?:i|we)\s+/;
const SMALL_WORD = /^(?:a|an|the|and|or|but|in|on|of|for|to|at|by|with|near|vs|from|into)$/;
export const TITLE_MAX_WORDS = 6;

/** The searching sheet's title: the question in a few words, title-cased ("what's the best kbbq in suwon?" → "Best KBBQ in Suwon"). */
export function questionTitle(question: string): string {
  let t = coreQuestion(question).replace(/[?.!。？！]+$/u, "").trim();
  t = t.replace(TITLE_VERB, "").replace(TITLE_LEAD, "").replace(TITLE_HOWTO, "").trim();
  // at most 6 words that carry meaning ("the", "in" don't count) and 8 in all
  let w: string[] = [];
  let content = 0;
  for (const x of t.split(/\s+/).filter(Boolean)) {
    if (w.length >= 8 || (!SMALL_WORD.test(x) && content >= TITLE_MAX_WORDS)) break;
    if (!SMALL_WORD.test(x)) content++;
    w.push(x);
  }
  while (w.length > 1 && SMALL_WORD.test(w[w.length - 1])) w = w.slice(0, -1);
  if (!w.length) return GENERAL_TITLE_FALLBACK;
  return w
    .map((x, i) => {
      if (i > 0 && SMALL_WORD.test(x)) return x;
      // "kbbq", "nyc", "bts": no vowel → an acronym
      if (/^[a-z]{2,5}$/.test(x) && !/[aeiouy]/.test(x)) return x.toUpperCase();
      return x.charAt(0).toUpperCase() + x.slice(1);
    })
    .join(" ");
}

/** The reason line on its own, at most 18 words; undefined when there is none (no empty labels). */
export function whyLine(why: string): string | undefined {
  const w = why.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return undefined;
  return w.length > 18 ? `${w.slice(0, 18).join(" ").replace(/[,;:—-]+$/, "")}…` : w.join(" ");
}

/** find.image "source-N" (0-based) on a stored card (runner + app keep the picture with its row). */
export function applySourceImage(card: FindCard, img: FindImage): void {
  const m = img.slot.match(/^source-(\d+)$/);
  const s = m ? card.sources?.[Number(m[1])] : undefined;
  if (s) s.image = img;
}

export function cutOff<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, outer: AbortSignal): Promise<T | null> {
  const a = new AbortController();
  const signal = AbortSignal.any([outer, a.signal]);
  return new Promise<T | null>((resolve) => {
    const t = setTimeout(() => { a.abort(); resolve(null); }, ms);
    run(signal).then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

/** Each result's own og:image, read in parallel (≤ GENERAL_IMAGE_MS per read), stored like a product photo. */
async function resultPictures(ctx: PipelineCtx, results: Result[]): Promise<void> {
  const { pageFacts, productImage } = ctx.vendors;
  if (!pageFacts || !productImage) return;
  await Promise.all(
    results.map(async (r, i) => {
      const slot = `source-${i}`;
      const facts = await cutOff((s) => pageFacts(r.url, s), GENERAL_IMAGE_MS, ctx.signal);
      const bytes = facts?.image ? await cutOff((s) => productImage(facts.image!, s), GENERAL_IMAGE_MS, ctx.signal) : null;
      if (ctx.signal.aborted) return;
      try {
        if (!bytes?.length) throw new Error(facts?.image ? "image unreadable" : "no og:image");
        // #1 is also the card's hero (the iPhone link layout already draws it)
        if (i === 0) ctx.emit({ type: "find.image", findId: ctx.findId, slot: "hero", status: "ready", url: await ctx.putImage("hero", bytes) });
        ctx.emit({ type: "find.image", findId: ctx.findId, slot, status: "ready", url: await ctx.putImage(slot, bytes) });
      } catch (err) {
        if (ctx.signal.aborted) return;
        ctx.emit({ type: "find.image", findId: ctx.findId, slot, status: "failed" });
        ctx.log("find.general_image_failed", { findId: ctx.findId, slot, message: String(err).slice(0, 120) });
      }
    }),
  );
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
  ctx.emit({ type: "find.started", findId: ctx.findId, utteranceId: ctx.utteranceId, kind: "answer", title: questionTitle(ctx.question), detail: "Searching the web" });
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
    // Chelsea 11/4: conversation first, finds only add a sheet — a failed search is silent (no line, no fail sheet)
    ctx.emit({ type: "find.failed", findId: ctx.findId, reason: "stopped", message: "" });
    return { card: null, timings };
  }
  const n = results.length;
  // r01 stage line: what was read, then what was picked (the app rotates on its own clock when these don't come)
  const pages = new Set(traced.map(samePageKey)).size;
  if (pages) ctx.emit({ type: "find.progress", findId: ctx.findId, detail: `Reading ${pages} page${pages > 1 ? "s" : ""}` });
  ctx.emit({ type: "find.progress", findId: ctx.findId, detail: `Picking the best ${n}` });
  const pictures = !!(ctx.vendors.pageFacts && ctx.vendors.productImage);
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
    // each result once: in Sources, as "title — why" with its link (P0 11/4: the Mac listed them twice); one summary line
    // above them because the iPhone link layout always shows its Takeaways label
    steps: [{ text: `Top ${n} result${n > 1 ? "s" : ""} from the web. Tap one to open it.` }],
    options: [],
    why: [],
    ask: strList(j?.ask, 2, 40),
    // title stays "title — why" for apps that predate `why` (r01 apps show `why` on its own line and drop the suffix)
    sources: results.map((r, i) => {
      const why = whyLine(r.why);
      return {
        title: r.why ? `${r.title} — ${r.why}` : r.title,
        url: r.url,
        domain: r.domain,
        ...(why ? { why } : {}),
        ...(pictures ? { image: { slot: `source-${i}`, status: "pending" as const } } : {}),
      };
    }),
    // never taste chips on a looked-up fact
    reasons: [],
    // no how lines: the Mac shows them under an empty-looking "Why these" (P0 11/4)
    how: [],
  };
  ctx.emit({ type: "find.created", findId: ctx.findId, card });
  timings.cardMs = Math.round(ctx.now() - t0);
  ctx.log("find.general", { findId: ctx.findId, results: n, traced: traced.length });
  await resultPictures(ctx, results);
  timings.picturesMs = Math.round(ctx.now() - t0);
  return { card, timings };
}

// ───────── the spoken side: one sentence ─────────

/** a word that is a link: never said */
const LINKISH = /^(?:https?:\/\/|www\.)|^\S+\.(?:com|org|net|io|ai|co|gov|edu|kr|jp|uk|dev|app)(?:\/\S*)?[)"'”’.,!?]*$/i;
function scrubWord(w: string): string {
  // markdown "[official](https://…)" keeps its words, drops the link
  // only a markdown link's brackets go: "[smile]" / "[whispers]" voice tags stay (Codex mix r2)
  const md = /\]\(/.test(w) ? w.replace(/\]\([^)\s]*\)?/g, "").replace(/^\[/, "") : w;
  const core = md.replace(/^["'“‘(<]+/, "");
  return LINKISH.test(core) ? "" : md;
}
const scrub = (t: string) => t.split(/(\s+)/).map((w) => (/^\s+$/.test(w) ? w : scrubWord(w))).join("").replace(/ {2,}/g, " ");
/** a line the voice drops anyway ("I'll look that up.", "Hmm."): not the one sentence */
/** some sentence of it is one the voice would say */
const sayable = (all: string) => {
  const sp = new SentenceSplitter({ firstClauseMaxChars: Number.POSITIVE_INFINITY });
  return [...sp.push(`${all} `), ...sp.flush()].some((x) => !unsaid(x));
};
const unsaid = (raw: string) => {
  // judged on what is said, without "<warm>" / "[smile]" tags (Codex mix r2)
  const s = parseTaggedSentence(raw).displayText.trim();
  return !s || isToolNarration(s) || isProcessLine(s) || isInterjectionOnly(s);
};

/**
 * The reply as one sentence: whole words go out as they arrive (first audio is not held back), link-looking words
 * are dropped, and nothing after the first sentence the voice would say is spoken. The stream is still read to its
 * end so tool calls after the sentence (remember) still happen (Codex mix r1). Sentence ends come from the
 * session's own SentenceSplitter ("Mt.", "U.S.", full-width marks).
 */
export async function* firstSentenceOnly(src: AsyncIterable<SparkStreamEvent>): AsyncIterable<SparkStreamEvent> {
  const splitter = new SentenceSplitter({ firstClauseMaxChars: Number.POSITIVE_INFINITY });
  let all = "";
  let emitted = 0;
  let cursor = 0;
  let stopAt: number | null = null;
  let said = "";
  const take = (upto: number): string => {
    if (upto <= emitted) return "";
    let t = scrub(all.slice(emitted, upto));
    emitted = upto;
    if (/\s$/.test(said) || !said) t = t.replace(/^\s+/, "");
    said += t;
    return t;
  };
  for await (const ev of src) {
    if (ev.type === "done") {
      if (stopAt === null) {
        const t = take(all.length);
        if (t) yield { type: "text", delta: t };
        // nothing the voice would say (an announcement, a bare tag, an empty reply): the hedge (P0 11/4)
        if (!sayable(all)) { const h = `${said && !/\s$/.test(said) ? " " : ""}${GENERAL_HEDGE}`; said += h; yield { type: "text", delta: h }; }
      }
      yield { ...ev, text: said };
      return;
    }
    if (ev.type !== "text") { yield ev; continue; }
    if (stopAt !== null) continue;
    all += ev.delta;
    for (const sentence of splitter.push(ev.delta)) {
      const at = all.indexOf(sentence, cursor);
      const end = at >= 0 ? at + sentence.length : all.length;
      cursor = end;
      if (stopAt === null && !unsaid(sentence)) stopAt = end;
    }
    // whole words only, so a link is seen whole before anything of it is said
    const lastSpace = all.search(/\s\S*$/);
    const t = take(stopAt ?? (lastSpace >= 0 ? lastSpace + 1 : emitted));
    if (t) yield { type: "text", delta: t };
  }
  if (stopAt === null) {
    const t = take(all.length);
    if (t) yield { type: "text", delta: t };
  }
}
