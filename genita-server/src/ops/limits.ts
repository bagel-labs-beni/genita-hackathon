/**
 * D46 operational limits for the single EC2 host. Global Meta counters are in
 * memory: a restart resets them (acceptable worst case: one extra day's budget).
 * UTC days, synchronous check-and-increment before I/O; failed vendor requests
 * still count. Image endpoints consume BOTH counters atomically.
 * User turns are admitted synchronously from memory (no DB wait on the reply path, order kept); with a DB
 * each accepted turn is written to usage_daily in the background and the stored total flows back into
 * memory, so other hosts/restarts are caught up within one turn. No keys/input are logged.
 * Uploads await a conditional usage_daily UPSERT before any vendor I/O: the
 * five-per-user UTC-day cap is strict across hosts/restarts. Failed attempts count.
 * Pause: GENITA_PAUSED=1 (needs a restart) or the file GENITA_PAUSE_FILE exists (checked every 5 s, no
 * restart, running calls keep going).
 */
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.ts";
import type { Queryable } from "../db/index.ts";
import { UpstreamError } from "../meta/http.ts";

type Log = (event: string, data: Record<string, unknown>) => void;
type Options = { now?: () => number; log?: Log; db?: Queryable };
type Limit = "calls" | "images" | "user_turns" | "user_uploads";
type OpsConfig = Pick<Config, "paused" | "metaDailyCalls" | "metaDailyImages" | "userDailyTurns"> & { pauseFile?: string | null };
const USER_DAILY_UPLOADS = 5;

export class OpsLimits {
  private readonly config: OpsConfig;
  private readonly now: () => number;
  private readonly log: Log;
  private readonly db?: Queryable;
  private day = "";
  private calls = 0;
  private images = 0;
  private turns = new Map<string, number>();
  private uploads = new Map<string, number>();
  private synced = new Set<string>();
  private priming = new Set<string>();
  private turnErrors = new Set<string>();
  private reached = new Set<Limit>();
  private pausedLogs = new Map<string, number>();
  private usageLoggedAt = -Infinity;

  constructor(config: OpsConfig = {}, opts: Options = {}) {
    this.config = config;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.db = opts.db;
  }

  private today(): string {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.calls = this.images = 0;
      this.turns.clear();
      this.uploads.clear();
      this.synced.clear();
      this.priming.clear();
      this.turnErrors.clear();
      this.reached.clear();
    }
    return day;
  }

  private cap(limit: Limit): number {
    return limit === "calls" ? this.config.metaDailyCalls ?? 20_000
      : limit === "images" ? this.config.metaDailyImages ?? 600
      : limit === "user_uploads" ? USER_DAILY_UPLOADS
      : this.config.userDailyTurns ?? 300;
  }

  private exhausted(limit: Limit, count: number, day: string): boolean {
    const cap = this.cap(limit);
    if (cap <= 0 || count < cap) return false;
    if (!this.reached.has(limit) && day === this.day) {
      this.reached.add(limit);
      this.log("limit.reached", { limit, day, count });
    }
    return true;
  }

  private pauseCheckedAt = -Infinity;
  private pauseFileOn = false;

  private pausedNow(): boolean {
    if (this.config.paused) return true;
    const file = this.config.pauseFile;
    if (!file) return false;
    const now = this.now();
    if (now - this.pauseCheckedAt >= 5_000) {
      this.pauseCheckedAt = now;
      try { this.pauseFileOn = existsSync(file); } catch { this.pauseFileOn = false; }
    }
    return this.pauseFileOn;
  }

  isPaused(kind: string): boolean {
    // Consult on every admission; never abort an already running call.
    if (!this.pausedNow()) return false;
    const now = this.now();
    if (now - (this.pausedLogs.get(kind) ?? -Infinity) >= 60_000) {
      this.pausedLogs.set(kind, now);
      this.log("ops.paused", { kind });
    }
    return true;
  }

  /** Admission only; actual outbound requests reserve the budget in consumeMeta. */
  metaLimit(image = false): "calls" | "images" | null {
    const day = this.today();
    if (this.exhausted("calls", this.calls, day)) return "calls";
    if (image && this.exhausted("images", this.images, day)) return "images";
    return null;
  }

  /** Meta calls left today (Infinity when uncapped): optional work (the V03 face scan) only starts with room to spare */
  metaCallsLeft(): number {
    this.today();
    const cap = this.cap("calls");
    return cap <= 0 ? Infinity : Math.max(0, cap - this.calls);
  }

  consumeMeta(image = false): void {
    const limit = this.metaLimit(image);
    if (limit) throw new UpstreamError("meta", 429, `daily_cap:${limit}`);
    this.calls++;
    if (image) this.images++;
    const now = this.now();
    if (now - this.usageLoggedAt >= 600_000) {
      this.usageLoggedAt = now;
      this.log("ops.usage", { calls: this.calls, images: this.images });
    }
  }

  usage(): { calls: number; images: number } {
    this.today();
    return { calls: this.calls, images: this.images };
  }

  /** Reserve before image checks. DB errors propagate: never spend Meta budget without a reservation. */
  async reserveUpload(userId: string): Promise<boolean> {
    const day = this.today();
    if (this.db) {
      const r = await this.db.query(
        `INSERT INTO usage_daily (user_id, day, uploads) VALUES ($1, $2::date, 1)
         ON CONFLICT (user_id, day) DO UPDATE SET uploads = usage_daily.uploads + 1
         WHERE usage_daily.uploads < $3
         RETURNING uploads`,
        [userId, day, USER_DAILY_UPLOADS],
      );
      if (r.rows.length > 0) return true;
      this.exhausted("user_uploads", USER_DAILY_UPLOADS, day);
      return false;
    }
    // Shared-token/loopback mode has no DB; check-and-increment without yielding.
    const used = this.uploads.get(userId) ?? 0;
    if (used >= USER_DAILY_UPLOADS) {
      this.exhausted("user_uploads", used, day);
      return false;
    }
    this.uploads.set(userId, used + 1);
    return true;
  }

  /** Used before speculative Spark, without spending a turn on a partial. Memory only: never waits. */
  canSpeculate(userId?: string | null): boolean {
    const day = this.today();
    if (!userId || this.cap("user_turns") <= 0) return true;
    return !this.unconfirmed(userId) && !this.exhausted("user_turns", this.turns.get(userId) ?? 0, day);
  }

  /** Warm today's stored count when a call starts, without delaying the call or its first turn. */
  prime(userId?: string | null): void {
    const day = this.today();
    if (!userId || !this.db || this.synced.has(userId) || this.priming.has(userId)) return;
    this.priming.add(userId);
    this.track(this.loadTurns(userId, day));
  }

  private async loadTurns(userId: string, day: string): Promise<void> {
    try {
      const r = await this.db!.query("SELECT turns FROM usage_daily WHERE user_id=$1 AND day=$2::date", [userId, day]);
      this.mergeTurns(userId, day, Number(r.rows[0]?.turns ?? 0));
    } catch (err) {
      this.turnError(userId, day, err);
    } finally {
      if (this.day === day) this.priming.delete(userId);
    }
  }

  private unconfirmed(userId: string): boolean {
    return !!this.db && !this.synced.has(userId) && (this.turns.get(userId) ?? 0) > 0;
  }

  /**
   * Synchronous admission from memory. With a DB the turn is also counted in usage_daily in the background;
   * the stored total (other hosts, earlier processes today) is merged back, so a restart allows at most one
   * extra turn before the cap applies again. A DB error is logged and the in-memory count still enforces the cap.
   */
  acceptUserTurn(userId?: string | null): boolean {
    const day = this.today();
    if (!userId) return true; // shared dev sessions without an authenticated user
    const count = this.turns.get(userId) ?? 0;
    if (this.cap("user_turns") > 0 && (this.unconfirmed(userId) || this.exhausted("user_turns", count, day))) return false;
    this.turns.set(userId, count + 1);
    this.track(this.persistTurn(userId, day));
    return true;
  }

  /** All background usage_daily work started so far (tests await it, never the reply path). */
  pending: Promise<void> = Promise.resolve();

  private track(work: Promise<void>): void {
    this.pending = Promise.all([this.pending, work]).then(() => {});
  }

  private mergeTurns(userId: string, day: string, stored: number): void {
    if (this.day !== day) return;
    if (Number.isFinite(stored)) this.turns.set(userId, Math.max(this.turns.get(userId) ?? 0, stored));
    this.synced.add(userId);
  }

  private turnError(userId: string, day: string, err: unknown): void {
    if (this.day !== day) return;
    // Fail open at the memory count once the DB has answered, even if it failed.
    this.synced.add(userId);
    if (this.turnErrors.has(userId)) return;
    this.turnErrors.add(userId);
    this.log("ops.turn_error", { message: String(err).slice(0, 120) });
  }

  private async persistTurn(userId: string, day: string): Promise<void> {
    if (!this.db) return;
    try {
      const r = await this.db.query(
        `INSERT INTO usage_daily (user_id, day, turns) VALUES ($1, $2::date, 1)
         ON CONFLICT (user_id, day) DO UPDATE SET turns = usage_daily.turns + 1
         RETURNING turns`,
        [userId, day],
      );
      this.mergeTurns(userId, day, Number(r.rows[0]?.turns));
    } catch (err) {
      this.turnError(userId, day, err);
    }
  }

  /** Over the cap → the session's existing non-retryable error path. Runs synchronously (keeps turn order). */
  userTurn(userId: string | null | undefined, accepted: () => void, rejected: (message: string) => void): void {
    if (this.acceptUserTurn(userId)) accepted();
    else rejected("daily_cap:user_turns");
  }

  /** Interpreter guesses cannot be charged as accepted final user turns. */
  cappedUser(userId?: string | null): boolean { return !!userId && this.cap("user_turns") > 0; }
}

let active = new OpsLimits();
export function configureOps(config: OpsConfig, opts: Options = {}): OpsLimits {
  active = new OpsLimits(config, opts);
  return active;
}
export function getOps(): OpsLimits { return active; }

/** Exact current generation routes, including GET voices (Spark ordering).
 * Finds REST only reads/edits stored cards on this base; its model calls are WS
 * pipelines and are counted by the common Meta clients. Memory settings/erase
 * and account/auth routes never generate. Import skip only stores choices.
 * sam.ts only parses; SAM uses media.ts.
 */
function generation(req: IncomingMessage, path: string): { image: boolean } | null {
  if (req.method === "GET" && path === "/v1/companion/voices") return { image: false };
  // voice previews render through the voice service on a cache miss
  if (req.method === "GET" && /^\/v1\/companion\/voices\/[^/]+\/preview$/.test(path)) return { image: false };
  if (req.method !== "POST") return null;
  if (["/v1/companion", "/v1/companion/prep/retry", "/v1/us-photos", "/v1/companion/image/polish"].includes(path)) return { image: true };
  if (["/v1/import", "/v1/companion/image", "/v1/companion/prefs", "/v1/companion/name/suggest"].includes(path)) return { image: false };
  return null;
}

/** True = response sent. Keep the shared server route diff to a single hook. */
export function rejectGeneration(req: IncomingMessage, res: ServerResponse, ops: OpsLimits): boolean {
  const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "");
  const route = generation(req, path);
  if (!route) return false;
  const paused = ops.isPaused(`${req.method} ${path}`);
  const limit = paused ? null : ops.metaLimit(route.image);
  if (!paused && !limit) return false;
  res.writeHead(paused ? 503 : 429, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(paused ? { error: "paused" } : { error: "limit_reached", limit: `meta_${limit}` }));
  return true;
}
