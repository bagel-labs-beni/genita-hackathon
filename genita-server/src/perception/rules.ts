/**
 * Perception smoothing and triggers as a pure reducer (PERC-1), like session/turnMachine.ts: the controller
 * feeds each Spark read with the conversation snapshot from when the frame was captured, and gets back the
 * new tracker and any triggers. Every timing rule here is unit-testable without sockets or vendors.
 */
import type { Expression, Gaze, PerceptionSample, PerceptionState, PerceptionTrigger, TriggerKind } from "./types.ts";

export const MIN_CONFIDENCE = 0.6;
export const STALE_MS = 8_000;
export const COOLDOWN_MS = 60_000;
export const SMILE_CONF = 0.7;
/** below this a "smile" is a resting face (eval 11/3: a neutral still read as smile 0.3) */
export const SMILE_MIN_INTENSITY = 0.45;
/** a face that has read the same for this long is its resting state, not a reaction */
export const BASELINE_MS = 10_000;
export const LAUGH_INTENSITY = 0.5;
export const REPLY_SMILE_WINDOW_MS = 4_000;
export const OWN_JOKE_WINDOW_MS = 3_000;
export const CONFUSED_CONF = 0.65;
export const CONFUSED_WINDOW_MS = 6_000;
export const TIRED_CONF = 0.75;
export const TIRED_MIN_MS = 6_000;
export const TIRED_SILENCE_MS = 8_000;
export const AWAY_MIN_MS = 10_000;
/** "down" counts as away only when attention is low: on an iPhone, reading the screen looks down (eval 11/3) */
export const DOWN_AWAY_ENGAGEMENT = 0.5;
export const LOW_ENGAGEMENT = 0.35;
export const ENGAGEMENT_REARM = 0.5;
export const LOW_ENGAGEMENT_MIN_MS = 20_000;

/** The conversation at the moment the frame was captured. */
export type Convo = {
  companionSpeaking: boolean;
  lastReplyEndAt: number | null;
  userSpeaking: boolean;
  lastUserSpeechAt: number | null;
};

type Run = { since: number | null; fired: boolean };
export type Tracker = {
  kept: { at: number; s: PerceptionSample }[];
  state: PerceptionState | null;
  lastFired: Partial<Record<TriggerKind, number>>;
  tired: Run;
  away: Run;
  low: Run;
};

const NO_RUN: Run = { since: null, fired: false };

export function initialTracker(): Tracker {
  return { kept: [], state: null, lastFired: {}, tired: NO_RUN, away: NO_RUN, low: NO_RUN };
}

function majority<T>(xs: T[]): T | null {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  for (const [x, n] of counts) if (n >= 2) return x;
  return null;
}

const ema = (prev: number | undefined, x: number) => (prev === undefined ? x : prev * 0.5 + x * 0.5);
const within = (at: number, ref: number | null, ms: number) => ref !== null && at >= ref && at - ref <= ms;

export function observe(t: Tracker, s: PerceptionSample, at: number, c: Convo): { tracker: Tracker; triggers: PerceptionTrigger[] } {
  if (s.confidence < MIN_CONFIDENCE) return { tracker: t, triggers: [] };
  const prevAt = t.kept.at(-1)?.at ?? null;
  // a gap (camera off, no face, failed reads): earlier samples and runs say nothing about now
  const fresh = prevAt === null || at - prevAt > STALE_MS;
  const base: Tracker = fresh ? { ...t, kept: [], state: null, tired: NO_RUN, away: NO_RUN, low: NO_RUN } : t;
  const kept = [...base.kept, { at, s }].slice(-3);

  const prev = base.state;
  const expression: Expression = majority(kept.map((k) => k.s.expression)) ?? prev?.expression ?? s.expression;
  const gaze: Gaze = majority(kept.map((k) => k.s.gaze)) ?? prev?.gaze ?? s.gaze;
  const state: PerceptionState = {
    expression,
    intensity: ema(prev?.intensity, s.intensity),
    gaze,
    engagement: ema(prev?.engagement, s.engagement),
    notable: s.notable,
    confidence: kept.reduce((a, k) => a + k.s.confidence, 0) / kept.length,
    at,
    since: prev && prev.expression === expression ? prev.since : at,
  };

  const lastFired = { ...base.lastFired };
  const triggers: PerceptionTrigger[] = [];
  const fire = (kind: TriggerKind): boolean => {
    const last = lastFired[kind];
    if (last !== undefined && at - last < COOLDOWN_MS) return false;
    lastFired[kind] = at;
    triggers.push({ kind, at, confidence: s.confidence });
    return true;
  };

  // fast, single-sample moments (a smile lasts a second or two); a reaction is a change from the resting face
  const resting = (e: Expression) => !!prev && prev.expression === e && at - prev.since >= BASELINE_MS;
  const positive =
    (s.expression === "smile" || s.expression === "laugh") && s.confidence >= SMILE_CONF && s.intensity >= SMILE_MIN_INTENSITY &&
    // a laugh from a resting smile is still a reaction; a smile from a resting smile is not
    !resting("laugh") && (s.expression === "laugh" || !resting("smile"));
  if (positive) {
    if (c.companionSpeaking || within(at, c.lastReplyEndAt, REPLY_SMILE_WINDOW_MS)) fire("smiled_at_reply");
    else if (c.userSpeaking || within(at, c.lastUserSpeechAt, OWN_JOKE_WINDOW_MS)) fire("smiled_at_own_joke");
    else if (s.expression === "laugh" && s.intensity >= LAUGH_INTENSITY) fire("laughed");
  }
  if (s.expression === "confused" && s.confidence >= CONFUSED_CONF && !resting("confused") && (c.companionSpeaking || within(at, c.lastReplyEndAt, CONFUSED_WINDOW_MS))) {
    fire("looks_confused");
  }

  // sustained states: one trigger per continuous run
  let tired: Run = s.expression === "tired" && s.confidence >= TIRED_CONF ? { since: base.tired.since ?? at, fired: base.tired.fired } : NO_RUN;
  const silent = !c.userSpeaking && (c.lastUserSpeechAt === null || at - c.lastUserSpeechAt >= TIRED_SILENCE_MS);
  if (tired.since !== null && !tired.fired && at - tired.since >= TIRED_MIN_MS && silent && fire("looks_tired")) tired = { ...tired, fired: true };

  const looksAway = s.gaze === "away" || (s.gaze === "down" && s.engagement < DOWN_AWAY_ENGAGEMENT);
  let away: Run = looksAway ? { since: base.away.since ?? at, fired: base.away.fired } : NO_RUN;
  if (away.since !== null && !away.fired && at - away.since >= AWAY_MIN_MS && !c.userSpeaking && fire("looked_away")) away = { ...away, fired: true };

  let low: Run;
  if (s.engagement < LOW_ENGAGEMENT) low = { since: base.low.since ?? at, fired: base.low.fired };
  else if (s.engagement >= ENGAGEMENT_REARM) low = NO_RUN;
  else low = { since: null, fired: base.low.fired };
  if (low.since !== null && !low.fired && at - low.since >= LOW_ENGAGEMENT_MIN_MS && fire("engagement_drop")) low = { ...low, fired: true };

  return { tracker: { kept, state, lastFired, tired, away, low }, triggers };
}

export function stateOf(t: Tracker, now: number): PerceptionState | null {
  return t.state && now - t.state.at <= STALE_MS ? t.state : null;
}

const EXPRESSION_PHRASE: Record<Expression, string> = {
  smile: "is smiling",
  laugh: "is laughing",
  neutral: "looks calm",
  frown: "is frowning",
  surprised: "looks surprised",
  confused: "looks puzzled",
  tired: "looks a little tired",
  sad: "looks a bit down",
  focused: "looks focused",
};
const GAZE_PHRASE: Record<Gaze, string> = { at_screen: "looking at you", away: "looking away", down: "looking down" };

/** One live line for the reply's instructions; null when there is nothing fresh to say. */
export function contextLine(state: PerceptionState | null): string | null {
  if (!state) return null;
  const notable = state.notable ? ` (${state.notable})` : "";
  return `Camera (live; only mention it if it fits): the user ${EXPRESSION_PHRASE[state.expression]} and ${GAZE_PHRASE[state.gaze]}${notable}.`;
}

/** The next reply's hint for a trigger: about the moment, never about looks. */
export function hintFor(kind: TriggerKind, s: PerceptionSample): string {
  switch (kind) {
    case "smiled_at_reply":
      return s.expression === "laugh" ? "The user just laughed at what you said." : "The user smiled at what you just said.";
    case "laughed":
      return "The user just laughed.";
    case "smiled_at_own_joke":
      return "The user is smiling at what they just said; enjoy it with them.";
    case "looks_tired":
      return "The user seems a little tired right now.";
    case "looks_confused":
      return "The user looks puzzled by your last answer; say it more simply.";
    case "looked_away":
      return "The user has been looking away for a bit.";
    case "engagement_drop":
      return "The user seems less into this topic for a while.";
  }
}
