/**
 * Interpretation trigger (F8): Genita's user speaks English, so a transcript
 * that is mostly Hangul is someone else talking. Muse Transcribe sends no
 * language field, so the script of the text is the signal.
 */
export function isMostlyHangul(text: string, threshold = 0.3): boolean {
  let hangul = 0;
  let letters = 0;
  for (const ch of text) {
    if (/\p{Script=Hangul}/u.test(ch)) {
      hangul++;
      letters++;
    } else if (/\p{L}/u.test(ch)) letters++;
  }
  return letters > 0 && hangul / letters >= threshold;
}
