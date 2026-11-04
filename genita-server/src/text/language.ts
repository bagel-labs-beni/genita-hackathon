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

const LANG_TAGS: Record<string, string> = {
  english: "en-US",
  korean: "ko-KR",
  japanese: "ja-JP",
  chinese: "zh-CN",
  mandarin: "zh-CN",
  spanish: "es-ES",
  french: "fr-FR",
  german: "de-DE",
  italian: "it-IT",
  portuguese: "pt-BR",
  vietnamese: "vi-VN",
  thai: "th-TH",
  indonesian: "id-ID",
  hindi: "hi-IN",
};
const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * BCP-47 hint for on-device speech (`say.lang`). Hangul text is Korean
 * whatever the call language; otherwise the reply language: a language name
 * ("English", "Korean"), or a tag passed through ("fr-CA"). Unknown → en-US
 * (Genita's default language).
 */
export function speechLang(text: string, language: string): string {
  if (isMostlyHangul(text)) return "ko-KR";
  const l = language.trim();
  if (BCP47.test(l)) return l;
  return LANG_TAGS[l.toLowerCase()] ?? "en-US";
}
