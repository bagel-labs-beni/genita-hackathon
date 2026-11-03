/**
 * RP-1 (D37): POST /me/report — session only, four reasons, short note, per-user limit,
 * stored in the caller's own blob prefix (erased with the account).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { startServer, defaultDeps } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { fakeApple } from "./helpers/fakeApple.ts";
import { testDb } from "./helpers/db.ts";
import { createAccounts } from "../src/auth/index.ts";

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));

test("RP-1 report: stored for the signed-in user, validated, rate limited, erased with the account", async (t) => {
  const apple = fakeApple();
  const realFetch = globalThis.fetch;
  globalThis.fetch = apple.fetch;
  const dir = mkdtempSync(join(tmpdir(), "genita-report-"));
  const env: NodeJS.ProcessEnv = { GENITA_DATA_DIR: dir, GENITA_JWT_SECRET: "j".repeat(40), GENITA_PUBLIC_URL: "https://genita-api.example", GENITA_AUTH_RATE_PER_MIN: "1000", ...apple.env };
  const config = { ...loadConfig({ MODEL_API_KEY: "m" }), port: 0, sessionToken: "shared-dev-token-0123456789" };
  const logs: Array<[string, Record<string, unknown>]> = [];
  const log = (e: string, d: Record<string, unknown> = {}) => { logs.push([e, d]); };
  const accounts = (await createAccounts(env, log, { loopback: true, db: await testDb(false) }))!;
  const server = await startServer(config, log, defaultDeps(config, log), env, accounts);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    globalThis.fetch = realFetch;
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, o: { token?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const r = await realFetch(base + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text();
    return { status: r.status, json: (text ? JSON.parse(text) : null) as Record<string, any> };
  };
  const nonce = randomBytes(16).toString("hex");
  const s = await call("POST", "/auth/apple", { body: { identityToken: apple.idToken({ sub: "001.apple.rp", aud: "ai.thebeni.genita", nonce: apple.nonceHash(nonce) }), nonce } });
  assert.equal(s.status, 200);
  const token = s.json.token as string;
  const userId = s.json.user.id as string;

  assert.equal((await call("POST", "/me/report", { body: { reason: "other" } })).status, 401, "no session, no report");
  assert.equal((await call("POST", "/me/report", { token, body: { reason: "spam" } })).status, 400, "unknown reason");

  const ok = await call("POST", "/v1/me/report".replace("/v1", ""), { token, body: { reason: "harmful_answer", note: "said something\u0000 mean " + "x".repeat(400), surface: "call", utteranceId: 12, text: "The reply text" } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, message: "Thanks, noted" });
  const stored = files(dir).filter((f) => f.includes(`users/${userId}/reports/`) || f.includes(`users${"/"}${userId}${"/"}reports`));
  assert.equal(stored.length, 1, files(dir).join("\n"));
  const rec = JSON.parse(readFileSync(stored[0], "utf8"));
  assert.equal(rec.reason, "harmful_answer");
  assert.equal(rec.surface, "call");
  assert.equal(rec.utteranceId, 12);
  assert.equal(rec.note.length, 280, "note capped");
  assert.ok(!rec.note.includes("\u0000"), "control characters dropped");
  const line = logs.find(([e]) => e === "report.received")![1];
  assert.deepEqual(Object.keys(line).sort(), ["device", "note", "reason", "surface"], "the log never carries the note or text");

  for (let i = 0; i < 9; i++) assert.equal((await call("POST", "/me/report", { token, body: { reason: "other" } })).status, 200);
  assert.equal((await call("POST", "/me/report", { token, body: { reason: "other" } })).status, 429, "10 per hour");

  assert.equal((await call("DELETE", "/me", { token })).status, 200);
  assert.equal(files(dir).filter((f) => f.includes("reports")).length, 0, "erased with the account");
});
