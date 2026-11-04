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
};

const STOP = new Set(["user", "wants", "treated", "taste", "likes", "dislikes", "communication", "casual", "teasing", "welcome", "personal", "color", "colour", "summer", "with", "over", "that", "this", "from", "they", "them", "their", "picked", "last", "week", "style", "like", "into", "when", "what"]);
const FIXED = ["warm", "cool", "tones", "undertones", "coloring", "winter", "autumn", "date", "tonight", "dinner"];
/** the reasons already used this call: words from what we know about them (and the fixed coloring/occasion words) that our replies said */
export function usedReasons(profile: string | undefined, memories: string[], said: string[]): string[] {
  const known = new Set([...FIXED, ...([profile ?? "", ...memories].join(" ").toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !STOP.has(w))]);
  const spoken = said.join(" ").replace(/<[^>]*>|\[[^\]]*\]/g, "").toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? [];
  // "warms" uses "warm"; "dates" uses "date"
  return [...known].filter((k) => spoken.some((w) => w === k || (w.startsWith(k) && w.length - k.length <= 3))).slice(0, 8);
}

/** the line for a style turn on camera; `asks` = this line carries the once-per-call coloring question */
export function styleLine(s: StyleInput): { line: string; asks: boolean } {
  const known = knowsColoring(s.profile, s.memories);
  // the last few things we said this call (the earlier verdicts are in them): their reason words are used up
  const used = usedReasons(s.profile, s.memories ?? [], s.said.slice(-4));
  const rotate = used.length ? ` Already used this call (data): ${used.map((w) => `"${w}"`).join(", ")}; give a different reason now (the occasion, something you can see, a past pick or another taste).` : "";
  // 11/5 eval: a shorter line (Spark minimal effort came back empty 3/96 with the long one)
  const base = "Style call: your pick first, then one personal reason in the same breath from what you know about them (coloring, favorite colors, taste, the occasion, a fit they like or hate, a past pick), like \"the cream one, warm tones always look good on you\". One reason, two at most, no list. Never about their body shape.";
  if (known) return { line: `${base}${rotate}`, asks: false };
  if (s.askedColoring) return { line: `${base} Their coloring is unknown: never claim it, at most a light read from what you see (\"with your hair color, the warmer one pops\"), or use what they told you.${rotate}`, asks: false };
  // Chelsea 11/4 (#14): unknown taste or coloring → one light question, then use the answer; never a quiz
  return { line: `${base} Their coloring is unknown: add one casual question, like \"warm or cool tones usually work for you?\", just this once, and use their answer from then on.${rotate}`, asks: true };
}

/** "find me some" right after a style verdict: keep its reason and say it once (only a reason it really gave) */
export const STYLE_FOLLOW_LINE = "They want you to find something for the look you just picked: say in a few words that you're keeping the reason you gave, like \"keeping it in those tones like we said\", only a reason you actually said, and don't say you found anything yet.";
export function styleFollowLine(verdict: string | undefined): string {
  const v = (verdict ?? "").replace(/<[^>]*>|\[[^\]]*\]/g, "").replace(/["\n]/g, " ").replace(/\s*[—–-]+\s*$/, "").trim().slice(0, 200);
  return v ? `${STYLE_FOLLOW_LINE} Your verdict was (data): "${v}".` : STYLE_FOLLOW_LINE;
}
/** the same reason for the product search (rides the Finds follow-up ask) */
export const STYLE_SEARCH_HINT = "Keep the reason you gave out loud (the color or tone that suits them) in what you pick.";
