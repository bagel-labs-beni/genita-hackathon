/**
 * #341: which profile things this user's last greetings opened on, so the next call opens on a different one.
 * Persisted in the memory lane's per-user call state JSON (`opener_topics`, an extra field the Postgres and JSON
 * adapters keep as is; Forget leaves it, it holds the user's own profile words only), with an in-process copy so a
 * call without the memory store, or one whose store is slow, still rotates. Never on the reply path's critical wait.
 */
import type { MemoryService } from "../memory/service.ts";
import { noteHook, OPENER_RECENT_KEEP } from "./opener.ts";

type WithTopics = { opener_topics?: unknown };
const LOCAL_MAX_USERS = 5000;
const local = new Map<string, string[]>();

function clean(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 80).slice(-OPENER_RECENT_KEEP) : [];
}

/** recent hooks from a call state already read (oldest → newest), merged with this process's copy */
export function recentFromState(userId: string | undefined, state: unknown): string[] {
  const stored = clean((state as WithTopics | null)?.opener_topics);
  const mine = userId ? local.get(userId) ?? [] : [];
  return stored.length >= mine.length ? stored : mine;
}

export function recentLocal(userId: string | undefined): string[] {
  return userId ? local.get(userId) ?? [] : [];
}

/** record this call's opener hook: in process now, in the store in the background (errors are only logged) */
export function noteOpenerTopic(userId: string | undefined, recent: string[], hook: string, memory?: MemoryService, onError?: (e: unknown) => void): string[] {
  const next = noteHook(recent, hook);
  if (!userId) return next;
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
  return next;
}

/** test seam */
export function resetOpenerTopics(): void {
  local.clear();
}
