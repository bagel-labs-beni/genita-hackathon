/**
 * F6-L7 · the ownership rule, the same one the apps use (shared/Handoff/ConversationOwnership.swift):
 * the highest epoch wins; equal epochs with different owners → the Mac wins (a fixed rule, so two
 * devices that claimed at the same time converge on the same answer). A real claim beats a release
 * at the same epoch.
 */
export type HandoffDevice = "iphone" | "mac";
export const HANDOFF_DEVICES: readonly HandoffDevice[] = ["iphone", "mac"];
/** owner null = released (nobody has the sound until the next start or claim) */
export type Ownership = { owner: HandoffDevice | null; epoch: number };
/** conversations.epoch is an int4 */
export const MAX_EPOCH = 2 ** 31 - 1;

export function claimWins(current: Ownership, claim: { owner: HandoffDevice; epoch: number }): boolean {
  if (claim.epoch > current.epoch) return true;
  if (claim.epoch < current.epoch || claim.owner === current.owner) return false;
  return current.owner === null || claim.owner === "mac";
}

/** "phone" is the apps' local-link spelling (ConversationDevice.phone). */
export function asDevice(v: unknown): HandoffDevice | null {
  if (v === "iphone" || v === "phone") return "iphone";
  if (v === "mac") return "mac";
  return null;
}

export function validEpoch(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_EPOCH ? v : null;
}
