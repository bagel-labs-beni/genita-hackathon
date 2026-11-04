/**
 * Minimal JWT with node:crypto, algorithms pinned per use:
 *   HS256  Genita session tokens (GENITA_JWT_SECRET)
 *   RS256  Apple identity tokens (verified against Apple's JWKS)
 *   ES256  Apple client secret (signed with the SIWA .p8 key)
 * The `alg` header is checked against the expected one — never trusted.
 */
import { createHash, createHmac, createPublicKey, sign as cryptoSign, timingSafeEqual, verify as cryptoVerify, type JsonWebKey, type KeyObject } from "node:crypto";

export type Claims = Record<string, unknown> & { iss?: string; sub?: string; aud?: string | string[]; exp?: number; iat?: number; nonce?: string };

export class JwtError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
export const sha256B64url = (s: string) => createHash("sha256").update(s).digest("base64url");

export function decode(token: string): { header: Record<string, unknown>; claims: Claims; signingInput: string; sig: Buffer } {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) throw new JwtError("malformed");
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
      claims: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
      signingInput: `${parts[0]}.${parts[1]}`,
      sig: Buffer.from(parts[2], "base64url"),
    };
  } catch {
    throw new JwtError("malformed");
  }
}

export const looksLikeJwt = (t: string) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t);

export function checkTimes(c: Claims, nowSec: number, skewSec = 60) {
  if (typeof c.exp !== "number" || c.exp + skewSec < nowSec) throw new JwtError("expired");
  if (typeof c.iat === "number" && c.iat - skewSec > nowSec) throw new JwtError("issued_in_future");
}

// ───────── HS256 (session) ─────────

export function signHs256(claims: Claims, secret: string): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

export function verifyHs256(token: string, secret: string, opts: { iss: string; nowSec?: number }): Claims {
  const { header, claims, signingInput, sig } = decode(token);
  if (header.alg !== "HS256") throw new JwtError("bad_alg");
  const want = createHmac("sha256", secret).update(signingInput).digest();
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) throw new JwtError("bad_signature");
  if (claims.iss !== opts.iss) throw new JwtError("bad_issuer");
  checkTimes(claims, opts.nowSec ?? Math.floor(Date.now() / 1000), 0);
  return claims;
}

// ───────── RS256 (Apple identity token) ─────────

export type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

export function verifyRs256(token: string, keyFor: (kid: string) => KeyObject | null, opts: { iss: string; aud: string[]; nowSec?: number }): Claims {
  const { header, claims, signingInput, sig } = decode(token);
  if (header.alg !== "RS256") throw new JwtError("bad_alg");
  if (typeof header.kid !== "string") throw new JwtError("no_kid");
  const key = keyFor(header.kid);
  if (!key) throw new JwtError("unknown_kid");
  if (!cryptoVerify("RSA-SHA256", Buffer.from(signingInput), key, sig)) throw new JwtError("bad_signature");
  if (claims.iss !== opts.iss) throw new JwtError("bad_issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => typeof a === "string" && opts.aud.includes(a))) throw new JwtError("bad_audience");
  checkTimes(claims, opts.nowSec ?? Math.floor(Date.now() / 1000));
  if (typeof claims.sub !== "string" || !claims.sub) throw new JwtError("no_subject");
  return claims;
}

export const publicKeyFromJwk = (jwk: Jwk) => createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });

// ───────── ES256 (Apple client secret) ─────────

export function signEs256(claims: Claims, privateKeyPem: string, kid: string): string {
  const head = b64url(JSON.stringify({ alg: "ES256", kid }));
  const body = b64url(JSON.stringify(claims));
  const sig = cryptoSign("sha256", Buffer.from(`${head}.${body}`), { key: privateKeyPem, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${sig.toString("base64url")}`;
}
