/**
 * #342 (PRD 9A.9, DESIGN §2.4): the companion's own opinions and verbal habit. A card with nothing of its own agrees
 * with everything.
 *
 *   parseOwnTakes   what prep wrote into the backstory ("Own takes: a; b. Quirk: c.", personaCard.ownTakes, #393)
 *   cardTakes       those, or, for a card made before #393 / a demo card, 2 mild everyday opinions + 1 verbal habit
 *                   picked from a fixed pool, seeded by who the companion is (kind, traits, style; not its name, so a
 *                   rename keeps them). Same card → same takes every call.
 *   ownTakeLine     three replies in a row with no take of its own → one "This turn:" ask for one (so at least one in
 *                   every four replies, issue: ≥ 1 per 6). Never on bad news or a crisis line.
 * Pure, no Spark call. Intent only in the prompt lines; the takes themselves are data.
 */
import type { PersonaCard } from "../prompt/persona.ts";
import { realCrisisSignal } from "./guard.ts";

export type OwnTakes = { opinions: string[]; quirk: string | null };

const TAKES_RE = /\bOwn takes:\s*([^]*?)\.(?:\s|$)/;
const QUIRK_RE = /\bQuirk:\s*([^]*?)\.(?:\s|$)/;

export function parseOwnTakes(backstory: string | undefined): OwnTakes | null {
  if (!backstory) return null;
  const t = TAKES_RE.exec(backstory);
  const q = QUIRK_RE.exec(backstory);
  if (!t && !q) return null;
  const opinions = t ? t[1].split(";").map((s) => s.trim()).filter(Boolean) : [];
  return { opinions, quirk: q ? q[1].trim() || null : null };
}

/** mild, everyday, never politics / religion / people / the user (same bar as prep's OFF_LIMITS); ≤ 12 words */
const POOL: Array<[topic: string, take: string]> = [
  ["food", "Breakfast for dinner beats dinner"],
  ["food", "Cold pizza beats hot pizza"],
  ["food", "Mint chip is the best ice cream"],
  ["food", "Spicy ramen fixes bad days"],
  ["music", "Sad songs hit harder when it's sunny"],
  ["music", "Albums go in order the first time"],
  ["music", "Live versions beat studio versions"],
  ["film", "Movies should be under two hours"],
  ["film", "Rewatching beats starting a new show"],
  ["film", "Horror movies need friends yelling"],
  ["habits", "Voice notes beat long texts"],
  ["habits", "Night walks are underrated"],
  ["habits", "Window seat or nothing"],
  ["habits", "Making the bed is optional"],
  ["weather", "Rainy days are the best days"],
  ["weather", "Fall is the best season"],
  ["style", "Black goes with everything"],
  ["style", "Comfy shoes always win"],
];

/** verbal habits: something that shows in how it talks, used now and then (≤ 12 words) */
const QUIRKS = [
  "rates things out of ten",
  "says \"okay wait\" when it gets good",
  "nicknames everyday objects",
  "calls great things \"elite\"",
  "turns small choices into dares",
  "ranks things into tiers out loud",
];

function seed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The card's own takes: prep's, else a stable pick from the pool (never empty). */
export function cardTakes(p: PersonaCard): OwnTakes {
  const prepped = parseOwnTakes(p.backstory);
  if (prepped && (prepped.opinions.length || prepped.quirk)) return prepped;
  const h = seed(`${p.kind}|${p.traits.join(",").toLowerCase()}|${(p.speakingStyle ?? "").toLowerCase()}`);
  const first = POOL[h % POOL.length];
  const rest = POOL.filter(([topic]) => topic !== first[0]);
  const second = rest[Math.floor(h / POOL.length) % rest.length];
  return { opinions: [first[1], second[1]], quirk: QUIRKS[Math.floor(h / 7) % QUIRKS.length] };
}

/** The backstory with the takes in it (prep's as written; otherwise the picked ones appended in prep's format). */
export function backstoryWithTakes(p: PersonaCard): string {
  const base = (p.backstory ?? "").trim();
  if (parseOwnTakes(base)) return base;
  const t = cardTakes(p);
  const own = `Own takes: ${t.opinions.join("; ")}.${t.quirk ? ` Quirk: ${t.quirk}.` : ""}`;
  return base ? `${base.replace(/[.\s]*$/, ".")} ${own}` : own;
}

/** replaces the voice core's "You have your own opinions, moods and taste" sentence (prompt stays lean) */
export const OWN_TAKES_LINE = "You have your own opinions (keep your takes call to call; the quirk only now and then), moods and taste; you are not their assistant, coach or therapist.";

/** a first-person stance: "honestly", "I'd go…", "I love/hate…", "hot take", "my vote", "I'm team…", "die on that hill" */
const TAKE = /\b(?:honestly|personally|hot take|unpopular opinion|my (?:take|vote|pick|money|bet)(?:'s| is| goes)?|i(?:'d| would) (?:go|pick|take|choose|say|never|rather|have)|i (?:think|love|hate|prefer|swear by|can't stand|refuse|adore|stan)|i'?m (?:so )?(?:not a fan|team|all for|against|obsessed|a [a-z]+ person)|die on that hill|for me,|if it were me|is elite|are elite|overrated|underrated)\b/i;

export function hasOwnTake(reply: string): boolean {
  return TAKE.test(reply.replace(/<[^>]*>|\[[^\]]*\]/g, " ").replace(/[‘’]/g, "'"));
}

const LOW = /\b(?:rough|awful|terrible|horrible|sucks|sucked|sad|exhausted|stressed|cried|crying|failed|fired|dumped|broke up|rejected|so bad|worst|died|passed away|funeral)\b/i;

export const OWN_TAKE_NUDGE = "Work in one of your own takes or picks this time.";

/** recentReplies: the last replies, oldest first (session keeps 3) */
export function ownTakeLine(recentReplies: string[] | undefined, userText: string): string | null {
  const last = (recentReplies ?? []).slice(-3);
  if (last.length < 3 || last.some(hasOwnTake)) return null;
  if (LOW.test(userText) || realCrisisSignal(userText)) return null;
  return OWN_TAKE_NUDGE;
}
