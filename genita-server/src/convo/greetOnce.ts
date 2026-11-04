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
// each phrase must end its clause (Codex r1: "You made it through a tough interview" is praise, not a hello)
const END = String.raw`(?=\s*(?:[,.!?…—]|$))`;
const GREET_AGAIN = new RegExp(String.raw`\b(?:look (?:who(?:'s| is)?|at you)\b[^,.!?]*\b(?:show(?:ed|s)? up|here|back|made it|decided to [a-z]+|finally|crawl(?:ed|ing)? back|alive)${END}|(?:you\s+|she\s+)?(?:finally|actually)\s+(?:decided\s+to\s+)?(?:show(?:ed)?\s+up|made\s+it|call(?:ed)?|here|back|join(?:ed)?|pick(?:ed)?\s+up)${END}|(?:decided|bothered)\s+to\s+(?:show\s+up|call|join)${END}|there\s+you\s+are${END}|you(?:'re|\s+are)\s+back${END}|welcome\s+back${END}|you\s+made\s+it(?:\s+just\s+in\s+time)?${END}|(?:good|nice|glad|great|so good)\s+to\s+(?:finally\s+)?(?:hear|see|meet|talk\s+to|catch)\s+you(?:\s+(?:live|again|for\s+real))?${END}|(?:finally\s+)?(?:putting|put|get\s+to\s+put)\s+a\s+face\s+to\s+the\s+(?:name|voice|banter|mischief)${END}|finally\s+(?:live|talking\s+for\s+real|hear(?:ing)?\s+you)(?:\s+and\s+not\s+just\s+texting)?${END}|(?:oh\s+)?hey\s+stranger|long\s+time\s+no\s+(?:see|talk)|(?:i was )?starting to think you (?:ditched|forgot|ghosted))`, "i");
/** "Look who actually stayed up late with me" (bake-off-100 run3): a piece that opens with "look who" is a hello tease */
const LOOK_WHO = /^\s*(?:(?:oh|well|hey)\s+)?(?:look who\b(?!'?s talking| is talking)|look at you\s*$)/i;
const HELLO_ONLY = /^\s*(?:oh\s+|well\s+)?(?:hey|hi|hello|heya|hiya|yo|sup)(?:\s+(?:you|there|girl|dude|babe|friend))?\s*$/i;
const USER_HELLO = /^\s*(?:hey|hi|hello|heya|hiya|yo|sup|what'?s up|wassup)\b[\s\w'!.?,]{0,20}$/i;

/** a sentence carrying real help ("call 911", "988") is never cut by these guards (Codex r1/r2 P1) */
const HELP = /\b(?:911|988|999|112|000|police|doctor|hospital|urgent care|poison control|ambulance|crisis (?:line|text)|hotline|lifeline|emergency (?:services|room|number|line)|call (?:someone|a friend|for help|them now))\b/i;
const TAGS = /^(\s*(?:(?:<[^>]*>|\[[^\]]*\])\s*)*)/;

/**
 * A sentence once the call already has a reply from us: comma pieces that are a "you're here again" line go; a bare
 * hello left over stays only when their line was itself a hello. Returns "" when nothing is left to say.
 */
export function noRepeatGreeting(sentence: string, userText: string): string {
  const lead = TAGS.exec(sentence)?.[1] ?? "";
  const body = sentence.slice(lead.length);
  // real help is never cut (Codex r2 P1: "Call 911 now that you're back.")
  const end = /[.!?…]+["')\]]*\s*$/.exec(body)?.[0]?.trim() ?? ".";
  const pieces = body.replace(/[.!?…]+["')\]]*\s*$/, "").split(/\s*(?:,|—| - )\s*/);
  if (!(GREET_AGAIN.test(body) || pieces.some((p) => LOOK_WHO.test(p))) || HELP.test(body)) return sentence;
  // a piece goes only when the hello is what it says: at most two words left once the phrase is out
  const isGreet = (p: string) => LOOK_WHO.test(p) || (GREET_AGAIN.test(p) && p.replace(GREET_AGAIN, " ").trim().split(/\s+/).filter(Boolean).length <= 2);
  const kept = pieces.filter((p) => p.trim() && !isGreet(p));
  // a hello left alone is said only back to a hello ("hey" → "Hey you."); to anything else it's a second greeting
  // a lone word left (the name: "…, Summer.") is not a reply either
  const real = kept.filter((p) => !HELLO_ONLY.test(p) && p.trim().split(/\s+/).length > 1);
  const hello = kept.filter((p) => HELLO_ONLY.test(p));
  if (!real.length) return USER_HELLO.test(userText) ? `${lead}${cap(hello.join(", ") || "hey")}${end.replace(/\?/, ".")}` : "";
  // the hello itself goes too: the opener already said it
  return `${lead}${cap(real.join(", "))}${end}`;
}

const SEND_OFF = /\b(?:bye|goodbye|good ?night|night night|ttyl|talk (?:to you )?(?:later|soon|tomorrow)|catch you (?:later|soon)|see (?:you|ya) (?:later|soon|tomorrow)|(?:i want|give me|tell me) the full story after|go,? have fun)\b/i;
/** their line asks something ("can I throw in the leftover rice too?"): it needs an answer, never a send-off */
const ASKS = /\?\s*$|^\s*(?:can|could|should|would|will|do|does|is|are|what|how|which|why|when|where|who)\b/i;


/**
 * A send-off ("Go, have fun! I want the full story after.") to a question that isn't them leaving: its clause goes
 * ("Get into the shop now; talk later." → "Get into the shop now."), a sentence that is only a send-off returns "".
 * A plan ("I'm going to a party tonight") may still get "go have fun" (the persona's "nudge them to go").
 */
export function noUnpromptedGoodbye(sentence: string, userText: string): string {
  if (!ASKS.test(userText) || userIsLeaving(userText)) return sentence;
  const lead = TAGS.exec(sentence)?.[1] ?? "";
  const body = sentence.slice(lead.length);
  if (!SEND_OFF.test(body) || HELP.test(body)) return sentence;
  const end = /[.!?…]+["')\]]*\s*$/.exec(body)?.[0]?.trim() ?? ".";
  const kept = body.replace(/[.!?…]+["')\]]*\s*$/, "").split(/\s*(?:[,;]|—| - )\s*/).filter((p) => p.trim() && !SEND_OFF.test(p) && !/^(?:go|okay|ok|so|and|have fun|enjoy)$/i.test(p.trim()));
  return kept.length ? `${lead}${cap(kept.join(", "))}${end.replace(/!+/, ".")}` : "";
}

function cap(s: string): string {
  return s.replace(/^(\p{Ll})/u, (c) => c.toUpperCase());
}

/**
 * prompt-100 r2 (11/4 22:00): a call's first line that claims what they're doing today ("Hey Summer, hope that spicy
 * ramen with egg is happening tonight", "Tell me you're doing extra spicy", "figured you'd be due for ramen by now") is
 * an invented plan, even after the opener prompt said not to (bake-off-100, 2 of 4 big-import first calls). The first
 * such sentence becomes a plain warm hello; a later one goes. "finally" leaves a first line ("good to finally catch you").
 */
// a claimed activity or plan, never a wish or a safety check ("Hope you're having a good day", "Tell me you're safe": Codex r3)
const INVENTED = /\b(?:tell me (?:you'?re|there'?s|you are) (?:making|cooking|doing|eating|having|on|about to|[a-z]+ing (?:that|the|some))|hope (?:that|the|your)\b[^.!?]{0,60}\b(?:is happening|are happening|survived|is on the stove|is cooking)|hope you'?re (?:making|cooking|eating|having (?:that|the|some))|(?:figured|bet|guessing|betting) you'?(?:re|d|ll) (?:be )?(?:making|cooking|eating|having|due|craving|on|in)\b|(?:is|are) happening (?:tonight|today)|you(?:'re| are) (?:probably|totally|definitely) (?:making|cooking|eating|doing|having)|(?:wondered|was wondering) when (?:you'?d|you would|my [a-z ]{0,30}would) (?:show|call|pick|get|finally)|due for (?:some|a|an) [a-z ]{0,30}(?:ramen|noodles|food|snack|dinner|by now))/i;

/** opts.greeted: the session's "Hey, Summer!" opener already went out → the replacement is the question alone (Codex r3 P2) */
export function noInventedOpener(sentence: string, opts: { first: boolean; name?: string; greeted?: boolean }): string {
  const lead = TAGS.exec(sentence)?.[1] ?? "";
  let body = sentence.slice(lead.length);
  if (HELP.test(body)) return sentence;
  // only the "at last you're here" finally ("good to finally catch you", "finally caught you"), never "did you finally try it?"
  body = body.replace(/\b((?:good|nice|glad) to )finally (?=(?:catch|see|talk|hear|meet)\b)/i, "$1").replace(/\bfinally (?=(?:caught|catch) you\b)/i, "");
  // prod 22:04 "Hi, summer! Or did one win?": a first line that leans on a thread it never names
  const fragment = opts.first && /^(?:or|and|but)\b|^(?:did|has|have|was|is) (?:one|it|that|they) (?:win|won|work|happen|go|end|pan)\b/i.test(body.trim());
  if (!INVENTED.test(body) && !fragment) return `${lead}${cap(body.trim())}`;
  if (!opts.first) return "";
  if (opts.greeted) return `${lead}What are you up to?`;
  const first = opts.name?.trim().split(/\s+/)[0];
  return `${lead}Hey${first ? ` ${first}` : ""}! What are you up to?`;
}
