/**
 * #344: the companion's mood carries from one call to the next. At call close the call's ending mood (rhythm.ts
 * moodFrom) is kept in the memory lane's per-user call state JSON (`call_mood`, beside `opener_topics`; tied to the
 * Forget revision like them); the next call starts from it, faded toward the persona's baseline with a 12 h half-life, so yesterday's great news
 * still shows a little today and a rough night has mostly passed by tomorrow. Numbers only, no words from the call.
 */
import type { MemoryService } from "../memory/service.ts";
import { NEUTRAL, toward, type Mood } from "./moodState.ts";

export type StoredMood = { valence: number; energy: number; at: number; rev: number };
const HALF_LIFE_MS = 12 * 3_600_000;
const clamp = (v: number) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));

/**
 * the start mood for a call from a call state already read: the last call's ending mood faded back toward the
 * persona's baseline (moodState.ts personaBaseline); the baseline itself when absent, stale by revision, or faded out
 */
export function carriedMood(state: unknown, now: number, baseline: Mood = NEUTRAL): Mood {
  const s = state as { call_mood?: unknown; revision?: unknown } | null;
  const m = s?.call_mood as Partial<StoredMood> | undefined;
  if (!m || typeof m.at !== "number" || (m.rev ?? 0) !== ((s?.revision as number | undefined) ?? 0)) return { ...baseline };
  const k = Math.pow(0.5, Math.max(0, now - m.at) / HALF_LIFE_MS);
  const v = clamp(toward(clamp(m.valence ?? 0), baseline.valence, k));
  const e = clamp(toward(clamp(m.energy ?? 0), baseline.energy, k));
  return { valence: Math.abs(v - baseline.valence) < 0.05 ? baseline.valence : v, energy: Math.abs(e - baseline.energy) < 0.05 ? baseline.energy : e };
}

/** keep this call's ending mood (background; errors only logged) */
export function saveCallMood(memory: MemoryService, userId: string, mood: Mood, now: number, onError?: (e: unknown) => void): void {
  void memory.serial(userId, async () => {
    const s = await memory.state.getState(userId);
    (s as typeof s & { call_mood?: StoredMood }).call_mood = { valence: clamp(mood.valence), energy: clamp(mood.energy), at: now, rev: s.revision };
    await memory.state.putState(userId, s);
  }).catch((e) => onError?.(e));
}

/** how big the face is follows the mood's energy: a flat call gets softer faces, an excited one fuller (DESIGN §7.3) */
export function moodScaledIntensity(intensity: number, mood: Mood | null): number {
  if (!mood) return intensity;
  return Math.round(Math.max(0.3, Math.min(1, intensity * (1 + 0.3 * mood.energy))) * 100) / 100;
}
