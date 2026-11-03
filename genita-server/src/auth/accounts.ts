/**
 * Accounts repository (users, consents, login sessions, one-time codes).
 * Pure SQL over the Db interface so it runs on pg and PGlite alike.
 */
import { createHash, randomBytes } from "node:crypto";
import { iso, type Db, type Queryable } from "../db/index.ts";

export type Provider = "apple" | "google" | "dev" | "email";
export type Device = "iphone" | "mac" | "web" | "dev";
export const DEVICES: Device[] = ["iphone", "mac", "web", "dev"];
export const SESSION_DAYS = 30;

export type User = {
  id: string;
  provider: Provider;
  providerSub: string;
  email: string | null;
  displayName: string | null;
  aiConsentAt: string | null;
  createdAt: string;
};

const toUser = (r: Record<string, any>): User => ({
  id: r.id,
  provider: r.provider,
  providerSub: r.provider_sub,
  email: r.email ?? null,
  displayName: r.display_name ?? null,
  aiConsentAt: iso(r.ai_consent_at),
  createdAt: iso(r.created_at)!,
});

const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");

/**
 * QA test photos (11/4): `GENITA_QA_SAMPLE_PHOTOS` = comma list of account ids and/or email addresses.
 * A listed account's `/me` carries `qaSamplePhotos: true` and the iPhone app shows "Use a test photo" on V01
 * (bundled sample pictures, so device QA never opens a real photo library). An email entry only matches an
 * address the provider verified, and never a `dev` (judge / shared-token) row. Unset = off for everyone,
 * and `/me` never has the key unless it is true (normal accounts see exactly what they saw before).
 */
export function parseQaList(raw: string | undefined): { ids: Set<string>; emails: Set<string> } {
  const ids = new Set<string>();
  const emails = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const s = part.trim();
    if (!s || s.length > 254) continue;
    if (s.includes("@")) emails.add(s.toLowerCase());
    else ids.add(s);
  }
  return { ids, emails };
}

export class Accounts {
  readonly db: Db;
  private readonly qa: { ids: Set<string>; emails: Set<string> };
  constructor(db: Db, opts: { qaSamplePhotos?: string } = {}) {
    this.db = db;
    this.qa = parseQaList(opts.qaSamplePhotos);
  }

  /** QA test photos on V01 (see parseQaList). Judges and every unlisted account: false. */
  async qaSamplePhotos(user: User): Promise<boolean> {
    if (this.qa.ids.has(user.id)) return true;
    if (!this.qa.emails.size || !user.email || user.provider === "dev" || !this.qa.emails.has(user.email.toLowerCase())) return false;
    const r = await this.db.query("SELECT email_verified FROM users WHERE id = $1", [user.id]);
    return r.rows[0]?.email_verified === true;
  }

  /**
   * Insert or find by (provider, sub). Email refreshes when given, together with whether the provider
   * verified it (only a verified address can be reached by email sign-in); the display name only fills a
   * blank (Apple sends it once).
   */
  async upsertUser(p: { provider: Provider; sub: string; email?: string | null; emailVerified?: boolean; displayName?: string | null }): Promise<{ user: User; isNew: boolean }> {
    const name = p.displayName?.trim().slice(0, 40) || null;
    const r = await this.db.query(
      `INSERT INTO users (provider, provider_sub, email, email_verified, display_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, provider_sub) DO UPDATE
         SET email = COALESCE(EXCLUDED.email, users.email),
             email_verified = CASE WHEN EXCLUDED.email IS NULL THEN users.email_verified ELSE EXCLUDED.email_verified END,
             display_name = COALESCE(NULLIF(users.display_name, ''), EXCLUDED.display_name),
             updated_at = now()
       RETURNING *, (xmax = 0) AS inserted`,
      [p.provider, p.sub, p.email ?? null, !!p.email && p.emailVerified === true, name],
    );
    return { user: toUser(r.rows[0]), isNew: r.rows[0].inserted === true };
  }

  /**
   * Email code sign-in: the account an earlier email sign-in made for this address, else the oldest
   * account whose provider verified it (Apple with email_verified), else a new 'email' account.
   * Dev/judge rows never match.
   */
  async userForVerifiedEmail(email: string): Promise<{ user: User; isNew: boolean }> {
    // an email account made for this address wins over any later-verified one, so the address never switches accounts
    const r = await this.db.query(
      "SELECT * FROM users WHERE lower(email) = $1 AND email_verified AND provider <> 'dev' ORDER BY (provider = 'email') DESC, created_at, id LIMIT 1",
      [email],
    );
    if (r.rows[0]) return { user: toUser(r.rows[0]), isNew: false };
    return this.upsertUser({ provider: "email", sub: email, email, emailVerified: true });
  }

  async getUser(id: string, q: Queryable = this.db): Promise<User | null> {
    const r = await q.query("SELECT * FROM users WHERE id = $1", [id]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  /** Lookup only (never creates): e.g. the reserved demo template account (provider dev, sub demo:template). */
  async findUserId(provider: Provider, sub: string): Promise<string | null> {
    const r = await this.db.query("SELECT id FROM users WHERE provider = $1 AND provider_sub = $2", [provider, sub]);
    return r.rows[0] ? String(r.rows[0].id) : null;
  }

  /** Dev fallback (shared GENITA_SESSION_TOKEN): a stable users row per x-genita-user name. */
  async devUserId(name: string): Promise<string> {
    return (await this.upsertUser({ provider: "dev", sub: name, displayName: name })).user.id;
  }

  async setAppleRefreshToken(userId: string, token: string, clientId: string) {
    await this.db.query("UPDATE users SET apple_refresh_token = $2, apple_client_id = $3, updated_at = now() WHERE id = $1", [userId, token, clientId]);
  }

  async appleLink(userId: string): Promise<{ token: string; clientId: string } | null> {
    const r = await this.db.query("SELECT apple_refresh_token, apple_client_id FROM users WHERE id = $1", [userId]);
    const row = r.rows[0];
    return row?.apple_refresh_token && row.apple_client_id ? { token: row.apple_refresh_token, clientId: row.apple_client_id } : null;
  }

  async setDisplayName(userId: string, name: string): Promise<User | null> {
    const r = await this.db.query("UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1 RETURNING *", [userId, name]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  async consent(userId: string, kind: "ai_data" | "photo_rights" | "seen_memory", version: string, device: Device | null): Promise<User | null> {
    return this.db.tx(async (q) => {
      await q.query("INSERT INTO consents (user_id, kind, version, device) VALUES ($1, $2, $3, $4)", [userId, kind, version, device]);
      if (kind === "ai_data") await q.query("UPDATE users SET ai_consent_at = COALESCE(ai_consent_at, now()), updated_at = now() WHERE id = $1", [userId]);
      return this.getUser(userId, q);
    });
  }

  // ───────── login sessions ─────────

  async createSession(userId: string, device: Device): Promise<{ sid: string; expiresAt: Date }> {
    const r = await this.db.query(`INSERT INTO auth_sessions (user_id, device, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days') RETURNING id, expires_at`, [userId, device]);
    return { sid: r.rows[0].id, expiresAt: new Date(r.rows[0].expires_at) };
  }

  /** Live session → user + consent flag; null when revoked, expired, or the user is gone. */
  async sessionUser(sid: string, userId: string): Promise<{ user: User; device: Device } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(sid) || !/^[0-9a-f-]{36}$/i.test(userId)) return null;
    const r = await this.db.query(
      `SELECT u.*, s.device AS session_device FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [sid, userId],
    );
    return r.rows[0] ? { user: toUser(r.rows[0]), device: r.rows[0].session_device } : null;
  }

  async revokeSession(sid: string) {
    await this.db.query("UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [sid]);
  }

  // ───────── Mac one-time codes (60 s) ─────────

  async createCode(userId: string, device: Device, challenge: string, isNew: boolean): Promise<string> {
    const code = randomBytes(32).toString("base64url");
    await this.db.query("INSERT INTO auth_codes (code_hash, user_id, device, code_challenge, is_new, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '60 seconds')", [hashCode(code), userId, device, challenge, isNew]);
    return code;
  }

  /** Marks the code used (once) and returns it; null if unknown, used, or expired. */
  async takeCode(code: string): Promise<{ userId: string; device: Device; challenge: string; isNew: boolean } | null> {
    const r = await this.db.query(
      "UPDATE auth_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id, device, code_challenge, is_new",
      [hashCode(code)],
    );
    const row = r.rows[0];
    return row ? { userId: row.user_id, device: row.device, challenge: row.code_challenge, isNew: row.is_new } : null;
  }

  // ───────── /me view ─────────

  async meView(userId: string) {
    const user = await this.getUser(userId);
    if (!user) return null;
    const c = await this.db.query("SELECT prep_status, demo FROM companions WHERE user_id = $1", [userId]);
    const conv = await this.db.query("SELECT active_device, epoch FROM conversations WHERE user_id = $1 ORDER BY last_active_at DESC LIMIT 1", [userId]);
    return {
      user: { id: user.id, provider: user.provider, email: user.email, displayName: user.displayName, aiConsentAt: user.aiConsentAt, createdAt: user.createdAt },
      consented: !!user.aiConsentAt,
      hasCompanion: c.rows.length > 0,
      prepStatus: (c.rows[0]?.prep_status ?? "none") as "none" | "running" | "ready" | "failed",
      /** D41: the companion is the ready-made judge demo (app shows a small "Demo companion" label) */
      companionDemo: c.rows[0]?.demo === true,
      conversation: conv.rows[0] ? { activeDevice: conv.rows[0].active_device ?? null, epoch: Number(conv.rows[0].epoch) } : null,
      /** QA test photos on V01 (GENITA_QA_SAMPLE_PHOTOS); the key is only there when true */
      ...((await this.qaSamplePhotos(user)) ? { qaSamplePhotos: true as const } : {}),
    };
  }

  /** Companion ids identify legacy assets in avatars/<id>/ blob storage. */
  async companionIds(userId: string): Promise<string[]> {
    return (await this.db.query("SELECT id FROM companions WHERE user_id = $1", [userId])).rows.map((r) => String(r.id));
  }

  /** Deletes the user row; ON DELETE CASCADE clears every user-owned table. */
  async deleteUser(userId: string): Promise<boolean> {
    return (await this.db.query("DELETE FROM users WHERE id = $1", [userId])).rowCount > 0;
  }
}
