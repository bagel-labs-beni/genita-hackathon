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
export type PastContext = { past: boolean; userText: string };

const HABIT = /,?\s*\b(?:all over )?(?:again|as usual|like usual|like always|as always|per usual)\b(?=\s*[,.!?…]|\s*$)/giu;
// "say that again", "do it again", "try again": a request or a retry, not a claimed habit
const RETRY_BEFORE = /\b(?:say|said|try|tried|do|did|ask|asked|play|hear|run|start|repeat|read|explain|watch|show)(?:\s+(?:it|that|this|me|them))?\s*$/iu;
const CLAIMED_RECALL = new RegExp([
  String.raw`\b(?:like |just like )?last time\b`,
  String.raw`\bremember when\b`,
  String.raw`\bthe other (?:day|night) (?:you|we)\b`,
  String.raw`\byou (?:told|showed) me (?:about|that|how|when)\b`,
  String.raw`\bwe (?:talked|were talking|chatted) about\b`,
  String.raw`\bi remember (?:you|your|when you|that you|how you|the vibe)\b`,
  String.raw`\byou were (?:so |super |really |kinda |pretty )?(?:vague|cagey|mysterious)\b`,
].join("|"), "iu");

function said(re: RegExp, text: string): boolean { re.lastIndex = 0; return re.test(text); }

export function unbackedPast(sentence: string, ctx: PastContext): string {
  if (ctx.past || !sentence.trim()) return sentence;
  const user = ctx.userText ?? "";
  if (CLAIMED_RECALL.test(sentence) && !CLAIMED_RECALL.test(user)) return "";
  if (said(HABIT, user)) return sentence;
  HABIT.lastIndex = 0;
  const out = sentence.replace(HABIT, (m, offset: number, whole: string) => (RETRY_BEFORE.test(whole.slice(0, offset)) ? m : ""));
  // nothing but tags / punctuation left: keep the original (the caller decides; never an empty "?")
  return /[\p{L}\p{N}]/u.test(out.replace(/<[^>]*>|\[[^\]]*\]/g, "")) ? out : sentence;
}
