/**
 * Splits a streamed reply into speakable sentences so the first one can go
 * to TTS while Spark is still writing the rest.
 *
 * A sentence ends at . ! ? … (or full-width 。！？) once the next character
 * shows it really ended: whitespace for Latin terminators, anything for
 * full-width ones. Decimals ("3.5"), common abbreviations ("Dr.", "e.g.")
 * and initials ("U.S.") do not end a sentence.
 *
 * The FIRST piece may also be cut at a comma/semicolon once it is longer than
 * firstClauseMaxChars, because a long opening sentence delays the first audio.
 */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "a.m", "p.m", "u.s", "u.k", "no", "approx", "mt",
]);
const LATIN_END = new Set([".", "!", "?", "…"]);
const WIDE_END = new Set(["。", "！", "？"]);
const CLOSERS = new Set(['"', "'", "”", "’", ")", "]", "」", "』"]);
// Keep tool-announcement recognition aligned with the clauses we can emit.
export const CLAUSE_SEPARATORS = ",;:，、；：—";
const CLAUSE_BREAK = new Set(CLAUSE_SEPARATORS);
const FIRST_CLAUSE = new RegExp(`^(\\s*<[^<>]{1,24}>)?[^${CLAUSE_SEPARATORS}.!?…。！？]*?\\p{L}[^${CLAUSE_SEPARATORS}.!?…。！？]*?[${CLAUSE_SEPARATORS}](?=\\s)`, "u");

export type SplitterOptions = {
  firstClauseMaxChars?: number;
  /**
   * Server voice (Seamless): cut the FIRST piece at its first comma/semicolon/dash, however short
   * ("Oh wow," / "Hmm,"), so the first sound starts while Spark is still writing the sentence.
   */
  eagerFirstClause?: boolean;
  /** Later pieces longer than this are cut at their last comma (rhythm; 0 = never). */
  clauseMaxChars?: number;
};

export class SentenceSplitter {
  private buf = "";
  private emitted = 0;
  private readonly firstClauseMaxChars: number;
  private readonly eagerFirstClause: boolean;
  private readonly clauseMaxChars: number;

  constructor(opts: SplitterOptions = {}) {
    this.firstClauseMaxChars = opts.firstClauseMaxChars ?? 90;
    this.eagerFirstClause = opts.eagerFirstClause ?? false;
    this.clauseMaxChars = opts.clauseMaxChars ?? 0;
  }

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const s = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (s) {
        out.push(s);
        this.emitted++;
      }
    }
    return out;
  }

  flush(): string[] {
    const s = this.buf.trim();
    this.buf = "";
    if (!s) return [];
    this.emitted++;
    return [s];
  }

  /** Index just past the end of the first complete sentence in buf, or -1. */
  private findCut(): number {
    const b = this.buf;
    if (this.emitted === 0 && this.eagerFirstClause) {
      // first clause break, skipping a leading <emotion> tag; needs at least one letter before it
      const m = FIRST_CLAUSE.exec(b);
      if (m) return m[0].length;
    }
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (WIDE_END.has(c)) {
        let j = i + 1;
        while (j < b.length && (CLOSERS.has(b[j]) || WIDE_END.has(b[j]))) j++;
        if (j < b.length) return j;
        return -1; // need one more char to know closers are done
      }
      if (LATIN_END.has(c)) {
        let j = i + 1;
        while (j < b.length && (LATIN_END.has(b[j]) || CLOSERS.has(b[j]))) j++;
        if (j >= b.length) return -1; // can't tell yet
        if (!/\s/.test(b[j])) {
          i = j - 1;
          continue; // "3.5", "U.S", "e.g"
        }
        if (c === "." && this.isAbbreviation(b, i)) {
          i = j - 1;
          continue;
        }
        return j;
      }
    }
    if (this.emitted > 0 && this.clauseMaxChars > 0 && b.length > this.clauseMaxChars) {
      for (let i = this.clauseMaxChars; i >= 40; i--) {
        if (CLAUSE_BREAK.has(b[i]) && i + 1 < b.length && /\s/.test(b[i + 1])) return i + 1;
      }
    }
    if (this.emitted === 0 && b.length > this.firstClauseMaxChars) {
      for (let i = b.length - 1; i >= 20; i--) {
        if (CLAUSE_BREAK.has(b[i]) && i + 1 < b.length && /\s/.test(b[i + 1])) return i + 1;
      }
    }
    return -1;
  }

  private isAbbreviation(b: string, dot: number): boolean {
    let k = dot - 1;
    while (k >= 0 && /[A-Za-z.]/.test(b[k])) k--;
    const word = b.slice(k + 1, dot).toLowerCase();
    if (!word) return false;
    if (ABBREVIATIONS.has(word)) return true;
    // single initial like "J." or dotted initials "U.S."
    return /^[a-z]$/.test(word) || /^([a-z]\.)+[a-z]$/.test(word);
  }
}
