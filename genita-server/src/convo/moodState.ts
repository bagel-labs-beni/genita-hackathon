/**
 * #344 (PRD 9A.9, DESIGN §7.3): the companion's own mood, a small state {valence, energy} in [-1, 1].
 *
 *   baseline   from the persona card (witty / playful → a bit more energy, calm / gentle → a bit less, warm → a bit
 *              warmer). Capped at ±0.25 so a persona alone never triggers a hint; it is where the mood rests.
 *   drift      per user line (rhythm.ts moodFrom): decay 25 % toward the baseline, then good news +, bad news −,
 *              a laugh or a tease → playful, two flat replies in a row ("ok", "yeah") → quieter (lower energy).
 *   carry      across calls (callMood.ts): the ending mood fades back to the baseline, 12 h half-life.
 *   effect     one "This turn:" hint line with its pacing (DESIGN §7.2: soft = short sentences and a comma pause,
 *              excited = a short burst), the face's size by energy, and a resting face instead of snapping to neutral.
 *
 * Pure. Numbers only: nothing the user said is kept. Rollback: GENITA_CONVO_V1=0 (the whole v1 engine).
 */

export type Mood = { valence: number; energy: number };
export const NEUTRAL: Mood = { valence: 0, energy: 0 };

export const clampMood = (v: number) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));
/** v moved toward base, keeping the fraction k of the distance (0.75 = a quarter of the way back) */
export const toward = (v: number, base: number, k: number) => base + (v - base) * k;

export type PersonaTone = { traits?: string[]; speakingStyle?: string; backstory?: string };

const LIVELY = /\b(?:witty|playful|teasing|cheeky|sassy|silly|goofy|bubbly|energetic|excitable|hype|quick|punchy|brisk|chaotic|spirited)\b/i;
const CALM = /\b(?:calm|gentle|quiet|soft-spoken|reflective|chill|mellow|serene|unhurried|slow|soothing|grounded)\b/i;
const WARM = /\b(?:warm|cheerful|sunny|upbeat|sweet|kind|optimistic|bubbly|caring)\b/i;
const DRY = /\b(?:dry|deadpan|sardonic|grumpy|blunt|stoic)\b/i;

/** where this companion's mood rests: from its traits and speaking style (the survey's Presence words land in traits) */
export function personaBaseline(p: PersonaTone | null | undefined): Mood {
  if (!p) return { ...NEUTRAL };
  const text = [...(p.traits ?? []), p.speakingStyle ?? ""].join(" ; ");
  const energy = (LIVELY.test(text) ? 0.2 : 0) - (CALM.test(text) ? 0.2 : 0);
  const valence = (WARM.test(text) ? 0.15 : 0) - (DRY.test(text) ? 0.1 : 0);
  const cap = (v: number) => Math.round(Math.max(-0.25, Math.min(0.25, v)) * 100) / 100;
  return { valence: cap(valence), energy: cap(energy) };
}

/** the survey's Never pick "Mirror my mood" (prep/personaCard.ts NEVER_RULE, carried in the card's backstory) */
export function holdsSteady(p: PersonaTone | null | undefined): boolean {
  return /never mirror the user'?s mood/i.test(p?.backstory ?? "");
}

/** the user teasing the companion ("nice try", "yeah right", "you're such a nerd"); not when they say they're serious */
const TEASE = /\b(?:nice try|yeah,? right|sure you (?:do|did|are|can|will)|whatever you say|you wish|skill issue|stop flexing|says the (?:ai|one|person|guy|girl)|(?:you'?re|ur|you are) (?:such an? |so |a |an )(?:nerd|dork|weirdo|clown|goof|goofball|menace|drama queen|show-?off|know-it-all|try-?hard)|(?:you'?re|ur|you are) (?:so )?(?:dramatic|extra|cheesy|corny|ridiculous))\b|[😏🙄😜😝]/iu;
const SERIOUS = /\b(?:i'?m serious|not funny|stop it|seriously stop|that hurt|rude)\b/i;
export function teased(line: string): boolean {
  return TEASE.test(line) && !SERIOUS.test(line);
}

/** a reply that gives nothing back ("ok", "yeah", "k", "mhm", "sure", "idk"); two in a row = the companion is being tuned out */
const FLAT = /^(?:ok(?:ay)?|k+|kk|sure|yeah|yea|ya|yep|yup|mhm+|mm+|hm+|uh[- ]?huh|cool|fine|idk|meh|whatever|i guess|right|true|nice|same)$/i;
export function flatReply(line: string): boolean {
  const s = line.toLowerCase().replace(/[^\p{L}\p{N}' -]+/gu, " ").replace(/\s+/g, " ").trim();
  return !!s && s.split(" ").length <= 3 && FLAT.test(s);
}

/**
 * The one mood line for this turn, with its pacing (intent only, never a line to copy). Low → quieter (or, when the
 * user picked "Never mirror my mood", steady and warm instead); good news → upbeat burst; teased / laughing → playful;
 * tuned out → low-key and brief. Near the baseline: nothing (the persona's own style already says how it sounds).
 */
export function moodHint(m: Mood, o: { steady?: boolean } = {}): string | null {
  if (m.valence <= -0.3) {
    return o.steady
      ? "They're low; stay steady and warm, not gloomy: calm, short sentences, no jokes at their expense."
      // tone 11/4 (eval v2 bad-day noCounselor 5 → 2 after #490; prod build 7: 3/5 low-mood replies were "I'm right here
      // with you"): softer, but still a friend on their side about the exact thing — never therapy lines
      : "Your mood right now is quieter, matching theirs, and you're on their side: react to exactly what happened with real feeling (take their side, a little outrage for them is fine), soft, no jokes at their expense, never therapy lines like \"I hear you\" or \"that sounds…\".";
  }
  if (m.valence >= 0.35 && m.energy >= 0.3) return "Your mood right now is upbeat and playful: a quick, bright burst; one exclamation is fine.";
  if (m.valence >= 0.1 && m.energy >= 0.35) return "You're in a playful mood: tease back a little, keep it quick.";
  if (m.energy <= -0.3) return "Your energy is low-key right now: keep it brief and easy, and don't push a new topic.";
  return null;
}

/** the face a reply with no face of its own rests on, instead of snapping to neutral (DESIGN §7.2 "mood carries over") */
export function restingFace(m: Mood | null): { tag: "smile" | "concerned"; intensity: number } | null {
  if (!m) return null;
  if (m.valence >= 0.35) return { tag: "smile", intensity: 0.35 };
  if (m.valence <= -0.3) return { tag: "concerned", intensity: 0.4 };
  if (m.valence >= 0.1 && m.energy >= 0.35) return { tag: "smile", intensity: 0.3 };
  return null;
}
