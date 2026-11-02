/** PCM and alignment contract for the Meta voice service. */
import type { Alignment } from "../lips/visemes.ts";
export const PCM_SAMPLE_RATE = 24000;
export type TtsChunk = { audio: Buffer; alignment: Alignment | null; model: string };
export type TtsRequest = {
  voiceId: string;
  text: string;
  emotion: string | null;
  model: string;
  signal?: AbortSignal;
  lang?: string;
};
export const pcmDurationMs = (bytes: number) => (bytes / 2 / PCM_SAMPLE_RATE) * 1000;
