/** Atlas playback timing from Meta voice alignment; no remote lip worker. */
import { alignmentToMouth, alignmentToWords, type Alignment, type MouthCue, type WordTiming } from "./visemes.ts";

export type LipMode = "atlas" | "none";
export type LipPlan = { requested: LipMode; active: LipMode; reason: string | null };

export type ChunkTiming = { mouth?: MouthCue[]; words: WordTiming[] };

/** Timing payload for one audio chunk. offsetMs = where its sentence starts in the utterance. */
export function chunkTiming(mode: LipMode, alignment: Alignment | null, offsetMs: number): ChunkTiming {
  if (!alignment) return { words: [], ...(mode === "atlas" ? { mouth: [] } : {}) };
  return {
    words: alignmentToWords(alignment, offsetMs),
    ...(mode === "atlas" ? { mouth: alignmentToMouth(alignment, offsetMs) } : {}),
  };
}
