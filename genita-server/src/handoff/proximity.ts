/**
 * Proximity handoff (PROTOCOL.md "Handoff" → proximity): bring the iPhone close to the Mac during a call and
 * the conversation moves by itself, no code and no tap.
 *
 *   iPhone (owner, in a live call)  → `proximity.arm`   → server issues a short token bound to this account,
 *                                                         this presence socket and the current owner epoch
 *   iPhone                           advertises the token over Bluetooth LE (local name), re-arms every 30 s
 *   Mac (same account)               sees the token held close (RSSI over the threshold for 0.5 s)
 *                                    → `proximity.seen {token}` → the server checks it and moves the conversation
 *
 * Threat line: callers are the user's own signed-in apps on /v1/presence (same JWT as /v1/session). A token only
 * counts for the account that issued it, so a stranger's iPhone nearby (or a stranger's Mac that hears this one)
 * can't move anything; a token is 40 random bits, lives 60 s, at most two per account, dies on any owner change, on
 * disarm and when its iPhone socket closes; a Mac may report at most one token per 200 ms; one proximity move per
 * account per 10 s. Exposed: nothing beyond the existing ownership events. Tokens are never logged.
 */
import { randomBytes } from "node:crypto";

/** Crockford base32 without I L O U, so a token survives being read aloud in a QA log too. */
export const CROCKFORD32 = "0123456789" + "ABCDEFGHJKMNPQRSTVWXYZ";
/** iOS gives a foreground advertiser 8 bytes of local name next to one 128-bit service UUID. */
export const TOKEN_LENGTH = 8;
export const TOKEN_TTL_MS = 60_000;
/** A re-arm sooner than this returns the current token (the app re-arms every 30 s). */
export const MIN_REISSUE_MS = 5_000;
export const COOLDOWN_MS = 10_000;
export const MIN_SEEN_INTERVAL_MS = 200;

export type ProximityReason =
  | "ok"
  | "unknown_token"
  | "expired"
  | "not_owner"
  | "not_in_call"
  | "phone_inactive"
  | "mac_inactive"
  | "cooldown"
  | "rate_limited";

/** 8 symbols × 5 bits from 5 random bytes. */
export function newToken(bytes: Buffer = randomBytes(5)): string {
  let bits = 0n;
  for (const b of bytes.subarray(0, 5)) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = TOKEN_LENGTH - 1; i >= 0; i--) out += CROCKFORD32[Number((bits >> BigInt(i * 5)) & 31n)];
  return out;
}

export function isToken(v: unknown): v is string {
  return typeof v === "string" && v.length === TOKEN_LENGTH && [...v].every((c) => CROCKFORD32.includes(c));
}

export type Issued = { token: string; expiresAt: number; issuedAt: number; epoch: number; armedBy: object };
type Book = { tokens: Issued[]; cooldownUntil: number; lastReportAt: number };

/** Per account: the live tokens and the cooldown. In memory, one process (same as the audio gate). */
export class ProximityBook {
  private users = new Map<string, Book>();
  private make: () => string;
  constructor(opts: { token?: () => string } = {}) {
    this.make = opts.token ?? (() => newToken());
  }

  private book(userId: string): Book {
    let b = this.users.get(userId);
    if (!b) this.users.set(userId, (b = { tokens: [], cooldownUntil: 0, lastReportAt: -Infinity }));
    return b;
  }

  /** A new token for this iPhone socket at this owner epoch (the previous one stays valid until it expires). */
  issue(userId: string, armedBy: object, epoch: number, now: number): Issued {
    const b = this.book(userId);
    b.tokens = b.tokens.filter((t) => t.expiresAt > now && t.armedBy === armedBy && t.epoch === epoch);
    const latest = b.tokens[b.tokens.length - 1];
    if (latest && now - latest.issuedAt < MIN_REISSUE_MS) return latest;
    const issued: Issued = { token: this.make(), issuedAt: now, expiresAt: now + TOKEN_TTL_MS, epoch, armedBy };
    b.tokens = [...b.tokens, issued].slice(-2);
    return issued;
  }

  /** Disarm, socket closed: that iPhone's tokens stop counting. Without `armedBy`: every token of the account. */
  revoke(userId: string, armedBy?: object): void {
    const b = this.users.get(userId);
    if (!b) return;
    b.tokens = armedBy ? b.tokens.filter((t) => t.armedBy !== armedBy) : [];
  }

  find(userId: string, token: string, now: number): Issued | "unknown_token" | "expired" {
    const t = this.users.get(userId)?.tokens.find((x) => x.token === token);
    if (!t) return "unknown_token";
    return t.expiresAt > now ? t : "expired";
  }

  /** One Mac report per account per MIN_SEEN_INTERVAL_MS, however many Mac sockets it opens. */
  reportAllowed(userId: string, now: number): boolean {
    const b = this.book(userId);
    if (now - b.lastReportAt < MIN_SEEN_INTERVAL_MS) return false;
    b.lastReportAt = now;
    return true;
  }

  /** This account's iPhone is advertising (a live token exists): the Mac scans only then. */
  armed(userId: string, now: number): boolean {
    return (this.users.get(userId)?.tokens ?? []).some((t) => t.expiresAt > now);
  }

  coolingDown(userId: string, now: number): boolean {
    return (this.users.get(userId)?.cooldownUntil ?? 0) > now;
  }

  /** A proximity move happened: no other for COOLDOWN_MS, and its tokens are spent. */
  spend(userId: string, now: number): void {
    const b = this.book(userId);
    b.cooldownUntil = now + COOLDOWN_MS;
    b.tokens = [];
  }

  forget(userId: string): void {
    this.users.delete(userId);
  }
}
