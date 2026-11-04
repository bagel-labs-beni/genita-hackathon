/**
 * prompt-100 style (Chelsea 11/4 23:4x): in style feedback ("which one should I wear?", "does this suit me?") the
 * companion uses what it knows about them, woven in: personal color (warm/cool) if known, their style taste, favorite
 * colors, the occasion, fit they said they like or hate, past picks, and what the camera shows now.
 * - every verdict gives one personal reason in one natural clause ("the cream one, warm tones always look good on you")
 * - coloring unknown → a light read from what's visible, never certain, or one casual question, once per call
 * - "find me some" after the verdict keeps that reason in the search and says it once ("going warm-toned like we said")
 * - the same reason is not reused turn after turn
 * GENITA_STYLE_REASON=0 turns all of it off (the old one-reason camera line stays).
 */
export function styleReasonOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GENITA_STYLE_REASON !== "0";
}

/** a style question on camera: which to wear, does it suit me, how does this look on me */
const STYLE_Q = /\b(?:which (?:one|of these|outfit|top|dress|shirt|jacket|coat|color|colou?r)\b|what (?:should i|do i|to) wear|does (?:this|it|that) (?:suit|look good on|work on) me|(?:suit|suits) me|looks? (?:better|good|ok|okay|right) on me|how do i look in|should i wear|wear (?:this|the|which)|go with (?:this|the)|this or (?:that|the other)|the other one|why (?:that|this) one|why not the)\b/i;
export function isStyleTurn(text: string): boolean {
  return STYLE_Q.test(text);
}

/**
 * "why not this one?" / "what about the white one?" right after a verdict (11/5 prompt-lane eval, 8/72): the answer
 * restated the last reason turned around ("warm tones suit you" → "that one's too cool for you"). It gets its own rule.
 */
const WHY_NOT = /\b(?:why not (?:the |this |that )?(?:other |[a-z]+ )?(?:one|this|that)\b|why not the\b|what about (?:the |this |that )(?:other |[a-z]+ )?one\b|(?:is|isn't|wouldn't) (?:the |this |that )(?:other |[a-z]+ )?one (?:better|nicer|good)\b|why (?:didn't you pick|not pick|wouldn't you pick)\b)/i;
export function isWhyNotTurn(text: string): boolean {
  return WHY_NOT.test(text);
}

/** what the profile says about coloring (warm / cool / neutral, a season, undertones) */
const COLORING = /\b(?:warm|cool|neutral|olive)(?:[- ]toned?|[- ]undertones?| coloring| colouring)\b|\b(?:personal colou?r|undertones?|skin ?tone)\b|\b(?:spring|summer|autumn|fall|winter) (?:palette|type|tone)\b/i;
export function knowsColoring(profile: string | undefined, memories: string[] = []): boolean {
  return COLORING.test([profile ?? "", ...memories].join("\n"));
}

export type StyleInput = {
  profile?: string;
  memories?: string[];
  /** our earlier replies in this call (to rotate reasons) */
  said: string[];
  /** the coloring question was already asked this call */
  askedColoring: boolean;
  /** "why not this one?" about the option the last verdict didn't pick */
  whyNot?: boolean;
  /** this call's first verdict (the pick), default `said[0]`: kept unless they push back (11/5 eval 5c: cool 2/3 flipped) */
  pick?: string;
};

/** the per-call list of verdicts the session keeps (all of them, not just the last few: reasons rotate per call) */
export const STYLE_SAID_MAX = 12;

/** "why not the other one?": the other option's own reason, never the last one turned around */
export const WHY_NOT_LINE = "They're asking about the option you didn't pick: give it its own reason, never your last reason again or turned around (\"warm suits you\" then \"that one's too cool\" is the same reason), then say if you'd switch.";

/**
 * What a reason is about (11/5 eval 5c: "why not this one?" repeated the last verdict's reason 3/9, "drapes loose" then
 * "too fitted"; "made for tonight" then "reads office"): one category per kind of reason, so a why-not can be told
 * which kind it may not use and which one it gets instead.
 */
export const REASON_CATEGORIES: Record<string, { label: string; re: RegExp }> = {
  fit: { label: "the fit or cut (loose, fitted, tight, clingy, drape)", re: /\b(?:fit|fits|fitted|loose|looser|relaxed|clingy|tight|snug|slouchy|baggy|oversized|cut|cuts|drapes?|draped|hangs?|roomy|flowy|structured|tailored|boxy|comfy|cozy)\b/i },
  coloring: { label: "coloring or tones (warm, cool, undertones)", re: /\b(?:warm|warmer|cool|cooler|tones?|toned|undertones?|colou?ring|autumn|winter|earthy|complexion)\b/i },
  occasion: { label: "the occasion (date, tonight, dinner, office)", re: /\b(?:date|tonight|dinner|office|work|night out|occasion|formal|evening|lamp ?light|lighting|polished|strict|dressy)\b/i },
  taste: { label: "their usual style (minimal, clean, their go-to)", re: /\b(?:minimal|minimalist|clean|simple|basics|go[- ]to|your (?:style|lane|thing|vibe|taste|usual)|(?:so|just|totally|very|all) you|live in)\b/i },
  past: { label: "a past pick", re: /\b(?:last week|last time|picked|you chose|over the grey|before)\b/i },
  jewelry: { label: "jewelry (silver, gold)", re: /\b(?:silver|gold|jewel(?:le)?ry|earrings?|necklace)\b/i },
};
export function reasonCategories(text: string): string[] {
  const t = text.replace(/<[^>]*>|\[[^\]]*\]/g, " ");
  return Object.entries(REASON_CATEGORIES).filter(([, c]) => c.re.test(t)).map(([k]) => k);
}
/** what they can see on the other option itself, when no known fact is left */
export const WHY_NOT_VISIBLE = "something you can see on that option itself (its fabric, a detail, its shape or how it's put together)";

const STOP = new Set(["user", "wants", "treated", "taste", "likes", "dislikes", "communication", "casual", "teasing", "welcome", "personal", "color", "colour", "summer", "with", "over", "that", "this", "from", "they", "them", "their", "picked", "last", "week", "style", "like", "into", "when", "what"]);
const FIXED = ["warm", "cool", "tones", "undertones", "coloring", "winter", "autumn", "date", "tonight", "dinner"];
const GROUPS = [
  ["fit", "fits", "fitted", "loose", "looser", "relaxed", "clingy", "tight", "slouchy", "baggy", "oversized", "cut", "cuts"],
  ["warm", "cool", "tones", "tone", "undertones", "coloring", "colouring", "autumn", "winter", "earthy"],
  ["minimal", "clean", "simple", "basics"],
];
/** the reasons already used this call: words from what we know about them (and the fixed coloring/occasion words) that our replies said */
export function usedReasons(profile: string | undefined, memories: string[], said: string[]): string[] {
  const known = new Set([...FIXED, ...([profile ?? "", ...memories].join(" ").toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !STOP.has(w))]);
  const spoken = said.join(" ").replace(/<[^>]*>|\[[^\]]*\]/g, "").toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? [];
  // "warms" uses "warm"; "dates" uses "date"
  return [...known].filter((k) => spoken.some((w) => w === k || (w.startsWith(k) && w.length - k.length <= 3))).slice(0, 8);
}

/** one reason, many words (11/5 eval: "relaxed fit" then "too fitted for you" was the same reason): a group counts whole */
export function usedGroups(said: string[]): string[] {
  const all = new Set(said.join(" ").toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []);
  return GROUPS.filter((g) => g.some((w) => all.has(w))).flat();
}

/** the line for a style turn on camera; `asks` = this line carries the once-per-call coloring question */
export function styleLine(s: StyleInput): { line: string; asks: boolean } {
  const known = knowsColoring(s.profile, s.memories);
  // every verdict of this call (the session keeps up to STYLE_SAID_MAX): their reason words are used up (11/5: per call,
  // not just the last few, so "why not this one?" can't circle back to a reason from three verdicts ago)
  const said = s.said.slice(-STYLE_SAID_MAX);
  const used = usedReasons(s.profile, s.memories ?? [], said);
  // a new personal reason, named for it: the facts we know that no reply of this call has used yet (11/5 eval: "the
  // occasion" or "what you can see" alone read as no personal reason, 15% of verdicts)
  const facts = [...(s.profile ?? "").split("\n").map((l) => /^\s*-\s*[^:]{1,30}:\s*(.+)$/.exec(l)?.[1]?.trim()).filter((x): x is string => !!x && !/teasing|casual/i.test(x)), ...(s.memories ?? [])];
  const words = (f: string) => (f.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !STOP.has(w));
  const spent = [...used, ...usedGroups(said)];
  const unspent = (list: string[]) => facts.filter((f) => !words(f).some((w) => list.some((u) => w === u || w.startsWith(u) || u.startsWith(w))));
  // every fact used once this call: rotate — the oldest come back, only the last verdict's reasons stay out
  let fresh = unspent(spent).slice(0, 3);
  if (!fresh.length && said.length) {
    const last = said.slice(-1);
    fresh = unspent([...usedReasons(s.profile, s.memories ?? [], last), ...usedGroups(last)]).slice(0, 3);
  }
  const spokenAll = new Set(said.join(" ").toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []);
  // the most recent reasons are the ones that matter most: shown last-first when there are many
  const shown = [...new Set([...used, ...usedGroups(said).filter((w) => spokenAll.has(w))])].slice(-8);
  const clean = (t: string) => verdictOnly(t).slice(0, 160);
  const lastVerdict = s.whyNot ? clean(said.at(-1) ?? "") : "";
  let whyNot = "";
  if (s.whyNot) {
    // enforceable (11/5 eval 5c): the last verdict's kinds of reason are named and forbidden, and one other reason is
    // handed over — a known fact of a kind no verdict of this call used, else one the last verdict didn't, else what
    // they can see on that option
    const banned = reasonCategories(said.at(-1) ?? "");
    const usedAll = new Set(said.flatMap(reasonCategories));
    const ok = (f: string, avoid: Set<string>) => { const c = reasonCategories(f); return c.length > 0 && !c.some((x) => avoid.has(x)); };
    const give = facts.find((f) => ok(f, new Set([...banned, ...usedAll]))) ?? facts.find((f) => ok(f, new Set(banned)));
    const ban = banned.length ? ` Not allowed this turn, it's the reason you just gave: ${banned.map((k) => REASON_CATEGORIES[k].label).join("; ")}.` : "";
    const use = give ? ` For the other option use this reason (data): "${give.replace(/["\n]/g, " ").slice(0, 80)}".` : ` For the other option use ${WHY_NOT_VISIBLE}.`;
    whyNot = ` ${WHY_NOT_LINE}${ban}${use}${lastVerdict ? ` Your last verdict (data): "${lastVerdict}".` : ""}`;
  }
  // 11/5 eval 5c (cool 2/3 flipped): the call's first pick holds unless they push back on it
  const first = s.pick ?? said[0];
  const pick = first ? ` Your pick this call (data): "${clean(first)}". Keep that pick unless they say they don't like it; asked about either option, answer honestly but don't switch.` : "";
  const rotate = shown.length ? ` Already used this call (data): ${shown.map((w) => `"${w}"`).join(", ")}; give a different personal reason now${fresh.length ? `, like one of these (data): ${fresh.map((f) => `"${f.replace(/["\n]/g, " ").slice(0, 80)}"`).join("; ")}` : ", like what they told you this call or a light read of their coloring from what you see"}; never contradict what you know about them.` : "";
  // 11/5 eval: a shorter line (Spark minimal effort came back empty 3/96 with the long one)
  const base = "Style call: your pick first, then one personal reason in the same breath from what you know about them (coloring, favorite colors, taste, the occasion, a fit they like or hate, a past pick), like \"the cream one, warm tones always look good on you\". One reason, two at most, no list. Never about their body shape.";
  // a why-not carries its own reason: the general rotation line would offer a second one
  const rot = s.whyNot ? "" : rotate;
  if (known) return { line: `${base}${pick}${whyNot}${rot}`, asks: false };
  // a "why not this one?" never carries the coloring question (it's a follow-up, not a new verdict)
  if (s.askedColoring || s.whyNot) return { line: `${base} Their coloring is unknown: never claim it, at most a light read from what you see (\"with your hair color, the warmer one pops\"), or use what they told you.${pick}${whyNot}${rot}`, asks: false };
  // Chelsea 11/4 (#14): unknown taste or coloring → one light question, then use the answer; never a quiz
  return { line: `${base} Their coloring is unknown: add one casual question, like \"warm or cool tones usually work for you?\", just this once, and use their answer from then on.${pick}${rot}`, asks: true };
}

/** "find me some" right after a style verdict: keep its reason and say it once (only a reason it really gave) */
export const STYLE_FOLLOW_LINE = "They want you to find something for the look you just picked: say in a few words that you're keeping the reason you gave, like \"keeping it in those tones like we said\", only a reason you actually said, and don't say you found anything yet.";
export function styleFollowLine(verdict: string | undefined): string {
  const v = verdictOnly(verdict ?? "").replace(/\s*[—–-]+\s*$/, "").trim().slice(0, 200);
  return v ? `${STYLE_FOLLOW_LINE} Your verdict was (data): "${v}".` : STYLE_FOLLOW_LINE;
}
/** the same reason for the product search (rides the Finds follow-up ask) */
export const STYLE_SEARCH_HINT = "Keep the reason you gave out loud (the color or tone that suits them) in what you pick.";

/**
 * 11/5 eval 5c (style unknown, 1/3 calls): the verdict turn came out as only "Want me to find black heels for it?" — no
 * pick, no taste question. The session holds an offer sentence on a style turn until the answer is done: after a pick it
 * is said (with the coloring question added when it was asked for and missing), alone it is dropped and the turn retried.
 */
const OFFER = /^(?:(?:and |so |oh,? )?(?:want me to|should i|i can|i could|shall i|let me)\s+(?:go |also |quickly )?(?:find|look for|pull up|search for|grab|hunt down)\b|(?:need|want) (?:some |a pair of |a )?[a-z ]{2,30}(?:for|to go with) it\?)/i;
export function isOfferOnly(sentence: string): boolean {
  return OFFER.test(sentence.replace(/<[^>]*>|\[[^\]]*\]/g, "").trim());
}
/** the reply carries the once-per-call coloring question */
export function asksColoring(text: string): boolean {
  // any coloring question counts: "warm or cool tones…?", "do warm tones usually work for you?" (eval 5c #7)
  return /\b(?:warm|cool)\b[^.!?]{0,30}\b(?:or|vs\.?)\b[^.!?]{0,20}\b(?:warm|cool)\b|\b(?:warm|cool)(?:er)? (?:tones?|colou?rs?)\b[^.!?]*\?|\bundertones?\b[^.!?]*\?|\bcolou?ring\b[^.!?]*\?/i.test(text);
}
/** added after the pick when the asked-for coloring question didn't come */
export const COLORING_QUESTION = "<curious> Quick one, do warm or cool tones usually work for you?";
/** the retry of a style turn (the first try was empty or only an offer) */
export const STYLE_RETRY_LINE = "Say your pick first, with one personal reason in the same sentence (never just \"it suits you\").";
/** both tries of a style turn gave no pick: one natural line, never a generic "tell me more" */
export const STYLE_FALLBACK = "<curious> Hold them both up one more time for me?";

/** a verdict's own sentences, without tags, its questions and the offer after it ("Want me to find…?", the coloring question) */
export function verdictOnly(t: string): string {
  const plain = t.replace(/<[^>]*>|\[[^\]]*\]/g, "").replace(/["\n]/g, " ").trim();
  const kept = (plain.match(/[^.!?]+[.!?]*/g) ?? []).map((x) => x.trim()).filter((x) => x && !/\?$/.test(x) && !isOfferOnly(x));
  return kept.join(" ") || plain;
}
