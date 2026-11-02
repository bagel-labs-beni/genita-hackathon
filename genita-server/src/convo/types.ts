/**
 * The perception seam (agreed 11/3 with the perception lane; its src/perception/types.ts is structurally
 * identical — whichever PR lands second re-exports the other's). The session only reads it; it never waits.
 */
export type PerceptionTriggerKind =
  | "smiled_at_reply"
  | "laughed"
  | "smiled_at_own_joke"
  | "looks_tired"
  | "looks_confused"
  | "looked_away"
  | "engagement_drop";

export type PerceptionTrigger = { kind: PerceptionTriggerKind; at: number; confidence: number };

export interface PerceptionSource {
  /** one sentence about the user's live face (camera on, fresh state only), or null */
  contextLine(): string | null;
  /** one line for the next reply ("The user just smiled at your last line."), consumed once; null if none */
  pendingHint(): string | null;
  onTrigger(cb: (t: PerceptionTrigger) => void): () => void;
}
