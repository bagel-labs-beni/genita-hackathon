/**
 * Reply text carries two kinds of inline tags:
 *   <emotion>   — one per reply (or per sentence), chosen by Spark; drives the
 *                 face clip and the TTS tone. Never spoken, never shown.
 *   [audio tag] — bracketed delivery tags like [laughs], [whispers] (stripped for speech).
 *                 Sent to TTS, hidden from subtitles and lip timing.
 */
const EMOTION_RE = /<\s*([A-Za-z][A-Za-z_-]{0,23})\s*>/g;
const AUDIO_RE = /\[[^\[\]\n]{1,30}\]/g;

export type TaggedSentence = { emotion: string | null; ttsText: string; displayText: string };

const tidy = (s: string) => s.replace(/\s{2,}/g, " ").replace(/\s+([,.!?…])/g, "$1").trim();

export function parseTaggedSentence(raw: string): TaggedSentence {
  let emotion: string | null = null;
  const noEmotion = raw.replace(EMOTION_RE, (_m, name: string) => {
    if (!emotion) emotion = name.toLowerCase();
    return " ";
  });
  const ttsText = tidy(noEmotion);
  return { emotion, ttsText, displayText: tidy(ttsText.replace(AUDIO_RE, " ")) };
}
