/**
 * Conversation engine P1 (DESIGN §3, §7.3, §9, §6): one short "This turn:" line for a user turn, built in code from
 * what the call already knows. No extra Spark call; the line rides the turn's instructions (read last, after the
 * voice block). Pure.
 *
 *   closeness   call count → how familiar to be (call 1 is the opener's job, so nothing)
 *   rhythm      the last reply ended in "?" → end on a statement (no two questions in a row)
 *   mood        {valence, energy} drifts with what the user says, decays each turn toward baseline (per call)
 *   landed      they laughed at the last line → stay in that lane; a long answer → stay on it
 *   recall      news + something remembered → name the remembered thing specifically (eval 11/3: "I got the job"
 *               answered without the design-studio interview, recall 0.78)
 * Intent only, never a line to copy.
 */

const GOOD_NEWS = /\b(?:i|we) (?:got|passed|won|aced|nailed|crushed|landed|finished|did) (?:it|the|my|a|an)\b|\bi did it\b|\bthey said yes\b|\bgot (?:the job|in|accepted|promoted|the offer)\b|\bguess what\b|!!/i;
const BAD_NEWS = /\b(?:rough|awful|terrible|horrible|sucks|sucked|sad|exhausted|stressed|cried|crying|failed|fired|dumped|broke up|rejected|didn'?t get|so bad|worst day|tore (?:it|my)|redid my)\b/i;
const LAUGH = /\b(?:ha(?:ha)+|lol+|lmao+|lmfao|rofl|i'?m dead|that'?s hilarious|you'?re funny)\b|😂|🤣|💀/i;

export type Mood = { valence: number; energy: number };

/**
 * One call's mood (DESIGN §7.3), folded from the call's user lines so far (oldest first): it starts at baseline each
 * call, good news lifts, bad news lowers, a laugh makes it playful, and it decays 25 % a line. Pure, so a request
 * built twice for one turn (speculation, a retry) gets the same mood.
 */
export function moodFrom(userLines: string[]): Mood {
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  let valence = 0;
  let energy = 0;
  for (const line of userLines) {
    valence *= 0.75;
    energy *= 0.75;
    if (GOOD_NEWS.test(line)) { valence += 0.6; energy += 0.5; }
    if (BAD_NEWS.test(line)) { valence -= 0.6; energy -= 0.4; }
    if (LAUGH.test(line)) { valence += 0.3; energy += 0.4; }
    valence = clamp(valence);
    energy = clamp(energy);
  }
  return { valence, energy };
}

export function moodLine(m: Mood): string | null {
  if (m.valence <= -0.3) return "Your mood right now is softer and quieter, with them.";
  if (m.valence >= 0.35 && m.energy >= 0.3) return "Your mood right now is upbeat and playful.";
  return null;
}

export type TurnHintInput = {
  /** this call's number for the account (1 = first call); undefined = unknown */
  callNumber?: number;
  /** the last reply as stored (tags included) */
  lastReply?: string;
  userText: string;
  mood?: string | null;
  /** the call has memories or notes from earlier calls */
  remembers: boolean;
};

const plain = (s: string) => s.replace(/<[^>]*>|\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();

export function closenessLine(callNumber: number | undefined): string | null {
  if (!callNumber || callNumber <= 1) return null;
  if (callNumber <= 4) return "You've talked a few times now: a little more teasing and callbacks are fine.";
  return "You're close by now: running jokes and honest disagreement are fine.";
}

export function turnHints(t: TurnHintInput): string | null {
  const out: string[] = [];
  const user = t.userText.trim();
  const last = t.lastReply ? plain(t.lastReply) : "";
  const close = closenessLine(t.callNumber);
  if (close) out.push(close);
  if (t.mood) out.push(t.mood);
  if (last && LAUGH.test(user)) out.push("Your last line landed (they laughed): stay in that lane.");
  else if (user.split(/\s+/).length >= 30) out.push("They're opening up: stay on what they said.");
  if (t.remembers && (GOOD_NEWS.test(user) || BAD_NEWS.test(user))) out.push("If this connects to something you remember, name that thing specifically.");
  // a reply cut off by the user is stored with a trailing "—" (session.ts): it still ended on a question
  if (/\?[\s—–…-]*$/.test(last)) out.push("End on a statement this time.");
  return out.length ? `This turn: ${out.join(" ")}` : null;
}
