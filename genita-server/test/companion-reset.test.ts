/** POST /v1/companion/reset (11/4): the companion goes, the account (login, consent, name, Knows-Me profile) stays. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createAccounts } from "../src/auth/index.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { interpretCheck } from "../src/prep/classify.ts";
import { skipStyleCard } from "../src/prep/importProfile.ts";
import { META_MEDIA } from "../src/prep/pipeline.ts";
import { newPrepState } from "../src/prep/runner.ts";
import { DEVICE_VOICES } from "../src/prep/voices.ts";
import { DEMO_TEMPLATE_SUB } from "../src/prep/demo.ts";
import { startServer } from "../src/server.ts";
import type { SessionDeps } from "../src/session/session.ts";
import type { BlobStore } from "../src/storage/blob.ts";
import { fakeMedia, fakePng } from "./helpers/fakeMedia.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function boot(t: TestContext, patch: (deps: SessionDeps) => void = () => {}) {
  const files = new Map<string, Buffer>();
  const hooks = { put: async (_key: string) => {}, beforeDelete: async (_prefix: string) => {} };
  const blobs: BlobStore = {
    kind: "fs",
    async put(key, bytes) { await hooks.put(key); files.set(key, bytes); },
    async get(key) { return files.get(key) ?? null; },
    async list(prefix) { return [...files.keys()].filter((key) => key.startsWith(prefix)); },
    async deletePrefix(prefix) {
      await hooks.beforeDelete(prefix);
      let count = 0;
      for (const key of files.keys()) if (key.startsWith(prefix)) { files.delete(key); count++; }
      return count;
    },
    signedUrl() { return null; },
  };
  const dir = mkdtempSync(join(tmpdir(), "genita-companion-reset-"));
  const env = { GENITA_DATA_DIR: dir, GENITA_JWT_SECRET: "j".repeat(40), GENITA_DEMO_TEMPLATE: "0", GENITA_FACE_TOPUP: "0", GENITA_FACE_REFLOW: "0" };
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const log = (event: string, data: Record<string, unknown>) => { logs.push({ event, data }); };
  const accounts = (await createAccounts(env, log, { loopback: true, db: await openDb("pglite:memory"), blobs, mail: null }))!;
  const config = { ...loadConfig({ MODEL_API_KEY: "fake" }), port: 0 };
  const deps: SessionDeps = {
    config,
    openAsr() { throw new Error("ASR forbidden in reset tests"); },
    async *spark() { throw new Error("Spark forbidden in reset tests"); },
    async *tts() {},
  };
  patch(deps);
  const server = await startServer(config, log, deps, env, accounts);
  t.after(async () => {
    await new Promise<void>((r, reject) => server.close((e) => e ? reject(e) : r()));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** a signed-in, consented account with a companion (photo + face files) and an imported profile */
  async function account(opts: { email?: string; provider?: "email" | "dev"; sub?: string; demo?: boolean; status?: "ready" | "failed" | "running" } = {}) {
    const { user } = opts.provider === "dev"
      ? await accounts.accounts.upsertUser({ provider: "dev", sub: opts.sub!, displayName: "Demo template" })
      : await accounts.accounts.userForVerifiedEmail(opts.email ?? "synthetic-reset@example.test");
    const userId = user.id;
    await accounts.accounts.consent(userId, "ai_data", "v1", "iphone");
    await accounts.accounts.setDisplayName(userId, "Chel");
    const { sid, expiresAt } = await accounts.accounts.createSession(userId, "iphone");
    const token = accounts.signSession(userId, sid, "iphone", expiresAt);
    const bytes = fakePng(800, 1000, `upload-${userId}`);
    const check = interpretCheck({ subject: "person", face_count: 1, front_facing: true, face_covered: false, sharp: true, well_lit: true, text_on_image: false });
    const photo = { mime: "image/png", bytes: bytes.length, check, headBox: null, rightsAck: true, createdAt: new Date().toISOString(), ms: { check: 0, sam: null } };
    await accounts.prepStore.putImage({ ...photo, id: `img-${userId.slice(0, 8)}`, userId }, bytes);
    // an upload that never became a companion (V01 → back)
    await accounts.prepStore.putImage({ ...photo, id: `spare-${userId.slice(0, 8)}`, userId }, bytes);
    const companionId = `c-${userId.slice(0, 8)}`;
    await accounts.prepStore.putCompanion({
      id: companionId, userId, imageId: `img-${userId.slice(0, 8)}`, type: "human", voiceId: DEVICE_VOICES[0].id,
      name: "Jin", createdAt: new Date().toISOString(), prep: { ...newPrepState(), status: opts.status ?? "ready" },
      ...(opts.demo ? { demo: true } : {}),
    });
    await accounts.prepStore.patchCompanion(userId, (c) => ({ ...c, prefs: { depth: "quick", answers: { help: "Think with me", relationship: "Friend", presence: [] } as never, updatedAt: new Date().toISOString() } }));
    await accounts.prepStore.putAsset(userId, companionId, "neutral", Buffer.from("synthetic-face"));
    const style = skipStyleCard({ interests: ["Design"], replies: "Start with the answer", avoid: ["Comments on my looks"] });
    assert.ok(style.ok);
    await accounts.prepStore.putStyle(userId, style.card);
    await blobs.put(`users/${userId}/reports/r1.json`, Buffer.from("{}"), "application/json");
    const call = async (method: string, path: string) => {
      const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}` } });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    return { userId, companionId, call };
  }
  return { accounts, files, hooks, logs, account, base };
}

const count = async (db: { query: (sql: string, p: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, sql: string, userId: string) =>
  Number((await db.query(sql, [userId])).rows[0].n);

test("companion reset: companion, photos, face files and call memory go; login, consent, name, profile and reports stay; /me has no companion", async (t) => {
  const forgotten: string[] = [];
  const forgetOpts: unknown[] = [];
  let companionAtForget: unknown = "unset";
  const { accounts, files, logs, account } = await boot(t, (deps) => {
    deps.memory = { ephemeral: true, useStore() {}, repository: {}, async forget(u: string, _id?: string, opts?: unknown) {
      forgotten.push(u); forgetOpts.push(opts);
      companionAtForget = await accounts.prepStore.getCompanion(u);
    } } as unknown as SessionDeps["memory"];
  });
  const { userId, call } = await account();
  const before = await call("GET", "/me");
  assert.equal(before.body.hasCompanion, true);
  // the old companion's calls counted (AU-90): call 3, two questions asked
  const st = (await accounts.prepStore.getStyle(userId))!;
  await accounts.prepStore.putStyle(userId, { ...st, growth: { calls: 3, asked: [{ item: "Food", at: new Date().toISOString(), answered: true }] } });

  const r = await call("POST", "/v1/companion/reset");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, removed: true });

  const me = await call("GET", "/me");
  assert.equal(me.status, 200, "the same session keeps working");
  assert.equal(me.body.hasCompanion, false);
  assert.equal(me.body.prepStatus, "none");
  assert.equal(me.body.consented, true, "consent kept");
  assert.equal((me.body.user as Record<string, unknown>).displayName, "Chel", "name kept");
  assert.equal((await call("GET", "/v1/companion")).status, 404);
  assert.equal((await call("GET", "/v1/import")).body.status, "ready", "Knows-Me profile kept");

  const db = accounts.db;
  for (const table of ["companions", "clip_jobs", "companion_images"]) assert.equal(await count(db, `SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, userId), 0, table);
  assert.equal(await count(db, "SELECT count(*)::int AS n FROM companion_prefs", userId).catch(() => 0), 0, "prefs cascade");
  assert.equal(await count(db, "SELECT count(*)::int AS n FROM user_styles WHERE user_id = $1", userId), 1, "user_styles kept");
  assert.equal(await count(db, "SELECT count(*)::int AS n FROM consents WHERE user_id = $1", userId), 1, "consent rows kept");
  assert.equal(await count(db, "SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL", userId), 1, "session kept");
  assert.deepEqual([...files.keys()].filter((k) => k.startsWith(`users/${userId}/`)), [`users/${userId}/reports/r1.json`], "only the report file is left");
  assert.deepEqual(forgotten, [userId], "call memory forgotten");
  assert.deepEqual(forgetOpts, [{ relationship: true }], "AU-90: when they last talked and the mood go too");
  const after = (await accounts.prepStore.getStyle(userId))!;
  assert.deepEqual(after.growth, { calls: 0, asked: [] }, "AU-90: call 1 with the new companion");
  assert.ok(after.sections.interests.length > 0, "what Genita knows stays");
  assert.equal(companionAtForget, null, "calls close (4410) and memory goes only after the companion rows are gone (Codex P2)");
  assert.ok(logs.some((l) => l.event === "companion.reset" && l.data.ok === true && l.data.removed === true && l.data.photos === 1));

  // a new companion can be made on the same account afterwards (no "account deletion in progress" block)
  assert.equal((await call("POST", "/v1/companion/reset")).body.removed, false, "idempotent: nothing left to remove");
});

test("companion reset: stops a running prep and drains its in-flight face write before erasing (no orphan file)", async (t) => {
  const { media } = fakeMedia({ keyOf: () => "scene" });
  t.mock.method(META_MEDIA, "imageEdit", media.imageEdit);
  t.mock.method(META_MEDIA, "samDetect", media.samDetect);
  const { files, hooks, account } = await boot(t);
  const { userId, call } = await account({ status: "failed" });
  const putStarted = gate();
  const releasePut = gate();
  t.after(releasePut.resolve);
  const order: string[] = [];
  hooks.put = async (key) => {
    if (key.endsWith("/face/neutral") && key.includes("/companions/")) {
      putStarted.resolve();
      await releasePut.promise;
      order.push("upload");
    }
  };
  assert.equal((await call("POST", "/v1/companion/prep/retry")).status, 202);
  await putStarted.promise;
  const reset = call("POST", "/v1/companion/reset").then((r) => { order.push("response"); return r; });
  const timer = setTimeout(releasePut.resolve, 50);
  t.after(() => clearTimeout(timer));
  assert.equal((await reset).status, 200);
  assert.deepEqual(order, ["upload", "response"], "the in-flight write settled before the reset answered");
  assert.deepEqual([...files.keys()].filter((k) => k.startsWith(`users/${userId}/companions/`)), [], "no face file survives");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual([...files.keys()].filter((k) => k.startsWith(`users/${userId}/companions/`)), [], "and none reappears");
  assert.equal((await call("GET", "/me")).body.hasCompanion, false);
});

test("companion reset: the demo template account is refused; a judge's reset removes only its own copy", async (t) => {
  const { files, account } = await boot(t);
  const tpl = await account({ provider: "dev", sub: `${DEMO_TEMPLATE_SUB}:abc123` });
  const judge = await account({ email: "judge-copy@example.test", demo: true });
  const refused = await tpl.call("POST", "/v1/companion/reset");
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "demo_template");
  assert.equal((await tpl.call("GET", "/me")).body.hasCompanion, true, "template untouched");
  const tplFiles = [...files.keys()].filter((k) => k.startsWith(`users/${tpl.userId}/`)).sort();
  assert.equal((await judge.call("POST", "/v1/companion/reset")).status, 200);
  assert.equal((await judge.call("GET", "/me")).body.hasCompanion, false);
  assert.deepEqual([...files.keys()].filter((k) => k.startsWith(`users/${tpl.userId}/`)).sort(), tplFiles, "template files untouched");
  assert.equal((await tpl.call("GET", "/me")).body.hasCompanion, true);
});

test("companion reset: 10 resets that removed a companion per account per day, then 429; another account is not affected", async (t) => {
  const { accounts, account } = await boot(t);
  const a = await account();
  const b = await account({ email: "other-reset@example.test" });
  const recreate = async () => {
    const id = `again-${Math.random().toString(36).slice(2, 8)}`;
    await accounts.prepStore.putCompanion({
      id, userId: a.userId, imageId: (await accounts.db.query("SELECT id FROM companion_images WHERE user_id = $1 LIMIT 1", [a.userId])).rows[0]?.id ?? await (async () => {
        const bytes = fakePng(64, 64, id);
        await accounts.prepStore.putImage({ id: `img-${id}`, userId: a.userId, mime: "image/png", bytes: bytes.length, check: interpretCheck({ subject: "person", face_count: 1, front_facing: true, face_covered: false, sharp: true, well_lit: true, text_on_image: false }), headBox: null, rightsAck: true, createdAt: new Date().toISOString(), ms: { check: 0, sam: null } }, bytes);
        return `img-${id}`;
      })(),
      type: "human", voiceId: DEVICE_VOICES[0].id, name: "Jin", createdAt: new Date().toISOString(), prep: { ...newPrepState(), status: "ready" },
    });
  };
  for (let i = 0; i < 10; i++) {
    if (i > 0) await recreate();
    const r = await a.call("POST", "/v1/companion/reset");
    assert.equal(r.status, 200, `reset ${i + 1}`);
    assert.equal(r.body.removed, true);
  }
  await recreate();
  const limited = await a.call("POST", "/v1/companion/reset");
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "rate_limited");
  assert.equal((await a.call("GET", "/me")).body.hasCompanion, true, "nothing removed when limited");
  assert.equal((await b.call("POST", "/v1/companion/reset")).status, 200, "per account");
});

test("companion reset: needs a session and only answers POST", async (t) => {
  const { account, base } = await boot(t);
  const a = await account();
  // a revoked / forged session (loopback without a token is the dev identity, so a bad JWT stands in for "no session")
  assert.equal((await fetch(`${base}/v1/companion/reset`, { method: "POST", headers: { authorization: "Bearer aaa.bbb.ccc" } })).status, 401);
  assert.equal((await a.call("GET", "/v1/companion/reset")).status, 405);
  assert.equal((await a.call("GET", "/me")).body.hasCompanion, true);
});

test("companion reset: a storage failure answers 502 and a retry still removes every photo and face file (Codex P1)", async (t) => {
  const { files, hooks, account } = await boot(t);
  const { userId, call } = await account();
  let failing = true;
  hooks.beforeDelete = async (prefix) => {
    if (failing && prefix.startsWith(`users/${userId}/images/`)) throw new Error("synthetic storage unavailable");
  };
  const first = await call("POST", "/v1/companion/reset");
  assert.equal(first.status, 502);
  assert.equal(first.body.error, "reset_failed");
  failing = false;
  const retry = await call("POST", "/v1/companion/reset");
  assert.equal(retry.status, 200);
  assert.equal((await call("GET", "/me")).body.hasCompanion, false);
  assert.deepEqual([...files.keys()].filter((k) => k.startsWith(`users/${userId}/`)), [`users/${userId}/reports/r1.json`], "no photo or face file left behind");
});

test("companion reset: POST /v1/companion waits (409) while a reset is erasing, and works right after", async (t) => {
  const { hooks, account } = await boot(t);
  const { call } = await account();
  const entered = gate();
  const release = gate();
  t.after(release.resolve);
  hooks.beforeDelete = async (prefix) => {
    if (prefix.includes("/companions/")) { entered.resolve(); await release.promise; }
  };
  const reset = call("POST", "/v1/companion/reset");
  await entered.promise;
  const during = await call("POST", "/v1/companion");
  assert.equal(during.status, 409);
  assert.equal(during.body.error, "reset_in_progress");
  release.resolve();
  assert.equal((await reset).status, 200);
  hooks.beforeDelete = async () => {};
  const after = await call("POST", "/v1/companion");
  assert.notEqual(after.body.error, "reset_in_progress", "the block lifts after the reset");
});

test("AU-90: memory.forget with relationship clears when they last talked and the carried mood; settings stay", async () => {
  const { MemoryService } = await import("../src/memory/service.ts");
  const { InMemoryMemoryRepository } = await import("../src/memory/repository.ts");
  const repo = new InMemoryMemoryRepository();
  const memory = new MemoryService({ repository: repo, state: repo, extract: async () => [] });
  const s = await repo.getState("u1");
  await repo.putState("u1", { ...s, last_message_at: Date.now(), last_opener_day: "2026-11-04", settings: { rememberSeen: false, photosOfUs: true }, call_mood: { valence: 0.5, energy: 0.2, at: Date.now(), rev: 0 } } as typeof s);
  await memory.forget("u1");
  assert.notEqual((await repo.getState("u1")).last_message_at, null, "a plain Forget keeps the call rhythm");
  await memory.forget("u1", undefined, { relationship: true });
  const after = await repo.getState("u1") as Awaited<ReturnType<typeof repo.getState>> & { call_mood?: unknown };
  assert.equal(after.last_message_at, null);
  assert.equal(after.last_opener_day, null);
  assert.equal(after.call_mood, undefined);
  assert.equal(after.settings.rememberSeen, false, "memory settings stay");
});
