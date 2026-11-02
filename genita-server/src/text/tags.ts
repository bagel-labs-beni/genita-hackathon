/**
 * Reply text carries two kinds of inline tags:
 *   <emotion>   — one per reply (or per sentence), chosen by Spark; drives the
 *                 face clip and the TTS tone. Never spoken, never shown.
 *   [audio tag] — ElevenLabs v3/v4 audio tags like [laughs], [whispers].
 *                 Sent to TTS, hidden from subtitles and lip timing.
 */
const EMOTION_RE = /<\s*([A-Za-z][A-Za-z_-]{0,23})\s*>/g;
const AUDIO_RE = /\[[^\[\]\n]{1,30}\]/g;
const MAX_TAG = 32;

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

/** Streaming subtitle filter: hides tags that may arrive split across deltas. */
export class TagFilter {
  private held = "";
  private last = ""; // last character emitted so far (across pushes)

  push(delta: string): string {
    let s = this.held + delta;
    this.held = "";
    let out = "";
    while (s.length) {
      const open = s.search(/[<\[]/);
      if (open < 0) {
        out += s;
        break;
      }
      out += s.slice(0, open);
      s = s.slice(open);
      const close = s.indexOf(s[0] === "<" ? ">" : "]");
      if (close < 0) {
        if (s.length < MAX_TAG) this.held = s;
        else {
          out += s[0];
          s = s.slice(1);
          continue;
        }
        break;
      }
      const tag = s.slice(0, close + 1);
      const isTag = s[0] === "<" ? /^<\s*[A-Za-z][A-Za-z_-]{0,23}\s*>$/.test(tag) : tag.length <= MAX_TAG && !tag.includes("\n");
      if (isTag) {
        s = s.slice(close + 1);
        // swallow one space after a tag when we're at the very start or after a space
        const prev = out ? out[out.length - 1] : this.last;
        if (s.startsWith(" ") && (prev === "" || /\s/.test(prev))) s = s.slice(1);
      } else {
        out += s[0];
        s = s.slice(1);
      }
    }
    if (out) this.last = out[out.length - 1];
    return out;
  }

  flush(): string {
    const s = this.held;
    this.held = "";
    return s;
  }
}
