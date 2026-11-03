/** D41 Judge access: POST /auth/judge on the real server (startServer) with PGlite. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startServer, defaultDeps } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { createAccounts } from "../src/auth/index.ts";
import { JudgeAccess, parseJudgeCodes } from "../src/auth/judge.ts";
import { testDb } from "./helpers/db.ts";

async function boot(t: import("node:test").TestContext, codes: string | null = "alpha=correct-horse-1,beta=battery-staple-2", extraEnv: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "genita-judge-"));
  const env: NodeJS.ProcessEnv = { GENITA_DATA_DIR: dir, GENITA_JWT_SECRET: "j".repeat(40), GENITA_AUTH_RATE_PER_MIN: "1000", ...(codes ? { GENITA_JUDGE_CODES: codes } : {}), ...extraEnv };
  const config = { ...loadConfig({ MODEL_API_KEY: "m" }), port: 0 };
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const log = (event: string, data: Record<string, unknown>) => events.push({ event, data });
  const accounts = (await createAccounts(env, log, { loopback: true, db: await testDb(false) }))!;
  const server = await startServer(config, log, defaultDeps(config, log), env, accounts);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => setTimeout(r, 50));
    rmSync(dir, { recursive: true, force: true });
  });
  const judge = async (body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}/auth/judge`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const me = async (token: string) => fetch(`${base}/me`, { headers: { authorization: `Bearer ${token}` } }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  return { judge, me, events };
}

test("right code: a normal session for the demo account, consent still pending", async (t) => {
  const { judge, me, events } = await boot(t);
  const r = await judge({ code: "correct-horse-1" });
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.token, "string");
  assert.equal(r.body.isNew, true);
  assert.equal(r.body.consented, false, "CS01 is still shown");
  const m = await me(r.body.token);
  assert.equal(m.status, 200);
  assert.equal(m.body.user.id, r.body.user.id);
  // same code again → same account; the other code → a different account
  const again = await judge({ code: "correct-horse-1", device: "mac" });
  assert.equal(again.body.user.id, r.body.user.id);
  assert.equal(again.body.isNew, false);
  const other = await judge({ code: "battery-staple-2" });
  assert.notEqual(other.body.user.id, r.body.user.id);
  const audit = events.filter((e) => e.event === "auth.judge");
  assert.equal(audit.length, 3);
  assert.equal(audit[0].data.label, "alpha");
  assert.ok(!JSON.stringify(events).includes("correct-horse-1"), "the code is never logged");
});

test("wrong or missing code: 401/400, no token, audit line without the code", async (t) => {
  const { judge, events } = await boot(t);
  const bad = await judge({ code: "nope" });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.token, undefined);
  assert.equal((await judge({})).status, 400);
  assert.equal((await judge({ code: "correct-horse-1x" })).status, 401);
  assert.ok(events.some((e) => e.event === "auth.judge" && e.data.ok === false && e.data.reason === "wrong_code"));
  assert.ok(!JSON.stringify(events).includes('"nope"'));
});

// 11/4: judges share a venue / office IP — 50 misses per IP; distinct prefixes so the per-prefix backoff stays out of it
const miss = (i: number) => `${String(i).padStart(4, "0")}-wrong`;

test("rate limit: 50 wrong tries per IP, then 429 (with Retry-After) even for the right code", async (t) => {
  const { judge } = await boot(t);
  for (let i = 0; i < 50; i++) assert.equal((await judge({ code: miss(i) })).status, 401);
  const over = await judge({ code: miss(50) });
  assert.equal(over.status, 429);
  assert.match(String(over.body.message), /^Too many tries\. Try again in \d+ min\.$/);
  assert.equal((await judge({ code: "correct-horse-1" })).status, 429);
});

test("11/4: wrong guesses on one code prefix wait longer and longer; another prefix and the right code are unaffected", async (t) => {
  const { judge } = await boot(t);
  assert.equal((await judge({ code: "corr-guess-1" })).status, 401);
  assert.equal((await judge({ code: "corr-guess-2" })).status, 401);
  const slow = await judge({ code: "corr-guess-3" });
  assert.equal(slow.status, 429, "third miss on the same prefix right away");
  assert.ok(Number(slow.body.retryAfterSec) >= 1);
  assert.equal((await judge({ code: "battery-staple-2" })).status, 200, "another prefix (another judge's code)");
});

test("60 concurrent wrong tries from one IP: at most 50 get checked", async (t) => {
  const { judge } = await boot(t);
  const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => judge({ code: miss(i) })));
  assert.equal(rs.filter((r) => r.status === 401).length, 50);
  assert.equal(rs.filter((r) => r.status === 429).length, 10);
});

test("behind a proxy only the proxy-appended X-Forwarded-For entry counts, a forged first entry doesn't dodge the limit", async (t) => {
  const { judge } = await boot(t, undefined, { GENITA_TRUST_PROXY: "1" });
  const st: number[] = [];
  for (let i = 0; i < 52; i++) st.push((await judge({ code: miss(i) }, { "x-forwarded-for": `9.9.9.${i}, 203.0.113.7` })).status);
  assert.deepEqual(st.slice(48), [401, 401, 429, 429]);
  // another real client is not blocked by it
  assert.equal((await judge({ code: "nope" }, { "x-forwarded-for": "203.0.113.8" })).status, 401);
});

test("no codes configured: the route is off (404)", async (t) => {
  const { judge } = await boot(t, null);
  assert.equal((await judge({ code: "anything" })).status, 404);
});

test("JudgeAccess: window resets after 10 minutes; parse handles labels, bare codes, junk", () => {
  let now = 1_000_000;
  const j = new JudgeAccess("a=one, two ,,=x", () => now);
  for (let i = 0; i < 50; i++) assert.equal(j.check("1.1.1.1", `${String(i).padStart(4, "0")}bad`), null);
  assert.equal(j.limited("1.1.1.1"), true);
  assert.equal(j.limited("2.2.2.2"), false);
  now += 10 * 60_000 + 1;
  assert.equal(j.limited("1.1.1.1"), false);
  assert.equal(j.check("1.1.1.1", "one"), "a");
  assert.match(j.check("1.1.1.1", "two")!, /^j[0-9a-f]{8}$/);
  // per-prefix backoff grows (2 s, 4 s …) and lets the next try through once it has passed
  const k = new JudgeAccess("a=one", () => now);
  k.check("5.5.5.5", "xyzw-1"); k.check("6.6.6.6", "xyzw-2");
  assert.equal(k.retryAfterSec("7.7.7.7", "xyzw-3"), 2, "any IP, same prefix");
  assert.equal(k.retryAfterSec("7.7.7.7", "abcd-1"), 0);
  now += 2000;
  assert.equal(k.retryAfterSec("7.7.7.7", "xyzw-3"), 0);
  k.check("7.7.7.7", "xyzw-3");
  assert.equal(k.retryAfterSec("7.7.7.7", "xyzw-4"), 4);
  assert.equal(parseJudgeCodes("a=x,a=y").length, 1);
  assert.equal(parseJudgeCodes("").length, 0);
});
