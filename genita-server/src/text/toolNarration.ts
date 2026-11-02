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
const INTENT = new RegExp(`^(?:i'll|i will|let me) ${LOOKUP}$`);
const SEPARATOR = `[${CLAUSE_SEPARATORS} ]+`;
const WAIT = "(?:one sec(?:ond)?|give me a sec(?:ond)?|just a moment)";
const KOREAN_WAIT = "(?:잠깐|잠시만요?|잠시)";
const INTERJECTION = "(?:hm+|mm+|um+|uh+|oh+|ah+|eh+|er+m*|huh|well|ok(?:ay)?|alright)";
const INTERJECTION_WORD = new RegExp(`^${INTERJECTION}$`, "iu");
const INTERJECTION_PREFIX = new RegExp(`^(?:${INTERJECTION}${SEPARATOR})+`);
const WAIT_LOOKUP = new RegExp(`^${WAIT}${SEPARATOR}(?:while i (?:${LOOKUP})|(?:looking (?:that|this|it) up|checking my memory|searching (?:my memory|the web))${QUERY})$`);
const NARRATION_LEAD = new RegExp(`^(?:${WAIT}|${KOREAN_WAIT})${SEPARATOR}$`, "iu");
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
  return NARRATION_LEAD.test(sentence.trim()) ||
    (isInterjectionOnly(sentence) && !/[.!?…。！？][\p{P}\s]*$/u.test(sentence));
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
 * Pure turn-local judge shared by both voice paths. Only an unfinished lead
 * or announcement is held; real content can always stream immediately.
 * Dropping a candidate never disables judging the next sentence. Tool use
 * persists across retries, so fillers cannot satisfy a tool's answer.
 */
export class NarrationJudge {
  private pending: { raw: string; kind: "lead" | "announcement" } | null = null;
  private usedTool = false;
  private readonly enabled: boolean;

  constructor(enabled = true) { this.enabled = enabled; }

  push(raw: string): NarrationDecision {
    if (!this.enabled || !parseTaggedSentence(raw).displayText) return this.result([raw]);
    const dropped: string[] = [];
    if (this.pending?.kind === "lead") {
      raw = this.pending.raw + " " + raw;
    } else if (this.pending) {
      dropped.push(this.pending.raw);
    }
    this.pending = null;
    const text = parseTaggedSentence(raw).displayText;
    if (isToolNarration(text)) {
      this.pending = { raw, kind: "announcement" };
    } else if (isToolNarrationLead(text)) {
      this.pending = { raw, kind: "lead" };
    } else {
      return this.result([raw], dropped);
    }
    return this.result([], dropped);
  }

  onToolCall(): NarrationDecision {
    if (!this.enabled) return this.result();
    this.usedTool = true;
    if (this.pending?.kind !== "announcement") return this.result();
    const raw = this.pending.raw;
    this.pending = null;
    return this.result([], [raw]);
  }

  /** EOF of an attempt: preserve lone no-tool replies; suppress tool narration. */
  finish(): NarrationDecision {
    if (!this.pending) return this.result();
    const { raw, kind } = this.pending;
    this.pending = null;
    return this.usedTool && kind === "announcement" ? this.result([], [raw]) : this.result([raw]);
  }

  /** Use the delivered display text, after opener rewriting, to decide retry. */
  hasAnswer(sentences: readonly string[]): boolean {
    return sentences.some((text) => !!text.trim() && (!this.usedTool ||
      (!isInterjectionOnly(text) && !isToolNarrationLead(text))));
  }

  private result(speak: string[] = [], dropped: string[] = []): NarrationDecision {
    return { speak, hold: this.pending ? [this.pending.raw] : [], dropped };
  }
}
