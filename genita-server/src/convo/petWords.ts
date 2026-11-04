/**
 * Verbal tics (11/5 eval 5c: "elite" in 16/16 product reactions and most style verdicts). A reaction word is said at
 * most once per call:
 *   - the prompt lists the ones this call already used ("use a different word"), `petWordLine`;
 *   - a repeat that still comes back is swapped for a plain word in rotation (`PetWordCap`), so the call never hears
 *     "elite" twice. Same word, same slot: "elite pick" → "great pick", "that's elite" → "that's great".
 * Kill switch: GENITA_PET_WORDS=0 (no prompt line, no swap).
 */
export function petWordsOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GENITA_PET_WORDS !== "0";
}

/** reaction words that turn into tics, and plain words that fit the same slot */
export const PET_WORDS: Record<string, string[]> = {
  elite: ["great", "solid", "perfect", "so good"],
  iconic: ["classic", "great", "perfect"],
  killer: ["great", "solid", "really good"],
  immaculate: ["perfect", "great"],
  slay: ["kill it", "own it"],
  slays: ["kills it", "owns it"],
  // 11/5 eval 5c rerun: the reactions in 3+ of 18 ("so you" 5/18, "sleep game", "breezy") and the new "fire", "pristine"
  fire: ["great", "so good"],
  pristine: ["perfect", "spotless"],
  breezy: ["light", "easy"],
  "sleep game": ["sleep setup", "pajama lineup"],
  "so you": ["your style", "right up your street"],
  "very you": ["your style", "right up your street"],
  "totally you": ["your style", "right up your street"],
};
const KEYS = Object.keys(PET_WORDS);
/** "so you" / "very you" only as the end of a clause ("that's so you."), never "so you can…" */
const pattern = (k: string) => (/ you$/.test(k) ? `${k.replace(" ", "\\s+")}(?=\\s*(?:[.!?,;]|$))` : `${k.replace(" ", "\\s+")}\\b`);
const RE = new RegExp(`\\b(?:${KEYS.map(pattern).join("|")})`, "gi");
/** "so you", "very you", "totally you" are one tic */
const keyOf = (w: string) => w.toLowerCase().replace(/\s+/g, " ").replace(/^(?:very|totally) you$/, "so you");
/** a standing hint for one-line reactions (a product ask): no stock phrase, so separate calls don't all sound alike */
export const STOCK_REACTION_HINT = "React in your own fresh words, never a stock phrase like \"so you\", \"elite\", \"fire\" or \"pristine\".";

/** the pet words in a text, each once */
export function petWordsIn(text: string): string[] {
  return [...new Set([...text.matchAll(RE)].map((m) => keyOf(m[0])))];
}

/** the prompt line for this turn: the reaction words this call already used (null when none) */
export function petWordLine(replies: string[]): string | null {
  const used = [...new Set(replies.flatMap(petWordsIn))];
  if (!used.length) return null;
  return `Words you already used this call, say each at most once per call (data): ${used.map((w) => `"${w}"`).join(", ")}; react with a different word now.`;
}

/** Per call: the first use of a pet word stays, every later one is swapped for a plain word in rotation. */
export class PetWordCap {
  private readonly used = new Map<string, number>();

  constructor(earlier: string[] = []) {
    for (const t of earlier) for (const w of petWordsIn(t)) this.used.set(w, 1);
  }

  apply(text: string): string {
    return text.replace(RE, (word: string) => {
      const k = keyOf(word);
      const n = this.used.get(k) ?? 0;
      this.used.set(k, n + 1);
      if (n === 0) return word;
      const alts = PET_WORDS[k] ?? [];
      const alt = alts[(n - 1) % alts.length] ?? word;
      return /^\p{Lu}/u.test(word) ? alt[0].toUpperCase() + alt.slice(1) : alt;
    });
  }
}
