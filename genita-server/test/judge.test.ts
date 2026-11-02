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

async function boot(t: import("node:test").TestContext, codes: string | null = "alpha=correct-horse-1,beta=battery-staple-2") {
  const dir = mkdtempSync(join(tmpdir(), "genita-judge-"));
  const env: NodeJS.ProcessEnv = { GENITA_DATA_DIR: dir, GENITA_JWT_SECRET: "j".repeat(40), GENITA_AUTH_RATE_PER_MIN: "1000", ...(codes ? { GENITA_JUDGE_CODES: codes } : {}) };
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
  const judge = async (body: unknown) => {
    const r = await fetch(`${base}/auth/judge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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

test("rate limit: 5 wrong tries per IP, then 429 even for the right code", async (t) => {
  const { judge } = await boot(t);
  for (let i = 0; i < 5; i++) assert.equal((await judge({ code: `wrong-${i}` })).status, 401);
  assert.equal((await judge({ code: "wrong-6" })).status, 429);
  assert.equal((await judge({ code: "correct-horse-1" })).status, 429);
});

test("no codes configured: the route is off (404)", async (t) => {
  const { judge } = await boot(t, null);
  assert.equal((await judge({ code: "anything" })).status, 404);
});

test("JudgeAccess: window resets after 10 minutes; parse handles labels, bare codes, junk", () => {
  let now = 1_000_000;
  const j = new JudgeAccess("a=one, two ,,=x", () => now);
  for (let i = 0; i < 5; i++) assert.equal(j.check("1.1.1.1", "bad"), null);
  assert.equal(j.limited("1.1.1.1"), true);
  assert.equal(j.limited("2.2.2.2"), false);
  now += 10 * 60_000 + 1;
  assert.equal(j.limited("1.1.1.1"), false);
  assert.equal(j.check("1.1.1.1", "one"), "a");
  assert.match(j.check("1.1.1.1", "two")!, /^j[0-9a-f]{8}$/);
  assert.equal(parseJudgeCodes("a=x,a=y").length, 1);
  assert.equal(parseJudgeCodes("").length, 0);
});
