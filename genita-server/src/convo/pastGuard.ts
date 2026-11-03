/**
 * CV-01 (eval v2 11/4, 9 "invented past" lines in n=100): with nothing stored from earlier calls, Spark still talks as if
 * there were a history — a profile taste turned into a habit ("bet you're craving late-night ramen talk again", "you back
 * on that one AM aespa spiral again", "winging it like usual?") or a fake recall ("I remember the vibe was messy",
 * "you were super vague about that one"). The prompt line (memory/call.ts NO_PAST_LINE) asks for it; this is the
 * zero-cost code check behind it, per spoken sentence, only when the call has NO past (no memories, notes, last call
 * lines, or handed-off turns):
 *   - a habit adverb about them at a clause end ("… again.", "… like usual?") is cut, the sentence kept;
 *   - a sentence that claims a remembered earlier talk ("last time", "remember when", "you told me about",
 *     "I remember the vibe…") is dropped (the caller never empties a reply).
 * Whatever the user's own line says is fair to echo ("rejected again?" after "got rejected again"). Pure.
 */
export type PastContext = { past: boolean; userText: string; /** this call's user lines so far (what was really said) */ callText?: string };

const HABIT = /,?\s*\b(?:all over )?(?:again|as usual|like usual|like always|as always|per usual)\b(?=\s*[,.!?…]|\s*$)/giu;
// "say that again", "do it again", "try again": a request or a retry, not a claimed habit
const RETRY_BEFORE = /\b(?:say|said|try|tried|do|did|ask|asked|play|hear|run|start|repeat|read|explain|watch|show)(?:\s+(?:it|that|this|me|them))?\s*$/iu;
const CLAIMED_RECALL = new RegExp([
  // a shared past claimed ("like last time", "last time we…"), not a question about their own life ("when was the last time you cooked?")
  String.raw`\b(?:like|just like|same as|unlike|remember) last time\b|\blast time (?:we|i|you told me|you said|you were here)\b`,
  String.raw`\bremember when\b`,
  String.raw`\bthe other (?:day|night) (?:you|we)\b`,
  String.raw`\byou (?:told|showed) me (?:about|that|how|when)\b`,
  String.raw`\bwe (?:talked|were talking|chatted) about\b`,
  String.raw`\bi remember (?:you|your|when you|that you|how you|the vibe)\b`,
  String.raw`\byou were (?:so |super |really |kinda |pretty )?(?:vague|cagey|mysterious)\b`,
].join("|"), "iu");

const STOPW = new Set("about that this with your you told said remember when time last were what have just like really then they them there their from been tonight today".split(" "));
/** a content word of the sentence (≥4 letters) the user really said in this call */
function groundedInCall(sentence: string, callText: string): boolean {
  const said = new Set((callText.toLowerCase().match(/[a-z']{4,}/g) ?? []));
  return (sentence.toLowerCase().match(/[a-z']{4,}/g) ?? []).some((w) => !STOPW.has(w) && said.has(w));
}
function said(re: RegExp, text: string): boolean { re.lastIndex = 0; return re.test(text); }

// a habit no memory ever backs ("like usual", "as always"): cut even when the call has a past (eval v2 r2, 3/14 with memories)
const ALWAYS_HABIT = /,?\s*\b(?:as usual|like usual|per usual|as always|like always)\b(?=\s*[,.!?…]|\s*$)/giu;
/** the user said it themselves: fair to echo */
const USER_HABIT = /\b(?:again|as usual|like usual|per usual|as always|like always)\b/i;
// "you still on that aespa phase?" with no past: "still" claims they were before
// only a claimed ongoing habit / phase ("still on that", "still obsessed", "still making"), never a plain fact the
// call itself gave ("You still have that interview tomorrow" — session test, Codex #423)
const STILL = /\b(you(?:'re| are)?|u|are you|you guys)\s+still\b\s*(?=(?:on|into|obsessed|stuck|hooked|doing|making|listening|watching|playing|eating|cooking|up|awake|at it|in your|in that|going|living)\b|[a-z]+ing\b)/giu;

export function unbackedPast(sentence: string, ctx: PastContext): string {
  if (!sentence.trim()) return sentence;
  const user = ctx.userText ?? "";
  if (ctx.past) {
    if (USER_HABIT.test(user)) return sentence;
    ALWAYS_HABIT.lastIndex = 0;
    const out = sentence.replace(ALWAYS_HABIT, "");
    return /[\p{L}\p{N}]/u.test(out.replace(/<[^>]*>|\[[^\]]*\]/g, "")) ? out : sentence;
  }
  if (!said(STILL, user)) { STILL.lastIndex = 0; sentence = sentence.replace(STILL, "$1 "); }
  // Codex #536 P2: "You told me your interview is tomorrow" after they said it in THIS call is real, not invented
  if (CLAIMED_RECALL.test(sentence) && !CLAIMED_RECALL.test(user) && !groundedInCall(sentence, `${ctx.callText ?? ""} ${user}`)) return "";
  if (USER_HABIT.test(user)) return sentence;
  HABIT.lastIndex = 0;
  const out = sentence.replace(HABIT, (m, offset: number, whole: string) => (RETRY_BEFORE.test(whole.slice(0, offset)) ? m : ""));
  // nothing but tags / punctuation left: keep the original (the caller decides; never an empty "?")
  return /[\p{L}\p{N}]/u.test(out.replace(/<[^>]*>|\[[^\]]*\]/g, "")) ? out : sentence;
}
