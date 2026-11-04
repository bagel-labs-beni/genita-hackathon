/**
 * Barge-in echo guard (iPhone build 13, 11/4): on the speaker the mic hears the companion's own voice,
 * so raw VAD and its transcript must not cut the reply. Only real words from the user count, and a
 * transcript that matches what the companion is saying right now is its own echo.
 */

/** sounds the ASR writes for a breath or a hum: never a word that interrupts */
const NON_WORD = /^(?:u+h+|u+m+|h?m+|hm+|a+h+|o+h+|e+r+|e+h+|mhm|uh-?huh|huh)$/;

const tokens = (t: string): string[] =>
  t
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)|<[^>]*>|\*[^*]*\*/g, " ") // [noise] (music) <sound> *laughs*
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w && /\p{L}/u.test(w));

/** words of real speech in a transcript: tags, punctuation and hums ("mm", "uh") are not words */
export function realWords(text: string): number {
  return tokens(text).filter((w) => !NON_WORD.test(w)).length;
}

/**
 * The partial is the companion's own voice coming back through the mic: its words are (mostly) the
 * words of the line playing. One or two words must appear in that order in the line; longer
 * transcripts are echo when at least 60% of their words are in it.
 */
export function isEchoOf(partial: string, playing: string): boolean {
  const p = tokens(partial).filter((w) => !NON_WORD.test(w));
  if (!p.length) return false;
  const r = tokens(playing);
  if (!r.length) return false;
  if (p.length <= 2) {
    for (let i = 0; i + p.length <= r.length; i++) if (p.every((w, j) => r[i + j] === w)) return true;
    return false;
  }
  const set = new Set(r);
  return p.filter((w) => set.has(w)).length / p.length >= 0.6;
}
