/**
 * Early-access waitlist (teaser page, 11/5). Public, no auth:
 *
 *   OPTIONS /v1/early-access   CORS preflight (allowed origins only)
 *   POST    /v1/early-access   {email, source?} → 200 {ok:true}, also for an address already on the list
 *
 * The address is trimmed + lowercased and upserted into early_access (migration 008). Only allowed
 * browser origins may post (GENITA_EARLY_ACCESS_ORIGINS, default the GitHub Pages site). Rate limited
 * per caller IP, body capped. The raw address and IP are never logged: logs carry a keyed hash.
 * GENITA_EARLY_ACCESS=0 turns the route off (404, as if it did not exist).
 */
import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Queryable } from "../db/index.ts";

export const EARLY_ACCESS_PATH = "/v1/early-access";
export const DEFAULT_ORIGINS = ["https://bagel-labs-beni.github.io"];
const BODY_LIMIT = 2 * 1024;
const RATE_LIMIT = 5;
const WINDOW_MS = 60_000;
const SOURCE = /^[a-z0-9_-]{1,32}$/;

type Log = (event: string, data: Record<string, unknown>) => void;
export type EarlyAccessOptions = {
  db: Queryable | null;
  log: Log;
  /** key for the IP / email hashes; without one the hashes are plain sha256 (still never the raw value) */
  secret: string;
  origins?: string[];
  enabled?: boolean;
  /** the caller's IP (the server passes CloudFront-aware clientIp) */
  ip: (req: IncomingMessage) => string;
  now?: () => number;
};
export type EarlyAccessRoute = { handles(pathname: string): boolean; handle(req: IncomingMessage, res: ServerResponse): Promise<void> };

/** trim + lowercase; null when it does not look like a deliverable address */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return null;
  const at = email.lastIndexOf("@");
  if (at < 1 || at > 64) return null;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)) return null;
  const local = email.slice(0, at);
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (!/\.[a-z]{2,}$/.test(email)) return null; // a real TLD, not "a@b.c1"
  return email;
}

export const hashValue = (secret: string, value: string) => createHmac("sha256", secret || "genita-early-access").update(value).digest("hex").slice(0, 16);

/** CSV of the waitlist for scripts/early-access-export.ts (RFC 4180 quoting, formula-safe for spreadsheets). */
export function toCsv(rows: Array<{ email: string; created_at: Date | string; source: string | null }>): string {
  const cell = (v: string) => {
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = ["email,created_at,source"];
  for (const r of rows) lines.push([r.email, r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at), r.source ?? ""].map(cell).join(","));
  return lines.join("\n") + "\n";
}

export function createEarlyAccessRoute(o: EarlyAccessOptions): EarlyAccessRoute {
  const origins = new Set(o.origins?.length ? o.origins : DEFAULT_ORIGINS);
  const enabled = o.enabled !== false;
  const now = o.now ?? Date.now;
  const hits = new Map<string, { startedAt: number; count: number }>();

  const send = (res: ServerResponse, status: number, body: unknown, origin: string | null) => {
    const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
    if (origin) Object.assign(headers, { "access-control-allow-origin": origin, vary: "Origin" });
    res.writeHead(status, headers).end(JSON.stringify(body));
  };

  function limited(ip: string): boolean {
    const at = now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (at - v.startedAt >= WINDOW_MS) hits.delete(k);
    const prev = hits.get(ip);
    const rate = !prev || at - prev.startedAt >= WINDOW_MS ? { startedAt: at, count: 0 } : prev;
    rate.count++;
    hits.set(ip, rate);
    return rate.count > RATE_LIMIT;
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > BODY_LIMIT) throw new Error("too_large");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > BODY_LIMIT) throw new Error("too_large");
      chunks.push(chunk as Buffer);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("bad_json"); }
  }

  return {
    handles: (pathname) => pathname === EARLY_ACCESS_PATH || pathname === EARLY_ACCESS_PATH + "/",
    async handle(req, res) {
      if (!enabled) return send(res, 404, { error: "not_found" }, null);
      const h = req.headers.origin;
      const origin = typeof h === "string" && origins.has(h) ? h : null;

      if (req.method === "OPTIONS") {
        if (!origin) return void res.writeHead(403, { "cache-control": "no-store" }).end();
        return void res.writeHead(204, {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "600",
          vary: "Origin",
        }).end();
      }
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "method_not_allowed" }, origin);
      // only the landing page posts here; a request from any other (or no) origin is refused
      if (!origin) return send(res, 403, { ok: false, error: "origin_not_allowed" }, null);
      if (limited(o.ip(req))) return send(res, 429, { ok: false, error: "rate_limited" }, origin);

      let body: unknown;
      try { body = await readJson(req); } catch (e) {
        const tooLarge = (e as Error).message === "too_large";
        if (tooLarge) res.setHeader("connection", "close");
        return send(res, tooLarge ? 413 : 400, { ok: false, error: tooLarge ? "too_large" : "bad_json" }, origin);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { ok: false, error: "invalid_email" }, origin);
      const b = body as { email?: unknown; source?: unknown; company?: unknown };
      const email = normalizeEmail(b.email);
      if (!email) return send(res, 400, { ok: false, error: "invalid_email" }, origin);
      // honeypot: a bot that fills the hidden field gets the same answer and nothing is stored
      if (typeof b.company === "string" && b.company.trim()) {
        o.log("early_access.honeypot", {});
        return send(res, 200, { ok: true }, origin);
      }
      if (!o.db) return send(res, 503, { ok: false, error: "unavailable" }, origin);
      const source = typeof b.source === "string" && SOURCE.test(b.source.trim().toLowerCase()) ? b.source.trim().toLowerCase() : null;
      try {
        const r = await o.db.query(
          "INSERT INTO early_access (email, source, ip_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING",
          [email, source, hashValue(o.secret, o.ip(req))],
        );
        o.log("early_access.signup", { emailHash: hashValue(o.secret, email), source, added: r.rowCount > 0 });
      } catch (e) {
        // the code only: a driver message or detail could quote the address
        o.log("early_access.error", { emailHash: hashValue(o.secret, email), code: String((e as { code?: unknown }).code ?? "unknown") });
        return send(res, 503, { ok: false, error: "unavailable" }, origin);
      }
      return send(res, 200, { ok: true }, origin);
    },
  };
}
