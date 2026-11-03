/**
 * Per-call perception (PERC-1, #319). The app sends a face crop now and then; this runs one Spark read at a
 * time in the background and keeps only the smoothed state. It never blocks a reply: the reply path reads
 * `contextLine()` / `pendingHint()` synchronously. Frames are dropped as soon as their Spark call ends —
 * nothing is written to disk, memory store or logs.
 */
import type { SparkRequest, SparkStreamEvent } from "../meta/spark.ts";
import { getOps } from "../ops/limits.ts";
import { buildPerceiveRequest, parseSample } from "./schema.ts";
import { contextLine, hintFor, initialTracker, observe, stateOf, type Convo, type Tracker } from "./rules.ts";
import type { PerceptionSource, PerceptionState, PerceptionTrigger } from "./types.ts";

export const HINT_TTL_MS = 15_000;
/** base64 chars; a 320 px JPEG at q 0.6 is ~15–30 KB */
export const MAX_IMAGE_CHARS = 300_000;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type PerceptionDeps = {
  spark: (req: SparkRequest, opts: { signal?: AbortSignal; firstEventTimeoutMs?: number }) => AsyncIterable<SparkStreamEvent>;
  now: () => number;
  /** the conversation right now (read when a frame arrives) */
  convo: () => Convo;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** idle: frames closer than this to the last call are dropped (default 1000) */
  minGapMs?: number;
  /** Spark reads per call (default 720 ≈ 30 min at one per 2.5 s) */
  maxCalls?: number;
  timeoutMs?: number;
  /** global Meta budget admission (default: the ops daily cap) */
  admit?: () => boolean;
  /** whether to read faces at all right now (session: chat mode, not watching together); default always */
  active?: () => boolean;
};

type Pending = { url: string; at: number; convo: Convo };

export class PerceptionController implements PerceptionSource {
  private tracker: Tracker = initialTracker();
  private inFlight: AbortController | null = null;
  private pending: Pending | null = null;
  private lastStartAt = -Infinity;
  private calls = 0;
  private budgetLogged = false;
  private hint: { text: string; at: number } | null = null;
  private listeners = new Set<(t: PerceptionTrigger) => void>();
  private closed = false;
  private gapTimer: NodeJS.Timeout | null = null;
  private readonly deps: PerceptionDeps;

  constructor(deps: PerceptionDeps) {
    this.deps = deps;
  }

  /** `perception.frame.image`: base64 JPEG or a JPEG data URL. Invalid input is ignored. */
  frame(image: unknown): void {
    if (this.closed || typeof image !== "string" || !this.isActive()) return;
    const b64 = image.startsWith("data:image/jpeg;base64,") ? image.slice("data:image/jpeg;base64,".length) : image;
    if (!b64 || b64.length > MAX_IMAGE_CHARS || !B64.test(b64)) return;
    const now = this.deps.now();
    const p: Pending = { url: `data:image/jpeg;base64,${b64}`, at: now, convo: { ...this.deps.convo() } };
    if (this.inFlight || this.gapTimer) {
      this.pending = p; // the newest face wins
      return;
    }
    if (now - this.lastStartAt < (this.deps.minGapMs ?? 1000)) return;
    void this.run(p);
  }

  state(): PerceptionState | null {
    return this.closed ? null : stateOf(this.tracker, this.deps.now());
  }

  contextLine(): string | null {
    return contextLine(this.state());
  }

  pendingHint(): string | null {
    const h = this.hint;
    this.hint = null;
    if (!h || this.closed || this.deps.now() - h.at > HINT_TTL_MS) return null;
    return h.text;
  }

  onTrigger(cb: (t: PerceptionTrigger) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  close(): void {
    this.closed = true;
    this.pending = null;
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.gapTimer = null;
    this.inFlight?.abort();
    this.inFlight = null;
    this.listeners.clear();
    this.tracker = initialTracker();
    this.hint = null;
  }

  private async run(p: Pending): Promise<void> {
    if (this.calls >= (this.deps.maxCalls ?? 720) || !(this.deps.admit ?? (() => getOps().metaLimit() === null))()) {
      if (!this.budgetLogged) this.log("perception.budget", { calls: this.calls });
      this.budgetLogged = true;
      return;
    }
    this.calls++;
    const abort = new AbortController();
    this.inFlight = abort;
    this.lastStartAt = this.deps.now();
    const started = this.lastStartAt;
    let text = "";
    let ok = false;
    try {
      const timer = setTimeout(() => abort.abort(), this.deps.timeoutMs ?? 6000);
      try {
        for await (const ev of this.deps.spark(buildPerceiveRequest(p.url), { signal: abort.signal, firstEventTimeoutMs: this.deps.timeoutMs ?? 6000 })) {
          if (ev.type === "text") text += ev.delta;
          else if (ev.type === "done" && ev.text) text = ev.text;
        }
      } finally {
        clearTimeout(timer);
      }
      if (this.closed || abort.signal.aborted) return;
      // a read that lands after a switch to interpretation / watch together says nothing to anyone
      if (!this.isActive()) {
        this.pending = null; // nor does a face that waited through it (Codex P2, round 2)
        return;
      }
      const sample = parseSample(text);
      ok = !!sample;
      if (sample) {
        const r = observe(this.tracker, sample, p.at, p.convo);
        this.tracker = r.tracker;
        for (const t of r.triggers) {
          this.hint = { text: hintFor(t.kind, sample), at: t.at };
          this.log("perception.trigger", { kind: t.kind, confidence: Math.round(t.confidence * 100) / 100 });
          for (const cb of this.listeners) {
            try {
              cb(t);
            } catch {
              // a listener's bug must not stop perception
            }
          }
        }
      }
    } catch {
      ok = false;
    } finally {
      if (this.inFlight === abort) this.inFlight = null;
      if (!this.closed) this.log("perception.sample", { ok, ms: Math.round(this.deps.now() - started) });
    }
    if (this.pending) this.runPendingAfterGap();
  }

  /** The waiting face goes next, but never sooner than minGapMs after the last call started (Codex P2). */
  private runPendingAfterGap(): void {
    const wait = Math.max(0, (this.deps.minGapMs ?? 1000) - (this.deps.now() - this.lastStartAt));
    const go = () => {
      this.gapTimer = null;
      const next = this.pending;
      this.pending = null;
      // a waiting face older than the stale window says nothing about now
      if (next && !this.closed && this.isActive() && this.deps.now() - next.at <= 3000) void this.run(next);
    };
    if (wait === 0) return go();
    this.gapTimer = setTimeout(go, wait);
  }

  private isActive(): boolean {
    return this.deps.active?.() ?? true;
  }

  private log(event: string, data: Record<string, unknown>): void {
    this.deps.log?.(event, data);
  }
}
