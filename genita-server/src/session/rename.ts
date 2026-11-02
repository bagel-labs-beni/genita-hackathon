/**
 * F2-L26 (#123) rename by voice: "Call yourself Max", "Your name is Max now",
 * "I'll call you Max", "Can I call you Max?" → "Max". Deterministic (no model
 * call), English only, checked per sentence. The name must end the sentence
 * (optionally followed by now / from now on / instead / please), which keeps
 * "Your name is Jin, right?" and "I'll call you when I get home" out. In a
 * mixed-case transcript the name must be capitalized ("Call yourself out",
 * "I'll call you later"); an all-lowercase ASR line relies on the stop list.
 */
import { cleanName } from "../prep/naming.ts";

const LEAD = [
  "call yourself",
  "you(?:'ll| will) be called",
  "your name(?:'s| is)(?: now)?",
  "change your name to",
  "rename yourself(?: to)?",
  "(?:i(?:'ll| will| shall)|i'm (?:gonna|going to)|i am (?:gonna|going to)|let me|let's|let us|can i|could i|may i|i(?:'d| would) like to|i (?:want|wanna) to|i wanna) call you",
].join("|");

const TAIL_WORDS = "now|from now on|instead|then|please|okay|ok";
const WORD = "[\\p{L}][\\p{L}\\p{M}'’-]*";
const RENAME = new RegExp(
  `(?:^|[\\s,;:—-])(?:${LEAD})\\s+(${WORD}(?:\\s+(?!(?:${TAIL_WORDS})\\b)${WORD})?)(?:,?\\s+(?:${TAIL_WORDS}))?\\s*[.!?…]*$`,
  "iu",
);

/** "Don't call yourself Max", "I won't call you Max": a negation before the phrase is not a rename (Codex 11/2) */
const NEGATED = /\b(?:don't|dont|do not|doesn't|never|not|won't|wont|will not|can't|cant|cannot|shouldn't|stop)\b/i;

/**
 * Questions (Codex 11/2): a request to call it something renames ("Can I call you Max?"); a question about the
 * companion's habit or an opinion does not ("Why do you call yourself Max?", "Should I call you Max?",
 * "Your name is Max now?"). Rule: a question word before the phrase never renames; a sentence ending in "?"
 * renames only through "can/could/may I call you".
 */
const QUESTION_LEAD = /\b(?:why|what|how|when|where|who|do|does|did|should|shall|would|will|are|is|was|were)\b/i;
const REQUEST = /\b(?:can|could|may) i call you\s/i;

const STOP = new Set(
  "out back later tomorrow tonight soon again now today sometime sometimes then when if in on at up a an the my your his her their that this it what whatever something anything maybe lucky so how anytime every after before about because yourself myself me him them us ok okay yes no please by".split(" "),
);

export function detectRename(text: string): string | null {
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    const s = sentence.trim().replace(/[’‘]/g, "'"); // iOS keyboards and ASR send curly apostrophes
    const m = s.match(RENAME);
    if (!m) continue;
    const before = s.slice(0, m.index! + m[0].search(/\S/));
    if (NEGATED.test(before) || QUESTION_LEAD.test(before)) continue;
    if (/\?\s*$/.test(s) && !REQUEST.test(m[0])) continue;
    const name = m[1];
    if (STOP.has(name.split(/\s+/)[0].toLowerCase())) continue;
    const mixedCase = /\p{Lu}/u.test(s);
    if (mixedCase && !/^\p{Lu}/u.test(name)) continue;
    const clean = cleanName(name);
    if (clean) return clean;
  }
  return null;
}
