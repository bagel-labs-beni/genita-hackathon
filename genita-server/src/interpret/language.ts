/**
 * F8 language and side decisions. Muse Transcribe sends no language field
 * (checked 11/1–11/2), so the script of the transcript is the signal:
 * Hangul → Korean, kana → Japanese, Han without kana → Chinese, Latin → the
 * user's language when it is written in Latin script (English by default).
 * Mixed speech ("음 그거 good idea 같아") counts as the non-Latin language
 * once ≥30% of its letters are in that script — the same threshold the chat
 * auto-switch uses (text/language.ts).
 */
export type Speaker = "them" | "me" | "unknown";

const LATIN_LANGUAGES = new Set(["English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch", "Indonesian", "Vietnamese", "Turkish"]);

/** Language of a transcript, or null when there is too little text or the script is unclear. */
export function detectLanguage(text: string, userLanguage = "English"): string | null {
  let hangul = 0;
  let kana = 0;
  let han = 0;
  let latin = 0;
  let letters = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    letters++;
    if (/\p{Script=Hangul}/u.test(ch)) hangul++;
    else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) kana++;
    else if (/\p{Script=Han}/u.test(ch)) han++;
    else if (/\p{Script=Latin}/u.test(ch)) latin++;
  }
  if (letters < 2) return null;
  if (hangul / letters >= 0.3) return "Korean";
  if (kana / letters >= 0.2) return "Japanese";
  if (han / letters >= 0.3) return "Chinese";
  if (latin / letters >= 0.7) return LATIN_LANGUAGES.has(userLanguage) ? userLanguage : "English";
  return null;
}

/** Hangul syllables and Latin words both work as tokens; bigrams survive ASR spacing differences. */
function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * Share of `heard`'s character bigrams that also occur in `spoken`. Used to
 * drop Genita hearing her own translation through the speaker (echo).
 */
export function containment(heard: string, spoken: string): number {
  const h = bigrams(heard);
  if (h.size === 0) return 0;
  const s = bigrams(spoken);
  let hit = 0;
  for (const b of h) if (s.has(b)) hit++;
  return hit / h.size;
}

/** "Can you interpret for me?" / "Stop interpreting" — the voice switch on INT-0. */
export function interpretCommand(text: string): "start" | "stop" | null {
  const t = text.toLowerCase();
  if (/\b(stop|end|turn off|quit)\b[^.?!]{0,20}\b(interpret|interpreting|translating|translation)\b/.test(t)) return "stop";
  if (/\b(interpret|translate)\b[^.?!]{0,30}\b(for me|for us|this conversation|between)\b/.test(t)) return "start";
  if (/\b(start|turn on)\b[^.?!]{0,10}\b(interpreting|interpretation|translating)\b/.test(t)) return "start";
  return null;
}
