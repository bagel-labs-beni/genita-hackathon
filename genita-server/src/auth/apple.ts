/**
 * Sign in with Apple verification
 * (identity-token check, code exchange, revoke on account deletion) without jose.
 *
 *   iPhone (native)  aud = APPLE_BUNDLE_ID   (default ai.thebeni.genita)
 *   Mac (web flow)   aud = APPLE_SERVICES_ID (default ai.thebeni.genita.web)
 * Both share one primary App ID, so the same Apple ID gives the same `sub`.
 *
 * Env: APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (SIWA .p8 PEM, `\n` escapes ok).
 * Without the key trio, identity tokens still verify (JWKS is public); only the
 * code exchange → refresh token → revoke path is skipped.
 */
import { timingSafeEqual } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { JwtError, publicKeyFromJwk, sha256Hex, signEs256, verifyRs256, type Jwk } from "./jwt.ts";

export const APPLE_ISSUER = "https://appleid.apple.com";
const JWKS_URL = "https://appleid.apple.com/auth/keys";
const JWKS_TTL_MS = 60 * 60_000;
const JWKS_MIN_REFETCH_MS = 60_000;

export type AppleConfig = {
  bundleId: string;
  servicesId: string;
  teamId: string | null;
  keyId: string | null;
  privateKey: string | null;
};

export function appleConfigFromEnv(env: NodeJS.ProcessEnv): AppleConfig {
  return {
    bundleId: env.APPLE_BUNDLE_ID || "ai.thebeni.genita",
    servicesId: env.APPLE_SERVICES_ID || "ai.thebeni.genita.web",
    teamId: env.APPLE_TEAM_ID?.trim() || null,
    keyId: env.APPLE_KEY_ID?.trim() || null,
    privateKey: env.APPLE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim() || null,
  };
}

export type AppleIdentity = { sub: string; email: string | null; emailVerified: boolean; aud: string };
export type AppleTokens = { idToken: string; refreshToken: string | null };

/** Constant-time check that the token's nonce is sha256(rawNonce) hex (what the app put in the request). */
export function nonceMatches(tokenNonce: unknown, rawNonce: string): boolean {
  if (typeof tokenNonce !== "string" || !rawNonce) return false;
  const a = Buffer.from(tokenNonce);
  const b = Buffer.from(sha256Hex(rawNonce));
  return a.length === b.length && timingSafeEqual(a, b);
}

export class AppleAuth {
  readonly cfg: AppleConfig;
  private f: typeof fetch;
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(cfg: AppleConfig, f: typeof fetch = fetch) {
    this.cfg = cfg;
    this.f = f;
  }

  get canExchange() {
    return !!(this.cfg.teamId && this.cfg.keyId && this.cfg.privateKey);
  }

  private async loadKeys(force: boolean) {
    const age = Date.now() - this.fetchedAt;
    if (!force && this.keys.size && age < JWKS_TTL_MS) return;
    if (force && age < JWKS_MIN_REFETCH_MS) return;
    this.inflight ??= (async () => {
      try {
        const r = await this.f(JWKS_URL, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error(`apple jwks ${r.status}`);
        const body = (await r.json()) as { keys?: Jwk[] };
        const next = new Map<string, KeyObject>();
        for (const k of body.keys ?? []) if (k.kid && k.kty === "RSA") next.set(k.kid, publicKeyFromJwk(k));
        if (next.size) {
          this.keys = next;
          this.fetchedAt = Date.now();
        }
      } finally {
        this.inflight = null;
      }
    })();
    await this.inflight;
  }

  /** Throws JwtError(reason) on any failure. `audience`: which client the token must be for. */
  async verifyIdentityToken(idToken: string, opts: { audience: string; rawNonce: string; nowSec?: number }): Promise<AppleIdentity> {
    await this.loadKeys(false);
    const run = () => verifyRs256(idToken, (kid) => this.keys.get(kid) ?? null, { iss: APPLE_ISSUER, aud: [opts.audience], nowSec: opts.nowSec });
    let claims;
    try {
      claims = run();
    } catch (e) {
      if (!(e instanceof JwtError) || e.reason !== "unknown_kid") throw e;
      await this.loadKeys(true); // Apple rotated keys
      claims = run();
    }
    if (!nonceMatches(claims.nonce, opts.rawNonce)) throw new JwtError("bad_nonce");
    return {
      sub: claims.sub!,
      email: typeof claims.email === "string" ? claims.email : null,
      emailVerified: claims.email_verified === true || claims.email_verified === "true",
      aud: opts.audience,
    };
  }

  clientSecret(clientId: string, nowSec = Math.floor(Date.now() / 1000)): string {
    if (!this.canExchange) throw new Error("apple key not configured");
    return signEs256({ iss: this.cfg.teamId!, iat: nowSec, exp: nowSec + 300, aud: APPLE_ISSUER, sub: clientId }, this.cfg.privateKey!, this.cfg.keyId!);
  }

  /** authorization_code → tokens. null on Apple refusal (bad/used/expired code). */
  async exchangeCode(code: string, clientId: string, redirectUri?: string): Promise<AppleTokens | null> {
    const body = new URLSearchParams({ client_id: clientId, client_secret: this.clientSecret(clientId), code, grant_type: "authorization_code" });
    if (redirectUri) body.set("redirect_uri", redirectUri);
    const r = await this.f(`${APPLE_ISSUER}/auth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const t = (await r.json()) as { id_token?: unknown; refresh_token?: unknown };
    if (typeof t.id_token !== "string") return null;
    return { idToken: t.id_token, refreshToken: typeof t.refresh_token === "string" ? t.refresh_token : null };
  }

  /**
   * Unlinks the Apple ID from the app (required when offering account deletion;
   * otherwise Apple keeps the app authorized and withholds the email next time).
   * Never throws: deletion must not be blocked by Apple. Returns Apple's status or null.
   */
  async revoke(refreshToken: string, clientId: string): Promise<number | null> {
    if (!this.canExchange) return null;
    try {
      const body = new URLSearchParams({ client_id: clientId, client_secret: this.clientSecret(clientId), token: refreshToken, token_type_hint: "refresh_token" });
      const r = await this.f(`${APPLE_ISSUER}/auth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(10_000) });
      return r.status;
    } catch {
      return null;
    }
  }

  authorizeUrl(o: { redirectUri: string; state: string; nonceHash: string }): string {
    const q = new URLSearchParams({
      response_type: "code id_token",
      response_mode: "form_post",
      client_id: this.cfg.servicesId,
      redirect_uri: o.redirectUri,
      scope: "name email",
      state: o.state,
      nonce: o.nonceHash,
    });
    return `${APPLE_ISSUER}/auth/authorize?${q.toString().replace(/\+/g, "%20")}`;
  }
}
