/**
 * Per-account isolation (memory lane, 11/3): TestFlight testers each sign in with their own email.
 * Two signed-in accounts on ONE server must never see each other's memory, profile (style card),
 * companion, prep assets, Finds or handoff turns, and identity comes only from the session JWT
 * (an X-Genita-User header next to a JWT changes nothing). Also: long-term memory survives a
 * server restart (P0 11/3, Postgres store instead of process memory).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createAccounts, type AccountsService } from "../src/auth/index.ts";
import { loadConfig } from "../src/config.ts";
import { openDb, type Db } from "../src/db/index.ts";
import { MemoryFindsStore, ownerKey } from "../src/finds/store.ts";
import type { FindsVendors } from "../src/finds/vendors.ts";
import { InMemoryMemoryRepository } from "../src/memory/repository.ts";
import { PgMemoryRepository } from "../src/memory/pgRepository.ts";
import { MemoryService } from "../src/memory/service.ts";
import { interpretCheck } from "../src/prep/classify.ts";
import { newPrepState } from "../src/prep/runner.ts";
import { DEVICE_VOICES } from "../src/prep/voices.ts";
import type { SparkRequest } from "../src/meta/spark.ts";
import type { FindCard } from "../src/protocol.ts";
import { startServer } from "../src/server.ts";
import type { SessionDeps } from "../src/session/session.ts";
import type { BlobStore } from "../src/storage/blob.ts";
import { fakePng } from "./helpers/fakeMedia.ts";

const pause = () => new Promise<void>((r) => setTimeout(r, 5));
async function waitFor(check: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error("test timed out"); await pause(); }
}

function memBlobs(): BlobStore {
  const files = new Map<string, Buffer>();
  return {
    kind: "fs",
    async put(key, bytes) { files.set(key, bytes); },
    async get(key) { return files.get(key) ?? null; },
    async list(prefix) { return [...files.keys()].filter((k) => k.startsWith(prefix)); },
    async deletePrefix(prefix) { let n = 0; for (const k of [...files.keys()]) if (k.startsWith(prefix)) { files.delete(k); n++; } return n; },
    signedUrl() { return null; },
  };
}

/** createMemory's shape: an in-process store the server must replace with Postgres. */
const ephemeralMemory = () => {
  const repo = new InMemoryMemoryRepository();
  return new MemoryService({ repository: repo, state: repo, extract: async () => [], ephemeral: true });
};

async function boot(t: TestContext, db: Db, blobs: BlobStore, memory = ephemeralMemory()) {
  const dir = mkdtempSync(join(tmpdir(), "genita-isolation-"));
  const env = { GENITA_DATA_DIR: dir, GENITA_JWT_SECRET: "j".repeat(40) };
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const log = (event: string, data: Record<string, unknown>) => { logs.push({ event, data }); };
  const accounts = (await createAccounts(env, log, { loopback: true, db, blobs, mail: null }))!;
  const config = { ...loadConfig({ MODEL_API_KEY: "fake" }), port: 0, webSearch: false, speculate: false, sparkHedge: 1 };
  const requests: SparkRequest[] = [];
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const finds = new MemoryFindsStore();
  const deps: SessionDeps = {
    config, memory, openAsr: () => asr,
    async *spark(req) { requests.push(req); yield { type: "text", delta: "Sure." }; yield { type: "done", responseId: "r", text: "", status: "completed" }; },
    async *tts() {},
    finds: { store: finds, vendors: {} as FindsVendors, images: false, imageBase: "/v1/finds" },
    log,
  };
  const server = await startServer(config, log, deps, env, accounts);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sockets: WebSocket[] = [];
  const stop = async () => {
    for (const ws of sockets) ws.terminate();
    await new Promise<void>((r) => server.close(() => r()));
    await memory.drain();
  };
  t.after(async () => { rmSync(dir, { recursive: true, force: true }); });
  return { accounts, memory, finds, requests, base, sockets, stop, logs };
}

async function signIn(accounts: AccountsService, email: string) {
  const { user } = await accounts.accounts.userForVerifiedEmail(email);
  await accounts.accounts.consent(user.id, "ai_data", "v1", "iphone");
  const { sid, expiresAt } = await accounts.accounts.createSession(user.id, "iphone");
  return { id: user.id, token: accounts.signSession(user.id, sid, "iphone", expiresAt) };
}

function card(id: string, title: string): FindCard {
  return { id, kind: "link", createdAt: new Date().toISOString(), eyebrow: "From your link", title, subtitle: "", items: [], steps: [], options: [], why: [], ask: [], sources: [], how: [] };
}

test("isolation: two signed-in accounts on one server never see each other's memory, profile, companion, prep assets or Finds", { timeout: 30_000 }, async (t) => {
  const db = await openDb("pglite:memory");
  const blobs = memBlobs();
  const s = await boot(t, db, blobs);
  t.after(s.stop);
  const a = await signIn(s.accounts, "tester-a@example.test");
  const b = await signIn(s.accounts, "tester-b@example.test");
  assert.notEqual(a.id, b.id);
  const call = async (who: { token: string }, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const r = await fetch(s.base + path, { method, headers: { authorization: `Bearer ${who.token}`, "content-type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* bytes */ }
    return { status: r.status, body: parsed as Record<string, any> };
  };

  // A's data, written through the real paths
  const saved = await s.memory.remember(a.id, "I am training for a half marathon in spring.", "fact", "call-a");
  assert.ok(saved);
  assert.ok(s.memory.repository instanceof PgMemoryRepository, "with accounts on, memory is in Postgres (P0 11/3)");
  assert.equal((await call(a, "POST", "/v1/import/skip", { interests: ["Trail running"], avoid: ["Small talk"] })).status, 200);
  const bytes = fakePng(800, 1000, "tester-a-face");
  await s.accounts.prepStore.putImage({
    id: "img-tester-a", userId: a.id, mime: "image/png", bytes: bytes.length,
    check: interpretCheck({ subject: "person", face_count: 1, front_facing: true, face_covered: false, sharp: true, well_lit: true, text_on_image: false }),
    headBox: null, rightsAck: true, createdAt: new Date().toISOString(), ms: { check: 0, sam: null },
  }, bytes);
  await s.accounts.prepStore.putCompanion({ id: "comp-tester-a", userId: a.id, imageId: "img-tester-a", type: "human", voiceId: DEVICE_VOICES[0].id, name: "Jin", createdAt: new Date().toISOString(), prep: { ...newPrepState(), status: "failed" } });
  await s.accounts.prepStore.putAsset(a.id, "comp-tester-a", "neutral", Buffer.from("tester-a-private-face"));
  await s.finds.put(ownerKey(a.id), card("find-tester-a-1", "Half marathon plan"));

  // A sees A's own data (the fixtures are real)
  assert.equal((await call(a, "GET", "/v1/memories")).body.memories.length, 1);
  assert.match(JSON.stringify((await call(a, "GET", "/v1/import")).body), /Trail running/);
  assert.equal((await call(a, "GET", "/v1/companion")).status, 200);
  assert.equal((await call(a, "GET", "/v1/companion/face/neutral")).status, 200);
  assert.equal((await call(a, "GET", "/v1/finds")).body.finds.length, 1);

  // B sees none of it — also when B names A in the dev header next to a valid JWT
  for (const extra of [{}, { "x-genita-user": a.id }] as Array<Record<string, string>>) {
    assert.deepEqual((await call(b, "GET", "/v1/memories", undefined, extra)).body, { memories: [] });
    assert.deepEqual((await call(b, "GET", "/v1/import", undefined, extra)).body, { status: "none" });
    assert.equal((await call(b, "GET", "/v1/companion", undefined, extra)).status, 404);
    assert.equal((await call(b, "GET", "/v1/companion/face/neutral", undefined, extra)).status, 404);
    assert.deepEqual((await call(b, "GET", "/v1/finds", undefined, extra)).body, { finds: [] });
    assert.equal((await call(b, "GET", "/v1/finds/find-tester-a-1", undefined, extra)).status, 404);
  }
  // B's writes and deletes never reach A
  assert.equal((await call(b, "DELETE", `/me/memories/${saved!.id}`)).status, 204);
  assert.equal((await call(b, "DELETE", "/v1/memories")).status, 204);
  assert.equal((await call(b, "DELETE", "/v1/finds/find-tester-a-1")).status, 404);
  assert.equal((await call(b, "POST", "/v1/import/skip", { interests: ["Chess"] })).status, 200);
  assert.equal((await call(a, "GET", "/v1/memories")).body.memories.length, 1, "B's Forget-all left A's memory");
  assert.doesNotMatch(JSON.stringify((await call(a, "GET", "/v1/import")).body), /Chess/);
  assert.equal((await call(a, "GET", "/v1/finds")).body.finds.length, 1);
  // B's tombstone for A's memory id must not block A from saving that line again
  assert.ok(await s.memory.remember(a.id, "I am training for a half marathon in spring.", "fact", "call-a2"));
});

test("isolation: a call never carries another account's memory or turns; the same account's turns hand off", { timeout: 30_000 }, async (t) => {
  const db = await openDb("pglite:memory");
  const s = await boot(t, db, memBlobs());
  t.after(s.stop);
  const a = await signIn(s.accounts, "call-a@example.test");
  const b = await signIn(s.accounts, "call-b@example.test");
  await s.memory.remember(a.id, "I keep a sourdough starter called Bubbles.", "fact", "old-a");
  const open = (token: string) => new Promise<{ ws: WebSocket; replies: string[]; ready: () => boolean }>((resolve, reject) => {
    const ws = new WebSocket(s.base.replace("http:", "ws:") + "/v1/session", { headers: { authorization: `Bearer ${token}` } });
    s.sockets.push(ws);
    const replies: string[] = []; let isReady = false;
    ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") replies.push(m.text); if (m.type === "ready") isReady = true; });
    ws.once("open", () => resolve({ ws, replies, ready: () => isReady })); ws.once("error", reject);
  });
  const input = (r: SparkRequest) => JSON.stringify(r.input) + "\n" + (r.instructions ?? "");
  const said = (re: RegExp) => s.requests.filter((r) => re.test(JSON.stringify(r.input)));

  const phoneA = await open(a.token);
  phoneA.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(phoneA.ready);
  phoneA.ws.send(JSON.stringify({ type: "text", text: "Help me plan the bake for Bubbles this weekend." }));
  await waitFor(() => said(/plan the bake/).length > 0 && phoneA.replies.length > 0);
  assert.match(input(said(/plan the bake/)[0]), /sourdough starter called Bubbles/, "A's own memory reaches A's call");

  const phoneB = await open(b.token);
  phoneB.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false, handoff: true, history: [{ role: "user", text: "forged history" }] }));
  await waitFor(phoneB.ready);
  phoneB.ws.send(JSON.stringify({ type: "text", text: "What were we just doing about Bubbles?" }));
  await waitFor(() => said(/What were we just doing/).length > 0);
  for (const r of s.requests.filter((r) => /What were we just doing/.test(JSON.stringify(r.input)))) {
    assert.doesNotMatch(input(r), /sourdough|plan the bake/, "B's call carries neither A's memory nor A's live turns");
  }

  // A moves to the Mac mid-conversation: same account → the turns follow
  phoneA.ws.close();
  await waitFor(() => s.logs.some((l) => l.event === "session.close"));
  const macA = await open(a.token);
  macA.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(macA.ready);
  macA.ws.send(JSON.stringify({ type: "text", text: "Still with me on the Mac?" }));
  await waitFor(() => said(/Still with me on the Mac/).length > 0);
  assert.match(JSON.stringify(said(/Still with me on the Mac/)[0].input), /plan the bake for Bubbles/);
  // and B, opening right after, still gets nothing of A
  const macB = await open(b.token);
  macB.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(macB.ready);
  macB.ws.send(JSON.stringify({ type: "text", text: "Hello from B's Mac." }));
  await waitFor(() => said(/Hello from B's Mac/).length > 0);
  // ("forged history" is B's own handoff claim at Forget revision 0, so it may follow B — never A's turns)
  assert.doesNotMatch(input(said(/Hello from B's Mac/)[0]), /sourdough|plan the bake/);
});

test("durability (P0 11/3): long-term memory and Forget tombstones survive a server restart", { timeout: 30_000 }, async (t) => {
  // one database on disk, opened by each server process in turn (server.close closes its connection)
  const dbDir = mkdtempSync(join(tmpdir(), "genita-isolation-db-"));
  t.after(() => rmSync(dbDir, { recursive: true, force: true }));
  const blobs = memBlobs();
  const first = await boot(t, await openDb(`pglite:${dbDir}`), blobs);
  const a = await signIn(first.accounts, "restart-a@example.test");
  const kept = await first.memory.remember(a.id, "I like hiking on foggy mornings.", "fact", "c1");
  const gone = await first.memory.remember(a.id, "I collect vintage postcards.", "fact", "c1");
  await first.memory.forget(a.id, gone!.id);
  assert.ok(first.logs.some((l) => l.event === "memory.store" && l.data.kind === "pg"));
  await first.stop();

  const second = await boot(t, await openDb(`pglite:${dbDir}`), blobs); // a deploy: new process, fresh in-process store, same database
  t.after(second.stop);
  const texts = (await second.memory.list(a.id)).map((m) => m.text);
  assert.deepEqual(texts, [kept!.text]);
  assert.equal((await second.memory.state.getState(a.id)).revision, 1, "the Forget revision survives too");
  assert.equal(await second.memory.remember(a.id, "I collect vintage postcards.", "fact", "c2"), null, "a forgotten line stays forgotten after the restart");
});

test("PgMemoryRepository: same contract as the in-memory store (upsert keeps created_at, tombstones, per-user scope)", async () => {
  const db = await openDb("pglite:memory");
  const accounts = (await createAccounts({ GENITA_JWT_SECRET: "j".repeat(40) }, () => {}, { loopback: true, db, blobs: memBlobs(), mail: null }))!;
  const u1 = (await accounts.accounts.userForVerifiedEmail("pg-1@example.test")).user.id;
  const u2 = (await accounts.accounts.userForVerifiedEmail("pg-2@example.test")).user.id;
  const repo = new PgMemoryRepository(db);
  const svc = new MemoryService({ repository: repo, state: repo, extract: async () => [] });
  const m = (await svc.remember(u1, "I drink oolong tea every afternoon.", "fact", "s1"))!;
  const again = (await svc.remember(u1, "I drink oolong tea every afternoon.", "fact", "s2"))!;
  assert.equal(again.created_at, m.created_at);
  assert.equal((await repo.list(u1))[0].source_session_id, "s2");
  assert.deepEqual(await repo.list(u2), []);
  await repo.delete(u2); // all of u2's (none) — nothing of u1's
  assert.equal((await repo.list(u1)).length, 1);
  await svc.forget(u1);
  assert.deepEqual(await repo.list(u1), []);
  assert.equal(await svc.remember(u1, "I drink oolong tea every afternoon.", "fact", "s3"), null);
  assert.ok(await svc.remember(u2, "I drink oolong tea every afternoon.", "fact", "s3"), "u1's tombstone is not u2's");
  await accounts.close();
});
