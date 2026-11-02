/**
 * Email one-time-code sign-in: the code store (Postgres `email_codes`) and the mail senders.
 * Routes live in routes.ts (POST /auth/email/start, /auth/email/verify).
 *
 * Codes: 6 random digits (crypto.randomInt), stored only as HMAC-SHA256(server secret, email + code),
 * 10 minutes, 5 tries, single use, and only the newest code for an email works. Per email: one send
 * per 60 s and 5 per hour. Per-IP limits are in routes.ts.
 *
 * Env:
 *   RESEND_API_KEY     mail provider key (Resend HTTP API). Unset: loopback dev servers log the code
 *                      instead; a deployed server answers 503 email_unavailable.
 *   GENITA_MAIL_FROM   verified sender, e.g. "Genita <login@your-domain>". Required with the key.
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/index.ts";

export const CODE_TTL_SEC = 10 * 60;
export const RESEND_AFTER_SEC = 60;
export const MAX_SENDS_PER_HOUR = 5;
export const MAX_ATTEMPTS = 5;

type Log = (event: string, data: Record<string, unknown>) => void;

export type MailSender = { kind: string; send(to: string, code: string, minutes: number): Promise<void> };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** trimmed + lowercased, or null when it isn't an address we will mail. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  // no control characters anywhere (header/HTML safety), RFC 5321 length cap
  if (e.length > 254 || /[\u0000-\u001f\u007f]/.test(e) || !EMAIL_RE.test(e)) return null;
  return e;
}

/** "jo***@example.com" for logs */
export const maskEmail = (e: string) => e.replace(/^(.{0,2})[^@]*/, "$1***");

export type StartResult = { ok: true; id: string; code: string } | { ok: false; retryAfterSec: number };
export type CheckResult = "ok" | "invalid" | "too_many";

export class EmailCodes {
  private readonly key: Buffer;
  private readonly db: Db;
  constructor(db: Db, serverSecret: string) {
    this.db = db;
    // own key, derived from the session secret, so a code hash never doubles as a token signature
    this.key = createHmac("sha256", serverSecret).update("genita email code v1").digest();
  }

  private hash(email: string, code: string): Buffer {
    return createHmac("sha256", this.key).update(`${email}\n${code}`).digest();
  }

  /** New code for `email` unless the per-email cooldown or hourly cap says wait. Older live codes stop working. */
  async issue(email: string): Promise<StartResult> {
    const recent = await this.db.query(
      `SELECT EXTRACT(EPOCH FROM (now() - created_at))::float8 AS age FROM email_codes
       WHERE email = $1 AND created_at > now() - interval '1 hour' ORDER BY created_at DESC LIMIT ${MAX_SENDS_PER_HOUR}`,
      [email],
    );
    const ages = recent.rows.map((r) => Number(r.age));
    if (ages.length && ages[0] < RESEND_AFTER_SEC) return { ok: false, retryAfterSec: Math.max(1, Math.ceil(RESEND_AFTER_SEC - ages[0])) };
    if (ages.length >= MAX_SENDS_PER_HOUR) return { ok: false, retryAfterSec: Math.max(1, Math.ceil(3600 - ages[ages.length - 1])) };

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const id = await this.db.tx(async (q) => {
      await q.query("UPDATE email_codes SET consumed_at = now() WHERE email = $1 AND consumed_at IS NULL", [email]);
      await q.query("DELETE FROM email_codes WHERE created_at < now() - interval '1 day'");
      const r = await q.query(`INSERT INTO email_codes (email, code_hash, expires_at) VALUES ($1, $2, now() + interval '${CODE_TTL_SEC} seconds') RETURNING id`, [
        email,
        this.hash(email, code).toString("hex"),
      ]);
      return String(r.rows[0].id);
    });
    return { ok: true, id, code };
  }

  /** The mail never left: forget the row so the user can ask again right away. */
  async discard(id: string) {
    await this.db.query("DELETE FROM email_codes WHERE id = $1", [id]);
  }

  /**
   * Checks `code` against the newest live code for `email`. The try is counted before the compare
   * (atomic, so parallel guesses can't exceed MAX_ATTEMPTS); a match consumes the code exactly once.
   */
  async check(email: string, code: string): Promise<CheckResult> {
    const live = await this.db.query(
      "SELECT id FROM email_codes WHERE email = $1 AND consumed_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
      [email],
    );
    // the newest code may have been burned by tries: say so instead of "invalid"
    if (!live.rows[0]) {
      const burned = await this.db.query(
        `SELECT 1 FROM email_codes WHERE email = $1 AND expires_at > now() AND attempts >= ${MAX_ATTEMPTS}
         AND created_at = (SELECT max(created_at) FROM email_codes WHERE email = $1)`,
        [email],
      );
      return burned.rows.length ? "too_many" : "invalid";
    }
    const id = live.rows[0].id;
    const tried = await this.db.query(
      `UPDATE email_codes SET attempts = attempts + 1 WHERE id = $1 AND consumed_at IS NULL AND attempts < ${MAX_ATTEMPTS} RETURNING attempts, code_hash`,
      [id],
    );
    if (!tried.rows[0]) return "too_many";
    const want = Buffer.from(String(tried.rows[0].code_hash), "hex");
    const got = this.hash(email, code);
    if (want.length === got.length && timingSafeEqual(want, got)) {
      const used = await this.db.query("UPDATE email_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL", [id]);
      return used.rowCount === 1 ? "ok" : "invalid";
    }
    if (Number(tried.rows[0].attempts) >= MAX_ATTEMPTS) {
      await this.db.query("UPDATE email_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL", [id]);
      return "too_many";
    }
    return "invalid";
  }
}

const subject = (code: string) => `${code} is your Genita sign-in code`;
const text = (code: string, minutes: number) =>
  `Your Genita sign-in code is ${code}.\n\nEnter it in the app. It expires in ${minutes} minutes. If you didn't ask for it, you can ignore this email.`;
// digits only go in here (the code), so no escaping is needed
const html = (code: string, minutes: number) => `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:420px;margin:0 auto;padding:32px 24px;color:#111">
<p style="margin:0 0 8px;font-size:15px;color:#6b6b6b">Your Genita sign-in code</p>
<p style="margin:0 0 24px;font-size:40px;font-weight:700;letter-spacing:8px">${code}</p>
<p style="margin:0;font-size:14px;line-height:20px;color:#6b6b6b">Enter it in the app. It expires in ${minutes} minutes.</p>
<p style="margin:24px 0 0;font-size:13px;line-height:18px;color:#9b9b9b">If you didn't ask for it, you can ignore this email.</p>
</div>`;

/**
 * Which sender this server uses. Resend when RESEND_API_KEY + GENITA_MAIL_FROM are set. Otherwise a
 * log-only sender, but only on a loopback dev server outside NODE_ENV=production (the code then appears
 * in the server log, for simulator / local runs). Anything else: null → start answers 503.
 */
export function mailSenderFromEnv(env: NodeJS.ProcessEnv, log: Log, o: { loopback: boolean }, fetchImpl: typeof fetch = fetch): MailSender | null {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.GENITA_MAIL_FROM?.trim();
  if (key && from) {
    return {
      kind: "resend",
      async send(to, code, minutes) {
        const r = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ from, to: [to], subject: subject(code), text: text(code, minutes), html: html(code, minutes) }),
          signal: AbortSignal.timeout(10_000),
        });
        // status only: the provider's body can echo the address
        if (!r.ok) throw new Error(`resend_${r.status}`);
      },
    };
  }
  if (key && !from) log("auth.email_misconfigured", { reason: "GENITA_MAIL_FROM unset" });
  if (o.loopback && env.NODE_ENV !== "production") {
    return {
      kind: "log",
      async send(to, code) {
        log("auth.email_code_dev", { to: maskEmail(to), code });
      },
    };
  }
  return null;
}
