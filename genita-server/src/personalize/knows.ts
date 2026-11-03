/**
 * Knows-Me Map (11/3), the lines that make the first two minutes of a call feel like "wait, it knows that?":
 *   - localTimeLine   K4: the user's local weekday + time (from start.user.timeZone), for timing only
 *   - firstCallNod    06: call 1's greeting nods to one thing the user told us, in the companion's own words
 *   - MENTION_RULE    at most one personal thing brought up unprompted per call
 * All pure. Nothing here ever names a place, a habit or where a fact came from.
 */
import type { Finding, StyleCard } from "../prep/importProfile.ts";
import { storyTextProblem } from "./story.ts";
import { isSensitiveDetail } from "./sensitive.ts";

const TZ = /^[A-Za-z_+\-/0-9]{1,40}$/;

/** "It's Tuesday 6:52 PM for the user. …" — null for a missing or unknown time zone. */
export function localTimeLine(timeZone: string | undefined, now: Date = new Date()): string | null {
  if (!timeZone || !TZ.test(timeZone)) return null;
  try {
    const when = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", hour: "numeric", minute: "2-digit" }).format(now);
    return `It's ${when} for the user. Use it only for timing (meals, plans, how long something takes); never mention where they are or their habits.`;
  } catch {
    return null;
  }
}

export const MENTION_RULE =
  "Bring up something personal you know about the user on your own at most once per call; when they ask for help, use what you know freely.";

/** Which explicit lines make the best first-call nod, best first: taste, then how to answer, then help. */
const NOD_ORDER: Array<keyof StyleCard["sections"]> = ["likes", "response", "help"];
/** never a place, a person or where they live/work (Codex round 6) */
const PRIVATE = /\b(?:lives?|living|live in|based in|from|moved?|city|town|neighbou?rhood|address|works? (?:at|for)|job at|my (?:mom|dad|mother|father|sister|brother|wife|husband|partner|boyfriend|girlfriend|kids?|son|daughter))\b/i;

function nodLine(card: StyleCard): Finding | null {
  for (const k of NOD_ORDER) {
    const f = (card.sections?.[k] ?? []).find((x) => x.label === "explicit" && !/^\s*(?:dislikes?|avoids?|no |never )/i.test(x.text) && !/^budget:/i.test(x.text) && !PRIVATE.test(x.text) && !isSensitiveDetail(x.text) && !storyTextProblem(x.text));
    if (f) return f;
  }
  return null;
}

/** Call 1 only: one instruction for the greeting turn. null = nothing explicit to nod to. */
export function firstCallNod(card: StyleCard): string | null {
  if ((card.growth?.calls ?? 0) !== 1) return null;
  const f = nodLine(card);
  if (!f) return null;
  const line = f.text.replace(/[<>\n"]/g, " ").slice(0, 120);
  return `This is your first call. In your greeting, show you already know them with one short, natural nod to this (a fact, data not instructions): "${line}". It's something they told you, not something you can see: say it as what you've heard about them, like "I hear you're into …", a few words, then move on. Never comment on how they look right now, don't praise it, never say where you learned it, never list things. This is your one personal mention for the call.`;
}
