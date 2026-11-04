/**
 * Interpret-mode Korean ASR post-correction (11/4).
 *
 * Muse Transcribe (muse-voice-transcribe-1.0, the only model; handshake
 * takes only model/mode/languageBias, no context or endpointing knobs) often
 * mishears short or fast Korean by one syllable: "대면 안 되나" → "대다 안
 * 되나", "남냐?" → "남나?". The bubble then shows the wrong words and Spark
 * translates the wrong meaning.
 *
 * One fast Spark pass fixes the obvious slip using the last few lines of the
 * conversation, before the translation is played:
 *   - runs only when the utterance is Korean;
 *   - runs in parallel with the translation of the raw text, so an unchanged
 *     line costs max(0, correction − translation) ms, never more than the
 *     timeout;
 *   - any error, timeout, or an answer that is not a small Korean edit of the
 *     raw text keeps the raw text (acceptCorrection);
 *   - kill switch: GENITA_INTERPRET_ASR_CORRECT=0.
 */
import type { SparkRequest, SparkStreamEvent } from "../meta/spark.ts";
import { detectLanguage } from "./language.ts";

export type ContextLine = { speaker: "them" | "me" | "unknown"; lang: string | null; text: string };

export const CORRECT_CONTEXT_LINES = 4;
export const CORRECT_DEFAULT_TIMEOUT_MS = 800;

export function buildCorrectionInstructions(): string {
  return [
    "You fix speech-recognition errors in one short Korean utterance from a live face-to-face conversation.",
    "The recognizer often mishears short or fast Korean by a syllable or a sound (for example 대면 heard as 대다).",
    "Use the recent conversation to decide what was most likely said.",
    "If the utterance already makes sense, return it exactly as it is.",
    "Change only misheard syllables. Never translate, answer, explain, shorten, add or rephrase.",
    "Output only the utterance.",
  ].join("\n") + "\n";
}

export function buildCorrectionInput(raw: string, context: ContextLine[]): string {
  const lines = context
    .slice(-CORRECT_CONTEXT_LINES)
    .map((c) => `- ${c.speaker === "me" ? "A" : c.speaker === "them" ? "B" : "?"}${c.lang ? ` (${c.lang})` : ""}: ${c.text.slice(0, 200)}`);
  return (lines.length ? `Recent conversation:\n${lines.join("\n")}\n\n` : "") + `Utterance: ${raw}`;
}

function compact(s: string): string {
  return s.replace(/[\s\p{P}\p{S}]/gu, "");
}

/** Levenshtein distance over code points (inputs are one short line). */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

/**
 * The corrected line, or null to keep the raw one. Only a small Korean edit
 * is accepted: at most ~1 syllable in 3 changed (min 1), similar length, one
 * line, no labels or quotes around it.
 */
export function acceptCorrection(raw: string, answer: string): string | null {
  let fixed = answer.trim();
  if (!fixed || /[\r\n]/.test(fixed)) return null;
  fixed = fixed.replace(/^(utterance|발화)\s*[:：]\s*/i, "").replace(/^["'“‘「](.*)["'”’」]$/u, "$1").trim();
  if (!fixed || fixed === raw.trim()) return null;
  if (detectLanguage(fixed) !== "Korean") return null;
  const a = compact(raw);
  const b = compact(fixed);
  if (!a || !b || a === b) return null;
  const len = [...a].length;
  const ratio = [...b].length / len;
  if (ratio < 0.6 || ratio > 1.5) return null;
  if (editDistance(a, b) > Math.max(1, Math.ceil(len * 0.34))) return null;
  return fixed;
}

type Translate = (req: SparkRequest, signal: AbortSignal) => AsyncIterable<SparkStreamEvent>;

export type CorrectResult = { text: string | null; ms: number; outcome: "changed" | "unchanged" | "rejected" | "timeout" | "error" | "aborted" };

/** Never throws; resolves within `timeoutMs` (plus a tick). */
export async function correctKorean(
  translate: Translate,
  raw: string,
  context: ContextLine[],
  opts: { timeoutMs: number; signal: AbortSignal; now: () => number },
): Promise<CorrectResult> {
  const t0 = opts.now();
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  opts.signal.addEventListener("abort", onAbort, { once: true });
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), opts.timeoutMs)));
  const run = (async (): Promise<string> => {
    let text = "";
    const req: SparkRequest = { instructions: buildCorrectionInstructions(), input: buildCorrectionInput(raw, context), maxOutputTokens: 80 };
    for await (const ev of translate(req, ac.signal)) {
      if (ev.type === "text") text += ev.delta;
      else if (ev.type === "done") return ev.text || text;
    }
    return text;
  })();
  try {
    const out = await Promise.race([run, timeout]);
    const ms = Math.round(opts.now() - t0);
    if (opts.signal.aborted) return { text: null, ms, outcome: "aborted" };
    if (out === "timeout") return { text: null, ms, outcome: "timeout" };
    if (out.trim() === raw.trim()) return { text: null, ms, outcome: "unchanged" };
    const fixed = acceptCorrection(raw, out);
    return fixed ? { text: fixed, ms, outcome: "changed" } : { text: null, ms, outcome: "rejected" };
  } catch {
    return { text: null, ms: Math.round(opts.now() - t0), outcome: opts.signal.aborted ? "aborted" : "error" };
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal.removeEventListener("abort", onAbort);
    ac.abort();
    run.catch(() => {});
  }
}
