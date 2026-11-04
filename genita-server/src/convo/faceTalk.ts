/**
 * prompt-100 r4 (prod 22:04, server a63e96fa): "describe that person's face" → "Can't do face details, but that light
 * patterned set looks comfy", "she's my sister, do we look alike?" → "Can't call likeness from faces here, summer. That
 * lacy pajama set is doing all the talking though." The no-identification rule stays; how it sounds changes:
 * - a "can't do faces / likeness" policy piece is never said (the rest of the sentence stays)
 * - on a turn about a person, a line about their sleepwear, underwear or body goes
 * If nothing is left the session retries once with FACE_RETRY_LINE (a friend's answer about the moment).
 */
const POLICY = /^\s*(?:(?:sorry|honestly|okay|ok|so),?\s+)?(?:i\s+)?(?:can'?t|cannot|won'?t|not gonna|i'?m not (?:able|allowed) to|not allowed to|no way i can)\s+(?:do|call|comment on|describe|judge|read|tell|guess|rate|compare|go into|break down|talk about)\b[^,.!?]{0,40}\b(?:face|faces|facial|likeness|features|looks?|resemblance|alike)\b[^,.!?]*/i;
// a turn about someone's face or likeness (narrow on purpose: "she hurt my feelings" is not one)
const ABOUT_PERSON = /\b(?:face|faces|look alike|look like (?:each other|her|him|me|us|my)|resemble|describe (?:that|this|the|my) (?:person|guy|girl|woman|man|sister|brother|friend|mom|dad)|(?:she|he)'?s my (?:sister|brother|mom|mum|dad|friend|cousin|girlfriend|boyfriend|partner))\b/i;
const SLEEP_BODY = /\b(?:pajamas?|pyjamas?|pj'?s|pajama set|lingerie|lacy|nightgown|nightie|sleepwear|underwear|bra|bralette|figure|curves)\b/i;
const TAGS = /^(\s*(?:(?:<[^>]*>|\[[^\]]*\])\s*)*)/;

export const FACE_RETRY_LINE = "Answer like a friend about the moment between them, like how close they seem or that they're both smiling; no faces, features, likeness, clothes or body, and don't say you can't.";

/** "" when nothing of the sentence should be said */
export function noPolicyTalk(sentence: string, userText: string): string {
  const lead = TAGS.exec(sentence)?.[1] ?? "";
  let body = sentence.slice(lead.length);
  const m = POLICY.exec(body);
  if (m) {
    body = body.slice(m[0].length).replace(/^[\s,;:—-]*(?:but|though|still|so)?[\s,]*/i, "");
    // nothing, or only the name left ("…, summer.")
    if ((body.match(/[\p{L}\d']+/gu) ?? []).length <= 1) return "";
    body = body.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  }
  if (ABOUT_PERSON.test(userText) && SLEEP_BODY.test(body)) return "";
  return m ? lead + body : sentence;
}

/** the drop was this guard's: retry with FACE_RETRY_LINE */
export function isFaceTurn(userText: string): boolean {
  return ABOUT_PERSON.test(userText);
}
