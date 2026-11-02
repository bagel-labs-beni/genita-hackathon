/**
 * Emotion → how ElevenLabs says the line. Ported from legacy-studio
 * src/lib/ttsEmotion.ts (pattern only; Genita keeps its own table).
 *
 * eleven_v4_turbo (default) and eleven_v3 read [audio tags] in the text;
 * we checked on 11/2 by transcribing the output that neither speaks the tag
 * aloud. v4 takes only stability + similarity_boost. Models without tag
 * support (flash/turbo v2.5, multilingual v2) get tags stripped.
 */
const TAG: Record<string, string> = {
  happy: "[cheerfully]",
  amused: "[amused]",
  teasing: "[playfully]",
  curious: "[curious]",
  thinking: "[thoughtful]",
  surprised: "[surprised]",
  excited: "[excited]",
  warm: "[warmly]",
  shy: "[shyly]",
  sad: "[sad]",
  relieved: "[relieved]",
  annoyed: "[annoyed]",
  whisper: "[whispers]",
};

export const TAG_MODELS = new Set(["eleven_v4_turbo", "eleven_v3"]);
export const V4_STABILITY = 0.5;

export type TtsBody = {
  text: string;
  model_id: string;
  voice_settings: { stability: number; similarity_boost: number };
};

export function buildTtsBody(text: string, emotion: string | null | undefined, model: string): TtsBody {
  const voice_settings = { stability: model === "eleven_v4_turbo" ? V4_STABILITY : 0.5, similarity_boost: 0.75 };
  if (!TAG_MODELS.has(model)) {
    return { text: text.replace(/\[[^\[\]]{1,30}\]/g, " ").replace(/\s{2,}/g, " ").trim(), model_id: model, voice_settings };
  }
  const tag = emotion ? TAG[emotion] : undefined;
  return { text: tag ? `${tag} ${text}` : text, model_id: model, voice_settings };
}

/** ElevenLabs refused the model itself (not busy/outage): retry on the fallback model. */
export function isModelRefusal(status: number | null | undefined): boolean {
  return status === 400 || status === 403 || status === 404 || status === 422;
}
