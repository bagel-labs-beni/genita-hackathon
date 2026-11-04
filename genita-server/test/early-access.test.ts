import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createEarlyAccessRoute, normalizeEmail, toCsv, hashValue } from "../src/earlyAccess/routes.ts";
import { createAccounts } from "../src/auth/index.ts";
import { defaultDeps, startServer } from "../src/server.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.ts";
import { testDb } from "./helpers/db.ts";
import type { Db } from "../src/db/index.ts";

const ORIGIN = "https://bagel-labs-beni.github.io";
const SECRET = "s".repeat(40);

test("normalizeEmail trims, lowercases and refuses what is not an address", () => {
  assert.equal(normalizeEmail("  Someone@Example.COM "), "someone@example.com");
  assert.equal(normalizeEmail("a.b+tag@mail.co.kr"), "a.b+tag@mail.co.kr");
  for (const bad of ["", "nope", "a@b", "a@b.c", "@example.com", "a@@example.com", "a b@example.com", "a@exa mple.com", ".a@example.com", "a..b@example.com", "a@-x.com", "a@example.c1", 42, null, undefined, {}, "x".repeat(65) + "@example.com", "a@" + "x".repeat(250) + ".com"]) {
    assert.equal(normalizeEmail(bad as unknown), null, JSON.stringify(bad));
  }
});

test("toCsv quotes commas/quotes/newlines and defuses spreadsheet formulas", () => {
  const csv = toCsv([
    { email: "a@example.com", created_at: new Date("2026-11-05T00:00:00Z"), source: "x-teaser" },
    { email: "b@example.com", created_at: "2026-11-05T01:00:00Z", source: null },
    { email: "=cmd@example.com", created_at: "t", source: 'a,"b"' },
  ]);
  assert.equal(csv, 'email,created_at,source\na@example.com,2026-11-05T00:00:00.000Z,x-teaser\nb@example.com,2026-11-05T01:00:00Z,\n\'=cmd@example.com,t,"a,""b"""\n');
});

type Logged = { event: string; data: Record<string, unknown> };

async function harness(t: import("node:test").TestContext, opts: { enabled?: boolean; db?: Db | null } = {}) {
  const db = opts.db === undefined ? await testDb() : opts.db;
  if (db) t.after(() => db.close());
  const logs: Logged[] = [];
  let clock = 1_000_000;
  const route = createEarlyAccessRoute({
    db, log: (event, data) => logs.push({ event, data }), secret: SECRET, enabled: opts.enabled,
    ip: (req: IncomingMessage) => String(req.headers["x-test-ip"] ?? "1.1.1.1"), now: () => clock,
  });
  const server = createServer((req, res) => {
    if (route.handles(new URL(req.url ?? "/", "http://x").pathname)) return void route.handle(req, res);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/early-access`;
  const post = (body: unknown, h: Record<string, string> = {}) => fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...h },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { db, logs, base, post, tick: (ms: number) => { clock += ms; } };
}

test("POST stores a normalized address once, answers ok for duplicates, never logs the raw address", async (t) => {
  const h = await harness(t);
  let n = 0;
  const ip = () => ({ "x-test-ip": `10.0.0.${++n}` }); // a fresh caller per request, so the limiter stays out of the way
  const r1 = await h.post({ email: "  Someone@Example.com ", source: "X-Teaser" }, ip());
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { ok: true });
  assert.equal(r1.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(r1.headers.get("cache-control"), "no-store");
  const first = (await h.db!.query("SELECT email, source, ip_hash, created_at FROM early_access")).rows;
  assert.equal(first.length, 1);
  assert.equal(first[0].email, "someone@example.com");
  assert.equal(first[0].source, "x-teaser");
  assert.equal(first[0].ip_hash, hashValue(SECRET, "10.0.0.1"));
  assert.notEqual(first[0].ip_hash, "10.0.0.1");

  const r2 = await h.post({ email: "someone@example.com", source: "other" }, ip());
  assert.equal(r2.status, 200);
  assert.deepEqual(await r2.json(), { ok: true });
  const again = (await h.db!.query("SELECT email, source, created_at FROM early_access")).rows;
  assert.equal(again.length, 1, "idempotent upsert");
  assert.equal(again[0].source, "x-teaser", "the first signup is kept");
  assert.equal(new Date(again[0].created_at).getTime(), new Date(first[0].created_at).getTime());

  // a bad source is dropped, not an error
  assert.equal((await h.post({ email: "two@example.com", source: "<script>" }, ip())).status, 200);
  assert.equal((await h.db!.query("SELECT source FROM early_access WHERE email = 'two@example.com'")).rows[0].source, null);

  const signups = h.logs.filter((l) => l.event === "early_access.signup");
  assert.deepEqual(signups.map((l) => l.data.added), [true, false, true]);
  assert.equal(signups[0].data.emailHash, hashValue(SECRET, "someone@example.com"));
  const dump = JSON.stringify(h.logs);
  assert.ok(!dump.includes("someone@example.com") && !dump.includes("Someone@Example") && !dump.includes("two@example.com") && !dump.includes("10.0.0."), "no raw address or IP in logs");
});

test("POST refuses bad input with a stable error and stores nothing", async (t) => {
  const h = await harness(t);
  let n = 0;
  const ip = () => ({ "x-test-ip": `10.1.0.${++n}` });
  const err = async (r: Response) => ({ status: r.status, body: await r.json() });
  assert.deepEqual(await err(await h.post({ email: "not-an-email" }, ip())), { status: 400, body: { ok: false, error: "invalid_email" } });
  assert.deepEqual(await err(await h.post({}, ip())), { status: 400, body: { ok: false, error: "invalid_email" } });
  assert.deepEqual(await err(await h.post([1], ip())), { status: 400, body: { ok: false, error: "invalid_email" } });
  assert.deepEqual(await err(await h.post("{nope", ip())), { status: 400, body: { ok: false, error: "bad_json" } });
  assert.deepEqual(await err(await h.post({ email: "a@example.com", pad: "x".repeat(4096) }, ip())), { status: 413, body: { ok: false, error: "too_large" } });
  // honeypot: same answer as a real signup, nothing stored
  assert.deepEqual(await err(await h.post({ email: "bot@example.com", company: "Acme" }, ip())), { status: 200, body: { ok: true } });
  assert.equal((await h.db!.query("SELECT count(*)::int AS n FROM early_access")).rows[0].n, 0);
  const get = await fetch(h.base, { headers: { origin: ORIGIN } });
  assert.equal(get.status, 405);
});

test("CORS: only the landing origin gets a preflight and may post", async (t) => {
  const h = await harness(t);
  const pre = await fetch(h.base, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(pre.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /content-type/);
  assert.equal(pre.headers.get("vary"), "Origin");

  const evil = await fetch(h.base, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get("access-control-allow-origin"), null);

  const r = await h.post({ email: "x@example.com" }, { origin: "https://evil.example" });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  const noOrigin = await fetch(h.base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "y@example.com" }) });
  assert.equal(noOrigin.status, 403);
  assert.equal((await h.db!.query("SELECT count(*)::int AS n FROM early_access")).rows[0].n, 0);
});

test("rate limit: 5 posts per IP per minute, then 429 until the window passes; other IPs unaffected", async (t) => {
  const h = await harness(t);
  const from = (ip: string) => ({ "x-test-ip": ip });
  for (let i = 0; i < 5; i++) assert.equal((await h.post({ email: `r${i}@example.com` }, from("9.9.9.9"))).status, 200);
  const limited = await h.post({ email: "r5@example.com" }, from("9.9.9.9"));
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { ok: false, error: "rate_limited" });
  assert.equal(limited.headers.get("access-control-allow-origin"), ORIGIN, "the page can read the 429");
  assert.equal((await h.post({ email: "other@example.com" }, from("8.8.8.8"))).status, 200);
  h.tick(60_000);
  assert.equal((await h.post({ email: "r5@example.com" }, from("9.9.9.9"))).status, 200);
  assert.equal((await h.db!.query("SELECT count(*)::int AS n FROM early_access")).rows[0].n, 7);
});

test("kill switch and missing database", async (t) => {
  const off = await harness(t, { enabled: false });
  assert.equal((await off.post({ email: "a@example.com" })).status, 404);
  assert.equal((await fetch(off.base, { method: "OPTIONS", headers: { origin: ORIGIN } })).status, 404);
  assert.equal((await off.db!.query("SELECT count(*)::int AS n FROM early_access")).rows[0].n, 0);
  const noDb = await harness(t, { db: null });
  const r = await noDb.post({ email: "a@example.com" });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { ok: false, error: "unavailable" });
});

const config: Config = { ...loadConfig({ MODEL_API_KEY: "x" }), host: "127.0.0.1", port: 0, sessionToken: "early-access-test-token" };

test("server wiring: public route (no token) stores into the accounts DB; GENITA_EARLY_ACCESS=0 → 404", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genita-early-access-"));
  const env: NodeJS.ProcessEnv = { GENITA_DATA_DIR: dir, GENITA_JWT_SECRET: "j".repeat(40) };
  const db = await testDb(false);
  const accounts = (await createAccounts(env, () => {}, { loopback: true, db, mail: null }))!;
  const deps = { ...defaultDeps(config, () => {}), memory: undefined, finds: undefined };
  const server = await startServer(config, () => {}, deps, env, accounts);
  t.after(async () => {
    await new Promise((r) => server.close(r)); // closes the accounts DB too
    await new Promise((r) => setTimeout(r, 50));
    rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/early-access`;
  const pre = await fetch(url, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST" } });
  assert.equal(pre.status, 204);
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ email: "Wired@Example.com", source: "x-teaser" }) });
  assert.equal(r.status, 200);
  assert.deepEqual((await db.query("SELECT email, source FROM early_access")).rows, [{ email: "wired@example.com", source: "x-teaser" }]);

  const offServer = await startServer(config, () => {}, deps, { ...env, GENITA_EARLY_ACCESS: "0" }, null);
  t.after(() => new Promise((r) => offServer.close(r)));
  const offUrl = `http://127.0.0.1:${(offServer.address() as AddressInfo).port}/v1/early-access`;
  assert.equal((await fetch(offUrl, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ email: "a@example.com" }) })).status, 404);
});
