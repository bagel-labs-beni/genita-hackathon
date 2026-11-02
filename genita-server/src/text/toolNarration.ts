/**
 * Narrow list of tool announcements, not general hesitation or real content.
 * The caller must also establish a tool call or subsequent content before
 * dropping one. Physical actions ("check the oven") and recollections stay.
 */
const TARGET = "(?:my memory|our (?:past |previous )?conversations|what you (?:told|said to) me|that|this|it)";
const QUERY = "(?: (?:for|about) [^,;:.!?—]+)?";
const LOOKUP = `(?:check ${TARGET}${QUERY}|search (?:my memory|the web)${QUERY}|look (?:up (?!at\\b|to\\b)[^,;:.!?—]+|(?:that|this|it) up)|recall ${TARGET}${QUERY}|remember (?:that|this|it)|save (?:that|this|it) to memory)`;
const INTENT = new RegExp(`^(?:i'll|i will|let me) ${LOOKUP}$`);
const WAIT_LOOKUP = new RegExp(`^(?:one sec(?:ond)?|give me a sec(?:ond)?|just a moment)[, ]+(?:while i (?:${LOOKUP})|(?:looking (?:that|this|it) up|checking my memory|searching (?:my memory|the web))${QUERY})$`);

export function isToolNarration(sentence: string): boolean {
  const s = sentence.trim().replace(/’/g, "'").replace(/\s+/g, " ").replace(/[.!?…,;:—。！？]+$/u, "").trim().toLowerCase();
  // Favor keeping a mixed clause over losing an answer or a real-world action.
  if (/\b(?:and|but|so|because|then)\b/.test(s)) return false;
  // Future/intended lookup or save; never a statement of the result.
  if (INTENT.test(s) || WAIT_LOOKUP.test(s)) return true;
  // Korean future lookup/save forms only, optionally after a short wait.
  return /^(?:(?:잠깐|잠시만요?|잠시)[, ]+)?(?:(?:(?:기억을?|네가 말해준 내용을|전에 (?:말한|나눈) (?:내용을|대화를)) )?(?:찾아\s?볼게요?|확인해\s?볼게요?)|검색해\s?볼게요?|기억해\s?둘게요?)$/u.test(s);
}

/** Eager TTS may split this preface at its comma before the lookup arrives. */
export function isToolNarrationLead(sentence: string): boolean {
  return /^(?:one sec(?:ond)?|give me a sec(?:ond)?|just a moment|잠깐|잠시만요?|잠시)[,;:—]$/iu.test(sentence.trim());
}
