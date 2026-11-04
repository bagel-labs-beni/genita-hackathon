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
  /** a live reply's one retry of a failed clause: asks the service even while it is parked as down */
  force?: boolean;
  /** answer only from the client's cache (the recovery line); never asks the service */
  cachedOnly?: boolean;
  /** first-byte budget for this request (ms); default VoiceConfig.timeoutMs. A reply's last retry on a cold GPU waits longer */
  waitMs?: number;
};
export const pcmDurationMs = (bytes: number) => (bytes / 2 / PCM_SAMPLE_RATE) * 1000;
