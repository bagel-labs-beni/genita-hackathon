/**
 * Auth unification (11/2): every feature route and socket uses the accounts principal
 * (session JWT or the dev token), the consent gate, and is erased with the account.
 * Real server (startServer) + PGlite + fake Apple, like auth.test.ts.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { startServer, defaultDeps } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { fakeApple } from "./helpers/fakeApple.ts";
import { testDb } from "./helpers/db.ts";
import { createAccounts } from "../src/auth/index.ts";
import type { SessionDeps } from "../src/session/session.ts";
import { InMemoryMemoryRepository } from "../src/memory/repository.ts";
import { MemoryService } from "../src/memory/service.ts";

const SHARED = "shared-dev-token-0123456789";

export async function bootAccounts(t: TestContext, patch: (deps: SessionDeps) => void = () => {}) {
  const apple = fakeApple();
  const realFetch = globalThis.fetch;
  globalThis.fetch = apple.fetch;
  const dir = mkdtempSync(join(tmpdir(), "genita-authf-"));
  const env: NodeJS.ProcessEnv = { GENITA_DATA_DIR: dir, GENITA_JWT_SECRET: "j".repeat(40), GENITA_PUBLIC_URL: "https://genita-api.example", GENITA_AUTH_RATE_PER_MIN: "1000", ...apple.env };
  const config = { ...loadConfig({ MODEL_API_KEY: "m", ELEVENLABS_API_KEY: "e" }), port: 0, sessionToken: SHARED };
  const log = () => {};
  const accounts = (await createAccounts(env, log, { loopback: true, db: await testDb(false) }))!;
  const deps = defaultDeps(config, log);
  patch(deps);
  const server = await startServer(config, log, deps, env, accounts);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    globalThis.fetch = realFetch;
    await new Promise((r) => server.close(r));
    await new Promise((r) => setTimeout(r, 50));
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, o: { token?: string; body?: unknown; user?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.user) headers["x-genita-user"] = o.user;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const r = await realFetch(base + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text();
    return { status: r.status, json: (text ? JSON.parse(text) : null) as Record<string, any> };
  };
  /** Apple sign-in for a new Apple sub; consent unless told otherwise. */
  const signIn = async (sub: string, consent = true) => {
    const nonce = randomBytes(16).toString("hex");
    const r = await call("POST", "/auth/apple", { body: { identityToken: apple.idToken({ sub, aud: "ai.thebeni.genita", nonce: apple.nonceHash(nonce) }), nonce } });
    assert.equal(r.status, 200);
    if (consent) assert.equal((await call("POST", "/me/consent", { token: r.json.token, body: {} })).status, 200);
    return { token: r.json.token as string, userId: r.json.user.id as string };
  };
  return { base, call, signIn, deps, shared: SHARED };
}

test("memory REST: JWT user gets 200 (own memories only), 403 before consent, erased on account delete", async (t) => {
  const repo = new InMemoryMemoryRepository();
  const memory = new MemoryService({ repository: repo, state: repo, extract: async () => [] });
  const { call, signIn } = await bootAccounts(t, (d) => {
    d.memory = memory;
  });
  const a = await signIn("001.apple.a");
  const b = await signIn("001.apple.b");
  const late = await signIn("001.apple.c", false);
  await memory.remember(a.userId, "I like kimchi jjigae.", "episode", "s1");
  await memory.remember(b.userId, "B's secret.", "episode", "s2");

  assert.equal((await call("GET", "/v1/memories")).status, 401);
  assert.equal((await call("GET", "/v1/memories", { token: late.token })).status, 403);
  const mine = await call("GET", "/v1/memories", { token: a.token });
  assert.equal(mine.status, 200);
  assert.match(JSON.stringify(mine.json), /kimchi/);
  assert.doesNotMatch(JSON.stringify(mine.json), /secret/, "never another user's memories");
  // a client-claimed user header does not change who a JWT is
  assert.doesNotMatch(JSON.stringify((await call("GET", "/v1/memories", { token: a.token, user: "x" })).json), /secret/);

  assert.equal((await call("DELETE", "/me", { token: a.token })).status, 200);
  await memory.drain();
  assert.deepEqual(await memory.list(a.userId), [], "memories erased with the account");
  assert.equal((await memory.list(b.userId)).length, 1, "other users untouched");
});
