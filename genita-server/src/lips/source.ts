/**
 * Pluggable lip source, chosen per session in `start.lip`:
 *   atlas — animals/characters: server sends mouth cues (visemes) with each
 *           audio chunk; the device composites its mouth atlas.
 *   peter — humans: MuseTalk 1.5 GPU worker (Modal) renders mouth crops from
 *           the same audio. Not deployed yet (needs a card on Modal), so this
 *           pass reports it unavailable and degrades to the session's
 *           `fallback` (default "none": the app plays its speaking clip).
 *   none  — audio + word timings only.
 * Word timings are always sent; they cost nothing and drive captions.
 */
import { alignmentToMouth, alignmentToWords, type Alignment, type MouthCue, type WordTiming } from "./visemes.ts";

export type LipMode = "peter" | "atlas" | "none";
export type LipPlan = { requested: LipMode; active: LipMode; reason: string | null };

export function planLips(requested: LipMode, fallback: LipMode, peterUrl: string | null): LipPlan {
  if (requested === "peter" && !peterUrl) {
    const active = fallback === "peter" ? "none" : fallback;
    return { requested, active, reason: "peter_not_deployed" };
  }
  return { requested, active: requested, reason: null };
}

export type ChunkTiming = { mouth?: MouthCue[]; words: WordTiming[] };

/** Timing payload for one audio chunk. offsetMs = where its sentence starts in the utterance. */
export function chunkTiming(mode: LipMode, alignment: Alignment | null, offsetMs: number): ChunkTiming {
  if (!alignment) return { words: [], ...(mode === "atlas" ? { mouth: [] } : {}) };
  return {
    words: alignmentToWords(alignment, offsetMs),
    ...(mode === "atlas" ? { mouth: alignmentToMouth(alignment, offsetMs) } : {}),
  };
}
