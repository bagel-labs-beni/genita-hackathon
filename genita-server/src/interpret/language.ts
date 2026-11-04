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

// ───────────────────────── free language switch (Chelsea 11/4) ─────────────────────────

const HAN_ONLY_DEFAULT = "Chinese";

/**
 * detectLanguage with what the conversation already knows: Latin script is the pair's one Latin-script
 * language when there is exactly one (a Korean↔Spanish pair hears Spanish, not English), and Han with no kana
 * is Japanese when the pair has Japanese but not Chinese ("大丈夫" mid-way in a Japanese talk).
 */
export function detectInPair(text: string, userLanguage: string, pair: readonly (string | null)[]): string | null {
  const known = pair.filter((l): l is string => !!l);
  const latin = known.filter((l) => LATIN_LANGUAGES.has(l));
  const lang = detectLanguage(text, latin.length === 1 ? latin[0] : userLanguage);
  if (lang === HAN_ONLY_DEFAULT && known.includes("Japanese") && !known.includes("Chinese")) return "Japanese";
  return lang;
}

/** Script of one word: the language it stands for, or null (numbers, symbols). */
function wordLanguage(word: string, latinAs: string): string | null {
  let hangul = 0, kana = 0, han = 0, latin = 0;
  for (const ch of word) {
    if (/\p{Script=Hangul}/u.test(ch)) hangul++;
    else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) kana++;
    else if (/\p{Script=Han}/u.test(ch)) han++;
    else if (/\p{Script=Latin}/u.test(ch)) latin++;
  }
  const top = Math.max(hangul, kana, han, latin);
  if (!top) return null;
  if (top === hangul) return "Korean";
  if (top === kana || (top === han && kana)) return "Japanese";
  if (top === han) return HAN_ONLY_DEFAULT;
  return latinAs;
}

/**
 * Two languages of a line said about evenly (≥2 words each, the smaller ≥40% of the words), or null.
 * "이거 iPhone 얼마예요" is not mixed; "음 그거 good idea 같아" and "これは good idea だと思う" are. The interpreter
 * only treats a mixed line as unclear when one of its languages is outside the pair it knows (or assumes).
 */
export function mixedLanguages(text: string, userLanguage = "English"): [string, string] | null {
  const latinAs = LATIN_LANGUAGES.has(userLanguage) ? userLanguage : "English";
  const counts = new Map<string, number>();
  let words = 0;
  for (const w of text.split(/\s+/)) {
    const l = wordLanguage(w, latinAs);
    if (!l) continue;
    words++;
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length < 2) return null;
  const [[a], [b, nb]] = ranked;
  return nb >= 2 && nb / words >= 0.4 ? [a, b] : null;
}

/** Names people say for a language, in Korean, English, Japanese and Chinese (lowercase). */
const LANGUAGE_NAMES: Record<string, string[]> = {
  Korean: ["korean", "한국어", "한국말", "韓国語", "韓國語", "韩语", "韩国语"],
  English: ["english", "영어", "英語", "英语", "英文"],
  Japanese: ["japanese", "일본어", "일본말", "日本語", "日语", "日文", "日本话"],
  Chinese: ["chinese", "mandarin", "중국어", "중국말", "中国語", "中国语", "中文", "汉语", "漢語", "普通话"],
  Spanish: ["spanish", "español", "espanol", "스페인어", "スペイン語", "西班牙语"],
  French: ["french", "français", "francais", "프랑스어", "불어", "フランス語", "法语"],
  German: ["german", "deutsch", "독일어", "ドイツ語", "德语"],
  Italian: ["italian", "italiano", "이탈리아어", "イタリア語", "意大利语"],
  Portuguese: ["portuguese", "português", "portugues", "포르투갈어", "ポルトガル語", "葡萄牙语"],
  Vietnamese: ["vietnamese", "베트남어", "ベトナム語", "越南语"],
  Indonesian: ["indonesian", "인도네시아어", "インドネシア語", "印尼语"],
};
const NAME_TO_LANGUAGE = new Map<string, string>(Object.entries(LANGUAGE_NAMES).flatMap(([lang, names]) => names.map((n) => [n, lang] as [string, string])));
const NAME_ALT = [...NAME_TO_LANGUAGE.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

const COMMANDS: RegExp[] = [
  // English: "translate to Japanese", "switch to Japanese please", "can you interpret into Japanese"
  // (not "speak/talk": "Can you speak Japanese?" is a question for the other person)
  new RegExp(`^(?:(?:ok(?:ay)?|hey|so|now|please|can you|could you|genita)\\s+)*(?:translate|interpret|switch|change)(?:\\s+(?:it|this|that|everything|for me|for us|the conversation))?(?:\\s+(?:in|into|to))?\\s+(${NAME_ALT})(?:\\s+(?:please|now|instead|from now on))*$`, "u"),
  new RegExp(`^(?:in\\s+)?(${NAME_ALT})(?:\\s+please)$`, "u"),
  // Korean: "일본어로 해줘", "이제 일본어로 통역해 주세요", "일본어로 바꿔줘", "일본어로요"
  new RegExp(`^(?:(?:이제|지금부터|그럼|그냥|음|어)\\s*)*(${NAME_ALT})\\s*(?:으로|로)\\s*(?:(?:통역|번역|말|얘기|이야기|바꿔|바꾸어)\\s*)?(?:해\\s*줘|해\\s*주세요|해\\s*줄래|해\\s*주실래요|해요|해|줘|주세요|부탁해|부탁해요|부탁합니다|하자|할게|해\\s*봐)?\\s*요?$`, "u"),
  // Japanese: "日本語で", "日本語でお願いします", "英語に通訳して"
  new RegExp(`^(${NAME_ALT})\\s*(?:で|に)\\s*(?:お願い(?:します)?|通訳して(?:ください)?|翻訳して(?:ください)?|話して(?:ください)?|して(?:ください)?)?$`, "u"),
  // Chinese: "翻译成日语", "请用日语", "换成日语吧"
  new RegExp(`^(?:请)?(?:翻译成|翻成|换成|改成|用)(${NAME_ALT})(?:吧|说|翻译)?$`, "u"),
];

function normCommand(text: string): string {
  return text.toLowerCase().replace(/[.,!?。、，！？~…"'“”‘’]+/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * "translate to Japanese" / "일본어로 해줘" / "日本語で" → "Japanese": the voice switch for the target language.
 * Only short, whole-line commands count, so "日本語で話してもいいですか" or "I studied Japanese" stay speech.
 */
export function languageCommand(text: string): string | null {
  const t = normCommand(text);
  if (!t || [...t].length > 40) return null;
  for (const re of COMMANDS) {
    const m = t.match(re);
    if (m) return NAME_TO_LANGUAGE.get(m[1]) ?? null;
  }
  return null;
}

/** An answer to "Which language should I translate into?": a command, or just the name ("일본어요", "Japanese"). */
export function languageAnswer(text: string): string | null {
  const cmd = languageCommand(text);
  if (cmd) return cmd;
  const t = normCommand(text).replace(/^(?:(?:um|uh|음|어|그|えっと|あの)\s+)+/u, "").replace(/\s*(?:please|요|이요|です|でお願いします|で|吧)$/u, "").trim();
  return NAME_TO_LANGUAGE.get(t) ?? null;
}

const LOCAL_NAMES: Record<string, Record<string, string>> = {
  Korean: { Korean: "한국어", English: "영어", Japanese: "일본어", Chinese: "중국어", Spanish: "스페인어", French: "프랑스어", German: "독일어", Italian: "이탈리아어", Portuguese: "포르투갈어", Vietnamese: "베트남어", Indonesian: "인도네시아어" },
  Japanese: { Korean: "韓国語", English: "英語", Japanese: "日本語", Chinese: "中国語", Spanish: "スペイン語", French: "フランス語", German: "ドイツ語", Italian: "イタリア語", Portuguese: "ポルトガル語", Vietnamese: "ベトナム語", Indonesian: "インドネシア語" },
  Chinese: { Korean: "韩语", English: "英语", Japanese: "日语", Chinese: "中文", Spanish: "西班牙语", French: "法语", German: "德语", Italian: "意大利语", Portuguese: "葡萄牙语", Vietnamese: "越南语", Indonesian: "印尼语" },
};

/** The one question Genita asks when she can't tell which language to translate into, in the user's language. */
export function askLanguageLine(userLanguage: string): string {
  switch (userLanguage) {
    case "Korean": return "어떤 언어로 통역할까요?";
    case "Japanese": return "何語に通訳しましょうか？";
    case "Chinese": return "要翻译成哪种语言？";
    case "Spanish": return "¿A qué idioma traduzco?";
    case "French": return "Dans quelle langue dois-je traduire ?";
    case "German": return "In welche Sprache soll ich übersetzen?";
    default: return "Which language should I translate into?";
  }
}

/** Short confirmation after a voice switch, in the user's language. */
export function switchedLine(userLanguage: string, target: string): string {
  const name = LOCAL_NAMES[userLanguage]?.[target] ?? target;
  switch (userLanguage) {
    case "Korean": return `좋아요, 이제 ${name}로 통역할게요.`;
    case "Japanese": return `わかりました。${name}に通訳します。`;
    case "Chinese": return `好的，现在翻译成${name}。`;
    default: return `Okay, translating into ${target} now.`;
  }
}
