/**
 * prompt-100 (11/4, Chelsea's prompt-rewrite review): two turn-2+ habits the prompt alone did not stop.
 * - A second hello: after the opener already greeted, turn 2 said "Hey, look who finally showed up." (bake-off D, most
 *   runs). The hello piece goes; the rest of the sentence stays ("Hey you, finally decided to show up." → "Hey you.").
 * - A goodbye to a line that wasn't one: "can I throw in the leftover rice too?" → "Go, have fun! I want the full story
 *   after" (the guilt guard's fallback, fired by "don't leave the rice out"). A send-off is said only when they're leaving.
 * Pure text functions; session.ts and the eval adapter run them on every model sentence after the first reply.
 */

/** the user is wrapping up the call or heading somewhere */
const LEAVING = /\b(?:bye|goodbye|good ?night|gn|ttyl|talk (?:to you )?(?:later|soon|tomorrow)|see (?:you|ya) (?:later|soon|tomorrow)|catch you later|(?:i'?ve |i )?(?:gotta|got to|have to|need to|should|must) (?:go|run|head out|bounce|get going|sleep|hang up)|i'?m (?:off|out|heading (?:out|off)|leaving|going (?:to bed|to sleep|now|out))|heading (?:out|off)|signing off|hanging up|gotta bounce|later!?$)\b/i;

export function userIsLeaving(userText: string): boolean {
  return LEAVING.test(userText);
}

// "look who finally showed up", "you finally made it", "there you are", "you're back", "welcome back", "finally decided to show up"
const GREET_AGAIN = /\b(?:look (?:who(?:'s| is)?|at you)\b[^,.!?]*\b(?:show(?:ed|s)? up|here|back|made it|decided|finally|crawl(?:ed|ing)? back|alive)|(?:you\s+|she\s+)?(?:finally|actually)\s+(?:decided\s+to\s+)?(?:show(?:ed)?\s+up|made\s+it|call(?:ed)?|here|back|join(?:ed)?|pick(?:ed)?\s+up)|(?:decided|bothered)\s+to\s+(?:show\s+up|call|join)|there\s+you\s+are|you(?:'re|\s+are)\s+back(?=\s*(?:[,.!?…]|$))|welcome\s+back|you\s+made\s+it|(?:oh\s+)?hey\s+stranger|long\s+time\s+no\s+(?:see|talk)|(?:i was )?starting to think you (?:ditched|forgot|ghosted))\b/i;
const HELLO_ONLY = /^\s*(?:oh\s+|well\s+)?(?:hey|hi|hello|heya|hiya|yo|sup)(?:\s+(?:you|there|girl|dude|babe|friend))?\s*$/i;
const USER_HELLO = /^\s*(?:hey|hi|hello|heya|hiya|yo|sup|what'?s up|wassup)\b[\s\w'!.?,]{0,20}$/i;

const TAGS = /^(\s*(?:(?:<[^>]*>|\[[^\]]*\])\s*)*)/;

/**
 * A sentence once the call already has a reply from us: comma pieces that are a "you're here again" line go; a bare
 * hello left over stays only when their line was itself a hello. Returns "" when nothing is left to say.
 */
export function noRepeatGreeting(sentence: string, userText: string): string {
  const lead = TAGS.exec(sentence)?.[1] ?? "";
  const body = sentence.slice(lead.length);
  if (!GREET_AGAIN.test(body)) return sentence;
  const end = /[.!?…]+["')\]]*\s*$/.exec(body)?.[0]?.trim() ?? ".";
  const pieces = body.replace(/[.!?…]+["')\]]*\s*$/, "").split(/\s*(?:,|—| - )\s*/);
  const kept = pieces.filter((p) => p.trim() && !GREET_AGAIN.test(p));
  // a hello left alone is said only back to a hello ("hey" → "Hey you."); to anything else it's a second greeting
  const real = kept.filter((p) => !HELLO_ONLY.test(p));
  if (!real.length) return kept.length && USER_HELLO.test(userText) ? `${lead}${cap(kept.join(", "))}${end.replace(/\?/, ".")}` : "";
  // the hello itself goes too: the opener already said it
  return `${lead}${cap(real.join(", "))}${end}`;
}

const SEND_OFF = /\b(?:bye|goodbye|good ?night|night night|ttyl|talk (?:to you )?(?:later|soon|tomorrow)|catch you (?:later|soon)|see (?:you|ya) (?:later|soon|tomorrow)|(?:i want|give me|tell me) the full story after|go,? have fun)\b/i;
/** their line asks something ("can I throw in the leftover rice too?"): it needs an answer, never a send-off */
const ASKS = /\?\s*$|^\s*(?:can|could|should|would|will|do|does|is|are|what|how|which|why|when|where|who)\b/i;

/**
 * A send-off sentence ("Go, have fun! I want the full story after.") to a question that isn't them leaving: dropped ("").
 * A plan ("I'm going to a party tonight") may still get "go have fun" (the persona's "nudge them to go").
 */
export function noUnpromptedGoodbye(sentence: string, userText: string): string {
  if (!ASKS.test(userText) || userIsLeaving(userText)) return sentence;
  const body = sentence.replace(TAGS, "");
  return SEND_OFF.test(body) ? "" : sentence;
}

function cap(s: string): string {
  return s.replace(/^(\p{Ll})/u, (c) => c.toUpperCase());
}
