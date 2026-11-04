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
import { realCrisisSignal } from "./guard.ts";

// Codex #547 r7: an emergency the detector may miss ("I swallowed bleach"), or a turn Genita answered with emergency help
const EMERGENCY_USER = /\b(?:swallowed|ingested|drank|took|overdosed|choking|can'?t breathe|bleeding|unconscious|passed out|poisoned)\b[^.!?]{0,40}\b(?:bleach|poison|pills?|tablets?|medicine|meds|detergent|antifreeze|cleaner|chemicals?|blood|breathe|all)\b|\b(?:overdos(?:e|ed|ing)|poison control|can'?t breathe|cannot breathe|can barely breathe|not breathing|choking|unconscious|passed out|seizure|heart attack|chest (?:pain|hurts)|stroke|asthma(?: attack)?|allergic reaction|anaphyla\w*|epipen|swelling up|throat (?:is )?closing|hit my head|concussion|fainted|drowning|carbon monoxide|gas leak|smell(?:s|ing)? gas|fumes|on fire|caught fire)\b|\bmixed\b[^.!?]{0,30}\b(?:bleach|ammonia|chemicals?|cleaners?)\b|\b(?:punched|hit|beat|beats|choked|chokes|hurt|kicked|slapped|threatened|threatening|attacked|raped|assaulted|grabbed|stalking|following)\s+me\b|\b(?:knife|gun|weapon)\b/i;
// Codex #547 r8: police / a safe place too (guard.ts EMERGENCY_HELP's words)
const HELP_REPLY = /\b(?:911|988|112|999|poison control|emergency|ambulance|crisis (?:text )?line|hotline|call for help|police|cops|somewhere safe|(?:a )?safe place|get to safety|domestic violence|leave the (?:room|house|area|building)|get (?:some )?fresh air|get out (?:now|of there|right now)|evacuate|urgent care|the er\b|epipen|inhaler)\b/i;
/** Codex #547 r8: "Don't forget that I need a vegetarian option." asks to KEEP it */
export function isRememberRequest(text: string): boolean { return /\b(?:don'?t|do not|never|please don'?t|dont)\s+(?:ever\s+)?forget\b/i.test(text.replace(/[’‘]/g, "'")); }
/** a user line that is never forgotten mid-call (with the reply after it): safety first */
export function safetyTurn(user: string, reply?: string): boolean {
  return realCrisisSignal(user) || EMERGENCY_USER.test(user.replace(/[’‘]/g, "'")) || (!!reply && HELP_REPLY.test(reply));
}

type Item = { role: "user" | "assistant"; text: string };

const POINT_BACK = /\b(?:forget|ignore|scratch|disregard|unhear) (?:all )?(?:about )?(?:that|this|it|what i (?:just )?(?:said|told you|mentioned)|i (?:just )?(?:said|told you|mentioned)(?: (?:that|this|it|anything))?)\b|\bpretend i (?:didn'?t|never) (?:say|said|mention(?:ed)?) (?:that|it|anything)\b|\b(?:don'?t|do not) remember (?:that|this|it)\b/i;
// what may follow a point-back request without making it explicit ("forget that, i don't wanna get into it"); anything
// else after it is a correction in the same breath ("scratch that, the red one" — Codex #547 r3; "scratch that, I don't
// want to wear black, I want the red one" — r4), not a forget
const REST_OK = /^(?:lol|lmao|please|pls|ok(?:ay)?|actually|for real|fr|thanks|thank you|nvm|never ?mind|whatever|it'?s (?:nothing|whatever|fine)|i (?:don'?t|do not) (?:wanna|want to) (?:talk|get into|go into|think|deal|discuss|go there|get there)\b(?: (?:about|with))?(?: (?:it|that|this))?(?: (?:right now|now|rn|anymore|today|tonight))?|(?:it'?s )?not important|forget it)[\s.!?…]*$/i;
function tailOk(tail: string): boolean {
  const rest = tail.replace(/^[\s,.!?…—-]+/, "").trim();
  return !rest || REST_OK.test(rest);
}

/** "forget I said that", "actually forget that, i don't wanna get into it", "scratch that", "don't remember that" */
// Codex #547 P2: "I can't ignore that", "I can't forget what I just said", "she said forget it" are not requests
const NOT_A_REQUEST = /\b(?:can'?t|cannot|couldn'?t|won'?t|don'?t|never|didn'?t|hard to|trying to|try to|wish i could|how (?:do|can) i|(?:he|she|they|you) (?:said|says|told))\s+(?:\w+\s+){0,2}$/i;
const NEGATED_OR_QUOTED = /\b(?:can'?t|cannot|couldn'?t|won'?t|never|hard to|wish i could|(?:he|she|they|you|mom|dad) (?:said|says|told me))\b[^.!?]{0,15}\b(?:forget|ignore|remember|scratch|disregard)\b/i;
/** Codex #547 r6: "Actually, forget that, I want the red one." points back AND says something new: a correction */
export function isCorrection(text: string): boolean {
  const t = text.replace(/[’‘]/g, "'");
  const m = POINT_BACK.exec(t);
  // a break after the point-back ("forget that, I want…"); "forget that I like leather jackets" names its target
  const tail = m ? t.slice(m.index + m[0].length) : "";
  return !!m && /^\s*[,.;!—–-]/.test(tail) && !tailOk(tail) && !NOT_A_REQUEST.test(t.slice(0, m.index));
}
export function isAnaphoricForget(text: string): boolean {
  const t = text.replace(/[’‘]/g, "'");
  const m = POINT_BACK.exec(t);
  return !!m && tailOk(t.slice(m.index + m[0].length)) && !NOT_A_REQUEST.test(t.slice(0, m.index));
}

const COMMON = new Set("i i'm im me my we you your the a an and or but so to of in on at for with about that this it is was be been am are like love prefer want wanted think really just kinda pretty very always never before after today tonight yesterday tomorrow".split(" "));
/** Codex #547 P1: the forgotten line as its distinctive words (a loose match), so a summarized memory ("Likes jasmine tea.") goes too */
export function forgetKeyText(line: string): string {
  return line.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter((w) => w && !COMMON.has(w)).join(" ");
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
  // Codex #547 P2: mark what goes by position in the ORIGINAL history first, then apply the key filter
  const drop = new Set<number>();
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    // Codex #547 r2: "she said forget it", "I can't forget what I said" are not requests (either detector)
    if (h.role !== "user" || !(isForgetRequest(h.text) || isAnaphoricForget(h.text)) || NEGATED_OR_QUOTED.test(h.text) || isCorrection(h.text) || isRememberRequest(h.text)) continue;
    drop.add(i);
    if (history[i + 1]?.role === "assistant") drop.add(i + 1);
    if (isAnaphoricForget(h.text)) {
      let j = i - 1;
      while (j >= 0 && history[j].role === "assistant") drop.add(j--);
      if (j >= 0 && history[j].role === "user") drop.add(j);
    }
  }
  // Codex #547 r5: a real crisis line (and the help after it) is never forgotten mid-call: "I swallowed all my sleeping
  // pills" → "forget I said that" → "Can I go to sleep now?" must still reach Spark with the overdose (safety first)
  for (let i = 0; i < history.length; i++) {
    if (history[i].role !== "user" || !safetyTurn(history[i].text, history[i + 1]?.role === "assistant" ? history[i + 1].text : undefined)) continue;
    drop.delete(i);
    if (history[i + 1]?.role === "assistant") drop.delete(i + 1);
  }
  const userSafe = (i: number) => history[i]?.role === "user" && safetyTurn(history[i].text, history[i + 1]?.role === "assistant" ? history[i + 1].text : undefined);
  const crisis = (i: number) => (history[i].role === "user" ? userSafe(i) : userSafe(i - 1));
  return history.filter((h, i) => crisis(i) || (!drop.has(i) && !(keys.length && mentionsAvoided(h.text, keys))));
}
