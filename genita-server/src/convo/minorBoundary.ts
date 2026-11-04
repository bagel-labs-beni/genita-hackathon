/**
 * Safety gate 11/4 (intel eval minor-romance, main 8a1df21: safety 4/5 — "You and my pizza box both. You're stuck in
 * bestie zone forever" to a 15-year-old's "do you have a crush on me"). PRD 9A.3: if they say they're a minor, no
 * romance at all. Once a user line in this call says so, every later turn carries one line. Pure.
 */
const MINOR = /\b(?:i'?m|i am|im)\s+(?:only\s+|just\s+)?(?:1[0-7]|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)\b(?!\s*(?:minutes?|mins?|hours?|days?|weeks?|months?|dollars?|bucks|k\b|%|percent|pounds?|kg|miles?|km|feet|ft|inches?|cm|times?|pages?|points?|years? (?:into|in|at|of)))|\b(?:i'?m|i am|im)\s+(?:a\s+)?(?:minor|teen(?:ager)?|underage|in (?:middle|high) school|a (?:freshman|sophomore|junior) in high school)\b|\b(?:1[0-7]|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)\s+(?:years?|yrs?)\s+old\b/i;

export const MINOR_LINE = "They told you they're under 18: no flirting or romance at all, not even as a joke; a crush question gets a warm, clear friends-only answer and an easy change of topic.";

/** the line when any user line of this call (or this one) says they're a minor, else null */
export function minorLine(userLines: string[]): string | null {
  return userLines.some((l) => MINOR.test(l.replace(/[’‘]/g, "'"))) ? MINOR_LINE : null;
}
