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
 *   GENITA_TRUST_PROXY    "1" = rate-limit by X-Forwarded-For (behind a proxy/load balancer)
 *   APPLE_*               see auth/apple.ts · GENITA_S3_* see storage/blob.ts
 */
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../db/index.ts";
import { migrateUp } from "../db/migrate.ts";
import { blobStoreFromEnv, type BlobStore } from "../storage/blob.ts";
import { PgPrepStore } from "../prep/pgStore.ts";
import { AppleAuth, appleConfigFromEnv } from "./apple.ts";
import { Accounts, DEVICES, type Device } from "./accounts.ts";
import { JwtError, looksLikeJwt, signHs256, verifyHs256 } from "./jwt.ts";
import { createAccountRoutes, type AccountRoutes } from "./routes.ts";

export const SESSION_ISSUER = "genita";

export type Principal = {
  userId: string;
  /** auth_sessions id; null for the shared-token dev fallback */
  sid: string | null;
  device: Device;
  consented: boolean;
  kind: "user" | "dev";
};

type Log = (event: string, data: Record<string, unknown>) => void;

export type AccountsCore = {
  db: Db;
  accounts: Accounts;
  blobs: BlobStore;
  apple: AppleAuth;
  jwtSecret: string;
  callbackUrl: string;
  trustProxy: boolean;
  authRatePerMin: number;
  log: Log;
  signSession(userId: string, sid: string, device: Device, expiresAt: Date): string;
  onUserDeleted?: (userId: string) => void;
  /** Drops baked Peter avatar caches on the GPU box (best effort; the S3 copy is deleted by DELETE /me itself). */
  forgetAvatars?: (companionIds: string[]) => Promise<void>;
};

export type AccountsService = AccountsCore & {
  routes: AccountRoutes;
  prepStore: PgPrepStore;
  /** Bearer token → principal. Throws JwtError for a JWT-shaped token that fails; null for a non-JWT token. */
  verifyToken(token: string): Promise<Principal | null>;
  close(): Promise<void>;
};

export type AccountsOptions = { loopback: boolean; db?: Db; blobs?: BlobStore; apple?: AppleAuth };

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
  const publicUrl = (env.GENITA_PUBLIC_URL || "https://genita-api.thebeni.ai").replace(/\/+$/, "");

  const core: AccountsCore = {
    db,
    accounts,
    blobs,
    apple,
    jwtSecret,
    callbackUrl: `${publicUrl}/auth/apple/callback`,
    trustProxy: env.GENITA_TRUST_PROXY === "1",
    authRatePerMin: Number(env.GENITA_AUTH_RATE_PER_MIN) || 30,
    log,
    forgetAvatars: peterForgetter(env, log),
    signSession: (userId, sid, device, expiresAt) =>
      signHs256({ iss: SESSION_ISSUER, sub: userId, sid, dev: device, iat: Math.floor(Date.now() / 1000), exp: Math.floor(expiresAt.getTime() / 1000) }, jwtSecret),
  };

  log("accounts.ready", { db: db.kind, blobs: blobs.kind, apple_key: apple.canExchange ? "set" : "unset" });

  return Object.assign(core, {
    routes: createAccountRoutes(core),
    prepStore: new PgPrepStore(db, blobs),
    async verifyToken(token: string): Promise<Principal | null> {
      if (!looksLikeJwt(token)) return null;
      const c = verifyHs256(token, jwtSecret, { iss: SESSION_ISSUER });
      if (typeof c.sub !== "string" || typeof c.sid !== "string") throw new JwtError("bad_claims");
      const s = await accounts.sessionUser(c.sid, c.sub);
      if (!s) throw new JwtError("session_revoked");
      return { userId: s.user.id, sid: c.sid, device: DEVICES.includes(s.device) ? s.device : "dev", consented: !!s.user.aiConsentAt, kind: "user" };
    },
    close: () => db.close(),
  });
}

/**
 * DELETE {GENITA_PETER_PREPARE_URL}/avatars/<id> (deploy/aws/peter/prep_api.py): local cache + tombstone so a
 * running bake never republishes. Throws when the GPU box can't confirm, so DELETE /me keeps the rows and the
 * user can retry (same rule as blob storage). Unset URL (Peter not deployed) = nothing to forget.
 */
function peterForgetter(env: NodeJS.ProcessEnv, log: Log): AccountsCore["forgetAvatars"] {
  const url = (env.GENITA_PETER_PREPARE_URL || "").replace(/\/+$/, "");
  const token = env.GENITA_PETER_TOKEN || env.GENITA_PETER_WORKER_TOKEN || "";
  if (!url) return undefined;
  return async (ids) => {
    for (const id of ids) {
      let status = 0;
      try {
        const r = await fetch(`${url}/avatars/${encodeURIComponent(id)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
        status = r.status;
      } catch (e) {
        log("account.avatar_forget_failed", { message: String(e).slice(0, 120) });
      }
      if (status !== 200 && status !== 404) {
        if (status) log("account.avatar_forget_failed", { status });
        throw new Error("avatar_forget_failed");
      }
    }
  };
}
