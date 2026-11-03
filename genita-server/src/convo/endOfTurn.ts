/**
 * End-of-turn policy (CA-14, 11/4). Muse Transcribe ends a segment ~0.7 s after the voice stops, so a user who pauses
 * to think mid-sentence used to get a full reply that was cut off when they went on. A Transcribe final is now a
 * candidate: the Session commits the turn only after this much more silence, longer when the words so far look
 * unfinished. If the user resumes inside the hold, the segments are joined into one turn.
 *
 *   complete      "?" / "!" / "." ending with no sign of more to come          → commit now (0 ms, no latency cost)
 *   unpunctuated  no terminal punctuation (ASR heard no falling intonation)      → short hold (masked by speculation)
 *   incomplete    trailing "and / so / because / the / to / um / ," or a clause   → long hold, backchannel cue inside it
 *                 cut right after its verb ("and then he started")
 *
 * GENITA_EOT_HOLD=0 restores the old policy (every final commits at once).
 */
export type EotKind = "complete" | "unpunctuated" | "incomplete";
export type EotVerdict = { kind: EotKind; holdMs: number; why: string };

/**
 * holdMs is counted from the Transcribe final (≈0.7 s after the voice stopped). The user's resumed speech reaches us
 * ≈0.45 s after they start again, so a 1.6 s hold keeps the turn open for pauses up to ≈1.85 s.
 * cueAfterMs: the backchannel goes ≈1.05 s after the voice stopped.
 */
export const EOT = { incompleteMs: 1600, unpunctuatedMs: 700, cueAfterMs: 350 } as const;

const w = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
/** words a finished sentence never ends on */
const CONTINUERS = w(`
  and but or nor so because cause 'cause cuz coz since although unless until till whereas whether if plus
  the a an my your our their every
  of to with into onto from about than as via per toward towards against during without between through
  um uh er erm uhm umm uhh hmm
  like basically literally kinda sorta gonna wanna gotta
`);
/** "so" closes a sentence after these ("I think so", "I hope so", "I told you so") */
const SO_CLOSERS = w("think thought hope guess believe suppose said say says told you do did is was really so not");
/** "to" closes an elliptical sentence after these ("I have to", "I don't want to") */
const TO_CLOSERS = w("want wanted wanna have has had need needs needed used supposed got going ought try tried love like hate meant able decided plan planned");
/** a stranded preposition closes a sentence after these ("that's what it's for", "what I was talking about") */
const STRANDERS = w("is are was were be been it's that's what's talking thinking worried afraid scared proud sure made full tired thinking looking waiting asking dealing");
/** clause openers: "and then he started", "so I was" */
const OPENERS = w("and but so because cause 'cause cuz then when while if until since like");
const PRONOUNS = w("i he she we they you it");
/** verbs that take more after them: right after "<opener> <person>" the clause is not over ("and then he started") */
const OPEN_VERBS = w("started starts start began begins begin kept keeps was were is am are goes gonna wanna");
/** a person, not "it" ("and then it began." is a finished sentence) */
const PEOPLE = w("i he she we they");

const norm = (t: string) => t.toLowerCase().replace(/[’‘]/g, "'");

export function judgeEndOfTurn(text: string, cfg: { incompleteMs?: number; unpunctuatedMs?: number } = {}): EotVerdict {
  const incompleteMs = cfg.incompleteMs ?? EOT.incompleteMs;
  const unpunctuatedMs = cfg.unpunctuatedMs ?? EOT.unpunctuatedMs;
  const t = text.trim().replace(/["'”’)\]]+$/u, "");
  if (!t) return { kind: "complete", holdMs: 0, why: "empty" };
  const incomplete = (why: string): EotVerdict => ({ kind: "incomplete", holdMs: incompleteMs, why });
  // a question asks for the answer now
  if (/[?？]$/u.test(t)) return { kind: "complete", holdMs: 0, why: "question" };
  if (/(?:[,;:\-–—]|\.\.\.|…)$/u.test(t)) return incomplete("trailing_mark");
  const words = norm(t).replace(/[.!。！]+$/u, "").split(/\s+/).map((x) => x.replace(/^[^\p{L}']+|[^\p{L}']+$/gu, "")).filter(Boolean);
  const last = words.at(-1) ?? "";
  const prev = words.at(-2) ?? "";
  const prev2 = words.at(-3) ?? "";
  const punct = /[.!。！]$/u.test(t);
  if (CONTINUERS.has(last)) {
    if (last === "so" && SO_CLOSERS.has(prev)) return punct ? { kind: "complete", holdMs: 0, why: "so_closer" } : { kind: "unpunctuated", holdMs: unpunctuatedMs, why: "so_closer" };
    // "I have to." is a whole answer; "…that I wanted to" with no falling tone is still going
    if (last === "to" && TO_CLOSERS.has(prev) && punct) return { kind: "complete", holdMs: 0, why: "to_closer" };
    // "what it's for." / "what I was talking about." — but only when ASR heard the sentence end
    if (punct && STRANDERS.has(prev) && last !== "and" && last !== "but" && last !== "or" && last !== "the" && last !== "a" && last !== "an") return { kind: "complete", holdMs: 0, why: "stranded_prep" };
    if (last === "like" && punct && prev && !OPENERS.has(prev) && !PRONOUNS.has(prev)) return { kind: "complete", holdMs: 0, why: "like_object" };
    return incomplete(`continuer:${last}`);
  }
  // "and then" / "but then" / "so then"
  if (last === "then" && OPENERS.has(prev)) return incomplete("and_then");
  // "and then he", "because I"
  if (PRONOUNS.has(last) && last !== "you" && last !== "it" && (OPENERS.has(prev) || prev === "then")) return incomplete(`opener_pronoun:${prev}`);
  // "and then he started", "so I was", "because she said"
  if (OPEN_VERBS.has(last) && PEOPLE.has(prev) && (OPENERS.has(prev2) || prev2 === "then")) return incomplete(`open_clause:${last}`);
  // "I was just" trailing off — not "that was fair and just." (Codex P2)
  if (last === "just" && !punct && words.length >= 3) return incomplete("just");
  if (!punct && !/[!！]$/u.test(t)) return { kind: "unpunctuated", holdMs: unpunctuatedMs, why: "no_terminal_punct" };
  return { kind: "complete", holdMs: 0, why: "terminal_punct" };
}

/** join a held segment and the next one ("…he started." + "yelling at me" → "…he started yelling at me") */
export function joinSegments(held: string, next: string): string {
  const a = held.trim();
  const b = next.trim();
  if (!a) return b;
  if (!b) return a;
  // the ASR closed the first segment with a period it did not hear as an ending: drop it when the next goes on lower case
  const head = /\.$/.test(a) && !/\.\.$/.test(a) && /^\p{Ll}/u.test(b) ? a.slice(0, -1) : a;
  return `${head} ${b}`;
}

/** GENITA_EOT_INCOMPLETE_MS / GENITA_EOT_UNPUNCT_MS: tune the holds on a restart without a deploy (0 = commit at once) */
export function eotTuning(env: NodeJS.ProcessEnv = process.env): { incompleteMs?: number; unpunctuatedMs?: number } {
  const ms = (v: string | undefined) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Math.max(0, Math.min(4000, Number(v))) : undefined);
  return { incompleteMs: ms(env.GENITA_EOT_INCOMPLETE_MS), unpunctuatedMs: ms(env.GENITA_EOT_UNPUNCT_MS) };
}
