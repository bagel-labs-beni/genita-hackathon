/**
 * Per-category mouth profiles for the flow morph (11/3). `prep-py/profiles.json` is the non-human lane's
 * file, shared with faceflow.py: keys + Muse prompts (read here), prep fields and runtime map fields (read there).
 * Humans use the built-in MOUTH keys in face.ts (the v7 demo set).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ClassifyRaw } from "./classify.ts";
import type { CompanionKind } from "./prompts.ts";

export type FlowProfile = "human" | "animal" | "cat" | "character3d" | "character2d" | "toy";

type ProfileJson = { keys?: string[]; prompts?: Record<string, string> };
export const PROFILES_JSON = fileURLToPath(new URL("../../prep-py/profiles.json", import.meta.url));

let cache: Record<string, ProfileJson> | null = null;
function profiles(): Record<string, ProfileJson> {
  if (!cache) {
    try {
      cache = JSON.parse(readFileSync(PROFILES_JSON, "utf8")) as Record<string, ProfileJson>;
    } catch {
      cache = {};
    }
  }
  return cache;
}

const isCat = (species: string | undefined) => !!species && /\b(cat|kitten|kitty)\b/i.test(species);

/** Classify answer → profile. Unknown character style → 3D (the safer, flow-based path). */
export function flowProfileOf(kind: CompanionKind, raw?: Partial<ClassifyRaw> | null): FlowProfile {
  if (kind === "human") return "human";
  if (kind === "animal") return isCat(raw?.species) ? "cat" : "animal";
  if (raw?.character_style === "2d") return "character2d";
  return raw?.character_style === "toy" ? "toy" : "character3d";
}

function entry(p: FlowProfile): ProfileJson {
  const all = profiles();
  const over = (base: string, o: string): ProfileJson => ({ ...all[base], ...all[o], prompts: { ...all[base]?.prompts, ...all[o]?.prompts } });
  if (p === "cat") return over("animal", "cat_override");
  if (p === "toy") return over("character3d", "toy_override"); // plush / figurine: no anatomical jaw
  return all[p] ?? {};
}

/** Mouth keys this profile generates (non-human profiles only; humans use face.ts MOUTH_KEYS). */
export function profileMouthKeys(p: FlowProfile): string[] | null {
  if (p === "human") return null;
  const k = entry(p).keys;
  return Array.isArray(k) && k.length ? k.filter((x) => x !== "BLINK") : null;
}

/** Full Muse prompt for a profile key ("BLINK" → the blink still), `{species}` filled in; null = use face.ts. */
export function profilePrompt(p: FlowProfile, key: string, species?: string): string | null {
  if (p === "human") return null;
  const t = entry(p).prompts?.[key];
  if (typeof t !== "string" || key.startsWith("_")) return null;
  const sp = (species ?? "").trim().toLowerCase() || (p === "cat" ? "cat" : "animal");
  return t.replaceAll("{species}", sp);
}

/** For tests: re-read profiles.json. */
export function resetProfiles(): void {
  cache = null;
}
