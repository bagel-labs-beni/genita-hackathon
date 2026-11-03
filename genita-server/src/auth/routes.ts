/**
 * Account routes (F1-L2, F1-L3, F1-L5, F1-L8).
 *
 *   POST   /auth/apple            {identityToken, nonce, authorizationCode?, fullName?, device?}  iPhone native → session
 *   GET    /auth/apple/start      ?challenge=<b64url sha256(verifier)>&device=mac                Mac: 302 to Apple
 *   POST   /auth/apple/callback   Apple form_post (code, id_token, state, user)                  302 genita://auth?code=…
 *   POST   /auth/exchange         {code, verifier}                                                Mac: one-time code → session
 *   POST   /auth/judge            {code, device?}                                                 Judge access (D41): demo-account session, no Apple ID;
 *                                                                                                 a companion-less judge account gets the demo "Jin" (prep/demo.ts)
 *   POST   /auth/email/start      {email}                                                         mails a 6-digit code (also /v1/auth/email/start)
 *   POST   /auth/email/verify     {email, code, device?}                                          code → session (also /v1/auth/email/verify)
 *   POST   /auth/logout           (session)                                                       revokes this session
 *   GET    /me                    {user, consented, hasCompanion, prepStatus, companionDemo, conversation}
 *   PATCH  /me                    {displayName}                                                   blank → 400
 *   POST   /me/consent            {kind?: "ai_data", version?}
 *   POST   /me/report             RP-1 (D37) {reason, note?, surface?, utteranceId?, text?}  → stored under users/<id>/reports/
 *   DELETE /me                    Apple revoke → blobs users/<id>/ + avatars/<companion>/ → rows (cascade)
 *
 * Threat line: callers are the Genita iOS/macOS apps, plus Apple's form_post
 * through the user's browser on /auth/apple/callback. Auth: Apple identity
 * token checked against Apple's JWKS (aud + nonce) for sign-in; HMAC-signed
 * state + one-time 60 s code + PKCE verifier for the Mac web flow; a mailed
 * 6-digit code (10 min, 5 tries, keyed hash) for email sign-in; the session JWT
 * (HS256, 30 d, revocable sid) for /me*. Limits: 30 req/min per IP on /auth/*,
 * 64 KB bodies; email: 1 send/60 s, 5/h and 10/day per address, 20 sends/h and
 * 20 wrong codes/10 min per IP (the last X-Forwarded-For entry behind CloudFront),
 * 60 sends/min overall, and start answers the same whether or not an account
 * exists. Exposes only the caller's own user row.
 * Report (RP-1, D37): session only; reason is one of four, note ≤ 280 and the
 * reported text ≤ 600 characters; 10 reports per user per hour; stored in the
 * caller's own blob prefix (erased with the account); the log line carries the
 * reason and surface only, never the note or text.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { JwtError, b64url, sha256B64url, sha256Hex } from "./jwt.ts";
import { DEVICES, type Device } from "./accounts.ts";
import type { AccountsCore, Principal } from "./index.ts";
import { CODE_TTL_SEC, RESEND_AFTER_SEC, maskEmail, normalizeEmail } from "./email.ts";

const BODY_LIMIT = 64 * 1024;
/** RP-1 reasons (PRD D37), in the sheet's order */
export const REPORT_REASONS = ["inappropriate_image", "harmful_answer", "someone_elses_photo", "other"] as const;
const REPORT_SURFACES = new Set(["call", "card", "settings", "mac"]);
const REPORTS_PER_USER_HOUR = 10;
// shared NATs (a hackathon venue, a judges' office, company Wi-Fi) sign in from one IP (11/4): the per-email limits
// (60 s resend, 5 / hour, 10 / day, 5 tries per code, EMAIL_FAILS_PER_EMAIL_10MIN) carry the abuse protection
export const EMAIL_SENDS_PER_IP_HOUR = 200;
export const EMAIL_FAILS_PER_IP_10MIN = 200;
/** wrong codes per address in 10 min, across resends (each code also burns after MAX_ATTEMPTS) */
export const EMAIL_FAILS_PER_EMAIL_10MIN = 10;
/** all addresses together: caps what any number of IPs can make the mail provider send */
const EMAIL_SENDS_PER_MIN = 60;

/** Fixed-window counter per key (one server instance; expired keys are dropped past 10k keys). */
function windowCounter(limit: number, windowMs: number) {
  const m = new Map<string, { n: number; reset: number }>();
  const live = (k: string) => {
    const h = m.get(k);
    return h && h.reset > Date.now() ? h : null;
  };
  return {
    full: (k: string) => (live(k)?.n ?? 0) >= limit,
    add(k: string) {
      const h = live(k);
      if (h) h.n++;
      else {
        if (m.size > 10_000) for (const [key, v] of m) if (v.reset <= Date.now()) m.delete(key);
        m.set(k, { n: 1, reset: Date.now() + windowMs });
      }
    },
    /** check + count in one synchronous step (before any await), so parallel requests can't all pass */
    take(k: string): boolean {
      if ((live(k)?.n ?? 0) >= limit) return false;
      this.add(k);
      return true;
    },
    /** seconds until `k` has a free slot again (0 = now) */
    retryAfterSec(k: string): number {
      const h = live(k);
      return h && h.n >= limit ? Math.max(1, Math.ceil((h.reset - Date.now()) / 1000)) : 0;
    },
    /** hand a taken slot back (nothing was sent) */
    give(k: string) {
      const h = live(k);
      if (h && h.n > 0) h.n--;
    },
  };
}
const STATE_TTL_SEC = 10 * 60;
export const APP_CALLBACK = "genita://auth";

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** 429 with Retry-After and a line the app can show ("Too many tries. Try again in 3 min.") */
function tooMany(res: ServerResponse, retryAfterSec: number, error = "rate_limited") {
  const sec = Math.max(1, Math.ceil(retryAfterSec));
  const min = Math.max(1, Math.ceil(sec / 60));
  res.writeHead(429, { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(sec) });
  res.end(JSON.stringify({ error, retryAfterSec: sec, message: `Too many tries. Try again in ${min} min.` }));
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > BODY_LIMIT) throw new HttpError(413, "body_too_large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const s = await readBody(req);
  try {
    const v = JSON.parse(s || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

const str = (v: unknown, max = 8192) => (typeof v === "string" && v.length <= max ? v : "");

/**
 * The id_token Apple returns from /auth/token came straight from Apple over TLS, so its
 * payload is trusted without a JWKS check; only its subject is compared to the signed-in user.
 */
export function sameAppleSub(idToken: string, sub: string): boolean {
  try {
    const p = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown };
    return typeof p.sub === "string" && p.sub === sub;
  } catch {
    return false;
  }
}

/** Signed, expiring state for the Mac web flow: carries the PKCE challenge and the nonce seed. */
export function signState(secret: string, p: { c: string; d: Device; n: string; x: number }): string {
  const body = b64url(JSON.stringify(p));
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function readState(secret: string, state: string, nowSec = Math.floor(Date.now() / 1000)): { c: string; d: Device; n: string; x: number } | null {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const want = createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof p.x !== "number" || p.x < nowSec || typeof p.c !== "string" || typeof p.n !== "string" || !DEVICES.includes(p.d)) return null;
    return p;
  } catch {
    return null;
  }
}

/**
 * Behind CloudFront (the only proxy; the instance accepts nothing else) the viewer's address is the LAST
 * X-Forwarded-For entry: CloudFront appends it to whatever the client sent, so earlier entries are the
 * client's own words and must never key a rate limit.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    // the LAST entry is the one our own proxy appended; earlier entries are whatever the caller sent
    const xff = req.headers["x-forwarded-for"];
    const last = (Array.isArray(xff) ? xff.join(",") : xff)?.split(",").pop()?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "?";
}

export type AccountRoutes = {
  handles(pathname: string): boolean;
  /** `who` is resolved by server.ts from the bearer token (null = none/invalid). */
  handle(req: IncomingMessage, res: ServerResponse, who: Principal | null): Promise<void>;
};

export function createAccountRoutes(core: AccountsCore): AccountRoutes {
  const { accounts, apple, blobs, log } = core;
  const emailSends = windowCounter(EMAIL_SENDS_PER_IP_HOUR, 60 * 60_000);
  const emailFails = windowCounter(EMAIL_FAILS_PER_IP_10MIN, 10 * 60_000);
  const emailFailsByEmail = windowCounter(EMAIL_FAILS_PER_EMAIL_10MIN, 10 * 60_000);
  const emailSendsAll = windowCounter(EMAIL_SENDS_PER_MIN, 60_000);
  const reports = windowCounter(REPORTS_PER_USER_HOUR, 60 * 60_000);
  const hits = new Map<string, { n: number; reset: number }>();
  const limited = (ip: string) => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || h.reset < now) {
      if (hits.size > 10_000) hits.clear();
      hits.set(ip, { n: 1, reset: now + 60_000 });
      return false;
    }
    return ++h.n > core.authRatePerMin;
  };

  async function issue(userId: string, device: Device, isNew: boolean, provider: string) {
    const { sid, expiresAt } = await accounts.createSession(userId, device);
    const token = core.signSession(userId, sid, device, expiresAt);
    log("auth.signed_in", { provider, device, is_new: isNew });
    return { token, expiresAt: expiresAt.toISOString(), isNew, ...(await accounts.meView(userId)) };
  }

  const fail = (provider: string, reason: string, status = 401) => {
    log("auth.failed", { provider, reason });
    return new HttpError(status, "auth_failed", reason);
  };

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, who: Principal | null) {
    const m = req.method ?? "GET";
    const p = url.pathname.replace(/\/+$/, "").replace(/^\/v1(?=\/auth\/email\/)/, "");

    if (p.startsWith("/auth/") && limited(clientIp(req, core.trustProxy))) {
      const h = hits.get(clientIp(req, core.trustProxy));
      return tooMany(res, h ? (h.reset - Date.now()) / 1000 : 60);
    }

    // ── iPhone: native Sign in with Apple ──
    if (m === "POST" && p === "/auth/apple") {
      const b = await readJson(req);
      const identityToken = str(b.identityToken);
      const nonce = str(b.nonce, 256);
      if (!identityToken || !nonce) throw fail("apple", "missing_token_or_nonce", 400);
      const device: Device = b.device === "mac" ? "mac" : "iphone";
      let id;
      try {
        id = await apple.verifyIdentityToken(identityToken, { audience: apple.cfg.bundleId, rawNonce: nonce });
      } catch (e) {
        throw fail("apple", e instanceof JwtError ? e.reason : "jwks_unavailable", e instanceof JwtError ? 401 : 503);
      }
      const fn = (b.fullName && typeof b.fullName === "object" ? b.fullName : {}) as Record<string, unknown>;
      const name = [str(fn.givenName, 60), str(fn.familyName, 60)].filter(Boolean).join(" ") || null;
      const { user, isNew } = await accounts.upsertUser({ provider: "apple", sub: id.sub, email: id.email, emailVerified: id.emailVerified, displayName: name });
      const code = str(b.authorizationCode, 2048);
      if (code && apple.canExchange) {
        const t = await apple.exchangeCode(code, apple.cfg.bundleId).catch(() => null);
        // the code must belong to the same Apple ID, or deleting this account would revoke someone else's
        if (t?.refreshToken && sameAppleSub(t.idToken, id.sub)) await accounts.setAppleRefreshToken(user.id, t.refreshToken, apple.cfg.bundleId);
        else log("auth.apple_exchange_skipped", { reason: t ? "no_refresh_token" : "exchange_failed" });
      }
      return send(res, 200, await issue(user.id, device, isNew, "apple"));
    }

    // ── Mac: web Sign in with Apple ──
    if (m === "GET" && p === "/auth/apple/start") {
      const challenge = url.searchParams.get("challenge") ?? "";
      if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new HttpError(400, "bad_challenge");
      const device: Device = url.searchParams.get("device") === "iphone" ? "iphone" : "mac";
      const n = randomBytes(16).toString("base64url");
      const state = signState(core.jwtSecret, { c: challenge, d: device, n, x: Math.floor(Date.now() / 1000) + STATE_TTL_SEC });
      return redirect(res, apple.authorizeUrl({ redirectUri: core.callbackUrl, state, nonceHash: sha256Hex(n) }));
    }

    if (m === "POST" && p === "/auth/apple/callback") {
      const form = new URLSearchParams(await readBody(req));
      const back = (q: Record<string, string>) => redirect(res, `${APP_CALLBACK}?${new URLSearchParams(q)}`);
      if (form.get("error")) {
        log("auth.failed", { provider: "apple", reason: `apple_${form.get("error")}`.slice(0, 60) });
        return back({ error: form.get("error") === "user_cancelled_authorize" ? "cancelled" : "apple_error" });
      }
      const st = readState(core.jwtSecret, form.get("state") ?? "");
      if (!st) {
        log("auth.failed", { provider: "apple", reason: "bad_state" });
        return back({ error: "bad_state" });
      }
      let id;
      try {
        id = await apple.verifyIdentityToken(form.get("id_token") ?? "", { audience: apple.cfg.servicesId, rawNonce: st.n });
      } catch (e) {
        log("auth.failed", { provider: "apple", reason: e instanceof JwtError ? e.reason : "jwks_unavailable" });
        return back({ error: "invalid_token" });
      }
      let name: string | null = null;
      try {
        const u = JSON.parse(form.get("user") ?? "null") as { name?: { firstName?: string; lastName?: string } } | null;
        name = [str(u?.name?.firstName, 60), str(u?.name?.lastName, 60)].filter(Boolean).join(" ") || null;
      } catch {}
      const { user, isNew } = await accounts.upsertUser({ provider: "apple", sub: id.sub, email: id.email, emailVerified: id.emailVerified, displayName: name });
      const code = form.get("code");
      if (code && apple.canExchange) {
        const t = await apple.exchangeCode(code, apple.cfg.servicesId, core.callbackUrl).catch(() => null);
        if (t?.refreshToken && sameAppleSub(t.idToken, id.sub)) await accounts.setAppleRefreshToken(user.id, t.refreshToken, apple.cfg.servicesId);
      }
      return back({ code: await accounts.createCode(user.id, st.d, st.c, isNew) });
    }

    if (m === "POST" && p === "/auth/exchange") {
      const b = await readJson(req);
      const code = str(b.code, 200);
      const verifier = str(b.verifier, 200);
      if (!code || verifier.length < 43) throw fail("apple", "missing_code_or_verifier", 400);
      const c = await accounts.takeCode(code);
      if (!c) throw fail("apple", "code_invalid_or_used");
      const a = Buffer.from(sha256B64url(verifier));
      const want = Buffer.from(c.challenge);
      if (a.length !== want.length || !timingSafeEqual(a, want)) throw fail("apple", "verifier_mismatch");
      return send(res, 200, await issue(c.userId, c.device, c.isNew, "apple"));
    }

    // ── Judge access (D41): code → session for that code's demo account ──
    if (m === "POST" && p === "/auth/judge") {
      const ip = clientIp(req, core.trustProxy);
      if (!core.judge.enabled) throw new HttpError(404, "not_found");
      const b = await readJson(req);
      // no await from here to the verdict: concurrent requests from one IP can't all slip past the limit
      const code = str(b.code, 128).trim();
      const ipWait = core.judge.ipRetryAfterSec(ip);
      if (ipWait > 0) {
        log("auth.judge", { ok: false, reason: "rate_limited", ip });
        return tooMany(res, ipWait);
      }
      const device: Device = b.device === "mac" ? "mac" : "iphone";
      // AU-04: the prefix backoff holds only a wrong code (judges share the code and the venue IP)
      const prefixWait = code ? core.judge.prefixRetryAfterSec(ip, code) : 0;
      const label = code ? core.judge.check(ip, code) : null;
      if (!label && prefixWait > 0) {
        log("auth.judge", { ok: false, reason: "rate_limited", ip });
        return tooMany(res, prefixWait);
      }
      if (!label) {
        log("auth.judge", { ok: false, reason: code ? "wrong_code" : "missing_code", ip });
        throw fail("judge", code ? "wrong_code" : "missing_code", code ? 401 : 400);
      }
      const { user, isNew } = await accounts.upsertUser({ provider: "dev", sub: `judge:${label}`, displayName: "Judge" });
      log("auth.judge", { ok: true, label, device, ip });
      // first sign-in (or no companion): the ready-made demo companion, so the first call needs no prep wait
      await core.seedDemo?.(user.id);
      return send(res, 200, await issue(user.id, device, isNew, "judge"));
    }

    // ── email one-time code (any address; same answer whether or not an account exists) ──
    if (m === "POST" && p === "/auth/email/start") {
      const ip = clientIp(req, core.trustProxy);
      const email = normalizeEmail((await readJson(req)).email);
      if (!email) throw new HttpError(400, "bad_email");
      if (!core.mail) {
        log("auth.failed", { provider: "email", reason: "no_mail_sender" });
        throw new HttpError(503, "email_unavailable", "Email sign-in isn't available right now.");
      }
      if (!emailSends.take(ip)) {
        log("auth.failed", { provider: "email", reason: "ip_send_limit" });
        return tooMany(res, emailSends.retryAfterSec(ip));
      }
      if (!emailSendsAll.take("all")) {
        emailSends.give(ip);
        log("auth.failed", { provider: "email", reason: "global_send_limit" });
        return tooMany(res, emailSendsAll.retryAfterSec("all"));
      }
      const giveBack = () => {
        emailSends.give(ip);
        emailSendsAll.give("all");
      };
      const issued = await core.emailCodes.issue(email).catch((e) => {
        giveBack();
        throw e;
      });
      if (!issued.ok) {
        giveBack();
        log("auth.failed", { provider: "email", reason: "email_send_limit" });
        return tooMany(res, issued.retryAfterSec);
      }
      try {
        await core.mail.send(email, issued.code, CODE_TTL_SEC / 60);
      } catch (e) {
        await core.emailCodes.discard(issued.id);
        giveBack();
        log("auth.email_send_failed", { to: maskEmail(email), sender: core.mail.kind, message: String(e).slice(0, 80) });
        throw new HttpError(502, "send_failed", "Couldn't send the code. Try again.");
      }
      log("auth.email_code_sent", { to: maskEmail(email), sender: core.mail.kind });
      return send(res, 200, { ok: true, expiresInSec: CODE_TTL_SEC, resendAfterSec: RESEND_AFTER_SEC });
    }

    if (m === "POST" && p === "/auth/email/verify") {
      const ip = clientIp(req, core.trustProxy);
      const b = await readJson(req);
      const email = normalizeEmail(b.email);
      const code = typeof b.code === "string" ? b.code.trim() : "";
      if (!email || !/^\d{6}$/.test(code)) throw new HttpError(400, "bad_request");
      // every try holds a "wrong code" slot (per address and per IP) until it turns out right, so parallel guesses
      // can't overshoot; the address is the real limit, the IP one is wide for shared NATs (11/4)
      if (!emailFailsByEmail.take(email)) {
        log("auth.failed", { provider: "email", reason: "email_fail_limit" });
        return tooMany(res, emailFailsByEmail.retryAfterSec(email));
      }
      if (!emailFails.take(ip)) {
        emailFailsByEmail.give(email);
        log("auth.failed", { provider: "email", reason: "ip_fail_limit" });
        return tooMany(res, emailFails.retryAfterSec(ip));
      }
      const giveBack = () => {
        emailFails.give(ip);
        emailFailsByEmail.give(email);
      };
      const device: Device = b.device === "mac" ? "mac" : "iphone";
      const r = await core.emailCodes.check(email, code).catch((e) => {
        giveBack();
        throw e;
      });
      if (r === "ok") giveBack();
      // nothing was compared (no live code / already burned): the address keeps its slot, the IP one stays counted
      if (r === "no_code" || r === "burned") emailFailsByEmail.give(email);
      if (r !== "ok") {
        if (r === "too_many" || r === "burned") {
          log("auth.failed", { provider: "email", reason: "too_many_attempts" });
          return send(res, 429, { error: "too_many_attempts", message: "Too many tries. Ask for a new code." });
        }
        throw fail("email", "code_invalid");
      }
      const { user, isNew } = await accounts.userForVerifiedEmail(email);
      return send(res, 200, await issue(user.id, device, isNew, "email"));
    }

    // ── everything below needs a session ──
    if (!who) throw new HttpError(401, "unauthorized");

    if (m === "POST" && p === "/auth/logout") {
      if (who.sid) await accounts.revokeSession(who.sid);
      log("auth.logged_out", { device: who.device });
      return send(res, 200, { ok: true });
    }

    if (m === "GET" && p === "/me") {
      const v = await accounts.meView(who.userId);
      if (!v) throw new HttpError(401, "unauthorized");
      return send(res, 200, v);
    }

    if (m === "PATCH" && p === "/me") {
      const b = await readJson(req);
      const raw = typeof b.displayName === "string" ? b.displayName : typeof b.display_name === "string" ? b.display_name : null;
      if (raw === null) throw new HttpError(400, "nothing_to_update");
      const name = raw.replace(/\s+/g, " ").trim();
      if (!name) throw new HttpError(400, "name_required");
      if (name.length > 40) throw new HttpError(400, "name_too_long");
      await accounts.setDisplayName(who.userId, name);
      log("name.entered", { chars: name.length });
      return send(res, 200, await accounts.meView(who.userId));
    }

    if (m === "POST" && p === "/me/consent") {
      const b = await readJson(req);
      const kind = b.kind === undefined ? "ai_data" : b.kind;
      if (kind !== "ai_data" && kind !== "photo_rights" && kind !== "seen_memory") throw new HttpError(400, "bad_kind");
      const version = str(b.version, 20) || "v1";
      await accounts.consent(who.userId, kind, version, who.device);
      if (kind === "ai_data") log("consent.accepted", { version });
      return send(res, 200, await accounts.meView(who.userId));
    }

    // RP-1 (D37): report a reply, a card or a picture. Kept with the account's own files; "Thanks, noted" in the app.
    if (m === "POST" && p === "/me/report") {
      const b = await readJson(req);
      const reason = (REPORT_REASONS as readonly string[]).includes(b.reason as string) ? (b.reason as string) : null;
      if (!reason) throw new HttpError(400, "bad_reason");
      const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");
      const surface = typeof b.surface === "string" && REPORT_SURFACES.has(b.surface) ? b.surface : "other";
      if (!reports.take(who.userId)) throw new HttpError(429, "rate_limited");
      const at = new Date();
      const record = {
        at: at.toISOString(), userId: who.userId, device: who.device, reason, surface,
        note: clean(b.note, 280),
        text: clean(b.text, 600),
        utteranceId: Number.isInteger(b.utteranceId) ? b.utteranceId : null,
        findId: clean(b.findId, 64) || null,
      };
      const key = `users/${who.userId}/reports/${at.toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}.json`;
      try {
        await blobs.put(key, Buffer.from(JSON.stringify(record)), "application/json");
      } catch (e) {
        reports.give(who.userId);
        log("report.failed", { message: String(e).slice(0, 120) });
        throw new HttpError(502, "report_failed", "Couldn't send that. Try again.");
      }
      // an account deleted while this was being written leaves nothing behind (Codex P2)
      if (!(await accounts.meView(who.userId))) {
        await blobs.deletePrefix(key).catch(() => 0);
        throw new HttpError(401, "unauthorized");
      }
      log("report.received", { reason, surface, device: who.device, note: record.note.length > 0 });
      return send(res, 200, { ok: true, message: "Thanks, noted" });
    }

    if (m === "DELETE" && p === "/me") {
      const link = await accounts.appleLink(who.userId);
      const appleStatus = link ? await apple.revoke(link.token, link.clientId) : null;
      if (link && appleStatus !== 200) log("account.apple_revoke_failed", { status: appleStatus });
      // blobs first: if storage is down, keep the rows so the user can retry
      let blobsDeleted: number;
      const companionIds = await accounts.companionIds(who.userId);
      try {
        blobsDeleted = await blobs.deletePrefix(`users/${who.userId}/`);
        // Legacy companion assets are keyed by companion id, outside users/<id>/
        for (const cid of companionIds) blobsDeleted += await blobs.deletePrefix(`avatars/${cid}/`);
      } catch (e) {
        log("account.delete_failed", { stage: "blobs", message: String(e).slice(0, 120) });
        throw new HttpError(502, "delete_failed", "Couldn't delete your files. Try again.");
      }
      try {
        await core.beforeUserDeleted?.(who.userId);
      } catch (e) {
        log("account.delete_failed", { stage: "features", message: String(e).slice(0, 120) });
        throw new HttpError(502, "delete_failed", "Couldn't delete your data. Try again.");
      }
      await accounts.deleteUser(who.userId);
      core.onUserDeleted?.(who.userId);
      log("account.deleted", { blobs: blobsDeleted, apple_revoked: appleStatus === 200 });
      return send(res, 200, { deleted: true, appleRevoked: link ? appleStatus === 200 : null, blobsDeleted });
    }

    throw new HttpError(404, "not_found");
  }

  return {
    handles: (p) => p === "/me" || p.startsWith("/me/") || p.startsWith("/auth/") || p.startsWith("/v1/auth/email/"),
    async handle(req, res, who) {
      const url = new URL(req.url ?? "/", "http://localhost");
      try {
        await route(req, res, url, who);
      } catch (err) {
        if (res.headersSent) return void res.end();
        if (err instanceof HttpError) return send(res, err.status, err.code === "auth_failed" ? { error: err.code, reason: err.message } : { error: err.code, message: err.message === err.code ? undefined : err.message });
        log("auth.http_error", { path: url.pathname, message: String(err).slice(0, 300) });
        send(res, 500, { error: "server_error" });
      }
    },
  };
}
