/**
 * Companion reset (11/4): POST /v1/companion/reset — "Make a new companion" on the iPhone's Settings.
 * One account, a new companion: QA no longer needs a new email per test, and a user can start over.
 *
 * Removed: the companion row and everything that cascades from it (prep job, prefs, persona card, voice,
 * name, emotions), its photo and every uploaded photo no companion uses, every face file under
 * users/<id>/companions/ (and legacy avatars/<cid>/), call memory (memory.forget: memories, call
 * summaries, recent openers), the in-process turn cache and opener topics. Live calls of the account
 * close with 4410 "companion_reset" (the apps go to V01 / Mac "Set up on iPhone").
 * Kept: the login (users row, sessions, Apple link), consents, display name, the import / HISY profile
 * (user_styles: what Genita knows about the user), memory settings, reports, Finds, usage counters
 * (judge daily turns), the handoff conversation row (owner device + epoch).
 *
 * Same stop as DELETE /me: prep, face top-up and reflow are cancelled and their in-flight writes drained
 * (runner.resetCompanion) before anything is erased, and none can start until the erase is done.
 *
 * Threat line: caller = the signed-in Genita iPhone app (Settings). Auth = session JWT (or the dev token),
 * AI consent, checked by server.ts like every /v1/companion route. Abuse = 10 resets that removed a
 * companion per account per 24 h (in process), one at a time per account (409), no body read. The
 * reserved demo template account is refused (403); a judge account resets only its own copy (copies
 * live under users/<judge>/). Exposes nothing: {ok, removed}.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BlobStore } from "../storage/blob.ts";
import { ResetBusy, type PrepRunner } from "./runner.ts";
import type { PrepStore } from "./store.ts";

export const RESET_PATH = "/v1/companion/reset";
export const RESETS_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60_000;

export type CompanionResetDeps = {
  store: PrepStore;
  runner: PrepRunner;
  log: (event: string, data: Record<string, unknown>) => void;
  /** legacy companion files at avatars/<companionId>/ (DELETE /me removes them too) */
  blobs?: BlobStore | null;
  /** the reserved demo template account(s): never reset */
  isProtected?: (userId: string) => Promise<boolean>;
  /** server-level cleanup before the rows go (close live calls, forget call memory). Throwing answers 502; a retry runs every step again. */
  beforeErase?: (userId: string) => Promise<void>;
};

export type CompanionReset = {
  handles(pathname: string): boolean;
  handle(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void>;
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function createCompanionReset(d: CompanionResetDeps, perDay = RESETS_PER_DAY): CompanionReset {
  const hits = new Map<string, number[]>();
  const recent = (userId: string) => (hits.get(userId) ?? []).filter((t) => Date.now() - t < DAY_MS);
  /** check + count before any await, so parallel requests can't all pass */
  const take = (userId: string) => {
    const h = recent(userId);
    if (h.length >= perDay) return false;
    h.push(Date.now());
    hits.set(userId, h);
    if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((t) => Date.now() - t < DAY_MS)) hits.delete(k);
    return true;
  };
  const give = (userId: string) => {
    const h = recent(userId);
    h.pop();
    hits.set(userId, h);
  };

  async function erase(userId: string) {
    const c = await d.store.getCompanion(userId);
    await d.beforeErase?.(userId);
    const removed = await d.store.deleteCompanion(userId);
    // a face file a stopped job wrote under any companion id, and photos no companion uses
    if (!(await d.store.getCompanion(userId))) await d.store.deleteAssets(userId);
    const photos = (await d.store.deleteUnusedImages?.(userId)) ?? 0;
    if (c && d.blobs) await d.blobs.deletePrefix(`avatars/${c.id}/`);
    return { removed, companion: c?.id ?? null, demo: c?.demo === true, photos };
  }

  return {
    handles: (pathname) => pathname.replace(/\/+$/, "") === RESET_PATH,
    async handle(req, res, userId) {
      try {
        if ((req.method ?? "GET") !== "POST") return send(res, 405, { error: "method_not_allowed" });
        if (await d.isProtected?.(userId)) {
          d.log("companion.reset", { ok: false, reason: "demo_template" });
          return send(res, 403, { error: "demo_template" });
        }
        if (!take(userId)) {
          d.log("companion.reset", { ok: false, reason: "rate_limited" });
          return send(res, 429, { error: "rate_limited", message: "You've started over a lot today. Try again tomorrow." });
        }
        const t0 = performance.now();
        let r: Awaited<ReturnType<typeof erase>>;
        try {
          r = await d.runner.resetCompanion(userId, () => erase(userId));
        } catch (err) {
          give(userId);
          if (err instanceof ResetBusy) return send(res, 409, { error: "reset_in_progress" });
          d.log("companion.reset", { ok: false, reason: "erase_failed", message: String(err).slice(0, 160) });
          return send(res, 502, { error: "reset_failed", message: "Couldn't start over. Try again." });
        }
        if (!r.removed) give(userId);   // nothing to remove: not counted
        // a companion made while the reset held prep back (POST /v1/companion raced it) still gets its prep
        const now = await d.store.getCompanion(userId).catch(() => null);
        if (now?.prep.status === "running" && !d.runner.isRunning(userId)) void d.runner.run(userId);
        d.log("companion.reset", { ok: true, removed: r.removed, demo: r.demo, photos: r.photos, ms: Math.round(performance.now() - t0) });
        return send(res, 200, { ok: true, removed: r.removed });
      } catch (err) {
        if (res.headersSent) return void res.end();
        d.log("companion.reset", { ok: false, reason: "server_error", message: String(err).slice(0, 160) });
        send(res, 500, { error: "server_error" });
      }
    },
  };
}
