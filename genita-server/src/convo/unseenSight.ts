/**
 * b10 gate (11/4, intel n=5): with no camera or screen frame in the call, Spark still talks as if it saw the thing —
 * "That looks dangerously good." (the user only said "ok it's done"), "Hey, good to see you again." (a voice call).
 * Dropping the sentence loses a good reaction, so the sight word becomes a hearing one: "That sounds dangerously good.",
 * "good to hear from you again". Only when nothing was seen this turn; "looks like" a plan / rain is left alone. Pure.
 */
// Codex #660 r1: "that look" is the noun ("I love that look with sneakers"): singular subjects only with the verb "looks"
const THING_LOOKS = /\b(?:(that|this|it)(\s+(?:totally|really|so|just|honestly|lowkey|already|kinda|definitely)\s+|\s+)(looks)|(those|these)(\s+(?:totally|really|so|just|honestly|lowkey|already|kinda|definitely)\s+|\s+)(look))\b(?!\s+like\b)/gi;
const THING_IS_LOOKING = /\b(that'?s|this'?s|it'?s|that is|this is|it is)\s+(looking)\b(?!\s+(?:for|at|into|up|forward)\b)/gi;
const SEE_YOU = /\b(good|nice|great|lovely|so good)\s+to\s+see\s+you\b/gi;
/** the sentence as said when nothing was seen this turn (camera and screen both off) */
export function unseenToHeard(sentence: string, seen: boolean): string {
  if (seen || !sentence) return sentence;
  return sentence
    .replace(THING_LOOKS, (_m, w1?: string, mid1?: string, _v1?: string, w2?: string, mid2?: string) => (w1 ? `${w1}${mid1}sounds` : `${w2}${mid2}sound`))
    .replace(THING_IS_LOOKING, (_m, w: string) => `${w} sounding`)
    .replace(SEE_YOU, (_m, g: string) => `${g} to hear from you`);
}
