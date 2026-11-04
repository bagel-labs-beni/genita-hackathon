import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { createAccounts } from "../src/auth/index.ts";
import { openDb } from "../src/db/index.ts";
import { FsBlobStore } from "../src/storage/blob.ts";
import { FileFindsStore, MemoryFindsStore, ownerKey } from "../src/finds/store.ts";
import type { FindCard, ServerEvent } from "../src/protocol.ts";
import type { SessionDeps } from "../src/session/session.ts";
import type { FindsVendors } from "../src/finds/vendors.ts";
import { FindsRunner } from "../src/finds/runner.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const picture = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const card = (id: string): FindCard => ({ id, kind: "product", createdAt: new Date().toISOString(), eyebrow: "", title: "Jacket", subtitle: "", items: [], steps: [], options: [], why: [], ask: [], sources: [], how: [] });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function productVendors(image: Promise<Buffer>, requested: () => void): FindsVendors {
  const productUrl = "https://shop.example.test/products/jacket-12345";
  return {
    async spark() { return { text: JSON.stringify({ label: "Jacket", items: [{ name: "Jacket", url: productUrl, image: "https://shop.example.test/jacket.png", store: "Shop" }] }), output: [{ type: "web_search_call", status: "completed", action: { type: "open_page", url: productUrl } }] }; },
    async pageFacts() { return { kind: "product", title: "Jacket", image: "https://shop.example.test/jacket.png" }; },
    productImage() { requested(); return image; },
  } as unknown as FindsVendors;
}

// Real loopback server + JWT + PGlite + file store; every vendor is a fake.
async function boot(t: TestContext, delayedWrite?: "card" | "image") {
  const dir = await mkdtemp(join(tmpdir(), "genita-finds-delete-"));
  const image = deferred<Buffer>();
  const imageRequested = deferred<void>();
  const writeStarted = deferred<void>();
  const writeGate = deferred<void>();
  const done = deferred<void>();
  const closed = deferred<void>();
  const deleting = deferred<void>();
  let purges = 0;
  class PausedStore extends FileFindsStore {
    override async put(owner: string, value: FindCard) {
      if (delayedWrite === "card" && owner !== ownerKey("other")) {
        writeStarted.resolve();
        await writeGate.promise;
      }
      await super.put(owner, value);
    }
    override async putImage(id: string, slot: string, bytes: Buffer) {
      if (delayedWrite === "image" && id !== "other-card") {
        writeStarted.resolve();
        await writeGate.promise;
      }
      await super.putImage(id, slot, bytes);
    }
    override async removeOwner(owner: string) {
      purges++;
      return super.removeOwner(owner);
    }
  }
  const store = new PausedStore(join(dir, "finds"));
  await store.put(ownerKey("other"), card("other-card"));
  await store.putImage("other-card", "product-1", picture);
  const env = { GENITA_DATA_DIR: dir, GENITA_JWT_SECRET: "fake".repeat(10) };
  const db = await openDb("pglite:memory");
  const accounts = (await createAccounts(env, () => {}, { loopback: true, db, blobs: new FsBlobStore(join(dir, "blobs")), mail: null }))!;
  const closeAccounts = accounts.close.bind(accounts);
  let closing: Promise<void> | undefined;
  accounts.close = () => closing ??= closeAccounts();
  const deletions: Promise<Response>[] = [];
  const { user } = await accounts.accounts.upsertUser({ provider: "email", sub: "finds@example.test", email: "finds@example.test", emailVerified: true });
  await accounts.accounts.consent(user.id, "ai_data", "v1", "iphone");
  const auth = await accounts.accounts.createSession(user.id, "iphone");
  const token = accounts.signSession(user.id, auth.sid, "iphone", auth.expiresAt);
  const vendors = productVendors(image.promise, () => imageRequested.resolve());
  const config = { ...loadConfig({ MODEL_API_KEY: "fake", GENITA_SPECULATE: "0" }), port: 0 };
  const deps: SessionDeps = {
    config, openAsr() { throw new Error("ASR not used"); },
    async *spark() { yield { type: "text", delta: "Sure." }; yield { type: "done", text: "Sure.", responseId: null, status: "completed" }; },
    async *tts() {},
    finds: { store, vendors, images: true, imageBase: "/v1/finds", productHedge: 1 },
    log(e) { if (e === "find.done") done.resolve(); },
  };
  const server = await startServer(config, (e) => { if (e === "session.close") closed.resolve(); }, deps, env, accounts);
  const beforeDelete = accounts.beforeUserDeleted!;
  accounts.beforeUserDeleted = async (userId) => { deleting.resolve(); await beforeDelete(userId); };
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const ws = new WebSocket(base.replace("http", "ws") + "/v1/session", { headers: { authorization: `Bearer ${token}` } });
  t.after(async () => {
    image.resolve(picture);
    writeGate.resolve();
    await done.promise;
    await Promise.allSettled(deletions);
    if (ws.readyState !== WebSocket.CLOSED) {
      const socketClosed = once(ws, "close");
      ws.terminate();
      await socketClosed;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await accounts.close();
    await rm(dir, { recursive: true, force: true });
  });
  const ready = deferred<void>();
  const created = deferred<FindCard>();
  ws.on("message", (raw, binary) => {
    if (binary) return;
    const event = JSON.parse(String(raw)) as ServerEvent;
    if (event.type === "ready") ready.resolve();
    if (event.type === "find.created") created.resolve(event.card);
  });
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "start", persona: { name: "Tara", kind: "human" }, mic: false }));
  await ready.promise;
  ws.send(JSON.stringify({ type: "text", text: "Find a jacket for this weekend" }));
  const found = await created.promise;
  await imageRequested.promise;
  return {
    store, dir, found, user, accounts, image, writeGate, writeStarted, done, deleting,
    purges: () => purges,
    async endCall() { ws.close(); await closed.promise; },
    deleteAccount() {
      const response = fetch(base + "/me", { method: "DELETE", headers: { authorization: `Bearer ${token}` } }).then(async (r) => { await r.arrayBuffer(); return r; });
      deletions.push(response);
      return response;
    },
    async assertPurged() {
      const reopened = new FileFindsStore(join(dir, "finds"));
      assert.deepEqual(await reopened.list(ownerKey(user.id)), [], "no cards after reopening the file store");
      assert.equal(await reopened.getImage(found.id, "product-1"), null, "no orphan image on disk");
      assert.deepEqual(await readdir(join(dir, "finds", "images")), ["other-card"]);
      assert.equal((await reopened.list(ownerKey("other"))).length, 1, "another owner's card is untouched");
      assert.deepEqual((await reopened.getImage("other-card", "product-1"))?.bytes, picture);
    },
  };
}

for (const ended of [true, false]) {
  test(`account deletion: ${ended ? "ended" : "active"} call cannot save its pending product image`, { timeout: 60_000 }, async (t) => {
    const f = await boot(t);
    if (ended) await f.endCall();
    const response = await f.deleteAccount();
    assert.equal(response.status, 200);
    assert.equal(await f.accounts.accounts.getUser(f.user.id), null);
    // This fake vendor deliberately ignores cancellation and completes after DELETE /me.
    f.image.resolve(picture);
    await f.done.promise;
    await tick();
    await f.assertPurged();
  });
}

for (const kind of ["card", "image"] as const) {
  test(`account deletion awaits an ended call's in-flight ${kind} writes before purging`, { timeout: 60_000 }, async (t) => {
    const f = await boot(t, kind);
    if (kind === "image") f.image.resolve(picture);
    await f.writeStarted.promise;
    await f.endCall();
    let responded = false;
    const response = f.deleteAccount().then((r) => { responded = true; return r; });
    await f.deleting.promise;
    await tick();
    await tick();
    assert.equal(f.purges(), 0, "purge waits for every write already in flight");
    assert.equal(responded, false, "DELETE /me has not succeeded while a write is pending");
    f.writeGate.resolve();
    assert.equal((await response).status, 200);
    f.image.resolve(picture);
    await f.done.promise;
    await tick();
    await f.assertPurged();
  });
}

test("normal call end preserves a card and its pending picture on disk", { timeout: 60_000 }, async (t) => {
  const f = await boot(t);
  await f.endCall();
  f.image.resolve(picture);
  await f.done.promise;
  await tick();
  const reopened = new FileFindsStore(join(f.dir, "finds"));
  assert.equal((await reopened.list(ownerKey(f.user.id))).length, 1);
  assert.deepEqual((await reopened.getImage(f.found.id, "product-1"))?.bytes, picture);
});

test("deleting one owner cancels all their ended calls but leaves another owner's pending Finds running", async () => {
  const store = new MemoryFindsStore();
  const image = deferred<Buffer>();
  const runners = ["alice", "alice", "bob"].map((owner) => {
    const requested = deferred<void>();
    const runner = new FindsRunner({ store, vendors: productVendors(image.promise, () => requested.resolve()), images: true, imageBase: "/v1/finds", productHedge: 1 }, { emit() {}, announce() {}, log() {}, now: () => performance.now() });
    runner.configure({ owner, memories: [] });
    const started = runner.onTurn({ text: "Find a jacket for this weekend", frames: [], utteranceId: 1, replyText: Promise.resolve("On it.") });
    assert.ok(started);
    return { runner, requested: requested.promise, id: started.findId };
  });
  try {
    await Promise.all(runners.map((r) => r.requested));
    runners.forEach((r) => r.runner.close());
    await store.work.deleteOwner(ownerKey("alice"));
    await store.removeOwner(ownerKey("alice"));
  } finally {
    image.resolve(picture);
    await Promise.all(runners.map((r) => r.runner.settle()));
  }
  assert.deepEqual(await store.list(ownerKey("alice")), []);
  for (const r of runners.slice(0, 2)) assert.equal(await store.getImage(r.id, "product-1"), null);
  assert.equal((await store.list(ownerKey("bob"))).length, 1);
  assert.deepEqual((await store.getImage(runners[2].id, "product-1"))?.bytes, picture);
  const late = new FindsRunner({ store, vendors: productVendors(image.promise, () => assert.fail("deleted owners must not start work")), images: true, imageBase: "/v1/finds" }, { emit() {}, announce() {}, log() {}, now: () => 0 });
  late.configure({ owner: "alice", memories: [] });
  assert.equal(late.onTurn({ text: "Find a jacket", frames: [], utteranceId: 2, replyText: Promise.resolve(null) }), null);
});

for (const file of [false, true]) {
  test(`${file ? "file" : "memory"} store refuses late cards and images for a deleted owner`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "genita-finds-tombstone-"));
    try {
      const store = file ? new FileFindsStore(dir) : new MemoryFindsStore();
      const value = card("deleted-card");
      await store.put("deleted", value);
      await store.work.deleteOwner("deleted");
      // The tombstone guards the store even before the final purge.
      await store.putImage(value.id, "product-1", picture);
      assert.equal(await store.getImage(value.id, "product-1"), null);
      await store.removeOwner("deleted");
      await store.put("deleted", value);
      await store.putImage(value.id, "product-1", picture);
      assert.deepEqual(await store.list("deleted"), []);
      assert.equal(await store.getImage(value.id, "product-1"), null);
      if (file) {
        const reopened = new FileFindsStore(dir);
        assert.deepEqual(await reopened.list("deleted"), []);
        assert.equal(await reopened.getImage(value.id, "product-1"), null);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
