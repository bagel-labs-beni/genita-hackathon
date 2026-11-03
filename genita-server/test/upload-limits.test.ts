import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createAccounts, type AccountsService } from "../src/auth/index.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { OpsLimits } from "../src/ops/limits.ts";
import { startServer } from "../src/server.ts";
import type { SessionDeps } from "../src/session/session.ts";

/** Real HTTP, auth and Postgres; only synthetic images and mocked Meta responses. */
async function fixture(t: TestContext, persistent = false) {
  const dir = await mkdtemp(join(tmpdir(), "genita-upload-limits-"));
  const env = { GENITA_DATA_DIR: dir, GENITA_JWT_SECRET: "j".repeat(40) };
  const config = loadConfig({ MODEL_API_KEY: "synthetic", PORT: "0", GENITA_HTTP_KEEPALIVE_MS: "0", GENITA_META_DAILY_CALLS: "12" });
  const deps: SessionDeps = {
    config,
    openAsr() { throw new Error("ASR forbidden in upload tests"); },
    async *spark() { throw new Error("chat Spark forbidden in upload tests"); },
    async *tts() { throw new Error("TTS forbidden in upload tests"); },
  };
  let accounts: AccountsService;
  let server: Server | undefined;
  let closingDb: Promise<void> | undefined;
  let base = "";
  let vendorCalls = 0;
  let failVendor = false;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(base + "/")) return realFetch(input, init);
    assert.equal(url, "https://api.meta.ai/v1/responses", "unexpected external request");
    vendorCalls++;
    if (failVendor) return new Response("synthetic failure", { status: 503 });
    const body = JSON.parse(String(init?.body));
    const text = body.model === "sam-3.1" ? "" : JSON.stringify({
      subject: "person", face_count: 1, front_facing: true, sharp: true,
      well_lit: true, face_covered: false, text_on_image: false,
    });
    return Response.json({ id: "synthetic", output: [{ type: "message", content: [{ type: "output_text", text }] }] });
  });

  async function close() {
    if (server) {
      const current = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => current.close((err) => err ? reject(err) : resolve()));
      await closingDb;
    }
  }
  async function boot() {
    closingDb = undefined;
    accounts = (await createAccounts(env, () => {}, {
      loopback: true, mail: null,
      db: await openDb(persistent ? `pglite:${join(dir, "db")}` : "pglite:memory"),
    }))!;
    const closeDb = accounts.close;
    accounts.close = () => closingDb ??= closeDb();
    server = await startServer(config, () => {}, deps, env, accounts);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  await boot();

  async function user(sub: string) {
    const { user } = await accounts.accounts.upsertUser({ provider: "dev", sub });
    await accounts.accounts.consent(user.id, "ai_data", "v1", "iphone");
    const { sid, expiresAt } = await accounts.accounts.createSession(user.id, "iphone");
    return { id: user.id, token: accounts.signSession(user.id, sid, "iphone", expiresAt) };
  }
  async function upload(token: string, headerUser = "ignored") {
    const response = await fetch(base + "/v1/companion/image?rights=1", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-genita-user": headerUser, "content-type": "image/jpeg" },
      // a readable JPEG header (APP0 + SOF0 800×600): the photo-polish input check reads the frame size
      body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  return {
    user, upload,
    get db() { return accounts.db; },
    calls: () => vendorCalls,
    failVendor: () => { failVendor = true; },
    restart: async () => { await close(); await boot(); },
  };
}

test("uploads 1–5 succeed; sixth spends no Meta budget, other users work, and a server/DB restart keeps the cap", async (t) => {
  const f = await fixture(t, true);
  const a = await f.user("upload-a");
  const b = await f.user("upload-b");
  await f.db.query("INSERT INTO usage_daily (user_id, day, turns, clip_sets) VALUES ($1, $2::date, 7, 1)", [a.id, new Date().toISOString().slice(0, 10)]);
  for (let n = 0; n < 5; n++) assert.equal((await f.upload(a.token)).status, 200);
  const before = f.calls();
  assert.equal(before, 10);
  assert.deepEqual(await f.upload(a.token, "spoof-new-user"), { status: 429, body: { error: "limit_reached", limit: "user_uploads" } });
  assert.equal(f.calls(), before, "the capped upload must not call Spark or SAM");
  assert.equal((await f.upload(b.token)).status, 200, "another account still has the remaining shared budget");
  const totals = await f.db.query("SELECT uploads, turns, clip_sets FROM usage_daily WHERE user_id = $1", [a.id]);
  assert.deepEqual(totals.rows, [{ uploads: 5, turns: 7, clip_sets: 1 }]);
  assert.equal((await f.db.query("SELECT 1 FROM companion_images WHERE user_id = $1", [a.id])).rows.length, 5);
  await f.restart();
  const afterRestart = f.calls();
  assert.equal((await f.upload(a.token)).status, 429, "a fresh server must consult persisted usage");
  assert.equal(f.calls(), afterRestart);
});

test("concurrent uploads for one authenticated account admit exactly five before vendor I/O", async (t) => {
  const f = await fixture(t);
  const a = await f.user("upload-concurrent");
  const results = await Promise.all(Array.from({ length: 16 }, (_, n) => f.upload(a.token, `spoof-${n}`)));
  assert.equal(results.filter((r) => r.status === 200).length, 5);
  assert.equal(results.filter((r) => r.status === 429).length, 11);
  assert.equal(f.calls(), 10);
  assert.deepEqual((await f.db.query("SELECT uploads FROM usage_daily WHERE user_id = $1", [a.id])).rows, [{ uploads: 5 }]);
});

test("a failed vendor attempt keeps its reservation, and a DB reservation failure never reaches Meta", async (t) => {
  const f = await fixture(t);
  const a = await f.user("upload-failure");
  f.failVendor();
  assert.equal((await f.upload(a.token)).status, 502);
  assert.deepEqual((await f.db.query("SELECT uploads FROM usage_daily WHERE user_id = $1", [a.id])).rows, [{ uploads: 1 }]);
  const before = f.calls();
  const query = f.db.query.bind(f.db);
  t.mock.method(f.db, "query", async (sql: string, params?: unknown[]) => {
    if (sql.includes("INSERT INTO usage_daily")) throw new Error("synthetic DB reservation failure");
    return query(sql, params);
  });
  assert.equal((await f.upload(a.token)).status, 502);
  assert.equal(f.calls(), before, "DB failure must fail closed before any Meta call");
});

test("independent limiters share atomic DB reservations and roll over at UTC midnight regardless of DB timezone", async (t) => {
  const f = await fixture(t);
  const a = await f.user("upload-utc");
  await f.db.exec("SET TIME ZONE 'Pacific/Honolulu'");
  let now = Date.parse("2026-11-03T23:59:59Z");
  const first = new OpsLimits({}, { db: f.db, now: () => now });
  const second = new OpsLimits({}, { db: f.db, now: () => now });
  const results = await Promise.all(Array.from({ length: 20 }, (_, n) => (n % 2 ? first : second).reserveUpload(a.id)));
  assert.equal(results.filter(Boolean).length, 5);
  now += 1000;
  assert.equal(await second.reserveUpload(a.id), true);
  assert.deepEqual((await f.db.query("SELECT day::text, uploads FROM usage_daily WHERE user_id = $1 ORDER BY day", [a.id])).rows, [
    { day: "2026-11-03", uploads: 5 }, { day: "2026-11-04", uploads: 1 },
  ]);
});

test("without accounts, the dev-mode upload counter still caps concurrent requests and resets at UTC midnight", async () => {
  let now = Date.parse("2026-11-03T23:59:59Z");
  const ops = new OpsLimits({}, { now: () => now });
  const results = await Promise.all(Array.from({ length: 12 }, () => ops.reserveUpload("a")));
  assert.equal(results.filter(Boolean).length, 5);
  assert.equal(await ops.reserveUpload("b"), true);
  now += 1000;
  assert.equal(await ops.reserveUpload("a"), true);
});

test("upload cap logs user_uploads once per UTC day for DB and memory reservations", async () => {
  const memoryLogs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const dbLogs: Array<{ event: string; data: Record<string, unknown> }> = [];
  let now = Date.parse("2026-11-03T23:59:59Z");
  const memory = new OpsLimits({}, { now: () => now, log: (event, data) => memoryLogs.push({ event, data }) });
  for (let n = 0; n < 5; n++) assert.equal(await memory.reserveUpload("memory-user"), true);
  assert.equal(await memory.reserveUpload("memory-user"), false);
  assert.equal(await memory.reserveUpload("memory-user"), false);

  const db = await openDb("pglite:memory");
  try {
    await db.exec("CREATE TABLE usage_daily (user_id text NOT NULL, day date NOT NULL, uploads integer NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day))");
    const database = new OpsLimits({}, { db, now: () => now, log: (event, data) => dbLogs.push({ event, data }) });
    for (let n = 0; n < 5; n++) assert.equal(await database.reserveUpload("db-user"), true);
    assert.equal(await database.reserveUpload("db-user"), false);
    assert.equal(await database.reserveUpload("db-user"), false);
    for (const logs of [memoryLogs, dbLogs]) assert.equal(logs.filter((entry) => entry.event === "limit.reached" && entry.data.limit === "user_uploads").length, 1);
    assert.deepEqual(dbLogs.find((entry) => entry.event === "limit.reached" && entry.data.limit === "user_uploads")?.data, {
      limit: "user_uploads", day: "2026-11-03", count: 5,
    });

    now += 1_000;
    assert.equal(await memory.reserveUpload("memory-user"), true);
    for (let n = 0; n < 4; n++) assert.equal(await memory.reserveUpload("memory-user"), true);
    assert.equal(await memory.reserveUpload("memory-user"), false);
    for (let n = 0; n < 5; n++) assert.equal(await database.reserveUpload("next-day-user"), true);
    assert.equal(await database.reserveUpload("next-day-user"), false);
    for (const logs of [memoryLogs, dbLogs]) assert.equal(logs.filter((entry) => entry.event === "limit.reached" && entry.data.limit === "user_uploads").length, 2);
  } finally {
    await db.close();
  }
});
