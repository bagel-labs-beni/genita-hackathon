/**
 * b10 gate (11/4, intel n=5): with no camera or screen frame in the call, Spark still talks as if it saw the thing —
 * "That looks dangerously good." (the user only said "ok it's done"), "Hey, good to see you again." (a voice call).
 * Dropping the sentence loses a good reaction, so the sight word becomes a hearing one: "That sounds dangerously good.",
 * "good to hear from you again". Only when nothing was seen this turn; "looks like" a plan / rain is left alone. Pure.
 */
const THING_LOOKS = /\b(that|this|it|those|these)(\s+(?:totally|really|so|just|honestly|lowkey|already|kinda|definitely)\s+|\s+)(looks|look)\b(?!\s+like\b)/gi;
const THING_IS_LOOKING = /\b(that'?s|this'?s|it'?s|that is|this is|it is)\s+(looking)\b(?!\s+(?:for|at|into|up|forward)\b)/gi;
const SEE_YOU = /\b(good|nice|great|lovely|so good)\s+to\s+see\s+you\b/gi;
/** the sentence as said when nothing was seen this turn (camera and screen both off) */
export function unseenToHeard(sentence: string, seen: boolean): string {
  if (seen || !sentence) return sentence;
  return sentence
    .replace(THING_LOOKS, (_m, w: string, mid: string, v: string) => `${w}${mid}${v === "look" ? "sound" : "sounds"}`)
    .replace(THING_IS_LOOKING, (_m, w: string) => `${w} sounding`)
    .replace(SEE_YOU, (_m, g: string) => `${g} to hear from you`);
}
