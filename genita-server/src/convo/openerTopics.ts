/**
 * #341: which profile things this user's last greetings opened on, so the next call opens on a different one.
 *
 * The pick is atomic per process: `pickOpenerTopic` reads this process's newest list, picks, and records in one
 * synchronous step, so an iPhone and a Mac greeting the same account a moment apart never pick the same hook
 * (Codex #352 P2; the server is one process). The list is also persisted in the memory lane's per-user call
 * state JSON (`opener_topics`, last 3) so a restart keeps rotating; the store copy is used only when this
 * process has none. Every stored or read value passes the same safe-text check as a memory (no health, money,
 * places, people). Forget and account deletion drop both copies.
 */
import type { MemoryService } from "../memory/service.ts";
import { isSafeHook, noteHook, OPENER_RECENT_KEEP, pickOpenerHook } from "./opener.ts";

type WithTopics = { opener_topics?: unknown };
const LOCAL_MAX_USERS = 5000;
const local = new Map<string, string[]>();

function clean(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 80 && isSafeHook(x)).slice(-OPENER_RECENT_KEEP) : [];
}

/** the persisted list from a call state already read (oldest → newest) */
export function storedTopics(state: unknown): string[] {
  return clean((state as WithTopics | null)?.opener_topics);
}

/** pick this call's hook and record it, in one step; `stored` is the call state's list (used if this process has none) */
export function pickOpenerTopic(userId: string | undefined, hooks: string[], stored: string[] | undefined, seed: number, memory?: MemoryService, onError?: (e: unknown) => void): { hook: string | null; recent: string[] } {
  const recent = (userId ? local.get(userId) : undefined) ?? clean(stored);
  const hook = pickOpenerHook(hooks, recent, seed + recent.length);
  if (!hook) return { hook: null, recent };
  const next = noteHook(recent, hook);
  if (userId) {
    local.delete(userId);
    local.set(userId, next);
    if (local.size > LOCAL_MAX_USERS) local.delete(local.keys().next().value!);
    if (memory) {
      void memory.serial(userId, async () => {
        const s = await memory.state.getState(userId);
        (s as typeof s & { opener_topics?: string[] }).opener_topics = noteHook(clean((s as WithTopics).opener_topics), hook);
        await memory.state.putState(userId, s);
      }).catch((e) => onError?.(e));
    }
  }
  return { hook, recent };
}

/** Forget / account deletion: this process's copy now, the stored copy in the background when a store is given */
export function forgetOpenerTopics(userId: string, memory?: MemoryService, onError?: (e: unknown) => void): void {
  local.delete(userId);
  if (!memory) return;
  void memory.serial(userId, async () => {
    const s = await memory.state.getState(userId);
    if (!(s as WithTopics).opener_topics) return;
    delete (s as WithTopics).opener_topics;
    await memory.state.putState(userId, s);
  }).catch((e) => onError?.(e));
}

/** test seam */
export function resetOpenerTopics(): void {
  local.clear();
}
