/**
 * npm run accounts:e2e -- [image]
 *
 * One pass of the account + Postgres path against the real vendors (Spark, SAM,
 * Muse Image), in-process: server on a random port, DATABASE_URL=pglite:memory
 * (or $DATABASE_URL), blobs in a temp dir. Apple is not involved — a session is
 * minted directly for a fresh `dev` user, so this checks everything after sign-in:
 *   consent gate 403 → consent → import (Spark) → photo check (Spark + SAM) →
 *   voices → companion (Meta prep starts) →
 *   /me → DELETE /me → 0 rows, 0 blobs.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { startServer, defaultDeps } from "../src/server.ts";
import { createAccounts } from "../src/auth/index.ts";
import { fixturePath } from "./fixtures.ts";

const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const img = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? fixturePath("out", "img", "p1.jpg");

const dir = mkdtempSync(join(tmpdir(), "genita-accounts-e2e-"));
const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "pglite:memory", GENITA_DATA_DIR: dir, GENITA_JWT_SECRET: "e2e-".repeat(10) };
const config = { ...loadConfig(), port: 0, sessionToken: "e2e-shared-token-not-used" };
const log = () => {};
const accounts = (await createAccounts(env, log, { loopback: true }))!;
const server = await startServer(config, log, defaultDeps(config, log), env, accounts);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { user } = await accounts.accounts.upsertUser({ provider: "dev", sub: `e2e-${Date.now()}`, displayName: "E2E" });
const s = await accounts.accounts.createSession(user.id, "iphone");
const token = accounts.signSession(user.id, s.sid, "iphone", s.expiresAt);

const out: Record<string, unknown> = {};
async function call(method: string, path: string, body?: unknown, raw?: Buffer) {
  const t0 = performance.now();
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(raw ? { "content-type": "image/jpeg" } : body !== undefined ? { "content-type": "application/json" } : {}) },
    body: raw ? new Uint8Array(raw) : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await r.json().catch(() => null)) as Record<string, any> | null;
  return { status: r.status, json, ms: Math.round(performance.now() - t0) };
}

try {
  const gated = await call("POST", "/v1/import", { text: "x".repeat(400) });
  out.before_consent = gated.status;
  out.consent = (await call("POST", "/me/consent", {})).json?.consented;
  const sample = readFileSync(new URL("../evals/import/samples/chatgpt-synthetic-1.txt", import.meta.url), "utf8");
  const imp = await call("POST", "/v1/import", { text: sample });
  out.import = { status: imp.status, items: imp.json?.style?.itemCount, ms: imp.ms };
  const photo = await call("POST", "/v1/companion/image?rights=1", undefined, readFileSync(img));
  out.photo = { status: photo.status, passed: photo.json?.passed, type: photo.json?.type, headBox: !!photo.json?.headBox, ms: photo.ms };
  const voices = await call("GET", `/v1/companion/voices?imageId=${photo.json?.imageId}`);
  out.voices = { status: voices.status, n: voices.json?.voices?.length, ms: voices.ms };
  const comp = await call("POST", "/v1/companion", { imageId: photo.json?.imageId, voiceId: voices.json?.voices?.[0]?.id });
  out.companion = { status: comp.status, prep: comp.json?.prep?.status, error: comp.json?.error };
  const me = await call("GET", "/me");
  out.me = { hasCompanion: me.json?.hasCompanion, prepStatus: me.json?.prepStatus, consented: me.json?.consented };
  const rows = await accounts.db.query("SELECT (SELECT count(*) FROM user_styles WHERE user_id = $1)::int AS styles, (SELECT count(*) FROM companion_images WHERE user_id = $1)::int AS images, (SELECT count(*) FROM companions WHERE user_id = $1)::int AS companions", [user.id]);
  out.rows_before_delete = rows.rows[0];
  out.blobs_before_delete = (await accounts.blobs.list(`users/${user.id}/`)).length;
  await new Promise((r) => setTimeout(r, 1500)); // let the runner write its first step
  const del = await call("DELETE", "/me");
  out.delete = del.json;
  out.me_after = (await call("GET", "/me")).status;
  const left = await accounts.db.query("SELECT (SELECT count(*) FROM users WHERE id = $1)::int + (SELECT count(*) FROM user_styles WHERE user_id = $1)::int + (SELECT count(*) FROM companion_images WHERE user_id = $1)::int + (SELECT count(*) FROM companions WHERE user_id = $1)::int + (SELECT count(*) FROM clip_jobs WHERE user_id = $1)::int AS n", [user.id]);
  out.rows_after_delete = left.rows[0].n;
  out.blobs_after_delete = (await accounts.blobs.list(`users/${user.id}/`)).length;
  console.log(JSON.stringify(out, null, 1));
} finally {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 200); // the prep runner may still be polling a vendor
}
