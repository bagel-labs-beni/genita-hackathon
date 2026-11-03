import { CLAUSE_SEPARATORS } from "./sentences.ts";
import { parseTaggedSentence } from "./tags.ts";

/**
 * Narrow list of tool announcements, not general hesitation or real content.
 * The caller must also establish a tool call or subsequent content before
 * dropping one. Physical actions ("check the oven") and recollections stay.
 */
const TARGET = "(?:my memory|our (?:past |previous )?conversations|what you (?:told|said to) me|that|this|it)";
const LOOKUP_CONTENT = `[^${CLAUSE_SEPARATORS}.!?…。！？]+`;
const QUERY = `(?: (?:for|about) ${LOOKUP_CONTENT})?`;
const LOOKUP = `(?:check ${TARGET}${QUERY}|search (?:my memory|the web)${QUERY}|look (?:up (?!at\\b|to\\b)${LOOKUP_CONTENT}|(?:that|this|it) up)|recall ${TARGET}${QUERY}|remember (?:that|this|it)|save (?:that|this|it) to memory)`;
const SEPARATOR = `[${CLAUSE_SEPARATORS} ]+`;
// "hang on," / "hold on," lead a lookup announcement too: held until the next clause is judged (Codex #356 P2, #354)
const WAIT = "(?:one sec(?:ond)?|one moment|give me (?:just )?a (?:sec(?:ond)?|moment|minute)|just a (?:sec(?:ond)?|moment)|hang on|hold on|bear with me)";
const KOREAN_WAIT = "(?:잠깐|잠시만요?|잠시)";
const INTENT = new RegExp(`^(?:(?:${WAIT}|${KOREAN_WAIT})${SEPARATOR})?(?:i'll|i will|let me) ${LOOKUP}$`);
const INTERJECTION = "(?:hm+|mm+|um+|uh+|oh+|ah+|eh+|er+m*|huh|well|ok(?:ay)?|alright)";
const INTERJECTION_WORD = new RegExp(`^${INTERJECTION}$`, "iu");
const FILLER = `(?:${WAIT}|${KOREAN_WAIT}|${INTERJECTION})`;
const FILLERS_ONLY = new RegExp(`^${FILLER}(?: ${FILLER})*$`, "iu");
const INTERJECTION_PREFIX = new RegExp(`^(?:${INTERJECTION}${SEPARATOR})+`);
const WAIT_LOOKUP = new RegExp(`^${WAIT}${SEPARATOR}(?:while i (?:${LOOKUP})|(?:looking (?:that|this|it) up|checking my memory|searching (?:my memory|the web))${QUERY})$`);
const KOREAN_LOOKUP = new RegExp(`^(?:${KOREAN_WAIT}${SEPARATOR})?(?:(?:(?:기억을?|네가 말해준 내용을|전에 (?:말한|나눈) (?:내용을|대화를)) )?(?:찾아\\s?볼게요?|확인해\\s?볼게요?)|검색해\\s?볼게요?|기억해\\s?둘게요?)$`, "u");
const TRAILING_PUNCTUATION = new RegExp(`[${CLAUSE_SEPARATORS}.!?…。！？]+$`, "u");

const normalize = (text: string) => text.trim().replace(/’/g, "'").replace(/\s+/g, " ").replace(TRAILING_PUNCTUATION, "").trim().toLowerCase().replace(INTERJECTION_PREFIX, "");

function isNarrowNarration(s: string): boolean {
  // Favor keeping a mixed clause over losing an answer or a real-world action.
  if (/\b(?:and|but|so|because|then)\b/.test(s)) return false;
  // Future/intended lookup or save; never a statement of the result.
  if (INTENT.test(s) || WAIT_LOOKUP.test(s)) return true;
  // Korean future lookup/save forms only, optionally after a short wait.
  return KOREAN_LOOKUP.test(s);
}

/**
 * #354: what Spark actually says around a memory/web lookup after #269 ("I'll pull what I remember to pick one",
 * "let me check what I've got on you", "I'll note that win", "trying to map your route"). The target is always
 * memory or the lookup itself, never a thing in the room ("I'll pull a chair up", "let me see what you've got").
 */
// the tail never crosses a clause separator ("let me check my memory， tofu works" stays real content)
const TAIL = `[^${CLAUSE_SEPARATORS}.!?…。！？]*`;
const MEMORY_TARGET = `(?:what (?:i|you|we)\\b${TAIL}|(?:my|our) (?:notes|memory)\\b${TAIL}|everything (?:i|you)\\b${TAIL})`;
const LOOKUP_INTENT = new RegExp(`^(?:(?:${WAIT})${SEPARATOR})?(?:i'll|i will|let me|i'm going to|i'm gonna|i am going to)(?: (?:just|quickly|quick|go|now|first))* (?:(?:check|pull up|pull|recall|(?:try to )?remember|search|look up|dig up|go through) ${MEMORY_TARGET}|(?:note|jot down|save) (?:that|this|it)(?: (?:win|one|down|for (?:later|next time)|to (?:my )?memory))?)$`);
/** Web/maps promises ("I'll pull up the best route to City Hall for you", smoke 11/3). */
const WEB_INTENT = new RegExp(`^(?:i'll|i will|let me|i'm going to|i'm gonna)(?: (?:just|quickly|quick|go|now|first))* (?:pull up|look up|find|check|map out|get|grab) (?:you )?(?:the )?(?:best |fastest |quickest |easiest )?(?:route|directions|way there|options|a few (?:options|picks|spots))\\b${TAIL}$`);
/** "now I'm pulling your favorites for dinner ideas" (smoke 11/3): a lookup in progress. */
// the subject may be dropped after a dash: "I'll pick a favorite — pulling up what I remember" (bug-fix 1c63d32 outfit 1/6)
// what a lookup is about — memory, a route, options — never a plain noun ("Choosing your own clothes builds confidence", Codex r23)
const LOOKUP_OBJ = "(?:(?:today|tomorrow|tonight|this week|the week|the weekend)'s (?:forecast|weather)\\b|what (?:i|you)\\b|on what you\\b|from what (?:i|you)\\b|something (?:good|tasty|fun|nice|new)\\b|(?:your|my|the)(?: [\\w'-]+){0,2} (?:style|notes|memory|options|favorites|faves|vibe|look|plans|calendar|route|directions|forecast|map|details|picks|choices)\\b|for you\\b)";
const LOOKING_NOW = new RegExp(`^(?:now |so |just )?(?:i'm )?(?:just )?(?:pulling|checking|digging|searching|looking|plotting|mapping|working out|figuring out|grabbing|loading|scanning|lining up|picking|choosing|sizing up|thinking back|cooking up|whipping up|putting together)\\b(?=.*${LOOKUP_OBJ})${TAIL}$`);
/** Deliberation said aloud before the pick ("Love both — let me think which one fits tonight best", outfit e2e 11/3).
 * A bare "Let me think" stays (it is how people start an answer). */
const THINK_INTENT = new RegExp(`^(?:let me|i'll|i need to|i have to) (?:think|figure out|decide|work out) (?:about )?(?:which|what|how)\\b${TAIL}$`);
/** a plan to choose, not the choice: "I'll pick between the two" (bug-fix lane, fcece2f outfit 1/6) */
// …and "I'll pick one for you" / "a favorite" / "the winner": a choice promised with nothing chosen (bug-fix 5784953, 3/6)
const NO_CHOICE = "(?:one|a favorite|a favourite|the winner|a winner|something|for you|the one (?:that|which) (?:fits|works|suits|goes)(?: [\\w']+){0,3} best|the one you(?:'ll| will)? (?:like|love) (?:most|best))";
const CHOOSE_PLAN = new RegExp(`^(?:(?:got it|okay|ok|alright)\\b[^a-z]*)?(?:[^—–;]*[—–;,]\\s*)?(?:let me|i'll|i will|i need to|i'm gonna|i'm going to) (?:pick|choose|decide)(?: (?:between|which)\\b| ${NO_CHOICE}\\b)${TAIL}$|^(?:still |just )?(?:deciding|choosing|picking|torn) between\\b${TAIL}$`);
/** a wait that promises a lookup, tool or no tool: "give me a sec to remember your vibe", "one sec while I check" */
const WAIT_TO = new RegExp(`^(?:${WAIT})(?: (?:to|while i|so i can|and i'll|let me))? (?:remember|recall|think|check|look|pull|find|map|dig|figure|search|go through)\\b${TAIL}$`);
/** "Trying to map your route — give me just a moment": only with a wait in the same sentence ("Trying to find a job is exhausting" is content). */
const TRYING = /^(?:i'm )?trying to (?:map|find|look up|pull up|check|search)\b/;
const WAIT_ONLY = new RegExp(`^(?:${WAIT}|${KOREAN_WAIT})$`);
/** The planning voice leaking into speech: the user in the third person ("She's holding up the trench and denim"). */
const META = /^(?:she|he)(?:'s| is) (?:holding up|showing (?:me|us)|asking me to (?:pick|choose|help (?:pick|choose)))\b/;
// a third person with a turn ("…, but the blue one") or speaking to "you" is real talk about someone
const META_GUARD = /\b(?:but|because|then|so|you|your)\b/;
const CLAUSE_SPLIT = /\s*(?:—|–|;| - )\s*/;

/** set per judge: a third-person "she/he" can be the user only when the user's line is about themselves (Codex #356 r11) */
let metaIsUser = true;

function isNarrationClause(clause: string): boolean {
  const s = normalize(clause);
  if (!s) return false;
  if (searchRetry(s) || recallNow(s) || progressClause(s) || (RESOURCE_PROMISE.test(s) && !HELP_ACTION.test(s))) return true;
  // an explicit pick is the answer before anything else ("I'm picking the trench for you", Codex r24)
  if (DECISION.test(s) && !(CHOOSE_PLAN.test(s) && new RegExp(`\\b${NO_CHOICE}\\b`).test(s))) return false;
  if (isNarrowNarration(s)) return true;
  if (META.test(s)) return metaIsUser && !META_GUARD.test(s);
  if (WAIT_TO.test(s)) return true;
  // "Outfit vote incoming." / "Your pick, coming right up." — a short promise of what's next (bug-fix a6df112)
  if (s.split(" ").length <= 6 && !/\b(?:is|are|was|were)\b/.test(s) && /\b(?:incoming|coming (?:right )?up)$/.test(s)) return true;
  // "Your dinner idea is coming" — our own answer promised, not a status (bug-fix 95acde0 smoke)
  if (/^your (?:\w+ )?(?:idea|ideas|pick|picks|answer|suggestion|recipe|plan|options?) (?:is|are) (?:coming|on (?:its|the) way)$/.test(s)) return true;
  // a plan to choose — unless the choice is in the same clause ("I'll pick one for you and it's the trench", "I'll pick one: the trench", Codex r17)
  if (CHOOSE_PLAN.test(s) && !/[:]|\b(?:it'?s|is|are|was|and (?:it|that|this)|the winner is)\b/.test(s)) return true;
  // "…for that but tofu works": a turn in the clause keeps it
  // "between the trench and denim" / "… and choose tonight" are part of the announcement, not a second statement
  // "… your style and that cozy bedroom backdrop": a noun phrase after "and" is part of the object (bug-fix a6df112)
  const guard = s.replace(/\bbetween .+? and \S+/, "between").replace(/\band (?:choose|pick|decide)\b.*$/, "").replace(/\band (?:that|the|your|this|those|these|my)\s+(?!(?:is|are|was|one)\b)(?![a-z' -]*\b\w+s$)[a-z' -]{1,40}$/, "");
  // a clause that already states its result ("Checking your calendar shows dinner is on Thursday", Codex r20) is the answer
  if (/\b(?:shows|says|is|are|was|were|confirms|suggests|has|it'?s|that'?s|takes|costs)\b|\d/.test(s)) return false;
  // a finished lookup stated in the past ("Checking the route confirmed the last train already left", Codex #371 r2)
  if (/\b(?:\w{3,}ed|found|left|came|went)\b/.test(s.replace(/\bwhat (?:i|you|we)(?:'ve)? (?:remember|know|told|said|shared|mentioned|liked|got)\b/g, " ").replace(/\b(?:need|needed|based|used)\b/g, " "))) return false;
  // a gerund subject with its own verb ("Scanning your boarding pass opens the gate", Codex r22): a verb in -s followed
  // by an object word is a statement, not a lookup in progress
  if (/\b\w{3,}(?:s|es)\s+(?:the|a|an|your|it|you|up|out|in|on|off|into)\b/.test(s.replace(/\b(?:what (?:i|you) (?:remember|know|told|said)|your (?:notes|options|favorites|faves|details|plans|messages))\b/g, " "))) return false;
  return !/\b(?:and|but|because|then)\b/.test(guard) && (LOOKUP_INTENT.test(s) || WEB_INTENT.test(s) || THINK_INTENT.test(s) || LOOKING_NOW.test(s));
}

/**
 * AI sweep 11/3 (real Spark with web_search + memory on, n=54): two shapes still reached the voice.
 * A search retry said aloud ("First search came up empty, so I'll try again with a broader query") and a recall in
 * progress ("Got it — trying to remember that concert we mentioned"). Both are the lookup itself, never its result:
 * "My search came up empty, I've never heard of it" (a result) and "trying to remember the last time I…" (a story) stay.
 */
/** D13 run (crisis turns use web_search for the local hotline): "I'm going to find the right support resources for you",
 * "let me find support resources you can reach right now" — a promise of the lookup, never the help itself */
// only a clause that IS the promise: ", and I'll find you support…" after a real instruction ("Please put the pills down")
// keeps the whole sentence (Codex #450 r2 P1)
const RESOURCE_PROMISE = /^(?:i'?m going to|i'?m gonna|let me|i'?ll|i will|i want to)(?: (?:just|quickly|now))? (?:find|get|pull up|look up|grab)(?: you)? (?:the |some )?(?:right |best |local )?(?:(?:support|crisis|help) ?(?:resources|options|numbers?|lines?|hotlines?)?|resources|options|numbers?|lines?|hotlines?)(?: (?:for you|you can (?:reach|call|use)|right now|now|here|tonight|in korea|near you|where you are))*$/;
const SEARCH_RETRY = /\b(?:i'll|i will|let me|i'm gonna|i'm going to)(?: just)? (?:try (?:again|another (?:search|query)|a (?:broader|different|wider|new) (?:search|query))|search again|(?:re-?)?search (?:again|with)|(?:run|do) (?:another|a broader|a different) (?:search|query)|dig (?:deeper|around|more)|look (?:again|harder|deeper))\b/;
/** "— finding you the Hongdae spots now", "Got you, hunting down late-night ramen", "— pulling it up now" (sweep r2):
 * our own search in progress. A result in the clause ("…is exhausting", "found", "says") keeps it. */
const PROGRESS = /^(?:i'm |i am )?(?:just |now |still )?(?:hunting (?:down|for)|tracking down|rounding up|scouting(?: out)?|finding (?:you|some|the best|a few|what'?s (?:open|good|around|near|close)|out what'?s (?:open|good))|pulling (?:up|together|it up|that up|those up|them up)|digging (?:up|into|through)|searching for|looking for (?:some|the best|a few|spots|places|options)|getting you (?:[\w,'-]+ ){0,3}(?:support|options|resources|numbers?|help lines?)|(?:pulling|grabbing|checking|getting|fetching|loading)(?: up)? (?:the |that |your )?(?:final |latest |live |current |full )?(?:score|scores|results?|stats|standings|box score|numbers|forecast|weather|schedule|times?))\b/;
// a predicate keeps it: "Searching for a job takes time", "Trying to remember what you ate can be hard" (Codex #415 P2)
const PROGRESS_RESULT = /\b(?:says|shows|found|turns out|is|was|were|has|had|takes|took|makes|costs|means|sucks|helps|works|gets|feels|seems|can|could|will|would|should|might|must)\b|\d/;
/** "I've got that note about your sister" said before the recall result, nothing in it: the memory store, never the
 * answer. "…note about your sister saying her birthday is May 12" carries the content and stays (Codex #415 P2). */
const NOTE_CLAIM = /^i(?:'ve| have)? got (?:that|the|a|your|some) notes? (?:about|on|for) (?:your |the |that |my )?[\w'-]+(?: [\w'-]+)?$/;
/** a sentence that carries help or a result is never a lookup promise (Codex #431 P1: "Let me get you the crisis line:
 * 988.", "Getting you support: call the police right now.", "Call 988 now, and I'll find support resources for you.") */
const HELP_ACTION = /\b(?:call|text|dial|police|emergency|someone you trust|stay with (?:someone|a friend|me)|move away from|crisis (?:line|text line)|hotline|helpline|one (?:oh|zero) nine|nine one one|nine eight eight)\b|\d/;
const progressClause = (c: string) => !HELP_ACTION.test(c) && (PROGRESS.test(c) && !PROGRESS_RESULT.test(c.replace(/\b(?:that|which) are\b.*$/, ""))) || NOTE_CLAIM.test(c);
// "which concert that was" is the thing being recalled, not a predicate
const RECALL_HEAD = /^(?:(?:got it|okay|ok|hmm+|wait)\W+)?(?:i'm )?(?:still )?trying to (?:remember|recall|place|think of) (?:that|which|what|who|when|where|the one|your)\b(?!.*\b(?:last time|first time|whenever|every time|back when)\b)/;
const RECALL_PRED = /\b(?:can|could|will|would|should|might|must|takes|makes|sucks|gets|is (?:hard|tough|impossible|easy|rough)|helps)\b/;
const recallNow = (s: string) => RECALL_HEAD.test(s) && !RECALL_PRED.test(s);
/** a retry is narration only when everything else in the sentence is about the search too (Codex #415 P2: "The last
 * train leaves at 11, so I'll try another search for a later bus" keeps the train time) */
const SEARCH_META = /\b(?:search|query|results?|nothing (?:yet|so far)|came (?:up|back) (?:empty|blank|short|with nothing)|no luck)\b/;
const searchRetry = (s: string) => {
  // help in the sentence is the answer (Codex #431 r2 P1: "Call the police and I'll look again for support resources")
  if (!SEARCH_RETRY.test(s) || HELP_ACTION.test(s)) return false;
  const parts = s.split(/\s*(?:,|;|—|–| - )\s*(?:so |and |but )?|\s+so\s+/).map((p) => p.trim()).filter(Boolean);
  // a retry part that carries a result is an answer ("Let me look again at the tag because it says hand wash only", Codex #431 P2)
  return parts.every((p) => (SEARCH_RETRY.test(p) && !/\bbecause\b/.test(p) && !PROGRESS_RESULT.test(p)) || (SEARCH_META.test(p) && !/\d/.test(p)) || /^(?:okay|ok|hmm+|ugh|got it|nothing yet)$/.test(p));
};

export function isToolNarration(sentence: string): boolean {
  const s = normalize(sentence);
  if (!s) return false;
  if (searchRetry(s) || recallNow(s) || progressClause(s) || (RESOURCE_PROMISE.test(s) && !HELP_ACTION.test(s))) return true;
  if (isProcessLine(sentence)) return true;
  if (isNarrowNarration(s)) return true;
  const clauses = s.split(CLAUSE_SPLIT).map(normalize).filter(Boolean);
  if (clauses.length <= 1) return isNarrationClause(s);
  // every clause announces, waits or narrates the user; any real clause keeps the sentence
  const narrates = (c: string) => isNarrationClause(c) || (TRYING.test(c) && clauses.some((w) => WAIT_ONLY.test(w)));
  // an acknowledgement clause ("got it — …") rides along with the announcement
  const ACK_ONLY = /^(?:got it|you got it|okay|ok|alright|all right|sure|yep|yeah|mm+|hm+|on it)$/;
  return clauses.every((c) => narrates(c) || WAIT_ONLY.test(c) || ACK_ONLY.test(c)) && clauses.some(narrates);
}

/**
 * #354 mixed sentence ("Your day sounded long — let me check what I've got on you."): drop the announcing
 * clauses, keep the real ones and the sentence's leading emotion/face tags. Unchanged when nothing announces.
 */
export function stripNarrationClauses(raw: string): string {
  const lead = raw.match(/^\s*(?:(?:<[^<>\n]{1,24}>|\[[^\[\]\n]{1,30}\])\s*)*/)?.[0] ?? "";
  const body = raw.slice(lead.length);
  const parts = body.split(/(\s*(?:—|–|;| - )\s*)/);
  if (parts.length < 3) return raw;
  const clauses: string[] = [];
  for (let i = 0; i < parts.length; i += 2) if (parseTaggedSentence(parts[i]).displayText) clauses.push(parts[i]);
  const announces = clauses.map((c) => isNarrationClause(parseTaggedSentence(c).displayText));
  const keep = clauses.map((c, i) => !announces[i] && !WAIT_ONLY.test(normalize(parseTaggedSentence(c).displayText)));
  // nothing announces, or nothing real is left (the judge then holds the whole sentence as an announcement)
  if (!announces.some(Boolean) || !keep.some(Boolean)) return raw;
  const end = body.trim().match(/[.!?…。！？]+$/)?.[0] ?? ".";
  const text = clauses.filter((_, i) => keep[i]).map((c) => c.trim().replace(/[.!?…。！？,;:—–]+$/u, "")).join(" — ");
  // the reply's <emotion> stays; face/delivery tags in front belong to the first clause and go with it
  const head = keep[0] ? lead : (lead.match(/<[^<>\n]{1,24}>/g) ?? []).join(" ") + (lead.trim() ? " " : "");
  return head + text.charAt(0).toUpperCase() + text.slice(1) + end;
}

/**
 * main 11/3 (smoke 95acde0 2/10): an acknowledgement, a dash or comma, then a subject-less "-ing" clause about our own
 * process — "Your dinner idea is coming — picking something good.", "You got it — thinking back on what you shared…".
 * Same family as "I'm …ing": the process clause is dropped; the acknowledgement stays only if real content follows
 * (the judge drops a "process" line at EOF too, so a reply that is only this says nothing and retries).
 */
const PROCESS_ACK = /^(?:got it|got you|gotchu|say less|bet|love (?:that|it|this)|you got it|okay|ok|alright|all right|sure|on it|yep|yeah|mm+|hm+|your (?:\w+ )?(?:idea|ideas|pick|picks|answer|suggestion|recipe|plan|options?) (?:is|are) (?:coming|on (?:its|the) way))$/;
const PROCESS_ING = /^(?:just )?(?:picking (?:something|one)\b|thinking (?:back|about which|it over)|pulling|checking|figuring|working (?:on|out)|cooking up|whipping up|putting together|digging|looking (?:up|into|through|for)|searching|plotting|mapping|deciding|weighing|choosing (?:something|one|between)\b|scrolling|loading|grabbing (?:something|a few))\b/;
const OPINION_ING = /^(?:loving|seeing|feeling|liking|looking (?:good|great|sharp|cute)|nothing|something|anything|everything|morning|evening)\b/;
export function isProcessLine(sentence: string): boolean {
  const s = normalize(sentence);
  const clauses = s.split(/\s*(?:—|–|;| - |,)\s*/).map((c) => c.trim()).filter(Boolean);
  if (clauses.length < 2) return false;
  const [head, ...rest] = clauses;
  // only a lookup / plan in progress, never a choice or a result ("You got it — wearing the trench tonight",
  // "… taking the bus saves you twenty minutes", Codex #371)
  if (PROCESS_ACK.test(head) && rest.length === 1 && progressClause(rest[0])) return true;
  return PROCESS_ACK.test(head) && rest.length === 1 && PROCESS_ING.test(rest[0]) && !OPINION_ING.test(rest[0])
    && !/\b(?:shows|says|is|are|it'?s|that'?s|takes)\b|\d/.test(rest[0]) && !/\b\w{3,}(?:s|es)\s+(?:the|a|an|your|you|it|up|out)\b/.test(rest[0]);
}

/** Hold a wait or interjection until the following clause can be judged. */
export function isToolNarrationLead(sentence: string): boolean {
  return isFillerOnly(sentence) && !/[.!?…。！？][\p{P}\s]*$/u.test(sentence);
}

/** Waits and interjections remain fillers even when complete or combined. */
function isFillerOnly(text: string): boolean {
  return FILLERS_ONLY.test(text.normalize("NFKC").replace(/[\p{P}\s]+/gu, " ").trim());
}

/** Shared by fragment buffering and tool-answer detection, regardless of punctuation. */
export function isInterjectionOnly(text: string): boolean {
  // Treat punctuation as a word boundary so merged fragments and full-width
  // separators work without allowing a filler prefix to hide real words.
  const words = text.normalize("NFKC").replace(/[\p{P}\s]+/gu, " ").trim();
  return !!words && words.split(" ").every((word) => INTERJECTION_WORD.test(word));
}

export type NarrationDecision = {
  /** Raw tagged sentences: the caller retains emotion and delivery tags. */
  speak: string[];
  hold: string[];
  dropped: string[];
};

/**
 * Pure turn-local judge shared by both voice paths. Hold announcements and
 * their fillers until tool use or real content justifies dropping them.
 * Dropping a candidate never disables judging the next sentence. Tool use
 * persists across retries, so fillers cannot satisfy a tool's answer.
 */
/**
 * #354: Spark's pre-tool line comes in endless wordings ("I'll get you pointed the right way", "I'm on it — deciding
 * between…"). A first-person plan or a third-person line is only *held*; the stream decides: a tool call right after
 * it makes it the preamble (dropped once the answer arrives), a following sentence releases it.
 */
// any first-person present-progressive opener ("I'm weighing…", "I am pulling…") or a line about our own process is held
// until the stream shows whether a tool follows (main 11/3: close the pattern, not a word list)
// …but an opinion or an observation in that form is content: "I'm seeing onions", "I'm loving the trench" (Codex r14)
const SUSPECT = /^(?:i'?m|i am)(?: \w+ly)? (?!(?:seeing|loving|liking|feeling|thinking|guessing|betting|getting|hearing|sensing|noticing|spotting)\b)\w+ing\b|^(?:just )?(?!(?:loving|seeing|feeling|looking (?:good|great|sharp|cute)|nothing|something|anything|everything|morning|evening|thing|king|spring|ring|sing|bring it)\b)\w{3,}ing\b(?=.*(?:what (?:i|you)\b|from what\b|\bbetween\b|\bfor you\b|(?:your|my) (?:style|notes|memory|options|vibe|look)\b))|^(?:my (?:plan|first step)|first,? i'?ll|okay,? so i'?m)\b|\b(?:i'll|i will|let me|i'm (?:going to|gonna|on it)|on it)\b|^(?:she|he)(?:'s| is)\b|\b(?:picking|deciding|choosing) (?:a|one|between|which)\b/;
/** "I'll go with the black blazer" is the answer, not a plan (Codex #356 r11) */
// a stated choice is the answer: "I'll go with…", "I'm going with the trench", "I'm leaning toward…" (Codex r15) — but not
// "I'll pick between the two" (a plan to choose)
const DECISION = /\b(?:i'?ll|i'?d|i will|i would|let me) (?:go with|pick (?!between|which|one\b(?!\s*[:,—–]\s*(?:the|that|this|it'?s))|a favou?rite|the winner|a winner|something|for you|the one (?:that|which) (?:fits|works|suits|goes)(?: [\w']+){0,3} best|the one you(?:'ll| will)? (?:like|love) (?:most|best))|take (?!a (?:sec|moment|minute))|choose (?!between|which|one\b)|vote for|say|recommend|bet on|stick with)|\bi'?m (?:going (?:with|for)|leaning (?:toward|towards|to)|voting for|sticking with|rooting for|picking the|choosing the|all in on)\b|\b(?:go with|pick|wear) the\b/;
/** the line already states what was chosen ("… and it's the trench", "the winner is…"): an answer, never held (Codex r18) */
const CARRIES_CHOICE = /\b(?:and|so) (?:it'?s|that'?s|the winner is|i'?m going with)\b|\bthe winner is\b|:\s*(?:the|that|this)\b/;
/** "let me walk you through it / tell you / explain" leads into content, never a tool (#194 S1 cut-off test) */
const TALK_LEAD = /\b(?:let me|i'?ll) (?:walk you through|tell you|explain|show you|break (?:it|this|that) down|be (?:honest|real)|guess|put it this way|say this)\b/;
const isSuspect = (text: string) => { const s = normalize(text); return SUSPECT.test(s) && !DECISION.test(s) && !CARRIES_CHOICE.test(s) && !TALK_LEAD.test(s) && (metaIsUser || !/^(?:she|he)(?:'s| is)\b/.test(s)); };
/** An eager first clause cut at a dash ("City Hall from here —") waits for the rest of its sentence. */
const DASH_END = /[—–]\s*$/;

export class NarrationJudge {
  private pending: { raw: string; kind: "lead" | "announcement" | "process" | "ack" | "filler" | "clause" | "suspect" }[] = [];
  /** held lines that a tool call followed: dropped when the answer comes, spoken at EOF if none does */
  private preTool: string[] = [];
  private usedTool = false;
  private readonly enabled: boolean;

  private readonly thirdPersonIsUser: boolean;
  constructor(enabled = true, opts: { thirdPersonIsUser?: boolean } = {}) { this.enabled = enabled; this.thirdPersonIsUser = opts.thirdPersonIsUser ?? true; }

  push(raw: string): NarrationDecision {
    if (!this.enabled || !parseTaggedSentence(raw).displayText) return this.result([raw]);
    // Judge the tail independently before a wait prefix can hide its intent.
    metaIsUser = this.thirdPersonIsUser;
    const announcement = isToolNarration(parseTaggedSentence(raw).displayText);
    const prev = this.pending.at(-1)?.kind;
    if (prev === "lead" || prev === "clause") raw = this.pending.pop()!.raw + " " + raw;
    const merged = raw;
    raw = stripNarrationClauses(raw);
    const text = parseTaggedSentence(raw).displayText;
    // what's left after a stripped process clause is only an acknowledgement ("You got it."): it is said only if real
    // content follows, never on its own (main 11/3)
    if (raw !== merged && /^(?:got it|you got it|okay|ok|alright|all right|sure|on it|yep|yeah)[.!]*$/i.test(text.trim())) {
      this.pending.push({ raw, kind: "ack" });
      return this.result();
    }
    // once merged/stripped, judge what is left ("Go with the black one — I'll check my memory." keeps the pick, r11)
    if ((raw === merged && announcement) || isToolNarration(text)) {
      // a narrated own process ("You got it — thinking back on what you shared…") is never the answer, tool or no tool
      this.pending.push({ raw, kind: isProcessLine(text) ? "process" : "announcement" });
    } else if (isToolNarrationLead(text)) {
      this.pending.push({ raw, kind: "lead" });
    } else if (!this.usedTool && DASH_END.test(text)) {
      this.pending.push({ raw, kind: "clause" });
    } else if (isFillerOnly(text)) {
      if (!this.pending.length) return this.result([raw]);
      this.pending.push({ raw, kind: "filler" });
    } else if (!this.usedTool && isSuspect(text)) {
      this.pending.push({ raw, kind: "suspect" });
    } else {
      const preamble = this.preTool;
      this.preTool = [];
      const { speak, dropped } = this.flush(true);
      return this.result([...speak, raw], [...preamble, ...dropped]);
    }
    return this.result();
  }

  onToolCall(): NarrationDecision {
    if (!this.enabled) return this.result();
    this.usedTool = true;
    const lead = this.pending.at(-1)?.kind === "lead" ? this.pending.pop() : undefined;
    // held plans/clauses right before the tool are its preamble: kept aside until the answer shows up
    this.preTool.push(...this.pending.filter(({ kind }) => kind === "suspect" || kind === "clause").map(({ raw }) => raw));
    this.pending = this.pending.filter(({ kind }) => kind !== "suspect" && kind !== "clause");
    const { speak, dropped } = this.flush(true);
    if (lead) this.pending.push(lead);
    return this.result(speak, dropped);
  }

  /** EOF of an attempt: preserve lone no-tool replies; suppress tool narration. */
  finish(): NarrationDecision {
    // no answer came after the tool: the held line is the answer after all (never leave the turn empty)
    const preamble = this.preTool;
    this.preTool = [];
    const { speak, dropped } = this.flush(this.usedTool, true);
    return this.result([...preamble, ...speak], dropped);
  }

  /** Use the delivered display text, after opener rewriting, to decide retry. */
  hasAnswer(sentences: readonly string[]): boolean {
    return sentences.some((text) => !!text.trim() && (!this.usedTool || !isFillerOnly(text)));
  }

  private flush(dropAnnouncements: boolean, atEnd = false): NarrationDecision {
    const speak: string[] = [], dropped: string[] = [];
    for (const { raw, kind } of this.pending) {
      ((dropAnnouncements && kind === "announcement") || kind === "process" || (atEnd && kind === "ack") ? dropped : speak).push(raw);
    }
    this.pending = [];
    return this.result(speak, dropped);
  }

  private result(speak: string[] = [], dropped: string[] = []): NarrationDecision {
    return { speak, hold: this.pending.length ? [this.pending.map(({ raw }) => raw).join(" ")] : [], dropped };
  }
}
