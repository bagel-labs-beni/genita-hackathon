/**
 * Narrow list of tool announcements, not general hesitation or real content.
 * The caller must also establish a tool call or subsequent content before
 * dropping one. Physical actions ("check the oven") and recollections stay.
 */
const TARGET = "(?:my memory|our (?:past |previous )?conversations|what you (?:told|said to) me|that|this|it)";
const QUERY = "(?: (?:for|about) [^,;:.!?—]+)?";
const LOOKUP = `(?:check ${TARGET}${QUERY}|search (?:my memory|the web)${QUERY}|look (?:up (?!at\\b|to\\b)[^,;:.!?—]+|(?:that|this|it) up)|recall ${TARGET}${QUERY}|remember (?:that|this|it)|save (?:that|this|it) to memory)`;
const INTENT = new RegExp(`^(?:i'll|i will|let me) ${LOOKUP}$`);
const SEPARATOR = "[,;:— ]+";
const WAIT = "(?:one sec(?:ond)?|give me a sec(?:ond)?|just a moment)";
const KOREAN_WAIT = "(?:잠깐|잠시만요?|잠시)";
const INTERJECTION = "(?:hm+|um+|uh+|oh|ah|well)";
const INTERJECTION_PREFIX = new RegExp(`^(?:${INTERJECTION}${SEPARATOR})+`);
const WAIT_LOOKUP = new RegExp(`^${WAIT}${SEPARATOR}(?:while i (?:${LOOKUP})|(?:looking (?:that|this|it) up|checking my memory|searching (?:my memory|the web))${QUERY})$`);
const NARRATION_LEAD = new RegExp(`^(?:${WAIT}|${KOREAN_WAIT}|${INTERJECTION})${SEPARATOR}$`, "iu");
const KOREAN_LOOKUP = new RegExp(`^(?:${KOREAN_WAIT}${SEPARATOR})?(?:(?:(?:기억을?|네가 말해준 내용을|전에 (?:말한|나눈) (?:내용을|대화를)) )?(?:찾아\\s?볼게요?|확인해\\s?볼게요?)|검색해\\s?볼게요?|기억해\\s?둘게요?)$`, "u");

export function isToolNarration(sentence: string): boolean {
  const s = sentence.trim().replace(/’/g, "'").replace(/\s+/g, " ").replace(/[.!?…,;:—。！？]+$/u, "").trim().toLowerCase().replace(INTERJECTION_PREFIX, "");
  // Favor keeping a mixed clause over losing an answer or a real-world action.
  if (/\b(?:and|but|so|because|then)\b/.test(s)) return false;
  // Future/intended lookup or save; never a statement of the result.
  if (INTENT.test(s) || WAIT_LOOKUP.test(s)) return true;
  // Korean future lookup/save forms only, optionally after a short wait.
  return KOREAN_LOOKUP.test(s);
}

/** Hold a wait or interjection until the following clause can be judged. */
export function isToolNarrationLead(sentence: string): boolean {
  return NARRATION_LEAD.test(sentence.trim());
}
