import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { loadConfig } from "../src/config.ts";
import { metaJson, metaForm, UpstreamError } from "../src/meta/http.ts";
import { museImageGenerate, museImageEdit, samDetect, uploadFile } from "../src/meta/media.ts";
import { sparkStream } from "../src/meta/spark.ts";
import { TranscribeStream } from "../src/meta/transcribe.ts";
import { metaVendors } from "../src/finds/vendors.ts";
import { startServer } from "../src/server.ts";
import { Session, type SessionDeps } from "../src/session/session.ts";
import type { ServerEvent } from "../src/protocol.ts";
import { openDb } from "../src/db/index.ts";
import { migrateUp } from "../src/db/migrate.ts";
import { createPrep } from "../src/prep/index.ts";
import { FileStore } from "../src/prep/store.ts";

const config = (env: NodeJS.ProcessEnv = {}) => loadConfig({ MODEL_API_KEY: "synthetic", PORT: "0", GENITA_SPECULATE: "0", GENITA_SPARK_HEDGE: "1", GENITA_INTERPRET_ASR_CORRECT: "0", ...env });
const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
const log = (event: string, data: Record<string, unknown>) => logs.push({ event, data });
const originalFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  logs.length = 0;
  const { configureOps } = await import("../src/ops/limits.ts");
  configureOps(config());
});
async function limits(env: NodeJS.ProcessEnv = {}, now = () => Date.now()) {
  const { configureOps } = await import("../src/ops/limits.ts");
  return configureOps(config(env), { now, log });
}
const capError = (kind: "calls" | "images") => (e: unknown) => e instanceof UpstreamError && e.status === 429 && e.message.includes(`daily_cap:${kind}`);
function stubFetch() {
  const calls: string[] = [];
  globalThis.fetch = (async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ id: "file-synthetic", data: [{ b64_json: Buffer.from("image").toString("base64") }], output: [] }), { status: 200 });
  }) as typeof fetch;
  return calls;
}
function http(base: string, path: string, method = "GET", body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method }, (res) => {
      let text = "";
      res.on("data", (b) => text += b);
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
function fakeSession(c = config(), userId?: string, ops?: SessionDeps["ops"], replyText = "Hi.") {
  const events: ServerEvent[] = [];
  const asr = Object.assign(new EventEmitter(), { isOpen: true, connect: async () => {}, sendAudio: () => {}, end: () => {} });
  let calls = 0;
  const deps: SessionDeps = {
    config: c, userId, ops, openAsr: () => asr,
    async *spark() { calls++; yield { type: "text", delta: replyText }; yield { type: "done", responseId: "r", text: replyText, status: "completed" }; },
    async *tts() {}, log,
  };
  const session = new Session("synthetic", { sendJson: (e) => events.push(e), sendBinary: () => {}, close: () => {} }, deps);
  return { deps, session, events, asr, calls: () => calls };
}
async function tick() { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function textTurn(s: ReturnType<typeof fakeSession>, text: string) {
  await s.session.onClientText(JSON.stringify({ type: "text", text }));
  await tick();
  const reply = s.events.filter((e) => e.type === "reply").at(-1);
  if (reply?.type === "reply") await s.session.onClientText(JSON.stringify({ type: "playback_done", utteranceId: reply.utteranceId }));
}
const start = JSON.stringify({ type: "start", persona: { name: "Synthetic" }, mic: false, greeting: false });

test("pause: generation REST and new WS get 503; health and read-only routes stay available", async () => {
  await limits();
  const dir = await mkdtemp(join(tmpdir(), "genita-ops-"));
  const env = { GENITA_DATA_DIR: dir, GENITA_PAUSED: "1" };
  const c = config(env);
  const fake = fakeSession(c);
  const server = await startServer(c, log, fake.deps, env, null);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const [path, method] of [["/v1/import", "POST"], ["/v1/companion/image", "POST"], ["/v1/companion", "POST"], ["/v1/companion/prefs", "POST"], ["/v1/companion/prep/retry", "POST"], ["/v1/companion/name/suggest", "POST"], ["/v1/companion/voices", "GET"], ["/v1/companion/voices/seamless:3/preview", "GET"], ["/v1/us-photos", "POST"]]) {
      assert.deepEqual(await http(base, path, method), { status: 503, body: { error: "paused" } });
    }
    assert.equal((await http(base, "/healthz")).status, 200);
    assert.equal((await http(base, "/v1/import")).status, 200);
    assert.equal((await http(base, "/v1/import/prompt")).status, 200);
    assert.equal((await http(base, "/v1/import/skip", "POST", { interests: ["Design"], replies: "Talk it out", avoid: ["Unasked advice"] })).status, 200);
    for (const path of ["/auth/email/start", "/auth/email/verify"]) {
      assert.deepEqual(await http(base, path, "POST"), { status: 503, body: { error: "accounts_disabled" } });
    }
    await http(base, "/v1/import", "POST");
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(base.replace("http", "ws") + "/v1/session");
      ws.on("unexpected-response", (_req, res) => { try { assert.equal(res.statusCode, 503); assert.equal(res.statusMessage, "Paused"); res.resume(); ws.terminate(); resolve(); } catch (e) { reject(e); } });
      ws.on("open", () => { ws.terminate(); reject(new Error("paused WS accepted")); });
      ws.on("error", () => {});
    });
    assert.equal(logs.filter((l) => l.event === "ops.paused" && l.data.kind === "POST /v1/import").length, 1);
    // Config is consulted for each request, so changing its pause value takes effect.
    c.paused = false;
    assert.notEqual((await http(base, "/v1/import", "POST")).status, 503);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test("Meta calls: third metaJson is blocked before fetch and limit logs once per day", async () => {
  await limits({ GENITA_META_DAILY_CALLS: "2" });
  const calls = stubFetch();
  await metaJson("x", "/responses", {});
  await metaJson("x", "/responses", {});
  for (let i = 0; i < 2; i++) await assert.rejects(metaJson("x", "/responses", {}), capError("calls"));
  assert.equal(calls.length, 2);
  assert.equal(logs.filter((l) => l.event === "limit.reached" && l.data.limit === "calls").length, 1);
});

test("images: Muse generations and edits share an image cap while text continues", async () => {
  const ops = await limits({ GENITA_META_DAILY_IMAGES: "2" });
  const calls = stubFetch();
  await museImageGenerate("x", "synthetic");
  await museImageEdit("x", Buffer.from("synthetic"), "edit");
  await assert.rejects(museImageGenerate("x", "blocked"), capError("images"));
  await metaJson("x", "/responses", {});
  assert.deepEqual(ops.usage(), { calls: 3, images: 2 });
  assert.equal(calls.length, 3);
});

test("UTC midnight resets counters and daily limit log suppression", async () => {
  let now = Date.parse("2026-11-03T23:59:59Z");
  const ops = await limits({ GENITA_META_DAILY_CALLS: "1", GENITA_META_DAILY_IMAGES: "1" }, () => now);
  stubFetch();
  await museImageGenerate("x", "synthetic");
  await assert.rejects(metaJson("x", "/responses", {}), capError("calls"));
  assert.equal(ops.usage().images, 1);
  now += 1000;
  assert.deepEqual(ops.usage(), { calls: 0, images: 0 });
  await metaJson("x", "/responses", {});
  await assert.rejects(metaJson("x", "/responses", {}), capError("calls"));
  assert.equal(logs.filter((l) => l.event === "limit.reached").length, 2);
});

test("user turns: third accepted text turn errors without Spark; another user is unaffected", async () => {
  const ops = await limits({ GENITA_USER_DAILY_TURNS: "2" });
  const a = fakeSession(config(), "a", ops), b = fakeSession(config(), "b", ops);
  try {
    await a.session.onClientText(start); await b.session.onClientText(start);
    await textTurn(a, "first"); await textTurn(a, "second"); await textTurn(a, "third"); await textTurn(b, "first");
    assert.equal(a.calls(), 2); assert.equal(b.calls(), 1);
    assert.ok(a.events.some((e) => e.type === "error" && e.retryable === false && e.message.includes("daily_cap:user_turns")));
    await textTurn(a, "fourth");
    assert.equal(logs.filter((l) => l.event === "limit.reached" && l.data.limit === "user_turns").length, 1);
  } finally { a.session.close(); b.session.close(); }
});

test("voice finals count once and speculation cannot call Spark past the user cap", async () => {
  const ops = await limits({ GENITA_USER_DAILY_TURNS: "1" });
  const s = fakeSession(config({ GENITA_SPECULATE: "1" }), "voice-user", ops);
  try {
    await s.session.onClientText(start);
    await s.session.onClientText(JSON.stringify({ type: "audio_start" }));
    s.asr.emit("event", { type: "speechComplete", turnId: 0, text: "First." });
    await tick();
    s.asr.emit("event", { type: "partial", text: "Second." });
    await tick();
    s.asr.emit("event", { type: "speechComplete", turnId: 1, text: "Second." });
    await tick();
    assert.equal(s.calls(), 1);
    assert.ok(s.events.some((e) => e.type === "error" && !e.retryable));
  } finally { s.session.close(); }
});

test("zero or negative caps are unlimited, and sessions without a user id are exempt", async () => {
  for (const cap of ["0", "-1"]) {
    const ops = await limits({ GENITA_META_DAILY_CALLS: cap, GENITA_META_DAILY_IMAGES: cap, GENITA_USER_DAILY_TURNS: cap });
    const calls = stubFetch();
    for (let i = 0; i < 4; i++) { await museImageGenerate("x", "synthetic"); assert.equal(await ops.acceptUserTurn("a"), true); }
    assert.equal(calls.length, 4);
  }
  const ops = await limits({ GENITA_USER_DAILY_TURNS: "1" });
  assert.equal(await ops.acceptUserTurn(undefined), true);
  assert.equal(await ops.acceptUserTurn(undefined), true);
});

test("database turns: admission never waits on the DB; usage_daily totals flow back, a restart allows at most one extra turn", async () => {
  const { OpsLimits } = await import("../src/ops/limits.ts");
  const db = await openDb("pglite:memory");
  try {
    await migrateUp(db);
    const a = (await db.query("INSERT INTO users (provider, provider_sub) VALUES ('dev', 'ops-a') RETURNING id")).rows[0].id;
    const b = (await db.query("INSERT INTO users (provider, provider_sub) VALUES ('dev', 'ops-b') RETURNING id")).rows[0].id;
    await db.exec("SET TIME ZONE 'Pacific/Honolulu'");
    let now = Date.parse("2026-11-04T00:00:01Z");
    const c = config({ GENITA_USER_DAILY_TURNS: "2" });
    const ops = new OpsLimits(c, { db, now: () => now, log });
    ops.prime(a);
    await ops.pending;
    // synchronous: no promise, order kept
    assert.deepEqual([ops.acceptUserTurn(a), ops.acceptUserTurn(a), ops.acceptUserTurn(a)], [true, true, false]);
    await ops.pending;
    const rows = await db.query("SELECT turns, day::text FROM usage_daily WHERE user_id = $1", [a]);
    assert.deepEqual(rows.rows, [{ turns: 2, day: "2026-11-04" }]);
    const restarted = new OpsLimits(c, { db, now: () => now });
    assert.equal(restarted.acceptUserTurn(a), true, "memory starts at 0 after a restart");
    await restarted.pending;
    assert.equal(restarted.acceptUserTurn(a), false, "the stored total (3) came back from usage_daily");
    assert.equal(ops.acceptUserTurn(b), true);
    now += 86_400_000;
    assert.equal(ops.acceptUserTurn(a), true);
    await ops.pending;
  } finally { await db.close(); }
});

test("database errors neither block nor bypass the per-user cap (memory still counts)", async () => {
  const { OpsLimits } = await import("../src/ops/limits.ts");
  const logs: string[] = [];
  const broken = new OpsLimits(config({ GENITA_USER_DAILY_TURNS: "2" }), { log: (e) => logs.push(e), db: { query: async () => { throw new Error("synthetic db failure"); } } as never });
  broken.prime("u");
  assert.deepEqual([broken.acceptUserTurn("u"), broken.acceptUserTurn("u")], [true, false], "only one turn while the DB is unconfirmed");
  await broken.pending;
  assert.deepEqual([broken.acceptUserTurn("u"), broken.acceptUserTurn("u")], [true, false], "a DB error unlocks admission at the memory count");
  await broken.pending;
  assert.equal(logs.filter((e) => e === "ops.turn_error").length, 1);
});

test("pause file: generation pauses while the file exists, without a restart", async () => {
  const { OpsLimits } = await import("../src/ops/limits.ts");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "genita-pause-"));
  const file = join(dir, "PAUSED");
  let now = 0;
  const ops = new OpsLimits({ pauseFile: file }, { now: () => now });
  try {
    assert.equal(ops.isPaused("x"), false);
    writeFileSync(file, "");
    assert.equal(ops.isPaused("x"), false, "checked at most every 5 s");
    now += 5_000;
    assert.equal(ops.isPaused("x"), true);
    rmSync(file);
    now += 5_000;
    assert.equal(ops.isPaused("x"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("all Meta wrappers count exactly once: SAM, files, forms, Finds and Spark streaming", async () => {
  const ops = await limits();
  const calls = stubFetch();
  await samDetect("x", "data:image/jpeg;base64,eA==", "box");
  await uploadFile("x", Buffer.from("x"), "x.jpg", "image/jpeg");
  await metaForm("x", "/files", new FormData());
  await metaVendors("x").spark({ input: "synthetic" });
  await metaVendors("x").sam("data:image/jpeg;base64,eA==", "box");
  await metaVendors("x").image("synthetic");
  globalThis.fetch = (async () => new Response('data: {"type":"response.completed","response":{"id":"r","status":"completed"}}\n\n')) as typeof fetch;
  for await (const _ of sparkStream("x", { input: "synthetic" })) {}
  assert.equal(calls.length, 6);
  assert.deepEqual(ops.usage(), { calls: 7, images: 1 });
});

test("Transcribe counts socket opens, never audio frames, and refuses past the call cap", async () => {
  const ops = await limits({ GENITA_META_DAILY_CALLS: "1" });
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  let connections = 0;
  wss.on("connection", () => connections++);
  const asr = new TranscribeStream({ key: "synthetic", languages: [], url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, maxReconnects: 0 });
  try {
    await asr.connect(); asr.sendAudio(Buffer.alloc(10)); asr.sendAudio(Buffer.alloc(10));
    assert.deepEqual(ops.usage(), { calls: 1, images: 0 });
    const blocked = new TranscribeStream({ key: "synthetic", languages: [], url: "ws://127.0.0.1:1" });
    await assert.rejects(blocked.connect(), capError("calls"));
    assert.equal(connections, 1);
  } finally { asr.end(); for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve())); }
});

test("REST budgets return structured 429 before starting generation, with independent image cap", async () => {
  const { getOps } = await import("../src/ops/limits.ts");
  const dir = await mkdtemp(join(tmpdir(), "genita-ops-"));
  const c = config({ GENITA_META_DAILY_IMAGES: "1", GENITA_META_DAILY_CALLS: "2" });
  const server = await startServer(c, log, fakeSession(c).deps, { GENITA_DATA_DIR: dir }, null);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    getOps().consumeMeta(true);
    assert.deepEqual(await http(base, "/v1/companion", "POST"), { status: 429, body: { error: "limit_reached", limit: "meta_images" } });
    assert.notEqual((await http(base, "/v1/import", "POST")).status, 429);
    getOps().consumeMeta();
    assert.deepEqual(await http(base, "/v1/import", "POST"), { status: 429, body: { error: "limit_reached", limit: "meta_calls" } });
    assert.deepEqual(await http(base, "/v1/companion/name/suggest", "POST"), { status: 429, body: { error: "limit_reached", limit: "meta_calls" } });
    assert.equal((await http(base, "/v1/import/skip", "POST", { replies: "Talk it out" })).status, 200);
    assert.equal((await http(base, "/v1/import")).status, 200);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test("ops usage log is nonzero and at most once every ten minutes; pause logs once per kind per minute", async () => {
  let now = Date.parse("2026-11-03T00:00:00Z");
  const ops = await limits({ GENITA_PAUSED: "1" }, () => now);
  ops.consumeMeta(); ops.consumeMeta(true);
  assert.equal(logs.filter((l) => l.event === "ops.usage").length, 1);
  now += 600_000; ops.consumeMeta(); ops.consumeMeta();
  assert.equal(logs.filter((l) => l.event === "ops.usage").length, 2);
  ops.isPaused("rest"); ops.isPaused("rest"); ops.isPaused("ws");
  assert.equal(logs.filter((l) => l.event === "ops.paused").length, 2);
  now += 60_000; ops.isPaused("rest");
  assert.equal(logs.filter((l) => l.event === "ops.paused").length, 3);
});


test("config: D46 defaults, overrides and invalid numeric fallbacks", () => {
  const c = config();
  assert.equal(c.paused, false);
  assert.equal(c.metaDailyCalls, 20_000);
  assert.equal(c.metaDailyImages, 600);
  assert.equal(c.userDailyTurns, 300);
  const overrides = config({ GENITA_PAUSED: "1", GENITA_META_DAILY_CALLS: "2", GENITA_META_DAILY_IMAGES: "3", GENITA_USER_DAILY_TURNS: "4" });
  assert.equal(overrides.paused, true);
  assert.equal(overrides.metaDailyCalls, 2);
  assert.equal(overrides.metaDailyImages, 3);
  assert.equal(overrides.userDailyTurns, 4);
  assert.equal(config({ GENITA_META_DAILY_CALLS: "NaN" }).metaDailyCalls, 20_000);
});

test("user memory counters roll over at UTC midnight; DB errors fail open (the call keeps answering)", async () => {
  let now = Date.parse("2026-11-03T23:59:59Z");
  const ops = await limits({ GENITA_USER_DAILY_TURNS: "1" }, () => now);
  assert.equal(await ops.acceptUserTurn("a"), true);
  assert.equal(await ops.acceptUserTurn("a"), false);
  now += 1000;
  assert.equal(await ops.acceptUserTurn("a"), true);
  const { OpsLimits } = await import("../src/ops/limits.ts");
  const broken = new OpsLimits(config(), { log, db: { query: async () => { throw new Error("synthetic db failure"); } } });
  const s = fakeSession(config(), "a", broken);
  try {
    await s.session.onClientText(start);
    await textTurn(s, "hello");
    assert.equal(s.calls(), 1);
    assert.ok(!s.events.some((e) => e.type === "error"));
  } finally { s.session.close(); }
});

function wsMessage(ws: WebSocket, predicate: (e: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", listener); reject(new Error("synthetic WS event timeout")); }, 2000);
    const listener = (data: WebSocket.RawData) => {
      const e = JSON.parse(data.toString());
      if (!predicate(e)) return;
      clearTimeout(timer); ws.off("message", listener); resolve(e);
    };
    ws.on("message", listener);
  });
}

test("WS admission: explicit dev users share turn caps across calls; anonymous sessions are exempt and running calls finish during pause", async () => {
  await limits();
  const dir = await mkdtemp(join(tmpdir(), "genita-ops-"));
  const c = config({ GENITA_USER_DAILY_TURNS: "1" });
  const fake = fakeSession(c);
  const server = await startServer(c, log, fake.deps, { GENITA_DATA_DIR: dir }, null);
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/session`;
  const clients: WebSocket[] = [];
  async function connect(user?: string) {
    const ws = new WebSocket(base, { headers: user ? { "x-genita-user": user } : {} });
    clients.push(ws); await once(ws, "open");
    const ready = wsMessage(ws, (e) => e.type === "ready"); ws.send(start); await ready;
    return ws;
  }
  async function turn(ws: WebSocket) {
    const result = wsMessage(ws, (e) => e.type === "reply" || e.type === "error");
    ws.send(JSON.stringify({ type: "text", text: "synthetic" }));
    return result;
  }
  try {
    const a = await connect("synthetic-user");
    assert.equal((await turn(a)).type, "reply");
    const b = await connect("synthetic-user");
    const error = await turn(b);
    assert.equal(error.type, "error"); assert.equal(error.retryable, false);
    const anonymous = await connect();
    assert.equal((await turn(anonymous)).type, "reply");
    c.paused = true;
    assert.equal((await turn(anonymous)).type, "reply");
    assert.equal(fake.calls(), 3);
  } finally {
    for (const client of clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fake.session.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("capped voice users reuse a matching speculative stream while turn admission awaits", async () => {
  const ops = await limits({ GENITA_USER_DAILY_TURNS: "2" });
  const s = fakeSession(config({ GENITA_SPECULATE: "1" }), "voice-user", ops);
  try {
    await s.session.onClientText(start);
    await s.session.onClientText(JSON.stringify({ type: "audio_start" }));
    s.asr.emit("event", { type: "partial", text: "First." });
    await tick();
    assert.equal(s.calls(), 1);
    s.asr.emit("event", { type: "speechComplete", turnId: 0, text: "First." });
    await tick();
    assert.equal(s.calls(), 1);
    assert.ok(s.events.some((e) => e.type === "turn.metrics" && e.speculative === "hit"));
  } finally { s.session.close(); }
});

test("paused restart leaves persisted prep jobs queued without resuming generation", async () => {
  await limits({ GENITA_PAUSED: "1" });
  const dir = await mkdtemp(join(tmpdir(), "genita-ops-"));
  const store = new FileStore(dir);
  let scans = 0;
  store.listCompanions = async () => { scans++; return []; };
  try {
    createPrep(config({ GENITA_PAUSED: "1" }), log, {}, store);
    await tick();
    assert.equal(scans, 0);
    await limits();
    createPrep(config(), log, {}, store);
    await tick();
    assert.equal(scans, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("round 2: pause file at startup skips prep resume and logs its kind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "genita-ops-pause-start-"));
  const file = join(dir, "PAUSED");
  const store = new FileStore(dir);
  let scans = 0;
  store.listCompanions = async () => { scans++; return []; };
  try {
    await writeFile(file, "");
    const c = config({ GENITA_PAUSE_FILE: file });
    assert.equal(c.paused, false);
    await limits({ GENITA_PAUSE_FILE: file });
    createPrep(c, log, {}, store);
    await tick();
    assert.equal(scans, 0, "a pause file must prevent resuming persisted generation");
    assert.ok(logs.some((l) => l.event === "ops.paused" && l.data.kind === "prep.resume"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("round 2: slow DB after restart allows only one unconfirmed turn while priming", async () => {
  const { OpsLimits } = await import("../src/ops/limits.ts");
  const queries: Array<{ sql: string; params?: unknown[]; resolve: (r: { rows: { turns: number }[]; rowCount: number }) => void }> = [];
  const db = { query: (sql: string, params?: unknown[]) => new Promise((resolve) => queries.push({ sql, params, resolve })) };
  const ops = new OpsLimits(config({ GENITA_USER_DAILY_TURNS: "3" }), { db: db as never });
  const s = fakeSession(config(), "restart-user", ops);
  try {
    await s.session.onClientText(start);
    ops.prime("restart-user");
    assert.deepEqual([ops.acceptUserTurn("restart-user"), ops.acceptUserTurn("restart-user"), ops.acceptUserTurn("restart-user")], [true, false, false]);
    assert.equal(queries.filter((q) => q.sql.startsWith("SELECT")).length, 1, "overlapping calls share one primer");
    assert.equal(ops.canSpeculate("restart-user"), false, "an unconfirmed extra turn cannot speculate");
    const read = queries.find((q) => q.sql.startsWith("SELECT"));
    assert.ok(read, "session start must prime usage_daily without waiting");
    assert.equal(read.params?.[0], "restart-user");
    assert.match(read.sql, /day\s*=\s*\$2::date/);
    read.resolve({ rows: [{ turns: 3 }], rowCount: 1 });
    await tick();
    assert.equal(ops.acceptUserTurn("restart-user"), false, "stored cap is enforced before the write answers");
    const write = queries.find((q) => q.sql.includes("INSERT INTO usage_daily"));
    assert.ok(write);
    write.resolve({ rows: [{ turns: 4 }], rowCount: 1 });
    await ops.pending;
    assert.equal(ops.acceptUserTurn("restart-user"), false);
  } finally { s.session.close(); }
});

test("round 2: an interpretation echo does not spend the second real utterance's turn", async () => {
  const ops = await limits({ GENITA_USER_DAILY_TURNS: "2" });
  const s = fakeSession(config(), "interpreter", ops, "Hello there.");
  try {
    await s.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Synthetic" }, mode: "interpret", greeting: false }));
    // (#750: a typed line before the pair is known is now translated at once, so it is not part of the skipped set)
    s.asr.emit("event", { type: "speechComplete", turnId: 0, text: "   " });
    s.asr.emit("event", { type: "speechComplete", turnId: 0, text: "…" });
    s.asr.emit("event", { type: "speechComplete", turnId: 1, text: "이거 얼마예요?" });
    await tick();
    assert.equal(s.calls(), 1);
    s.asr.emit("event", { type: "speechComplete", turnId: 2, text: "Hello there." });
    await tick();
    assert.equal(s.calls(), 1, "the translation echo must be dropped");
    s.asr.emit("event", { type: "speechComplete", turnId: 3, text: "혹시 이 근처에 약국 있어요?" });
    await tick();
    assert.equal(s.calls(), 2, "the next real utterance still has a turn");
    assert.ok(!s.events.some((e) => e.type === "error"));
    await s.session.onClientText(JSON.stringify({ type: "text", text: "This is a third real utterance." }));
    await tick();
    assert.equal(s.calls(), 2);
    assert.ok(s.events.some((e) => e.type === "error" && e.message.includes("daily_cap:user_turns") && !e.retryable));
  } finally { s.session.close(); }
});

test("round 2: capped text and voice turns leave listening as the last state, without thinking", async () => {
  for (const [source, busy] of [["text", false], ["voice", false], ["text", true], ["voice", true]] as const) {
    const ops = await limits({ GENITA_USER_DAILY_TURNS: "1" });
    const s = fakeSession(config(), source, ops);
    try {
      await s.session.onClientText(start);
      if (busy) {
        await s.session.onClientText(JSON.stringify({ type: "text", text: "First." }));
        await tick();
      } else await textTurn(s, "First.");
      const before = s.events.length;
      if (source === "text") await s.session.onClientText(JSON.stringify({ type: "text", text: "Over cap." }));
      else {
        await s.session.onClientText(JSON.stringify({ type: "audio_start" }));
        s.asr.emit("event", { type: "speechComplete", turnId: 2, text: "Over cap." });
      }
      await tick();
      assert.ok(s.events.slice(before).some((e) => e.type === "error" && e.message.includes("daily_cap:user_turns") && !e.retryable));
      assert.equal(s.calls(), 1);
      assert.equal(s.events.filter((e) => e.type === "state").at(-1)?.state, "listening");
      assert.ok(!s.events.slice(before).some((e) => e.type === "state" && e.state === "thinking"));
      if (busy) assert.ok(s.events.slice(before).some((e) => e.type === "utterance.cancelled"));
    } finally { s.session.close(); }
  }
});
