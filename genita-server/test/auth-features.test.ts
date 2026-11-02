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
    let json: Record<string, any> | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {} // image bytes
    return { status: r.status, json: json as Record<string, any> };
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

test("finds REST: JWT user gets 200 for their own cards and pictures only; X-Genita-User is ignored; erased on account delete", async (t) => {
  const { MemoryFindsStore, ownerKey } = await import("../src/finds/store.ts");
  const store = new MemoryFindsStore();
  const { call, signIn, shared } = await bootAccounts(t, (d) => {
    d.finds = { vendors: d.finds!.vendors, store, images: false, imageBase: "/v1/finds" };
  });
  const a = await signIn("001.finds.a");
  const b = await signIn("001.finds.b");
  const late = await signIn("001.finds.c", false);
  const card = (id: string, title: string) => ({ id, kind: "recipe", createdAt: "2026-11-02T00:00:00.000Z", eyebrow: "", title, subtitle: "", items: [], steps: [], options: [], why: [], ask: [], sources: [], how: [] }) as any;
  await store.put(ownerKey(a.userId), card("finda-0001", "A's card"));
  await store.putImage("finda-0001", "hero", Buffer.from([0xff, 0xd8, 0xff]));
  await store.put(ownerKey(b.userId), card("findb-0001", "B's card"));

  assert.equal((await call("GET", "/v1/finds")).status, 401);
  assert.equal((await call("GET", "/v1/finds", { token: late.token })).status, 403);
  const mine = await call("GET", "/v1/finds", { token: a.token });
  assert.equal(mine.status, 200, "a signed-in (JWT) user gets their Finds");
  assert.deepEqual(mine.json.finds.map((f: { id: string }) => f.id), ["finda-0001"]);
  // the old owner header can't reach someone else's cards with a JWT
  assert.deepEqual((await call("GET", "/v1/finds", { token: a.token, user: b.userId })).json.finds.map((f: { id: string }) => f.id), ["finda-0001"]);
  assert.equal((await call("GET", "/v1/finds/findb-0001", { token: a.token })).status, 404);
  assert.equal((await call("GET", "/v1/finds/finda-0001/images/hero", { token: b.token })).status, 404, "pictures only for the card's owner");
  assert.equal((await call("GET", "/v1/finds/finda-0001/images/hero", { token: a.token })).status, 200);
  // dev token: X-Genita-User names a dev user, mapped to its own account id (not a raw owner key)
  assert.deepEqual((await call("GET", "/v1/finds", { token: shared, user: a.userId })).json.finds, []);

  assert.equal((await call("DELETE", "/me", { token: a.token })).status, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(await store.list(ownerKey(a.userId)), [], "Finds erased with the account");
  assert.equal((await store.list(ownerKey(b.userId))).length, 1, "other users untouched");
});

test("DELETE /me: if memories can't be erased, the account stays (502) and a retry finishes the job", async (t) => {
  const repo = new InMemoryMemoryRepository();
  const memory = new MemoryService({ repository: repo, state: repo, extract: async () => [] });
  const { call, signIn } = await bootAccounts(t, (d) => {
    d.memory = memory;
  });
  const a = await signIn("001.apple.retry");
  await memory.remember(a.userId, "I like kimchi jjigae.", "episode", "s1");
  const realDelete = repo.delete.bind(repo);
  let fail = true;
  repo.delete = async (...args: Parameters<typeof repo.delete>) => {
    if (fail) throw new Error("storage offline");
    return realDelete(...args);
  };
  const first = await call("DELETE", "/me", { token: a.token });
  assert.equal(first.status, 502);
  assert.equal((await call("GET", "/me", { token: a.token })).status, 200, "account kept for a retry");
  fail = false;
  assert.equal((await call("DELETE", "/me", { token: a.token })).status, 200);
  assert.deepEqual(await memory.list(a.userId), []);
});

test("/v1/watch: only the user who owns the call can share into it; others get 404, no token closes 4401", async (t) => {
  const { base, signIn } = await bootAccounts(t);
  const { WebSocket } = await import("ws");
  const a = await signIn("001.watch.a");
  const b = await signIn("001.watch.b");
  const wsBase = base.replace("http", "ws");
  const call = new WebSocket(`${wsBase}/v1/session`, { headers: { authorization: `Bearer ${a.token}` } });
  const sessionId = await new Promise<string>((resolve, reject) => {
    call.on("open", () => call.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false })));
    call.on("message", (d, bin) => {
      if (bin) return;
      const m = JSON.parse(String(d));
      if (m.type === "ready") resolve(m.sessionId);
    });
    call.on("error", reject);
  });
  const tryWatch = (token?: string) =>
    new Promise<{ status?: number; opened?: boolean; close?: number }>((resolve) => {
      let opened = false;
      const ws = new WebSocket(`${wsBase}/v1/watch?session=${sessionId}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
      ws.on("unexpected-response", (_q, res) => { res.resume(); resolve({ status: res.statusCode }); });
      ws.on("open", () => { opened = true; setTimeout(() => ws.close(1000), 100); });
      ws.on("close", (c) => resolve({ opened, close: c }));
      ws.on("error", () => {});
    });
  assert.deepEqual(await tryWatch(b.token), { status: 404 }, "another user's call looks missing");
  assert.equal((await tryWatch()).close, 4401, "no token: upgrade, then 4401 like the call socket");
  assert.deepEqual(await tryWatch(a.token), { opened: true, close: 1000 }, "the owner shares into their own call (we close it)");
  call.terminate();
});
