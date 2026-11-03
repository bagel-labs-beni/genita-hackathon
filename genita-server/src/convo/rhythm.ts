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

import { ownTakeLine } from "./ownTakes.ts";

const GOOD_NEWS = /\b(?:i|we) (?:got|landed) (?:the |a |an |my )?(?:job|offer|part|role|promotion|raise|apartment|place|internship|spot|scholarship|tickets?)\b|\b(?:i|we) (?:passed|won|aced|nailed|crushed)\b|\bi did it\b|\bthey said yes\b|\bgot (?:in|accepted|promoted|engaged|hired)\b/i;
const BAD_NEWS = /\b(?:rough|awful|terrible|horrible|sucks|sucked|sad|exhausted|stressed|cried|crying|failed|fired|dumped|broke up|rejected|didn'?t get|so bad|worst|tore (?:it|my)|redid my)\b/i;
const LAUGH = /\b(?:ha(?:ha)+|lol+|lmao+|lmfao|rofl|i'?m dead|that'?s hilarious|you'?re funny)\b|😂|🤣|💀/i;
/** "dead serious", "stop joking": never read as a laugh that landed (Codex P1 review) */
const NOT_A_LAUGH = /\b(?:dead serious|i'?m serious|not funny|stop (?:joking|it|laughing))\b/i;
/** "not sad anymore", "didn't win": a negated hit does not count (the 5 words before it) */
const NEGATED = /\b(?:not|no longer|never|isn'?t|wasn'?t|aren'?t|don'?t|doesn'?t|didn'?t|won'?t|can'?t)\b(?:\s+\S+){0,3}\s*$/i;
function said(re: RegExp, line: string): boolean {
  const m = re.exec(line);
  if (!m) return false;
  // "didn't get" is itself bad news, not a negation of something else
  if (re === BAD_NEWS && /^didn/i.test(m[0])) return true;
  return !NEGATED.test(line.slice(0, m.index));
}
const laughed = (line: string) => LAUGH.test(line) && !NOT_A_LAUGH.test(line);

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
    if (said(GOOD_NEWS, line)) { valence += 0.6; energy += 0.5; }
    if (said(BAD_NEWS, line)) { valence -= 0.6; energy -= 0.4; }
    if (laughed(line)) { valence += 0.3; energy += 0.4; }
    valence = clamp(valence);
    energy = clamp(energy);
  }
  return { valence, energy };
}

export function moodLine(m: Mood): string | null {
  if (m.valence <= -0.3) return "Your mood right now is quieter, matching theirs.";
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
  /** K-test 11/3: this call already brought up one personal thing on its own (MENTION_RULE budget) */
  mentionSpent?: boolean;
  /** the last replies as stored, oldest first (session keeps 3) */
  recentReplies?: string[];
  /** this call already had a real crisis line, kept as call state, not read from the trimmed history (Codex #502 P1) */
  crisisInCall?: boolean;
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
  // #342: three replies with no take of its own → ask for one (ownTakes.ts)
  const take = ownTakeLine(t.recentReplies, user, t.crisisInCall);
  if (take) out.push(take);
  if (last && laughed(user) && !said(BAD_NEWS, user)) out.push("Your last line landed (they laughed): stay in that lane.");
  else if (user.split(/\s+/).length >= 30) out.push("They're opening up: stay on what they said.");
  if (t.remembers && (said(GOOD_NEWS, user) || said(BAD_NEWS, user))) out.push("If this connects to something you remember, name that thing specifically.");
  // a reply cut off by the user is stored with a trailing "—" (session.ts): it still ended on a question
  if (/\?[\s—–…-]*$/.test(last)) out.push("End on a statement this time.");
  if (t.mentionSpent) out.push("Don't bring up their tastes or personal details on your own; only if they do.");
  return out.length ? `This turn: ${out.join(" ")}` : null;
}

/**
 * K-test 11/3: a reply that brings up one of the user's own profile tastes ("camel and black together always wins"
 * from "minimal monochrome fashion") when the user's line didn't go there. Content words of the profile's taste /
 * interest lines (≥ 5 letters) are matched in the reply and must be absent from the user's line.
 */
const STOP = new Set(["about", "their", "there", "these", "those", "things", "really", "short", "answers", "direct", "casual", "witty", "teasing", "welcome", "prefers", "small", "talk", "being", "lectured", "advice", "unsolicited", "challenged", "little", "opinionated", "humor"]);
const TASTE_LINE = /^\s*-?\s*(?:taste|interests?|into|likes?|loves?|hobbies|favou?rites?|style)\s*:/i;
export function mentionsProfile(reply: string, profile: string | undefined, userText: string): boolean {
  if (!profile) return false;
  const words = new Set<string>();
  for (const line of profile.split("\n")) {
    if (!TASTE_LINE.test(line)) continue;
    for (const w of line.toLowerCase().replace(/^[^:]*:/, "").match(/[a-z][a-z'-]{4,}/g) ?? []) if (!STOP.has(w)) words.add(w);
  }
  const said = (text: string) => new Set(text.toLowerCase().match(/[a-z][a-z'-]{4,}/g) ?? []);
  const r = said(plain(reply));
  const u = said(userText);
  for (const w of words) if (r.has(w) && !u.has(w)) return true;
  return false;
}
