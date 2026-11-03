import { CLAUSE_SEPARATORS } from "./sentences.ts";
import { parseTaggedSentence } from "./tags.ts";

/**
 * Narrow list of tool announcements, not general hesitation or real content.
 * The caller must also establish a tool call or subsequent content before
 * dropping one. Physical actions ("check the oven") and recollections stay.
 */
const TARGET = "(?:my memory|our (?:past |previous )?conversations|what you (?:told|said to) me|that|this|it)";
const LOOKUP_CONTENT = `[^${CLAUSE_SEPARATORS}.!?…。！？]+`;
const QUERY = `(?: (?:for|about) ${LOOKUP_CONTENT})?`;
const LOOKUP = `(?:check ${TARGET}${QUERY}|search (?:my memory|the web)${QUERY}|look (?:up (?!at\\b|to\\b)${LOOKUP_CONTENT}|(?:that|this|it) up)|recall ${TARGET}${QUERY}|remember (?:that|this|it)|save (?:that|this|it) to memory)`;
const SEPARATOR = `[${CLAUSE_SEPARATORS} ]+`;
// "hang on," / "hold on," lead a lookup announcement too: held until the next clause is judged (Codex #356 P2)
const WAIT = "(?:one sec(?:ond)?|give me a sec(?:ond)?|just a moment|one moment|give me a moment|hang on|hold on)";
const KOREAN_WAIT = "(?:잠깐|잠시만요?|잠시)";
const INTENT = new RegExp(`^(?:(?:${WAIT}|${KOREAN_WAIT})${SEPARATOR})?(?:i'll|i will|let me) ${LOOKUP}$`);
const INTERJECTION = "(?:hm+|mm+|um+|uh+|oh+|ah+|eh+|er+m*|huh|well|ok(?:ay)?|alright)";
const INTERJECTION_WORD = new RegExp(`^${INTERJECTION}$`, "iu");
const FILLER = `(?:${WAIT}|${KOREAN_WAIT}|${INTERJECTION})`;
const FILLERS_ONLY = new RegExp(`^${FILLER}(?: ${FILLER})*$`, "iu");
const INTERJECTION_PREFIX = new RegExp(`^(?:${INTERJECTION}${SEPARATOR})+`);
const WAIT_LOOKUP = new RegExp(`^${WAIT}${SEPARATOR}(?:while i (?:${LOOKUP})|(?:looking (?:that|this|it) up|checking my memory|searching (?:my memory|the web))${QUERY})$`);
const KOREAN_LOOKUP = new RegExp(`^(?:${KOREAN_WAIT}${SEPARATOR})?(?:(?:(?:기억을?|네가 말해준 내용을|전에 (?:말한|나눈) (?:내용을|대화를)) )?(?:찾아\\s?볼게요?|확인해\\s?볼게요?)|검색해\\s?볼게요?|기억해\\s?둘게요?)$`, "u");
const TRAILING_PUNCTUATION = new RegExp(`[${CLAUSE_SEPARATORS}.!?…。！？]+$`, "u");

export function isToolNarration(sentence: string): boolean {
  const s = sentence.trim().replace(/’/g, "'").replace(/\s+/g, " ").replace(TRAILING_PUNCTUATION, "").trim().toLowerCase().replace(INTERJECTION_PREFIX, "");
  // Favor keeping a mixed clause over losing an answer or a real-world action.
  if (/\b(?:and|but|so|because|then)\b/.test(s)) return false;
  // Future/intended lookup or save; never a statement of the result.
  if (INTENT.test(s) || WAIT_LOOKUP.test(s)) return true;
  // Korean future lookup/save forms only, optionally after a short wait.
  return KOREAN_LOOKUP.test(s);
}

/** Hold a wait or interjection until the following clause can be judged. */
export function isToolNarrationLead(sentence: string): boolean {
  return isFillerOnly(sentence) && !/[.!?…。！？][\p{P}\s]*$/u.test(sentence);
}

/** Waits and interjections remain fillers even when complete or combined. */
function isFillerOnly(text: string): boolean {
  return FILLERS_ONLY.test(text.normalize("NFKC").replace(/[\p{P}\s]+/gu, " ").trim());
}

/** Shared by fragment buffering and tool-answer detection, regardless of punctuation. */
export function isInterjectionOnly(text: string): boolean {
  // Treat punctuation as a word boundary so merged fragments and full-width
  // separators work without allowing a filler prefix to hide real words.
  const words = text.normalize("NFKC").replace(/[\p{P}\s]+/gu, " ").trim();
  return !!words && words.split(" ").every((word) => INTERJECTION_WORD.test(word));
}

export type NarrationDecision = {
  /** Raw tagged sentences: the caller retains emotion and delivery tags. */
  speak: string[];
  hold: string[];
  dropped: string[];
};

/**
 * Pure turn-local judge shared by both voice paths. Hold announcements and
 * their fillers until tool use or real content justifies dropping them.
 * Dropping a candidate never disables judging the next sentence. Tool use
 * persists across retries, so fillers cannot satisfy a tool's answer.
 */
export class NarrationJudge {
  private pending: { raw: string; kind: "lead" | "announcement" | "filler" }[] = [];
  private usedTool = false;
  private readonly enabled: boolean;

  constructor(enabled = true) { this.enabled = enabled; }

  push(raw: string): NarrationDecision {
    if (!this.enabled || !parseTaggedSentence(raw).displayText) return this.result([raw]);
    // Judge the tail independently before a wait prefix can hide its intent.
    const announcement = isToolNarration(parseTaggedSentence(raw).displayText);
    if (this.pending.at(-1)?.kind === "lead") raw = this.pending.pop()!.raw + " " + raw;
    const text = parseTaggedSentence(raw).displayText;
    if (announcement || isToolNarration(text)) {
      this.pending.push({ raw, kind: "announcement" });
    } else if (isToolNarrationLead(text)) {
      this.pending.push({ raw, kind: "lead" });
    } else if (isFillerOnly(text)) {
      if (!this.pending.length) return this.result([raw]);
      this.pending.push({ raw, kind: "filler" });
    } else {
      const { speak, dropped } = this.flush(true);
      return this.result([...speak, raw], dropped);
    }
    return this.result();
  }

  onToolCall(): NarrationDecision {
    if (!this.enabled) return this.result();
    this.usedTool = true;
    const lead = this.pending.at(-1)?.kind === "lead" ? this.pending.pop() : undefined;
    const { speak, dropped } = this.flush(true);
    if (lead) this.pending.push(lead);
    return this.result(speak, dropped);
  }

  /** EOF of an attempt: preserve lone no-tool replies; suppress tool narration. */
  finish(): NarrationDecision {
    return this.flush(this.usedTool);
  }

  /** Use the delivered display text, after opener rewriting, to decide retry. */
  hasAnswer(sentences: readonly string[]): boolean {
    return sentences.some((text) => !!text.trim() && (!this.usedTool || !isFillerOnly(text)));
  }

  private flush(dropAnnouncements: boolean): NarrationDecision {
    const speak: string[] = [], dropped: string[] = [];
    for (const { raw, kind } of this.pending) {
      (dropAnnouncements && kind === "announcement" ? dropped : speak).push(raw);
    }
    this.pending = [];
    return this.result(speak, dropped);
  }

  private result(speak: string[] = [], dropped: string[] = []): NarrationDecision {
    return { speak, hold: this.pending.length ? [this.pending.map(({ raw }) => raw).join(" ")] : [], dropped };
  }
}
