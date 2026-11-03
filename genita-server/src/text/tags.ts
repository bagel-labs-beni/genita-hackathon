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

/** `expression`: Spark's clause tag; "neutral" = it said so explicitly (then nothing is inferred). */
export type TaggedSentence = { emotion: string | null; ttsText: string; displayText: string; expression: Expression | "neutral" | null };
// a tag cut off by the end of the stream ("Hello. [smi" then an upstream error) is never spoken or shown
const DANGLING_RE = /\[[A-Za-z\s]{0,30}$|<\s*[A-Za-z_-]{0,24}$/;

const tidy = (s: string) => s.replace(/\s{2,}/g, " ").replace(/\s+([,.!?…])/g, "$1").trim();

export function parseTaggedSentence(raw: string): TaggedSentence {
  let emotion: string | null = null;
  let tagged: string | null = null;
  const noEmotion = raw
    .replace(DANGLING_RE, " ")
    .replace(EMOTION_RE, (_m, name: string) => {
      if (!emotion) emotion = name.toLowerCase();
      return " ";
    })
    .replace(EXPRESSION_RE, (_m, name: string) => {
      tagged ??= name.toLowerCase();
      return " ";
    });
  const ttsText = tidy(noEmotion);
  const expression = tagged as Expression | "neutral" | null;
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
export function clauseExpression(s: TaggedSentence, emotion: string | null, emotionStartsHere: boolean, opts: { scaled?: boolean } = {}): { tag: Expression; intensity: number } | null {
  if (s.expression === "neutral") return null;
  const tag: Expression | null =
    s.expression ??
    (LAUGH_RE.test(s.ttsText) ? "laugh" : CONCERN_RE.test(s.displayText) ? "concerned" : emotionStartsHere && emotion ? EMOTION_FACE[emotion] ?? null : null);
  if (!tag) return null;
  if (tag === "laugh") return { tag, intensity: 1 };
  return { tag, intensity: opts.scaled ? scaledIntensity(tag, emotion) : 0.7 };
}

/**
 * Conversation engine v1 (DESIGN §7.2): how big the face is follows how strong the feeling is — a warm reply
 * gets a soft smile, an excited one a grin. The reply's emotion sets it; a face with no matching emotion keeps
 * the tag's own default.
 */
const EMOTION_INTENSITY: Record<string, number> = { excited: 0.9, surprised: 0.85, happy: 0.65, teasing: 0.55, warm: 0.45, sad: 0.6, curious: 0.5, whisper: 0.4 };
const TAG_INTENSITY: Record<Exclude<Expression, "laugh">, number> = { smileopen: 0.85, surprised: 0.8, smile: 0.6, concerned: 0.6 };

export function scaledIntensity(tag: Exclude<Expression, "laugh">, emotion: string | null): number {
  const e = emotion ? EMOTION_INTENSITY[emotion] : undefined;
  // a grin can't be fainter than 0.7, a concerned face never stronger than 0.7 (it reads as alarm)
  if (e === undefined) return TAG_INTENSITY[tag];
  if (tag === "smileopen") return Math.max(0.7, e);
  if (tag === "concerned") return Math.min(0.7, Math.max(0.45, e));
  return e;
}
