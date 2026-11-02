/** PCM and alignment contract for the Meta voice service. */
import type { Alignment, ClauseTiming } from "../lips/visemes.ts";
export const PCM_SAMPLE_RATE = 24000;
/** `timing`: a timing-only chunk (no audio) from the voice service's forced aligner (Meta MMS_FA), after the
 * clause's audio; ms from the start of that request's audio. */
export type TtsChunk = { audio: Buffer; alignment: Alignment | null; model: string; timing?: ClauseTiming };
export type TtsRequest = {
  voiceId: string;
  text: string;
  emotion: string | null;
  model: string;
  signal?: AbortSignal;
  lang?: string;
};
export const pcmDurationMs = (bytes: number) => (bytes / 2 / PCM_SAMPLE_RATE) * 1000;
