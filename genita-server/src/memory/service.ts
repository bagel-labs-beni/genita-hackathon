import { type CallStateRepository, type MemoryRepository, type Memory, type MemoryKind, type MemorySettings, memoryId } from "./repository.ts";
import { cleanKeys, safeMemoryText, type Extractor, type KeyMaker, type Turn } from "./extract.ts";
import { validSeen, type SeenCandidate, type SeenContext } from "./seen.ts";
import { within } from "../util/within.ts";
import { RERANK_BUDGET_MS, RERANK_CANDIDATES, stableFacts, type Reranker } from "./rerank.ts";
import { SUMMARY_KEEP, type CallSummary, type Summarizer, type SummaryRepository } from "./summaries.ts";

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
  /** Seen memory (SM-1~3). Off in the hackathon build via createMemory (D40); defaults on for direct use/tests. */
  seenMemory?: boolean;
  isSafe?: (text: string) => Promise<boolean>;
  /** Session memory (per-thread call summaries). Off when unset or sessionMemory=false (GENITA_SESSION_MEMORY=0). */
  summarize?: Summarizer;
  sessionMemory?: boolean;
  /** recall keys for an explicitly remembered line (extraction brings its own); background only */
  keys?: KeyMaker;
  /** Spark re-rank for the recall TOOL (GENITA_MEMORY_RERANK=0 turns it off); unset = overlap order */
  rerank?: Reranker;
  /** createMemory's default in-process store: the server swaps it for Postgres when accounts are on (useStore). */
  ephemeral?: boolean;
  log?: Log;
};
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
// Words that match everything ("my", "the", "what") are not evidence of relevance.
const STOP = new Set("i me my mine myself you your yours we us our the a an and or but to of in on at for with from by as is am are was were be been being it its this that these those do does did doing what which who whom how why when where about so just like have has had can could would should will shall get got im i'm it's dont don't not no yes ok okay oh hey hi please really very".split(" "));
const tokens = (s: string) => new Set((s.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).map((t) => t.replace(/'/g, "")).filter((t) => t && !STOP.has(t)));

export class MemoryService {
  repository: MemoryRepository;
  state: CallStateRepository;
  /** true while memory lives only in this process (lost on restart) */
  ephemeral: boolean;
  private readonly options: MemoryOptions;
  private locks = new Map<string, Promise<unknown>>();
  private listeners = new Map<string, Set<(revision: number) => void>>();
  private jobs = new Set<Promise<unknown>>();
  private seen = new Map<string, number>();
  readonly now: () => number;
  constructor(options: MemoryOptions) {
    this.options = options; this.repository = options.repository; this.state = options.state; this.now = options.now ?? Date.now;
    this.ephemeral = options.ephemeral === true;
  }
  /** Durable store swap (server start, before any traffic): P0 11/3, memory survives deploys. */
  useStore(store: MemoryRepository & CallStateRepository & Partial<SummaryRepository>): void {
    this.repository = store; this.state = store; this.ephemeral = false;
  }
  /** the store's summary side, when it has one */
  private get summaryStore(): SummaryRepository | null {
    const r = this.repository as MemoryRepository & Partial<SummaryRepository>;
    return typeof r.putSummary === "function" && typeof r.listSummaries === "function" && typeof r.deleteSummaries === "function" ? (r as SummaryRepository) : null;
  }
  get sessionMemory(): boolean { return !!this.options.summarize && this.options.sessionMemory !== false && !!this.summaryStore; }
  /** Newest first; the current thread (a handed-off call already has its turns) is left out. */
  async summaries(userId: string, exceptThread?: string, limit = SUMMARY_KEEP): Promise<CallSummary[]> {
    if (!this.sessionMemory) return [];
    // No lock (a slow store must not block the user's other memory work); Forget deletes summaries
    // BEFORE it notifies calls, so a load that races it is discarded by the caller (MemoryCall.open).
    return (await this.summaryStore!.listSummaries(userId, limit + 1)).filter((s) => s.thread_id !== exceptThread).slice(0, limit);
  }
  /** Background only (call close / every few turns). Turns are summarized, never stored; Forget wins. */
  async summarizeThread(userId: string, threadId: string, turns: Turn[], revision: number, covered = turns.length): Promise<CallSummary | null> {
    if (!this.sessionMemory || !turns.length) return null;
    if ((await this.state.getState(userId)).revision !== revision) return null;
    const previous = (await this.summaryStore!.listSummaries(userId, SUMMARY_KEEP)).find((s) => s.thread_id === threadId) ?? null;
    const body = await this.options.summarize!(turns, previous);
    if (!body) return null;
    return this.serial(userId, async () => {
      if ((await this.state.getState(userId)).revision !== revision) return null;
      const now = this.now();
      const summary: CallSummary = { ...body, thread_id: threadId, created_at: now, updated_at: now, turns: covered };
      await this.summaryStore!.putSummary(userId, summary);
      this.log("memory.summarized", { turns: covered, topics: body.topics.length, open_threads: body.open_threads.length, promises: body.promises.length });
      return summary;
    });
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
  subscribe(userId: string, fn: (revision: number) => void): () => void {
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
    const saved = await this.serial(userId, async () => (await this.state.getState(userId)).revision === revision ? this.put(userId, text, kind, sessionId, followUp) : null);
    if (saved && !saved.keys && this.options.keys) {
      const makeKeys = this.options.keys;
      // off the reply path: recall keys for the explicit line, written only onto the still-live row
      this.background(async () => {
        const keys = cleanKeys(await makeKeys(saved.text));
        if (!keys) return;
        await this.serial(userId, async () => {
          if ((await this.state.getState(userId)).revision !== revision) return;
          const row = (await this.repository.list(userId)).find((m) => m.id === saved.id);
          if (row && !row.keys) await this.repository.put(userId, { ...row, keys });
        });
      });
    }
    return saved;
  }
  private async put(userId: string, text: string, kind: MemoryKind, sessionId: string, followUp: boolean, imageRef?: string, keys?: string[]): Promise<Memory | null> {
    if (!safeMemoryText(text) || (kind !== "fact" && kind !== "episode")) return null;
    text = text.trim();
    const now = this.now();
    const old = (await this.repository.list(userId)).find((m) => m.id === memoryId(text));
    const m: Memory = { ...old, id: memoryId(text), text, kind, created_at: old?.created_at ?? now, updated_at: now, last_used_at: old?.last_used_at ?? null, follow_up: followUp, source_session_id: sessionId, ...(imageRef ? { image_ref: imageRef } : {}), ...(keys?.length ? { keys } : {}) };
    if (!await this.repository.put(userId, m)) return null;
    // same line seen again with a new crop: the old crop would otherwise be unreachable by Forget / account delete
    if (old?.image_ref && imageRef && old.image_ref !== imageRef) await this.options.deleteCrop?.(userId, old.image_ref).catch(() => {});
    return m;
  }
  /** The call's top stable facts (see rerank.ts stableFacts): loaded once at call start. */
  async stableFacts(userId: string): Promise<Memory[]> {
    return stableFacts(await this.repository.list(userId));
  }
  /**
   * Token overlap (stop words removed) ranks; `rerank` (the recall tool only) lets Spark re-order up to
   * RERANK_CANDIDATES overlap candidates, padded with the newest items so a same-meaning memory ("pet" vs
   * "my cat") can still be found. Bounded; past the budget or on error the overlap order stands.
   */
  async recall(userId: string, query: string, opts: { rerank?: boolean } = {}): Promise<Memory[]> {
    if (!query.trim()) return [];
    const { items, revision } = await this.serial(userId, async () => ({ items: await this.repository.list(userId), revision: (await this.state.getState(userId)).revision }));
    const q = tokens(query);
    // the memory's words plus its recall keys ("pet" finds "my cat Miso")
    const scored = items.map((m) => ({ m, score: [...tokens(m.text + " " + (m.keys ?? []).join(" "))].filter((t) => q.has(t)).length }))
      .filter((r) => r.score > 0).sort((a, b) => b.score - a.score || b.m.updated_at - a.m.updated_at);
    let ranked = scored.slice(0, 3).map((r) => r.m);
    if (opts.rerank && this.options.rerank && items.length) {
      const candidates = scored.slice(0, RERANK_CANDIDATES).map((r) => r.m);
      for (const m of [...items].sort((a, b) => b.updated_at - a.updated_at)) {
        if (candidates.length >= RERANK_CANDIDATES) break;
        if (!candidates.includes(m)) candidates.push(m);
      }
      const t0 = performance.now();
      const ctl = new AbortController();
      const picks = await within(this.options.rerank(query, candidates.map((m) => m.text), ctl.signal), RERANK_BUDGET_MS, null);
      if (!picks) ctl.abort();
      this.log("memory.reranked", { candidates: candidates.length, picked: picks?.length ?? null, ms: Math.round(performance.now() - t0), fallback: !picks });
      if (picks) ranked = picks.map((i) => candidates[i]).filter(Boolean);
      // a Forget while Spark was ranking: nothing from before it
      if ((await this.state.getState(userId)).revision !== revision) return [];
    }
    const at = this.now();
    for (const m of ranked) {
      m.last_used_at = at;
      this.log("memory.recalled", { memory_id: m.id, age_s: Math.max(0, Math.floor((at - m.created_at) / 1000)) });
    }
    // The last_used_at write is bookkeeping, not the answer: off the reply path (with Postgres it is a
    // transaction per item). A Forget in between wins: put() refuses tombstoned ids.
    // Only last_used_at changes on the CURRENT row (a newer write, e.g. a new crop ref, must not be undone).
    if (ranked.length) this.background(() => this.serial(userId, async () => {
      const current = new Map((await this.repository.list(userId)).map((m) => [m.id, m]));
      for (const m of ranked) {
        const row = current.get(m.id);
        if (row) await this.repository.put(userId, { ...row, last_used_at: Math.max(row.last_used_at ?? 0, at) });
      }
    }));
    return ranked;
  }
  async forget(userId: string, id?: string): Promise<void> {
    await this.serial(userId, async () => {
      const items = (await this.repository.list(userId)).filter((m) => !id || m.id === id);
      // Session summaries are free text across many topics: any Forget (one item or all) drops them all,
      // the same rule as the handoff turn cache. First, so no call can load them after the notification.
      await this.summaryStore?.deleteSummaries(userId);
      const s = await this.state.getState(userId); s.revision++; s.recent_openers = []; await this.state.putState(userId, s);
      for (const fn of this.listeners.get(userId) ?? []) fn(s.revision);
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
        if (m.sensitive === "none" && typeof m.follow_up === "boolean" && await this.put(userId, m.text, m.kind, sessionId, m.follow_up, undefined, cleanKeys(m.keys))) count++;
      }
      this.log("memory.extracted", { count });
    });
  }
  async rememberSeen(userId: string, context: SeenContext, candidate: SeenCandidate): Promise<Memory | null> {
    if (this.options.seenMemory === false) return null;
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
