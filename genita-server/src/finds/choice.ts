/**
 * Demo 11/4 (device): "black or white shoes for me?" → the companion said white suits her, then the shoes sheet
 * searched BLACK. An "A or B" ask is answered out loud; the search after it follows that spoken verdict, and with no
 * clear verdict no product sheet opens at all.
 */

/** the two options of an "A or B" ask ("black or white shoes", "the navy one or the beige one") */
const OR_PAIR = /\b([a-z][a-z-]{1,20})\s+or\s+(?:the\s+|a\s+)?([a-z][a-z-]{1,20})\b/i;
const FILLER = /^(?:the|a|an|this|that|one|it|me|you|should|would|could|go|wear|either|not|and|so|is|are|do)$/i;

export function choiceOptions(question: string): [string, string] | null {
  const m = question.match(OR_PAIR);
  if (!m) return null;
  const a = m[1].toLowerCase();
  const b = m[2].toLowerCase();
  if (a === b || FILLER.test(a) || FILLER.test(b)) return null;
  return [a, b];
}

const VERDICT_BEFORE = /\b(?:go with|go for|pick|choose|i'?d (?:say|go with|go for|pick|choose)|definitely|wear|get|try)\s+(?:the\s+)?(?:a\s+)?$/i;
const VERDICT_AFTER = /^\s*(?:ones?\s+|shoes?\s+|pair\s+|\w+\s+)?(?:suits?|works?|looks?|is (?:better|the one|your|more)|wins|for (?:you|sure)|all the way|would (?:look|suit|work)|'s (?:better|the one|your))/i;
const NEGATED_AFTER = /^\s*(?:ones?\s+|shoes?\s+|\w+\s+)?(?:doesn'?t|don'?t|won'?t|isn'?t|is not|might not|could feel|can feel|feels? (?:heavy|harsh|too))/i;

/**
 * Which of the two options the spoken reply picks: the only one it names, or the one a verdict word sits on
 * ("white suits you", "go with the white"). null = no clear pick (both hedged, or neither named).
 */
export function spokenChoice(options: [string, string], said: string | null | undefined): string | null {
  const s = (said ?? "").toLowerCase();
  if (!s) return null;
  const named = options.filter((o) => new RegExp(`\\b${o}\\b`).test(s));
  if (named.length === 0) return null;
  if (named.length === 1) {
    const o = named[0];
    const at = s.search(new RegExp(`\\b${o}\\b`));
    return NEGATED_AFTER.test(s.slice(at + o.length)) ? options.find((x) => x !== o) ?? null : o;
  }
  // "black and white both work" / "either one": no pick
  if (/\b(?:both|either)\b/.test(s)) return null;
  const hits = options.filter((o) => {
    for (const m of s.matchAll(new RegExp(`\\b${o}\\b`, "g"))) {
      const i = m.index ?? 0;
      if (VERDICT_BEFORE.test(s.slice(Math.max(0, i - 30), i)) || (VERDICT_AFTER.test(s.slice(i + o.length)) && !NEGATED_AFTER.test(s.slice(i + o.length)))) return true;
    }
    return false;
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The search an "A or B" turn may run: the spoken pick, or `false` when the ask was a choice and the reply picked
 * nothing clear (no sheet). `null` = not a choice ask, nothing to enforce.
 */
export function choiceForSearch(question: string, said: string | null | undefined): string | false | null {
  const opts = choiceOptions(question);
  if (!opts) return null;
  return spokenChoice(opts, said) ?? false;
}

const COLOR = /^(?:black|white|navy|blue|red|green|grey|gray|beige|brown|tan|cream|ivory|pink|purple|yellow|orange|olive|khaki|camel|burgundy|maroon|silver|gold|charcoal|denim|light|dark)$/;
export function isColorWord(w: string): boolean {
  return COLOR.test(w.toLowerCase());
}
