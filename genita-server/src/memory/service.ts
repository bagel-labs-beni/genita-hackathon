import { type CallStateRepository, type MemoryRepository, type Memory, type MemoryKind, type MemorySettings, memoryId } from "./repository.ts";
import { safeMemoryText, type Extractor, type Turn } from "./extract.ts";
import { validSeen, type SeenCandidate, type SeenContext } from "./seen.ts";

type Log = (event: string, data: Record<string, unknown>) => void;
export type MemoryOptions = {
  repository: MemoryRepository;
  state: CallStateRepository;
  extract: Extractor;
  now?: () => number;
  revisitGapHours?: number;
  /** Storage owner must delete the crop, not just its DB reference. */
  deleteCrop?: (userId: string, ref: string) => Promise<void>;
  verifyCrop?: (userId: string, crop: SeenCandidate["crop"]) => Promise<boolean>;
  isSafe?: (text: string) => Promise<boolean>;
  log?: Log;
};
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const tokens = (s: string) => new Set(s.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

export class MemoryService {
  readonly repository: MemoryRepository;
  readonly state: CallStateRepository;
  private readonly options: MemoryOptions;
  private locks = new Map<string, Promise<unknown>>();
  private listeners = new Map<string, Set<() => void>>();
  private jobs = new Set<Promise<unknown>>();
  private seen = new Map<string, number>();
  readonly now: () => number;
  constructor(options: MemoryOptions) {
    this.options = options; this.repository = options.repository; this.state = options.state; this.now = options.now ?? Date.now;
  }
  async serial<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const task = (this.locks.get(userId) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.locks.set(userId, task);
    try { return await task; } finally { if (this.locks.get(userId) === task) this.locks.delete(userId); }
  }
  private log(event: string, data: Record<string, unknown>) { this.options.log?.(event, data); }
  /** Schedules work, returns immediately. Tests/evals can explicitly drain it. */
  background(fn: () => Promise<unknown>): void {
    const job = Promise.resolve().then(fn).catch(() => this.log("memory.failed", { retry: "next_batch" }));
    this.jobs.add(job); void job.finally(() => this.jobs.delete(job));
  }
  async drain(): Promise<void> { while (this.jobs.size) await Promise.all(this.jobs); }
  subscribe(userId: string, fn: () => void): () => void {
    const list = this.listeners.get(userId) ?? new Set(); list.add(fn); this.listeners.set(userId, list);
    return () => { list.delete(fn); if (!list.size) this.listeners.delete(userId); };
  }
  list(userId: string): Promise<Memory[]> { return this.repository.list(userId); }
  async settings(userId: string, update?: Partial<MemorySettings>): Promise<MemorySettings> {
    return this.serial(userId, async () => {
      const state = await this.state.getState(userId);
      if (update) { state.settings = { ...state.settings, ...update }; await this.state.putState(userId, state); }
      return state.settings;
    });
  }
  async noteMessage(userId: string): Promise<void> {
    return this.serial(userId, async () => {
      const s = await this.state.getState(userId); s.last_message_at = this.now(); await this.state.putState(userId, s);
    });
  }
  async noteOpener(userId: string, word: string): Promise<void> {
    return this.serial(userId, async () => {
      const s = await this.state.getState(userId); s.recent_openers = [...s.recent_openers ?? [], word.slice(0, 40)].slice(-3); await this.state.putState(userId, s);
    });
  }
  async remember(userId: string, text: string, kind: MemoryKind, sessionId: string, followUp = kind === "episode"): Promise<Memory | null> {
    if (!safeMemoryText(text)) return null;
    const revision = (await this.state.getState(userId)).revision;
    if (this.options.isSafe && !await this.options.isSafe(text)) return null;
    return this.serial(userId, async () => (await this.state.getState(userId)).revision === revision ? this.put(userId, text, kind, sessionId, followUp) : null);
  }
  private async put(userId: string, text: string, kind: MemoryKind, sessionId: string, followUp: boolean, imageRef?: string): Promise<Memory | null> {
    if (!safeMemoryText(text) || (kind !== "fact" && kind !== "episode")) return null;
    text = text.trim();
    const now = this.now();
    const old = (await this.repository.list(userId)).find((m) => m.id === memoryId(text));
    const m: Memory = { ...old, id: memoryId(text), text, kind, created_at: old?.created_at ?? now, updated_at: now, last_used_at: old?.last_used_at ?? null, follow_up: followUp, source_session_id: sessionId, ...(imageRef ? { image_ref: imageRef } : {}) };
    return await this.repository.put(userId, m) ? m : null;
  }
  async recall(userId: string, query: string): Promise<Memory[]> {
    if (!query.trim()) return [];
    return this.serial(userId, async () => {
      const q = tokens(query);
      const ranked = (await this.repository.list(userId)).map((m) => ({ m, score: [...tokens(m.text)].filter((t) => q.has(t)).length }))
        .filter((r) => r.score > 0).sort((a, b) => b.score - a.score || b.m.updated_at - a.m.updated_at).slice(0, 3).map((r) => r.m);
      for (const m of ranked) {
        m.last_used_at = this.now(); await this.repository.put(userId, m);
        this.log("memory.recalled", { memory_id: m.id, age_s: Math.max(0, Math.floor((this.now() - m.created_at) / 1000)) });
      }
      return ranked;
    });
  }
  async forget(userId: string, id?: string): Promise<void> {
    await this.serial(userId, async () => {
      const items = (await this.repository.list(userId)).filter((m) => !id || m.id === id);
      const s = await this.state.getState(userId); s.revision++; s.recent_openers = []; await this.state.putState(userId, s);
      for (const fn of this.listeners.get(userId) ?? []) fn();
      for (const m of items) if (m.image_ref) await this.options.deleteCrop?.(userId, m.image_ref);
      // Retain the row if blob deletion fails so a retry can find and erase it.
      await this.repository.delete(userId, id);
    });
  }
  async extract(userId: string, sessionId: string, turns: Turn[], revision: number): Promise<void> {
    if ((await this.state.getState(userId)).revision !== revision) return;
    const items = await this.options.extract(turns);
    await this.serial(userId, async () => {
      if ((await this.state.getState(userId)).revision !== revision) return;
      let count = 0;
      for (const m of items) {
        if (m.sensitive === "none" && typeof m.follow_up === "boolean" && await this.put(userId, m.text, m.kind, sessionId, m.follow_up)) count++;
      }
      this.log("memory.extracted", { count });
    });
  }
  async rememberSeen(userId: string, context: SeenContext, candidate: SeenCandidate): Promise<Memory | null> {
    const revision = (await this.state.getState(userId)).revision;
    if (!this.options.deleteCrop || !this.options.verifyCrop || !validSeen(candidate, context) || !await this.options.verifyCrop(userId, candidate.crop)) return null;
    return this.serial(userId, async () => {
      const state = await this.state.getState(userId);
      if (!state.settings.rememberSeen || state.revision !== revision) return null;
      const key = JSON.stringify([userId, context.sessionId]);
      if ((this.seen.get(key) ?? 0) >= 3) return null;
      // Count surviving and forgotten items alike; Forget must not reset a call's cap.
      const m = await this.put(userId, candidate.line, "episode", context.sessionId, true, candidate.crop.image_ref);
      if (m) this.seen.set(key, (this.seen.get(key) ?? 0) + 1);
      return m;
    });
  }
  endCall(userId: string, sessionId: string): void { this.seen.delete(JSON.stringify([userId, sessionId])); }
  async opening(userId: string, sessionId: string): Promise<Memory | null> {
    return this.serial(userId, async () => {
      const s = await this.state.getState(userId);
      const now = this.now();
      const gap = (this.options.revisitGapHours ?? 6) * 3_600_000;
      if (s.last_message_at === null || now - s.last_message_at < gap || s.last_opener_day === day(now)) return null;
      const eligible = (await this.repository.list(userId)).filter((m) => m.kind === "episode" && m.follow_up && m.source_session_id !== sessionId);
      const seen = eligible.filter((m) => m.image_ref && now - m.updated_at >= 6 * 3_600_000);
      const item = [...seen.length ? seen : eligible.filter((m) => !m.image_ref)].sort((a, b) => b.updated_at - a.updated_at)[0];
      if (!item) return null;
      s.last_opener_day = day(now); await this.state.putState(userId, s);
      item.last_used_at = now; await this.repository.put(userId, item);
      this.log("memory.recalled", { memory_id: item.id, age_s: Math.floor((now - item.created_at) / 1000) });
      return item;
    });
  }
}
