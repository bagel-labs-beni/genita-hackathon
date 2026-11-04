/**
 * Empty Spark replies (11/5 sign-off: 2/96 eval turns came back empty and the call said "Sorry, I lost you for a sec.
 * Say that again?"). Two steps:
 *   1. the one retry (session.ts) goes out with a shorter context: the last few lines of the call only, so a long
 *      history or a heavy turn doesn't sink the second try as well (`retryContext`);
 *   2. still nothing: a short, natural line (`emptyFiller`) that never parrots their words, never "lost you" or
 *      "say that again" (the user did talk, and heard nothing wrong on their side).
 * No model call: the filler is a fixed line, so it is instant and never empty.
 */
import type { SparkInputItem, SparkRequest } from "../meta/spark.ts";

/** messages kept for the retry: the turn itself and the exchange or two before it */
export const RETRY_CONTEXT_ITEMS = 5;

/** The retry request with only the last few messages (starting on a user line); unchanged when it is short already. */
export function retryContext(req: SparkRequest, keep = RETRY_CONTEXT_ITEMS): SparkRequest {
  if (!Array.isArray(req.input) || req.input.length <= keep) return req;
  const tail: SparkInputItem[] = req.input.slice(-keep);
  while (tail.length > 1 && !("role" in tail[0] && tail[0].role === "user")) tail.shift();
  return { ...req, input: tail };
}

/**
 * The line said when both tries came back empty: short, natural, in character. It never repeats their words back
 * (11/5 eval 5c: "ok which one suits me?" became "Ooh, one suits."). A question gets a question back, a statement a
 * "go on". `pick` rotates the wording (the turn number).
 */
const ASKED_LINES = ["<curious> Hmm, good question. What's your gut say?", "<curious> Ooh, tough one. What are you leaning toward?"];
const SAID_LINES = ["<warm> Mm, tell me more.", "<curious> Oh? Go on.", "<warm> I'm listening, keep going."];
export function emptyFiller(userText: string, pick = 0): string {
  const t = userText.trim();
  const asked = /\?\s*$/.test(t) || /^(?:what|how|why|when|where|who|which|do|does|did|should|could|would|can|is|are|will)\b/i.test(t);
  const lines = asked ? ASKED_LINES : SAID_LINES;
  return lines[Math.abs(pick) % lines.length];
}
