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

// The seam types live with the conversation engine (src/convo/types.ts, landed first); one definition (11/3 agreement).
import type { PerceptionTriggerKind } from "../convo/types.ts";
export type { PerceptionSource, PerceptionTrigger } from "../convo/types.ts";
export type TriggerKind = PerceptionTriggerKind;
