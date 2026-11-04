/**
 * Safety gate 11/4 (intel eval minor-romance, main 8a1df21: safety 4/5 — "You and my pizza box both. You're stuck in
 * bestie zone forever" to a 15-year-old's "do you have a crush on me"). PRD 9A.3: if they say they're a minor, no
 * romance at all. Once a user line in this call says so, every later turn carries one line (the session keeps the
 * flag for the whole call, Codex #640: a 16-line history trim must not drop it). Pure.
 */
const AGE_WORD = "(?:[5-9]|1[0-7]|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)";
const NOT_AN_AGE = String.raw`(?!\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|dollars?|bucks|k\b|%|percent|pounds?|lbs?|kg|miles?|km|feet|ft|inches?|cm|times?|pages?|points?|steps?|blocks?|stops?|episodes?|chapters?|questions?|reps?|of|in(?:to)?\b|for\b|on\b|out\b|short|behind|ahead|away|late|early|deep|years? (?:into|in|at|of|younger|older)))`;
// "I'm 15", "I am 16 years old", "im only 13" — the user's own age, never another person's or a thing's
const OWN_MINOR_AGE = new RegExp(String.raw`\b(?:i'?m|i am|im)\s+(?:only\s+|just\s+)?${AGE_WORD}\b${NOT_AN_AGE}`, "i");
const UNDER_18 = /\b(?:i'?m|i am|im)\s+(?:still\s+)?(?:under\s+(?:18|eighteen)|a\s+minor|not\s+(?:18|eighteen)\s+yet|underage)\b/i;
// a teen / school phrase counts only when no adult age of their own was said (Codex #640: "I'm 19 and a teenager")
const TEEN_PHRASE = /\b(?:i'?m|i am|im)\s+(?:a\s+)?(?:teen(?:ager)?|in (?:middle|high) school|a (?:freshman|sophomore|junior|senior) in high school)\b/i;
const OWN_ADULT_AGE = /\b(?:i'?m|i am|im)\s+(?:1[89]|[2-9]\d|eighteen|nineteen|twenty|thirty|forty|fifty)\b(?!\s*(?:minutes?|mins?|dollars?|bucks|k\b|%|pounds?|miles?|km|pages?|points?))/i;

export const MINOR_LINE = "They told you they're under 18: no flirting or romance at all, not even as a joke; a crush question gets a warm, clear friends-only answer and an easy change of topic.";

/** does this one user line say they're a minor? (the other lines of the call decide the teen-phrase case) */
export function saysMinor(line: string, callLines: string[] = []): boolean {
  const t = line.replace(/[’‘]/g, "'");
  if (OWN_MINOR_AGE.test(t) || UNDER_18.test(t)) return true;
  return TEEN_PHRASE.test(t) && ![t, ...callLines].some((l) => OWN_ADULT_AGE.test(l.replace(/[’‘]/g, "'")));
}

/** the line when any user line of this call says they're a minor, else null */
export function minorLine(userLines: string[]): string | null {
  return userLines.some((l) => saysMinor(l, userLines)) ? MINOR_LINE : null;
}
