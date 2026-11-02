/**
 * Character alignment (Meta voice with-timestamps) → mouth cues for the
 * on-device mouth atlas used by animal / character companions.
 *
 * Viseme set (9 shapes, the atlas has one sprite per shape):
 *   X rest/closed-neutral · A open (a) · E wide (e, i) · O round-open (o)
 *   U round-small (u, w, oo) · M lips pressed (m, b, p) · F lip-teeth (f, v)
 *   L tongue-teeth (l, t, d, n, th) · S small-open (s, z, k, g, r, h, …)
 *
 * Letter-level, not phoneme-level: good enough for stylised mouths. Humans
 * go through lip worker (real lip-sync video), which ignores these cues.
 */
export type Viseme = "X" | "A" | "E" | "O" | "U" | "M" | "F" | "L" | "S";
export type MouthCue = { t: number; v: Viseme };
export type Alignment = { chars: string[]; startsSec: number[]; endsSec: number[] };

const LETTER: Record<string, Viseme> = {
  a: "A", e: "E", i: "E", y: "E", o: "O", u: "U", w: "U", q: "U",
  m: "M", b: "M", p: "M", f: "F", v: "F",
  l: "L", t: "L", d: "L", n: "L",
  s: "S", z: "S", c: "S", k: "S", g: "S", j: "S", r: "S", h: "S", x: "S",
};

// Hangul medial vowels (21) in Unicode order → viseme
const HANGUL_VOWEL: Viseme[] = [
  "A", "A", "A", "A", // ㅏ ㅐ ㅑ ㅒ
  "E", "E", "E", "E", // ㅓ ㅔ ㅕ ㅖ
  "O", "O", "O", "O", "O", // ㅗ ㅘ ㅙ ㅚ ㅛ
  "U", "U", "U", "U", "U", // ㅜ ㅝ ㅞ ㅟ ㅠ
  "E", "E", "E", // ㅡ ㅢ ㅣ
];
// Hangul initials (19): ㅁ=6, ㅂ=7, ㅃ=8, ㅍ=17
const BILABIAL_INITIAL = new Set([6, 7, 8, 17]);

/** Visemes for one character, in order (a Hangul syllable can be two). */
export function charVisemes(ch: string): Viseme[] {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0xac00 && code <= 0xd7a3) {
    const idx = code - 0xac00;
    const initial = Math.floor(idx / 588);
    const medial = Math.floor((idx % 588) / 28);
    const vowel = HANGUL_VOWEL[medial];
    return BILABIAL_INITIAL.has(initial) ? ["M", vowel] : [vowel];
  }
  return [LETTER[ch.toLowerCase()] ?? "X"];
}

export function charViseme(ch: string): Viseme {
  return charVisemes(ch)[0];
}

/**
 * @param offsetMs where this alignment starts in the utterance's audio
 *                 timeline (alignment times are per TTS request).
 */
export function alignmentToMouth(a: Alignment, offsetMs: number): MouthCue[] {
  const cues: MouthCue[] = [];
  let inTag = false;
  let lastEnd = 0;
  const push = (t: number, v: Viseme) => {
    const prev = cues[cues.length - 1];
    if (prev && prev.v === v) return;
    if (prev && prev.t === t) {
      prev.v = v;
      return;
    }
    cues.push({ t, v });
  };
  for (let i = 0; i < a.chars.length; i++) {
    const ch = a.chars[i];
    if (ch === "[") inTag = true;
    if (inTag) {
      if (ch === "]") inTag = false;
      continue;
    }
    const start = a.startsSec[i] ?? lastEnd;
    const end = a.endsSec[i] ?? start;
    const vs = charVisemes(ch);
    const step = (end - start) / vs.length;
    vs.forEach((v, k) => push(Math.round(offsetMs + (start + step * k) * 1000), v));
    lastEnd = Math.max(lastEnd, end);
  }
  if (cues.length) push(Math.round(offsetMs + lastEnd * 1000), "X");
  return cues;
}

export type WordTiming = { w: string; s: number; e: number };

/** Word timings (ms, utterance timeline) for captions; [audio tags] skipped. */
export function alignmentToWords(a: Alignment, offsetMs: number): WordTiming[] {
  const out: WordTiming[] = [];
  let inTag = false;
  let cur: WordTiming | null = null;
  for (let i = 0; i < a.chars.length; i++) {
    const ch = a.chars[i];
    if (ch === "[") inTag = true;
    if (inTag) {
      if (ch === "]") inTag = false;
      continue;
    }
    if (/\s/.test(ch)) {
      cur = null;
      continue;
    }
    const s = Math.round(offsetMs + (a.startsSec[i] ?? 0) * 1000);
    const e = Math.round(offsetMs + (a.endsSec[i] ?? a.startsSec[i] ?? 0) * 1000);
    if (!cur) {
      cur = { w: ch, s, e };
      out.push(cur);
    } else {
      cur.w += ch;
      cur.e = e;
    }
  }
  return out;
}
