/** Account deletion must finish personal-file cleanup before revoking a retryable account. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createAccounts } from "../src/auth/index.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { MemoryFindsStore, ownerKey } from "../src/finds/store.ts";
import { interpretCheck } from "../src/prep/classify.ts";
import { META_MEDIA } from "../src/prep/pipeline.ts";
import { newPrepState } from "../src/prep/runner.ts";
import { DEVICE_VOICES } from "../src/prep/voices.ts";
import { startServer } from "../src/server.ts";
import type { SessionDeps } from "../src/session/session.ts";
import type { BlobStore } from "../src/storage/blob.ts";
import { tableCounts } from "./helpers/db.ts";
import { fakeMedia, fakePng } from "./helpers/fakeMedia.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function boot(t: TestContext, patch: (deps: SessionDeps) => void = () => {}) {
  const files = new Map<string, Buffer>();
  const hooks = {
    put: async (_key: string) => {},
    beforeDelete: async (_prefix: string) => {},
    afterDelete: async (_prefix: string) => {},
  };
  const blobs: BlobStore = {
    kind: "fs",
    async put(key, bytes) { await hooks.put(key); files.set(key, bytes); },
    async get(key) { return files.get(key) ?? null; },
    async list(prefix) { return [...files.keys()].filter((key) => key.startsWith(prefix)); },
    async deletePrefix(prefix) {
      await hooks.beforeDelete(prefix);
      let count = 0;
      for (const key of files.keys()) if (key.startsWith(prefix)) { files.delete(key); count++; }
      await hooks.afterDelete(prefix);
      return count;
    },
    signedUrl() { return null; },
  };
  const dir = mkdtempSync(join(tmpdir(), "genita-delete-cleanup-"));
  const env = { GENITA_DATA_DIR: dir, GENITA_JWT_SECRET: "j".repeat(40) };
  const log = () => {};
  // Always an isolated synthetic DB, regardless of TEST_DATABASE_URL.
  const accounts = (await createAccounts(env, log, { loopback: true, db: await openDb("pglite:memory"), blobs, mail: null }))!;
  const config = { ...loadConfig({ MODEL_API_KEY: "fake" }), port: 0 };
  const deps: SessionDeps = {
    config,
    openAsr() { throw new Error("ASR forbidden in deletion tests"); },
    async *spark() { throw new Error("Spark forbidden in deletion tests"); },
    async *tts() {},
  };
  patch(deps);
  const server = await startServer(config, log, deps, env, accounts);
  t.after(async () => {
    await new Promise<void>((r, reject) => server.close((e) => e ? reject(e) : r()));
    rmSync(dir, { recursive: true, force: true });
  });
  const { user } = await accounts.accounts.userForVerifiedEmail("synthetic-delete@example.test");
  const userId = user.id;
  await accounts.accounts.consent(userId, "ai_data", "v1", "iphone");
  const { sid, expiresAt } = await accounts.accounts.createSession(userId, "iphone");
  const token = accounts.signSession(userId, sid, "iphone", expiresAt);
  const bytes = fakePng(800, 1000, "synthetic-upload");
  const imageId = "synthetic-image";
  await accounts.prepStore.putImage({
    id: imageId, userId, mime: "image/png", bytes: bytes.length,
    check: interpretCheck({ subject: "person", face_count: 1, front_facing: true, face_covered: false, sharp: true, well_lit: true, text_on_image: false }),
    headBox: null, rightsAck: true, createdAt: new Date().toISOString(), ms: { check: 0, sam: null },
  }, bytes);
  const companionId = "synthetic-companion";
  await accounts.prepStore.putCompanion({
    id: companionId, userId, imageId, type: "human", voiceId: DEVICE_VOICES[0].id,
    name: "Jin", createdAt: new Date().toISOString(), prep: { ...newPrepState(), status: "failed" },
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path = "/me") => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { accounts, userId, companionId, files, hooks, call };
}

test("DELETE /me: late prep upload plus failed final cleanup returns 502, preserves rows/session, and retries to zero", async (t) => {
  const { accounts, userId, companionId, files, hooks, call } = await boot(t);
  const before = await tableCounts(accounts.db, userId);
  const releasePut = gate();
  t.after(releasePut.resolve);
  hooks.put = async () => releasePut.promise;
  const lateWrite = accounts.prepStore.putAsset(userId, companionId, "neutral", Buffer.from("synthetic-private-face"));
  hooks.afterDelete = async (prefix) => {
    if (prefix === `users/${userId}/`) {
      // Repro: an upload already in flight lands after the initial blob purge.
      releasePut.resolve();
      await lateWrite;
    }
  };
  let failing = true;
  hooks.beforeDelete = async (prefix) => {
    if (failing && prefix === `users/${userId}/companions/`) throw new Error("synthetic store unavailable");
  };
  const first = await call("DELETE");
  assert.equal(first.status, 502);
  assert.equal(first.body.error, "delete_failed");
  assert.deepEqual(await tableCounts(accounts.db, userId), before, "all account rows kept on cleanup failure");
  assert.equal((await call("GET")).status, 200, "the same session can retry");
  assert.equal(files.size, 1, "the failed purge left the late face upload");

  failing = false;
  assert.equal((await call("DELETE")).status, 200);
  await lateWrite;
  assert.equal(files.size, 0);
  for (const [table, count] of Object.entries(await tableCounts(accounts.db, userId))) assert.equal(count, 0, table);
  assert.equal((await call("GET")).status, 401, "session revoked only after success");
});

test("DELETE /me: waits for an actual prep upload; a delayed write cannot reappear after 200", async (t) => {
  const { media } = fakeMedia({ keyOf: () => "scene" });
  t.mock.method(META_MEDIA, "imageEdit", media.imageEdit);
  t.mock.method(META_MEDIA, "samDetect", media.samDetect);
  const { accounts, userId, files, hooks, call } = await boot(t);
  const putStarted = gate();
  const releasePut = gate();
  const putFinished = gate();
  const firstPurge = gate();
  t.after(releasePut.resolve);
  const order: string[] = [];
  hooks.put = async (key) => {
    if (key.endsWith("/face/neutral")) {
      putStarted.resolve();
      await releasePut.promise;
      order.push("upload");
      putFinished.resolve();
    }
  };
  hooks.afterDelete = async (prefix) => {
    if (prefix === `users/${userId}/`) firstPurge.resolve();
  };
  assert.equal((await call("POST", "/v1/companion/prep/retry")).status, 202);
  await putStarted.promise;
  const deletion = call("DELETE").then((response) => { order.push("response"); return response; });
  await firstPurge.promise;
  // The former fire-and-forget cleanup returned 200 while this upload was still blocked.
  const timer = setTimeout(releasePut.resolve, 50);
  t.after(() => clearTimeout(timer));
  assert.equal((await deletion).status, 200);
  await putFinished.promise;
  assert.deepEqual(order, ["upload", "response"], "all in-flight writes settle before success");
  assert.equal(files.size, 0, "no file can reappear after the response");
  for (const [table, count] of Object.entries(await tableCounts(accounts.db, userId))) assert.equal(count, 0, table);
});

test("DELETE /me: failed Finds cleanup preserves rows/session and is retryable", async (t) => {
  const store = new MemoryFindsStore();
  const { accounts, userId, call } = await boot(t, (deps) => {
    const forbidden = async () => { throw new Error("Finds vendor forbidden in deletion tests"); };
    deps.finds = {
      store, images: false, imageBase: "/v1/finds",
      vendors: { spark: forbidden, async *sparkStream() { await forbidden(); }, sam: forbidden, image: forbidden },
    };
  });
  const before = await tableCounts(accounts.db, userId);
  const removeOwner = store.removeOwner.bind(store);
  let failing = true;
  t.mock.method(store, "removeOwner", async (owner: string) => {
    assert.equal(owner, ownerKey(userId));
    if (failing) throw new Error("synthetic Finds unavailable");
    await removeOwner(owner);
  });
  const first = await call("DELETE");
  assert.equal(first.status, 502);
  assert.equal(first.body.error, "delete_failed");
  assert.deepEqual(await tableCounts(accounts.db, userId), before);
  assert.equal((await call("GET")).status, 200);
  failing = false;
  assert.equal((await call("DELETE")).status, 200);
  for (const [table, count] of Object.entries(await tableCounts(accounts.db, userId))) assert.equal(count, 0, table);
});
