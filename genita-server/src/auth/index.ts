/**
 * Accounts wiring. server.ts calls createAccounts(env) once; it returns null
 * when DATABASE_URL is unset (then the server keeps the old file store and the
 * shared-token dev mode only).
 *
 * Env:
 *   DATABASE_URL          postgres://… (deployed) | pglite:memory | pglite:<dir> (local, dev dep)
 *   GENITA_DB_MIGRATE     "0" skips migrate-on-boot (default: run pending migrations)
 *   GENITA_JWT_SECRET     HS256 secret for session tokens (≥32 chars). Unset on loopback = random per boot.
 *   GENITA_PUBLIC_URL     https://genita-api.thebeni.ai — Apple web callback base (Mac login)
 *   GENITA_JUDGE_CODES    label=code,… Judge access (auth/judge.ts)
 *   GENITA_JUDGE_DAILY_TURNS  user turns per UTC day per judge code (default 200, 0 = no cap)
 *   GENITA_TRUST_PROXY    "1" = rate-limit by X-Forwarded-For (behind a proxy/load balancer)
 *   APPLE_*               see auth/apple.ts · GENITA_S3_* see storage/blob.ts
 *   RESEND_API_KEY, GENITA_MAIL_FROM   email code sign-in, see auth/email.ts
 */
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../db/index.ts";
import { migrateUp } from "../db/migrate.ts";
import { blobStoreFromEnv, type BlobStore } from "../storage/blob.ts";
import { PgPrepStore } from "../prep/pgStore.ts";
import { AppleAuth, appleConfigFromEnv } from "./apple.ts";
import { EmailCodes, mailSenderFromEnv, type MailSender } from "./email.ts";
import { Accounts, DEVICES, type Device } from "./accounts.ts";
import { JwtError, looksLikeJwt, signHs256, verifyHs256 } from "./jwt.ts";
import { JudgeAccess, JudgeDailyTurns, judgeLabelOf } from "./judge.ts";
import { createAccountRoutes, type AccountRoutes } from "./routes.ts";

export const SESSION_ISSUER = "genita";

export type Principal = {
  userId: string;
  /** auth_sessions id; null for the shared-token dev fallback */
  sid: string | null;
  device: Device;
  consented: boolean;
  kind: "user" | "dev";
  /** D41: the Judge access code label when this is a judge demo account */
  judge?: string;
};

type Log = (event: string, data: Record<string, unknown>) => void;

export type AccountsCore = {
  db: Db;
  accounts: Accounts;
  blobs: BlobStore;
  apple: AppleAuth;
  /** email code sign-in; `mail` null = no sender configured (start answers 503) */
  emailCodes: EmailCodes;
  mail: MailSender | null;
  jwtSecret: string;
  callbackUrl: string;
  trustProxy: boolean;
  authRatePerMin: number;
  /** D41 Judge access codes (GENITA_JUDGE_CODES); disabled when none are set */
  judge: JudgeAccess;
  /** D41 per-code daily turn cap (GENITA_JUDGE_DAILY_TURNS) */
  judgeTurns: JudgeDailyTurns;
  log: Log;
  signSession(userId: string, sid: string, device: Device, expiresAt: Date): string;
  /** Awaited before any row is deleted: erase data kept outside Postgres (memory, Finds). Throwing keeps the account so the user can retry. */
  beforeUserDeleted?: (userId: string) => Promise<void>;
  onUserDeleted?: (userId: string) => void;
};

export type AccountsService = AccountsCore & {
  routes: AccountRoutes;
  prepStore: PgPrepStore;
  /** Bearer token → principal. Throws JwtError for a JWT-shaped token that fails; null for a non-JWT token. */
  verifyToken(token: string): Promise<Principal | null>;
  close(): Promise<void>;
};

export type AccountsOptions = { loopback: boolean; db?: Db; blobs?: BlobStore; apple?: AppleAuth; mail?: MailSender | null };

export async function createAccounts(env: NodeJS.ProcessEnv, log: Log, opts: AccountsOptions): Promise<AccountsService | null> {
  if (!env.DATABASE_URL && !opts.db) return null;
  let jwtSecret = env.GENITA_JWT_SECRET ?? "";
  if (jwtSecret.length < 32) {
    if (!opts.loopback) throw new Error("GENITA_JWT_SECRET (≥32 chars) is required when accounts are on and HOST is not loopback");
    jwtSecret = randomBytes(32).toString("hex");
    log("auth.jwt_secret", { source: "ephemeral" });
  }
  const db = opts.db ?? (await openDb(env.DATABASE_URL!));
  if (env.GENITA_DB_MIGRATE !== "0") {
    const ran = await migrateUp(db);
    if (ran.length) log("db.migrated", { ran });
  }
  const blobs = opts.blobs ?? blobStoreFromEnv(env, join(env.GENITA_DATA_DIR || join(homedir(), ".genita-data"), "blobs"));
  const apple = opts.apple ?? new AppleAuth(appleConfigFromEnv(env));
  const accounts = new Accounts(db);
  const mail = opts.mail !== undefined ? opts.mail : mailSenderFromEnv(env, log, { loopback: opts.loopback });
  const publicUrl = (env.GENITA_PUBLIC_URL || "https://genita-api.thebeni.ai").replace(/\/+$/, "");

  const core: AccountsCore = {
    db,
    accounts,
    blobs,
    apple,
    emailCodes: new EmailCodes(db, jwtSecret),
    mail,
    jwtSecret,
    callbackUrl: `${publicUrl}/auth/apple/callback`,
    trustProxy: env.GENITA_TRUST_PROXY === "1",
    authRatePerMin: Number(env.GENITA_AUTH_RATE_PER_MIN) || 30,
    judge: new JudgeAccess(env.GENITA_JUDGE_CODES),
    judgeTurns: JudgeDailyTurns.fromEnv(env.GENITA_JUDGE_DAILY_TURNS),
    log,
    signSession: (userId, sid, device, expiresAt) =>
      signHs256({ iss: SESSION_ISSUER, sub: userId, sid, dev: device, iat: Math.floor(Date.now() / 1000), exp: Math.floor(expiresAt.getTime() / 1000) }, jwtSecret),
  };

  log("accounts.ready", { db: db.kind, blobs: blobs.kind, apple_key: apple.canExchange ? "set" : "unset", email: mail?.kind ?? "off", judge_codes: core.judge.enabled ? "set" : "unset" });

  return Object.assign(core, {
    routes: createAccountRoutes(core),
    prepStore: new PgPrepStore(db, blobs),
    async verifyToken(token: string): Promise<Principal | null> {
      if (!looksLikeJwt(token)) return null;
      const c = verifyHs256(token, jwtSecret, { iss: SESSION_ISSUER });
      if (typeof c.sub !== "string" || typeof c.sid !== "string") throw new JwtError("bad_claims");
      const s = await accounts.sessionUser(c.sid, c.sub);
      if (!s) throw new JwtError("session_revoked");
      const judge = judgeLabelOf(s.user);
      return { userId: s.user.id, sid: c.sid, device: DEVICES.includes(s.device) ? s.device : "dev", consented: !!s.user.aiConsentAt, kind: "user", ...(judge ? { judge } : {}) };
    },
    close: () => db.close(),
  });
}
