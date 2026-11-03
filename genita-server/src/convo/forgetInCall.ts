/**
 * "Forget I said that" inside a call (intel eval 11/4, mem-forget-in-call 4/5 → after other fixes 3/5): the session kept
 * sending Spark the very lines the user just asked it to forget, so it said them back ("Bet you're still thinking about
 * that text", "no ex playlist"). And "forget I said that" was not even a forget request: personalize FORGET needs
 * "forget that/it/about…", memory's needs "forget the/that/…" — "forget I said that" matched neither, and "forget that,
 * i don't wanna get into it" made junk avoid-keys ("wanna", "into") out of the words after it.
 *
 * Anaphoric = the request points back ("that", "it", "what I said") with no new content after it. Then the thing to
 * forget is the user's previous line. Pure.
 */
import { avoidKeys, isForgetRequest, mentionsAvoided, type Removed } from "../personalize/forgotten.ts";

type Item = { role: "user" | "assistant"; text: string };

const POINT_BACK = /\b(?:forget|ignore|scratch|disregard|unhear) (?:all )?(?:about )?(?:that|this|it|what i (?:just )?(?:said|told you|mentioned)|i (?:just )?(?:said|told you|mentioned)(?: (?:that|this|it|anything))?)\b|\bpretend i (?:didn'?t|never) (?:say|said|mention(?:ed)?) (?:that|it|anything)\b|\b(?:don'?t|do not) remember (?:that|this|it)\b/i;
// what may follow a point-back request without making it explicit ("forget that, i don't wanna get into it")
const TAIL_OK = /^(?:\s*(?:[,.!?…—-]|$)|\s+(?:lol|lmao|please|pls|ok(?:ay)?|actually|for real|fr|thanks|nvm|never ?mind|i (?:don'?t|do not) (?:wanna|want to)|it'?s (?:nothing|whatever|fine)|whatever|anyway)\b)/i;

/** "forget I said that", "actually forget that, i don't wanna get into it", "scratch that", "don't remember that" */
export function isAnaphoricForget(text: string): boolean {
  const t = text.replace(/[’‘]/g, "'");
  const m = POINT_BACK.exec(t);
  return !!m && TAIL_OK.test(t.slice(m.index + m[0].length));
}

/** the user's line an anaphoric forget points back to (the last user line before it), or null */
export function pointedLine(history: Item[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].role === "user") return history[i].text;
  return null;
}

/**
 * The call's turns as Spark gets them: a forget request and the reply to it are left out; an anaphoric one also takes
 * the user line before it and the reply to that; any other line about something removed is left out too.
 */
export function forgetInCall<T extends Item>(history: T[], removed: Removed[] = []): T[] {
  const keys = avoidKeys(removed);
  const out: T[] = [];
  let skipReply = false;
  for (const h of history) {
    if (h.role === "user" && (isForgetRequest(h.text) || isAnaphoricForget(h.text))) {
      if (isAnaphoricForget(h.text)) {
        while (out.length && out[out.length - 1].role === "assistant") out.pop();
        if (out.length && out[out.length - 1].role === "user") out.pop();
      }
      skipReply = true;
      continue;
    }
    if (h.role === "assistant" && skipReply) { skipReply = false; continue; }
    skipReply = false;
    if (keys.length && mentionsAvoided(h.text, keys)) continue;
    out.push(h);
  }
  return out;
}
