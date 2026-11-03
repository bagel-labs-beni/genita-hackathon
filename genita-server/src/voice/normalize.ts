/**
 * Written reply → what the voice model should read (SeamlessM4T has no prosody or
 * normalisation of its own: "3:30pm" or "$12" come out garbled, emojis and URLs get
 * spelled). Captions keep the written text; only the speech uses this.
 *
 * English: numbers, money, %, times, ordinals, a few units/abbreviations → words;
 * markdown, emojis, URLs dropped. Korean: digits → Sino-Korean readings, native
 * readings (한/두/세…) before counters like 개·명·시·살.
 */

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

export function numberToWords(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `minus ${numberToWords(-n)}`;
  if (!Number.isInteger(n)) {
    const [i, f] = String(n).split(".");
    return `${numberToWords(Number(i))} point ${f.split("").map((d) => ONES[Number(d)]).join(" ")}`;
  }
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred` + (n % 100 ? ` ${numberToWords(n % 100)}` : "");
  for (const [v, w] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]] as const) {
    if (n >= v) return `${numberToWords(Math.floor(n / v))} ${w}` + (n % v ? ` ${numberToWords(n % v)}` : "");
  }
  return String(n);
}

function yearToWords(y: number): string {
  if (y >= 2000 && y < 2010) return numberToWords(y);
  const hi = Math.floor(y / 100), lo = y % 100;
  return `${numberToWords(hi)} ${lo === 0 ? "hundred" : lo < 10 ? `oh ${ONES[lo]}` : numberToWords(lo)}`;
}

function ordinal(n: number): string {
  const w = numberToWords(n);
  const irregular: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
  const m = w.match(/([a-z]+)$/);
  if (!m) return w;
  const last = m[1];
  const ord = irregular[last] ?? (last.endsWith("y") ? last.slice(0, -1) + "ieth" : last + "th");
  return w.slice(0, -last.length) + ord;
}

const ABBR: [RegExp, string][] = [
  [/\bDr\./g, "Doctor"], [/\bMr\./g, "Mister"], [/\bMrs\./g, "Missus"], [/\bMs\./g, "Miz"], [/\bSt\./g, "Street"],
  [/\bvs\.?(?=\s)/gi, "versus"], [/\be\.g\./gi, "for example"], [/\bi\.e\./gi, "that is"], [/\betc\./gi, "et cetera"],
  [/\bapprox\./gi, "about"], [/\bmins?\b/g, "minutes"], [/\bhrs?\b/g, "hours"], [/\bkm\b/g, "kilometers"],
  [/\bkg\b/g, "kilograms"], [/\blbs?\b/g, "pounds"], [/\bmi\b/g, "miles"], [/\bml\b/g, "milliliters"],
  [/\bAI\b/g, "A.I."], [/&/g, " and "], [/\+/g, " plus "], [/=/g, " equals "], [/@/g, " at "],
];

/**
 * Texting slang said the way people say it (11/3 tone pass): the voice model spells "ngl" / "rn" letter by letter or
 * garbles them. Captions keep the written form. "rn" / "fr" only in lower case ("RN" is a nurse, "FR" a code).
 */
const SLANG: [RegExp, string][] = [
  [/\bngl\b/gi, "not gonna lie"], [/\btbh\b/gi, "to be honest"], [/\bidk\b/gi, "I don't know"], [/\bimo\b/gi, "in my opinion"],
  [/\bimho\b/gi, "in my honest opinion"], [/\bbtw\b/gi, "by the way"], [/\bomg\b/gi, "oh my god"], [/\bnvm\b/gi, "never mind"],
  [/\bikr\b/gi, "I know, right"], [/\biykyk\b/gi, "if you know, you know"], [/\brn\b/g, "right now"], [/\bfr\b/g, "for real"],
  [/\b(?:lol|lmao|lmfao|rofl)\b/gi, "haha"], [/\b(?:pls|plz)\b/gi, "please"], [/\btho\b/gi, "though"], [/\bw\/(?=\s)/gi, "with"],
];

/**
 * 11/3 voice-naturalness pass: Seamless reads an ALL-CAPS word letter by letter ("SO" → "S. O."), so shouted words
 * are said as words; real acronyms stay spelled. Stretched letters ("sooo", "yesss") come out dragged and robotic, so
 * they collapse to the word ("hmmm" keeps its "mm"); "hahahaha" is "haha". Captions keep the written form.
 */
const ACRONYMS = new Set(["TV", "NASA", "FBI", "CIA", "USA", "US", "UK", "EU", "NYC", "LA", "SF", "DC", "CEO", "CTO", "DM", "DMs", "ID",
  "PM", "AM", "ASAP", "DIY", "BBQ", "FAQ", "GPS", "PDF", "URL", "USB", "VIP", "NBA", "NFL", "BTS", "K", "TBD", "RSVP", "OMG", "LOL", "RN", "FR",
  "IKEA", "UNESCO", "NATO", "UFO", "MRI", "ER", "ICU", "IQ", "PhD", "MBA", "IT", "HR", "PR", "QA", "UI", "UX", "API", "AI"]);
const SHOUTED_2 = new Set(["NO", "SO", "OH", "GO", "MY", "ME", "WE", "DO", "BE", "UP", "IS", "IN", "ON", "TO", "OF", "AT", "HI", "YO", "OK", "AH", "UH", "UM", "HE", "OR"]);
function speakCaps(t: string): string {
  return t.replace(/\b[A-Z]{2,}\b/g, (w) => {
    if (ACRONYMS.has(w)) return w;
    if (w.length === 2) return SHOUTED_2.has(w) ? w.toLowerCase() : w;
    return /[AEIOUY]/.test(w) ? w.toLowerCase() : w;
  });
}
function unstretch(t: string): string {
  return t
    .replace(/\b(?:ha){3,}h?\b/gi, (w) => (w[0] === "H" ? "Haha" : "haha"))
    .replace(/\b(?:he){3,}\b/gi, (w) => (w[0] === "H" ? "Hehe" : "hehe"))
    .replace(/(\p{L})\1{2,}/gu, (_, c: string) => (c.toLowerCase() === "m" ? c + c : c));
}

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;

/** Shared clean-up: markdown, URLs, emojis, tags, brackets. */
function clean(t: string): string {
  return t
    .replace(/<[^<>]{1,24}>/g, " ") // <happy> emotion tags
    .replace(/\[[^\[\]]{1,30}\]/g, " ") // [audio tags]
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, " ")
    .replace(/[*_`#>~|]+/g, " ")
    .replace(/\n\s*(?:[-•]|\d+[.)])\s+/g, ", ") // list items → a spoken list
    .replace(/^\s*(?:[-•]|\d+[.)])\s+/gm, "")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(EMOJI, " ")
    .replace(/\(([^()]{1,60})\)/g, ", $1,")
    .replace(/\s*—\s*|\s+-\s+/g, ", ")
    .replace(/\.{3,}|…/g, "...")
    .replace(/[!?！？]*[?？][!?！？]*|[!！]{2,}/g, (m) => (/[?？]/.test(m) ? "?" : "!")) // "?!" asks, "!!!" is one "!"
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/,\s*,+/g, ",")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,]+/, "")
    .trim();
}

export function normalizeEnglish(text: string): string {
  let t = clean(text);
  for (const [re, w] of ABBR) t = t.replace(re, w);
  for (const [re, w] of SLANG) t = t.replace(re, w);
  t = t.replace(/\b(?:OK|Ok|ok)\b(?!\.\w)/g, "okay").replace(/\bu\b/g, "you").replace(/\bur\b/g, "your");
  t = speakCaps(unstretch(t));
  // times: 3:30pm, 10:05 AM, 7pm
  t = t.replace(/\b(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\b/gi, (_, h, m, ap) => `${numberToWords(+h)} ${m === "00" ? "" : +m < 10 ? `oh ${numberToWords(+m)} ` : numberToWords(+m) + " "}${ap.toUpperCase()}.M.`.replace(/\s+/g, " "));
  t = t.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => `${numberToWords(+h)} ${m === "00" ? "o'clock" : +m < 10 ? `oh ${numberToWords(+m)}` : numberToWords(+m)}`);
  t = t.replace(/\b(\d{1,2})\s*([ap])\.?m\.?\b/gi, (_, h, ap) => `${numberToWords(+h)} ${ap.toUpperCase()}.M.`);
  // money: $12, $3.50, $1.2M, ₩15,000
  t = t.replace(/\$(\d[\d,]*)(?:\.(\d{2}))?\b/g, (_, d, c) => {
    const n = Number(d.replace(/,/g, ""));
    const dollars = `${numberToWords(n)} dollar${n === 1 ? "" : "s"}`;
    return c && +c ? `${dollars} ${numberToWords(+c)}` : dollars;
  });
  t = t.replace(/₩\s?(\d[\d,]*)/g, (_, d) => `${numberToWords(Number(d.replace(/,/g, "")))} won`);
  t = t.replace(/(\d[\d,.]*)\s?%/g, (_, d) => `${numberToWords(Number(d.replace(/,/g, "")))} percent`);
  t = t.replace(/(\d+)\s?°\s?([CF])\b/g, (_, d, u) => `${numberToWords(+d)} degrees ${u === "C" ? "Celsius" : "Fahrenheit"}`);
  // ordinals 1st 2nd 23rd
  t = t.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_, d) => ordinal(+d));
  // years 1990–2099 standing alone
  t = t.replace(/\b(19\d{2}|20\d{2})\b(?!\s*(?:dollars|percent|won))/g, (_, y) => yearToWords(+y));
  // plain numbers (with thousands separators / decimals)
  t = t.replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\b/g, (d) => numberToWords(Number(d.replace(/,/g, ""))));
  return tidy(t.replace(/\b([AP])\.M\.\./g, "$1.M."));
}

// ---- Korean ----
const SINO = ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
const NATIVE_ONES = ["", "한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉"];
const NATIVE_TENS = ["", "열", "스물", "서른", "마흔", "쉰", "예순", "일흔", "여든", "아흔"];
const NATIVE_COUNTERS = "개|명|시|살|번째|마리|잔|병|권|사람|군데|가지|시간|달|번";

export function sinoKorean(n: number): string {
  if (n === 0) return "영";
  if (!Number.isInteger(n)) {
    const [i, f] = String(n).split(".");
    return `${sinoKorean(Number(i))} 점 ${f.split("").map((d) => (d === "0" ? "영" : SINO[+d])).join("")}`;
  }
  const units: [number, string][] = [[1e8, "억"], [1e4, "만"]];
  for (const [v, w] of units) {
    if (n >= v) {
      const hi = Math.floor(n / v);
      return `${hi === 1 && w === "만" ? "" : sinoKorean(hi)}${w}${n % v ? " " + sinoKorean(n % v) : ""}`.trim();
    }
  }
  let out = "";
  for (const [v, w] of [[1000, "천"], [100, "백"], [10, "십"]] as const) {
    const d = Math.floor(n / v) % 10;
    if (d) out += (d === 1 ? "" : SINO[d]) + w;
  }
  return out + SINO[n % 10];
}

function nativeKorean(n: number): string | null {
  if (n < 1 || n > 99) return null;
  if (n === 20) return "스무";
  return NATIVE_TENS[Math.floor(n / 10)] + NATIVE_ONES[n % 10];
}

export function normalizeKorean(text: string): string {
  let t = clean(text);
  t = t.replace(/(\d{1,2}):(\d{2})/g, (_, h, m) => `${nativeKorean(+h) ?? sinoKorean(+h)}시${m === "00" ? "" : ` ${sinoKorean(+m)}분`}`);
  t = t.replace(/(\d[\d,.]*)\s?%/g, (_, d) => `${sinoKorean(Number(d.replace(/,/g, "")))} 퍼센트`);
  t = t.replace(new RegExp(`(\\d+)\\s?(${NATIVE_COUNTERS})`, "g"), (all, d, c) => {
    const n = nativeKorean(+d);
    return n && !(c === "시간" && +d > 24) ? `${n} ${c}` : `${sinoKorean(+d)} ${c}`;
  });
  t = t.replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g, (d) => sinoKorean(Number(d.replace(/,/g, ""))));
  return tidy(t);
}

/** Punctuation left over by the rewrites: ",." → ".", double spaces, leading commas. */
function tidy(t: string): string {
  return t.replace(/,\s*([.!?])/g, "$1").replace(/\s+([,.!?])/g, "$1").replace(/\s+/g, " ").replace(/^[\s,]+/, "").trim();
}

/** lang: "eng" | "kor" (Seamless codes). */
export function spokenText(text: string, lang: "eng" | "kor"): string {
  return lang === "kor" ? normalizeKorean(text) : normalizeEnglish(text);
}

/** Pause after a clause, by how it ends (Seamless gives none between separate requests). */
export function pauseAfterMs(text: string): number {
  // 11/3 tone pass: casual talk runs clauses together; the old gaps (110 ms after every comma, 220 after every
  // sentence) made each clause sound read out one by one. Before → after, same 10 lines: pause per line 689 → see PR.
  const t = text.trim();
  if (/(\.\.\.|…)$/.test(t)) return 280;
  if (/[?？]$/.test(t)) return 200;
  if (/[!！]$/.test(t)) return 160;
  if (/[.。]$/.test(t)) return 170;
  if (/[,;:，]$/.test(t)) return 50;
  return 120;
}
