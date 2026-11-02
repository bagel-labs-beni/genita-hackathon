/**
 * Account routes (F1-L2, F1-L3, F1-L5, F1-L8).
 *
 *   POST   /auth/apple            {identityToken, nonce, authorizationCode?, fullName?, device?}  iPhone native → session
 *   GET    /auth/apple/start      ?challenge=<b64url sha256(verifier)>&device=mac                Mac: 302 to Apple
 *   POST   /auth/apple/callback   Apple form_post (code, id_token, state, user)                  302 genita://auth?code=…
 *   POST   /auth/exchange         {code, verifier}                                                Mac: one-time code → session
 *   POST   /auth/judge            {code, device?}                                                 Judge access (D41): demo-account session, no Apple ID
 *   POST   /auth/logout           (session)                                                       revokes this session
 *   GET    /me                    {user, consented, hasCompanion, prepStatus, conversation}
 *   PATCH  /me                    {displayName}                                                   blank → 400
 *   POST   /me/consent            {kind?: "ai_data", version?}
 *   DELETE /me                    Apple revoke → blobs users/<id>/ + avatars/<companion>/ → Peter cache → rows (cascade)
 *
 * Threat line: callers are the Genita iOS/macOS apps, plus Apple's form_post
 * through the user's browser on /auth/apple/callback. Auth: Apple identity
 * token checked against Apple's JWKS (aud + nonce) for sign-in; HMAC-signed
 * state + one-time 60 s code + PKCE verifier for the Mac web flow; the
 * session JWT (HS256, 30 d, revocable sid) for /me*. Limits: 30 req/min per
 * IP on /auth/*, 64 KB bodies. Exposes only the caller's own user row.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { JwtError, b64url, sha256B64url, sha256Hex } from "./jwt.ts";
import { DEVICES, type Device } from "./accounts.ts";
import type { AccountsCore, Principal } from "./index.ts";

const BODY_LIMIT = 64 * 1024;
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

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) return first;
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
    const p = url.pathname.replace(/\/+$/, "");

    if (p.startsWith("/auth/") && limited(clientIp(req, core.trustProxy))) throw new HttpError(429, "rate_limited");

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
      const { user, isNew } = await accounts.upsertUser({ provider: "apple", sub: id.sub, email: id.email, displayName: name });
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
      const { user, isNew } = await accounts.upsertUser({ provider: "apple", sub: id.sub, email: id.email, displayName: name });
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
      if (core.judge.limited(ip)) {
        log("auth.judge", { ok: false, reason: "rate_limited", ip });
        throw new HttpError(429, "rate_limited");
      }
      const b = await readJson(req);
      const code = str(b.code, 128).trim();
      const device: Device = b.device === "mac" ? "mac" : "iphone";
      const label = code ? core.judge.check(ip, code) : null;
      if (!label) {
        log("auth.judge", { ok: false, reason: code ? "wrong_code" : "missing_code", ip });
        throw fail("judge", code ? "wrong_code" : "missing_code", code ? 401 : 400);
      }
      const { user, isNew } = await accounts.upsertUser({ provider: "dev", sub: `judge:${label}`, displayName: "Judge" });
      log("auth.judge", { ok: true, label, device, ip });
      return send(res, 200, await issue(user.id, device, isNew, "judge"));
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

    if (m === "DELETE" && p === "/me") {
      const link = await accounts.appleLink(who.userId);
      const appleStatus = link ? await apple.revoke(link.token, link.clientId) : null;
      if (link && appleStatus !== 200) log("account.apple_revoke_failed", { status: appleStatus });
      // blobs first: if storage is down, keep the rows so the user can retry
      let blobsDeleted: number;
      const companionIds = await accounts.companionIds(who.userId);
      try {
        blobsDeleted = await blobs.deletePrefix(`users/${who.userId}/`);
        // Peter avatar caches (face frames + latents) are keyed by companion id, outside users/<id>/
        for (const cid of companionIds) blobsDeleted += await blobs.deletePrefix(`avatars/${cid}/`);
        await core.forgetAvatars?.(companionIds); // GPU box copy; throws → rows kept, user retries
      } catch (e) {
        log("account.delete_failed", { stage: "blobs", message: String(e).slice(0, 120) });
        throw new HttpError(502, "delete_failed", "Couldn't delete your files. Try again.");
      }
      await accounts.deleteUser(who.userId);
      core.onUserDeleted?.(who.userId);
      log("account.deleted", { blobs: blobsDeleted, apple_revoked: appleStatus === 200 });
      return send(res, 200, { deleted: true, appleRevoked: link ? appleStatus === 200 : null, blobsDeleted });
    }

    throw new HttpError(404, "not_found");
  }

  return {
    handles: (p) => p === "/me" || p.startsWith("/me/") || p.startsWith("/auth/"),
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
