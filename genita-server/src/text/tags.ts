/**
 * Reply text carries three kinds of inline tags:
 *   <emotion>     — one per reply (or per sentence), chosen by Spark; drives the
 *                   face clip and the TTS tone. Never spoken, never shown.
 *   [expression]  — [smile] [smileopen] [laugh] [surprised] [concerned] (or [neutral]) at the start of a
 *                   clause, chosen by Spark; becomes one `expression` event for the face. Never spoken, never shown.
 *   [audio tag]   — other bracketed delivery tags like [laughs], [whispers] (stripped for speech).
 *                   Sent to TTS, hidden from subtitles and lip timing.
 */
const EMOTION_RE = /<\s*([A-Za-z][A-Za-z_-]{0,23})\s*>/g;
const EXPRESSION_RE = /\[\s*(smile|smileopen|laugh|surprised|concerned|neutral)\s*\]/gi;
const AUDIO_RE = /\[[^\[\]\n]{1,30}\]/g;

/** Face expressions the app can draw (expression layer, 11/3). Neutral is "no event". */
export const EXPRESSIONS = ["smile", "smileopen", "laugh", "surprised", "concerned"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export type TaggedSentence = { emotion: string | null; ttsText: string; displayText: string; expression: Expression | null };

const tidy = (s: string) => s.replace(/\s{2,}/g, " ").replace(/\s+([,.!?…])/g, "$1").trim();

export function parseTaggedSentence(raw: string): TaggedSentence {
  let emotion: string | null = null;
  let tagged: string | null = null;
  const noEmotion = raw
    .replace(EMOTION_RE, (_m, name: string) => {
      if (!emotion) emotion = name.toLowerCase();
      return " ";
    })
    .replace(EXPRESSION_RE, (_m, name: string) => {
      tagged ??= name.toLowerCase();
      return " ";
    });
  const ttsText = tidy(noEmotion);
  const expression = tagged && tagged !== "neutral" ? (tagged as Expression) : null;
  return { emotion, ttsText, displayText: tidy(ttsText.replace(AUDIO_RE, " ")), expression };
}

/** The reply's leading <emotion> → the face on the clause it starts (curious / whisper / neutral: none). */
const EMOTION_FACE: Record<string, Expression> = { happy: "smile", warm: "smile", teasing: "smile", excited: "smileopen", surprised: "surprised", sad: "concerned" };
const LAUGH_RE = /\b(?:ha(?:ha)+|hah|lol)\b|\[laugh(?:s|ing)?\]/i;
const CONCERN_RE = /\b(?:oh no|sorry|ugh|oof|that sucks|rough|tough|long day|tired|exhausted)\b/i;

/**
 * One clause → at most one face expression, or null (neutral: no event).
 * Order: Spark's inline [tag] > laughing / concerned words > the reply's <emotion>, only on the clause where it appears.
 */
export function clauseExpression(s: TaggedSentence, emotion: string | null, emotionStartsHere: boolean): { tag: Expression; intensity: number } | null {
  const tag: Expression | null =
    s.expression ??
    (LAUGH_RE.test(s.ttsText) ? "laugh" : CONCERN_RE.test(s.displayText) ? "concerned" : emotionStartsHere && emotion ? EMOTION_FACE[emotion] ?? null : null);
  return tag ? { tag, intensity: tag === "laugh" ? 1 : 0.7 } : null;
}
