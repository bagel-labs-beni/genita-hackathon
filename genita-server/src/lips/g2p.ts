/**
 * Phoneme labels from the reply text (CMU Pronouncing Dictionary), on the aligner's word times.
 *
 * The voice service's aligner (11/3 "uroman-snap-hold50") times words well but guesses phoneme labels from the
 * letters: "you" came back as AW, "warm" as W AE R M. The app picks the mouth shape from those labels, so round /
 * spread shapes landed on the wrong words. Here every word the dictionary knows gets its real ARPAbet phonemes
 * (first pronunciation, no stress digits), laid over that word's own time span:
 *   - same count as the aligner gave → the aligner's phoneme boundaries, new labels;
 *   - different count → the word span split again, vowels weighted 1.5 against consonants.
 * Unknown words keep the aligner's labels. No model: a static open dictionary (dict/cmudict-1st.txt.gz,
 * CMU Pronouncing Dictionary 0.7b, BSD-2 — dict/cmudict-LICENSE), loaded once on first use (~126k words).
 * Switch: GENITA_LIPS_G2P, default on; "0" / "false" / "off" keeps the aligner's labels.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { ClauseTiming, PhonemeTiming } from "./visemes.ts";

const VOWELS = new Set(["AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW"]);
let dict: Map<string, string[]> | null = null;

export function cmuDict(): Map<string, string[]> {
  if (dict) return dict;
  const m = new Map<string, string[]>();
  try {
    const raw = gunzipSync(readFileSync(new URL("./dict/cmudict-1st.txt.gz", import.meta.url))).toString("utf8");
    for (const line of raw.split("\n")) {
      const sp = line.indexOf(" ");
      if (sp > 0) m.set(line.slice(0, sp), line.slice(sp + 1).split(" "));
    }
  } catch {
    // no data file: every word keeps the aligner's labels
  }
  dict = m;
  return m;
}

export function g2pOn(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.GENITA_LIPS_G2P ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/** "Halloween," → "halloween"; "I'd" → "i'd"; curly apostrophes folded. */
export function dictKey(word: string): string {
  return word.toLowerCase().replace(/[‘’]/g, "'").replace(/^[^a-z']+|[^a-z']+$/g, "");
}

/** The clause timing with dictionary phoneme labels on every known word (see the file comment). */
export function relabelPhonemes(t: ClauseTiming, d: Map<string, string[]> = cmuDict()): ClauseTiming {
  if (!d.size || !t.words.length) return t;
  const out: PhonemeTiming[] = [];
  const used = new Set<number>();
  for (const w of t.words) {
    const inWord = t.phonemes.map((p, i) => ({ p, i })).filter(({ p }) => (p.s + p.e) / 2 >= w.s && (p.s + p.e) / 2 < w.e);
    const ph = d.get(dictKey(w.w));
    if (!ph?.length) continue;
    for (const { i } of inWord) used.add(i);
    if (inWord.length === ph.length) {
      inWord.forEach(({ p }, k) => out.push({ p: ph[k], s: p.s, e: p.e }));
      continue;
    }
    const s0 = inWord.length ? Math.min(w.s, inWord[0].p.s) : w.s;
    const e0 = inWord.length ? Math.max(w.e, inWord[inWord.length - 1].p.e) : w.e;
    const weights = ph.map((x) => (VOWELS.has(x) ? 1.5 : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    ph.forEach((x, k) => {
      const s = Math.round(s0 + ((e0 - s0) * acc) / total);
      acc += weights[k];
      const e = Math.round(s0 + ((e0 - s0) * acc) / total);
      if (e > s) out.push({ p: x, s, e });
    });
  }
  t.phonemes.forEach((p, i) => { if (!used.has(i)) out.push(p); });
  out.sort((a, b) => a.s - b.s || a.e - b.e);
  return { words: t.words, phonemes: out };
}

// warm the dictionary off the request path (~0.1–0.2 s parse) so the first reply's timing never waits on it
if (g2pOn()) setTimeout(() => void cmuDict(), 0).unref?.();
