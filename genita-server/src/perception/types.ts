/**
 * Camera perception (PERC-1, #319): what the companion can see of the user's face during a call.
 * Contract with the conversation engine (agreed 11/3, conversation-engine/PERCEPTION.md):
 * the engine reads `contextLine()` / `pendingHint()` and subscribes to triggers; it owns every spoken line.
 * Nothing here is stored: state lives in memory for one call.
 */
export const EXPRESSIONS = ["smile", "laugh", "neutral", "frown", "surprised", "confused", "tired", "sad", "focused"] as const;
export const GAZES = ["at_screen", "away", "down"] as const;
export type Expression = (typeof EXPRESSIONS)[number];
export type Gaze = (typeof GAZES)[number];

/** One Spark read of one face crop. */
export type PerceptionSample = {
  expression: Expression;
  intensity: number;
  gaze: Gaze;
  engagement: number;
  /** a short visible action ("yawning", "nodding"), never appearance/identity/traits */
  notable: string | null;
  confidence: number;
};

/** Smoothed over the last few kept samples. `at` = last kept sample, `since` = when this expression began. */
export type PerceptionState = PerceptionSample & { at: number; since: number };

export const TRIGGER_KINDS = [
  "smiled_at_reply",
  "laughed",
  "smiled_at_own_joke",
  "looks_tired",
  "looks_confused",
  "looked_away",
  "engagement_drop",
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** `at` is the session clock (performance.now) of the frame the trigger is about. */
export type PerceptionTrigger = { kind: TriggerKind; at: number; confidence: number };

/** What the conversation engine sees (structurally identical to its src/convo/types.ts). */
export interface PerceptionSource {
  /** one live line for the reply's instructions, or null when the camera is off / state is stale */
  contextLine(): string | null;
  /** one line about the latest trigger for the next reply; consumed once, expires after 15 s */
  pendingHint(): string | null;
  /** returns an unsubscribe */
  onTrigger(cb: (t: PerceptionTrigger) => void): () => void;
}
