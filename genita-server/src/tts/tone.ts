/**
 * Genita voice delivery cues for the companion's conversational moods.
 * Tag-capable models receive a bracketed performance direction before the line.
 * Other models receive clean speech text with inline directions removed.
 * Voice settings and refusal classification are independent of the mood table.
 */
const TAG: Record<string, string> = {
  happy: "[bright and upbeat]",
  amused: "[light chuckle]",
  teasing: "[gently teasing]",
  curious: "[with interest]",
  thinking: "[considering carefully]",
  surprised: "[taken aback]",
  excited: "[eager anticipation]",
  warm: "[gentle reassurance]",
  shy: "[soft and hesitant]",
  sad: "[quietly downcast]",
  relieved: "[a calming exhale]",
  annoyed: "[restrained frustration]",
  whisper: "[hushed voice]",
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
