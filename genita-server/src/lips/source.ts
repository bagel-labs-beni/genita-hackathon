/**
 * Pluggable lip source, chosen per session in `start.lip`:
 *   atlas — animals/characters: server sends mouth cues (visemes) with each
 *           audio chunk; the device composites its mouth atlas.
 *   peter — humans: MuseTalk 1.5 GPU worker (Modal) renders 256 px mouth
 *           crops from the same audio (bridge: peter.ts). Without
 *           GENITA_PETER_URL/TOKEN it reports "peter_not_deployed" and uses
 *           the session's `fallback` (default "none": speaking clip).
 *   none  — audio + word timings only.
 * Word timings are always sent; they cost nothing and drive captions.
 */
import { alignmentToMouth, alignmentToWords, type Alignment, type MouthCue, type WordTiming } from "./visemes.ts";

export type LipMode = "peter" | "atlas" | "none";
export type LipPlan = { requested: LipMode; active: LipMode; reason: string | null };

/**
 * Initial lip plan. Peter needs a worker connection (cold start ~34 s), so it
 * starts on the fallback with reason "peter_connecting" and the session sends
 * `lip.changed` once the worker is READY (or "peter_unavailable" if not).
 */
export function planLips(requested: LipMode, fallback: LipMode, peterConfigured: boolean): LipPlan {
  if (requested !== "peter") return { requested, active: requested, reason: null };
  const active = fallback === "peter" ? "none" : fallback;
  return { requested, active, reason: peterConfigured ? "peter_connecting" : "peter_not_deployed" };
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
