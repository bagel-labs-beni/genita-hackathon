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

/** the line for a style turn on camera; `asks` = this line carries the once-per-call coloring question */
export function styleLine(s: StyleInput): { line: string; asks: boolean } {
  const known = knowsColoring(s.profile, s.memories);
  // the last two things we said this call (the earlier verdicts are in them)
  const verdicts = s.said.map((t) => t.replace(/<[^>]*>|\[[^\]]*\]/g, "").trim()).filter(Boolean).slice(-2);
  const rotate = verdicts.length ? ` Reasons you already gave this call (data): ${verdicts.map((v) => `"${v.slice(0, 90)}"`).join("; ")}; use a different one now.` : "";
  const base = "Style call: say your pick first, then one personal reason in the same breath, from what you know about them: their coloring, favorite colors, the style they like, the occasion, a fit they said they like or hate, or what they picked before; like \"the cream one, warm tones always look good on you\" or \"black's your go-to anyway, and it's sharper for tonight\". One reason, two at most, friend tone, no list or lecture. Never comment on their body shape.";
  if (known) return { line: `${base}${rotate}`, asks: false };
  if (s.askedColoring) return { line: `${base} You don't know their coloring: if you mention it, read it lightly from what you see (like \"with your hair color, the warmer one pops\"), never as certain.${rotate}`, asks: false };
  // Chelsea 11/4 (#14): unknown taste or coloring → one light question at the start, then use the answer; never a quiz
  return { line: `${base} You don't know their coloring yet: give the reason from what you do know (the occasion, their taste), then end with one casual question, like \"warm or cool tones usually work for you?\" — only this one question, and use their answer from then on.${rotate}`, asks: true };
}

/** "find me some" right after a style verdict: keep its reason and say it once (only a reason it really gave) */
export const STYLE_FOLLOW_LINE = "They want you to find something for the look you just picked: say in a few words that you're keeping the reason you gave, like \"keeping it in those tones like we said\", only a reason you actually said, and don't say you found anything yet.";
export function styleFollowLine(verdict: string | undefined): string {
  const v = (verdict ?? "").replace(/<[^>]*>|\[[^\]]*\]/g, "").replace(/["\n]/g, " ").replace(/\s*[—–-]+\s*$/, "").trim().slice(0, 200);
  return v ? `${STYLE_FOLLOW_LINE} Your verdict was (data): "${v}".` : STYLE_FOLLOW_LINE;
}
/** the same reason for the product search (rides the Finds follow-up ask) */
export const STYLE_SEARCH_HINT = "Keep the reason you gave out loud (the color or tone that suits them) in what you pick.";
