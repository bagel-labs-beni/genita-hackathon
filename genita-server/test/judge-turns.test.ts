/** D41 per-code daily turn cap for Judge access demo accounts (auth/judge.ts JudgeDailyTurns + Session turnGate). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { JudgeDailyTurns, judgeLabelOf, JUDGE_DAILY_TURNS_DEFAULT } from "../src/auth/judge.ts";
import { Session, type ClientSink, type SessionDeps } from "../src/session/session.ts";
import { checkServerEvent } from "../src/protocol.ts";
import { loadConfig, type Config } from "../src/config.ts";
import type { SparkStreamEvent } from "../src/meta/spark.ts";
import { startServer, defaultDeps } from "../src/server.ts";
import { createAccounts } from "../src/auth/index.ts";
import { OpsLimits } from "../src/ops/limits.ts";
import { testDb } from "./helpers/db.ts";

const DAY = 86_400_000;

test("JudgeDailyTurns: cap per label, peek doesn't spend, take refuses at the cap", () => {
  const t = new JudgeDailyTurns(3, () => Date.UTC(2026, 10, 5, 12));
  assert.equal(t.peek("alpha"), true);
  assert.equal(t.used("alpha"), 0, "peek spends nothing");
  assert.deepEqual([t.take("alpha"), t.take("alpha"), t.take("alpha"), t.take("alpha")], [true, true, true, false]);
  assert.equal(t.used("alpha"), 3, "a refused turn isn't counted");
  assert.equal(t.peek("alpha"), false);
});

test("JudgeDailyTurns: a new UTC day resets every label", () => {
  let now = Date.UTC(2026, 10, 5, 23, 59, 59);
  const t = new JudgeDailyTurns(1, () => now);
  assert.equal(t.take("alpha"), true);
  assert.equal(t.take("alpha"), false);
  now += 1000; // 00:00:00 UTC next day
  assert.equal(t.take("alpha"), true);
  assert.equal(t.take("alpha"), false);
  now += DAY;
  assert.equal(t.used("alpha"), 0);
});

test("JudgeDailyTurns: labels are isolated; gate() binds one label", () => {
  const t = new JudgeDailyTurns(1, () => 0);
  const a = t.gate("alpha");
  const b = t.gate("beta");
  assert.equal(a.take(), true);
  assert.equal(a.take(), false);
  assert.equal(b.peek(), true, "beta untouched by alpha");
  assert.equal(b.take(), true);
});

test("JudgeDailyTurns.fromEnv: default 200, 0 = no cap, junk = default", () => {
  assert.equal(JudgeDailyTurns.fromEnv(undefined).cap, JUDGE_DAILY_TURNS_DEFAULT);
  assert.equal(JUDGE_DAILY_TURNS_DEFAULT, 200);
  assert.equal(JudgeDailyTurns.fromEnv("5").cap, 5);
  assert.equal(JudgeDailyTurns.fromEnv("abc").cap, 200);
  assert.equal(JudgeDailyTurns.fromEnv("").cap, 200);
  const off = JudgeDailyTurns.fromEnv("0");
  for (let i = 0; i < 500; i++) assert.equal(off.take("x"), true);
});

test("judgeLabelOf: only dev rows with sub judge:<label>; Apple and dev-token users are not judges", () => {
  assert.equal(judgeLabelOf({ provider: "dev", providerSub: "judge:alpha" }), "alpha");
  assert.equal(judgeLabelOf({ provider: "dev", providerSub: "demo" }), null);
  assert.equal(judgeLabelOf({ provider: "apple", providerSub: "judge:alpha" }), null);
  assert.equal(judgeLabelOf({ provider: "dev", providerSub: "judge:" }), null);
});

// ── session level ──

const config: Config = {
  ...loadConfig({ MODEL_API_KEY: "x" }),
  serverTts: false,
  speculate: false,
  sparkHedge: 1,
};

class FakeAsr extends EventEmitter {
  isOpen = false;
  async connect() { this.isOpen = true; }
  sendAudio() {}
  end() { this.isOpen = false; }
}

class FakeClient implements ClientSink {
  json: Record<string, unknown>[] = [];
  closed: [number, string] | null = null;
  sendJson(m: Record<string, unknown>) {
    assert.deepEqual(checkServerEvent(m), [], JSON.stringify(m));
    this.json.push(m);
  }
  sendBinary() {}
  close(code: number, reason: string) { this.closed = [code, reason]; }
  of(type: string) { return this.json.filter((m) => m.type === type); }
  waitFor(pred: (m: Record<string, unknown>) => boolean, ms = 3000): Promise<Record<string, unknown>> {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        const hit = this.json.find(pred);
        if (hit) return resolve(hit);
        if (Date.now() - t0 > ms) return reject(new Error(`timeout; got ${this.json.map((m) => m.type).join(",")}`));
        setTimeout(tick, 2);
      };
      tick();
    });
  }
}

const persona = { name: "Companion", kind: "animal", traits: ["warm"] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeSpark(counter: { n: number }): SessionDeps["spark"] {
  return async function* (): AsyncGenerator<SparkStreamEvent> {
    counter.n++;
    yield { type: "text", delta: "Hi there." };
    yield { type: "done", responseId: "r", text: "Hi there.", status: "completed" };
  };
}

function setup(gate?: SessionDeps["turnGate"]) {
  const client = new FakeClient();
  const spark = { n: 0 };
  const session = new Session("j1", client, {
    config,
    openAsr: () => new FakeAsr(),
    spark: fakeSpark(spark),
    tts: () => { throw new Error("no server voice in these tests"); },
    turnGate: gate,
  });
  return { client, session, spark };
}

test("session: over the judge cap → daily_limit error, no Spark call, socket stays open, the next turn is refused too", async () => {
  const turns = new JudgeDailyTurns(1);
  const { client, session, spark } = setup(turns.gate("alpha"));
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "hello" }));
  await client.waitFor((m) => m.type === "reply");
  assert.equal(spark.n, 1);
  assert.equal(turns.used("alpha"), 1);

  await session.onClientText(JSON.stringify({ type: "text", text: "again" }));
  const err = await client.waitFor((m) => m.type === "error");
  assert.equal(err.code, "daily_limit");
  assert.equal(err.retryable, false);
  await sleep(30);
  assert.equal(spark.n, 1, "no Spark call over the cap");
  assert.equal(client.of("reply").length, 1);
  assert.equal(client.closed, null, "the call is not closed");
  assert.equal(client.of("state").at(-1)?.state, "listening", "the last state is listening (not a stuck thinking)");

  // still usable: pings answer, a further turn gets the same clear refusal
  await session.onClientText(JSON.stringify({ type: "ping", t: 1 }));
  await client.waitFor((m) => m.type === "pong");
  await session.onClientText(JSON.stringify({ type: "text", text: "and again" }));
  await sleep(30);
  assert.equal(client.of("error").filter((e) => e.code === "daily_limit").length, 2);
  assert.equal(spark.n, 1);
  assert.equal(turns.used("alpha"), 1, "refused turns aren't counted");
  session.close();
});

test("session: no gate (Apple / dev users) → never capped", async () => {
  const { client, session, spark } = setup(undefined);
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  for (let i = 0; i < 3; i++) {
    await session.onClientText(JSON.stringify({ type: "text", text: `turn ${i}` }));
    await client.waitFor((m) => m.type === "reply" && client.of("reply").length === i + 1);
  }
  assert.equal(spark.n, 3);
  assert.equal(client.of("error").length, 0);
  session.close();
});

test("session: interpretation lines count too; over the cap the line is closed (no stuck bubble), no Spark call", async () => {
  const turns = new JudgeDailyTurns(1);
  const { client, session, spark } = setup(turns.gate("alpha"));
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false, mode: "interpret", interpret: { other: "Korean" } }));
  await session.onClientText(JSON.stringify({ type: "text", text: "Tuesday works." }));
  await client.waitFor((m) => m.type === "reply");
  assert.equal(spark.n, 1);
  await session.onClientText(JSON.stringify({ type: "text", text: "Can we do 3 pm?" }));
  await client.waitFor((m) => m.type === "error" && m.code === "daily_limit");
  await sleep(30);
  assert.equal(spark.n, 1, "no translation call over the cap");
  assert.ok(client.of("error").some((e) => e.code === "daily_limit"));
  const last = client.of("interpret.bubble").at(-1)!;
  assert.equal(last.status, "cancelled", "the refused line's bubble is closed, not left hearing");
  assert.equal(client.closed, null);
  session.close();
});

test("session: a turn the judge cap refuses is not charged to the D46 per-user cap (one admission point)", async () => {
  const turns = new JudgeDailyTurns(1);
  const ops = new OpsLimits({ userDailyTurns: 2 });
  const client = new FakeClient();
  const spark = { n: 0 };
  const session = new Session("j2", client, {
    config, openAsr: () => new FakeAsr(), spark: fakeSpark(spark),
    tts: () => { throw new Error("no server voice in these tests"); },
    turnGate: turns.gate("alpha"), ops, userId: "u-judge",
  });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "hello" }));
  await client.waitFor((m) => m.type === "reply");
  await session.onClientText(JSON.stringify({ type: "text", text: "again" }));
  const err = await client.waitFor((m) => m.type === "error");
  assert.equal(err.code, "daily_limit", "the judge cap answers first, not the D46 error");
  assert.equal(spark.n, 1);
  // D46 spent exactly one turn for this user: one more is admitted, then the cap of 2 is reached
  const admitted: boolean[] = [];
  ops.userTurn("u-judge", () => admitted.push(true), () => admitted.push(false));
  ops.userTurn("u-judge", () => admitted.push(true), () => admitted.push(false));
  assert.deepEqual(admitted, [true, false]);
  session.close();
});

// ── end to end: Judge access JWT → WS call on the real server ──

test("server: a judge code's calls share one daily cap; another code and the dev user are unaffected", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genita-judge-turns-"));
  const env: NodeJS.ProcessEnv = {
    GENITA_DATA_DIR: dir, GENITA_JWT_SECRET: "j".repeat(40), GENITA_AUTH_RATE_PER_MIN: "1000",
    GENITA_JUDGE_CODES: "alpha=correct-horse-1,beta=battery-staple-2", GENITA_JUDGE_DAILY_TURNS: "1",
  };
  const cfg = { ...loadConfig({ MODEL_API_KEY: "m" }), port: 0, sparkHedge: 1, speculate: false };
  const spark = { n: 0 };
  const accounts = (await createAccounts(env, () => {}, { loopback: true, db: await testDb(false) }))!;
  const deps: SessionDeps = { ...defaultDeps(cfg, () => {}), memory: undefined, finds: undefined, openAsr: () => new FakeAsr(), spark: fakeSpark(spark) };
  const server = await startServer(cfg, () => {}, deps, env, accounts);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => setTimeout(r, 50));
    rmSync(dir, { recursive: true, force: true });
  });
  const signIn = async (code: string) => {
    const r = await fetch(`${base}/auth/judge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const token = ((await r.json()) as { token: string }).token;
    await fetch(`${base}/me/consent`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    return token;
  };
  /** one call: start, one typed turn → the first reply or error */
  const turn = (headers: Record<string, string>) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/v1/session", { headers });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "start", persona, mic: false }));
      ws.send(JSON.stringify({ type: "text", text: "hello" }));
    });
    ws.on("message", (d, binary) => {
      if (binary) return;
      const m = JSON.parse(String(d));
      if (m.type === "reply" || m.type === "error") { clearTimeout(timer); resolve(m); ws.close(); }
    });
    ws.on("error", reject);
    const timer = setTimeout(() => reject(new Error("no reply")), 4000);
  });
  const alpha = await signIn("correct-horse-1");
  assert.equal((await turn({ authorization: `Bearer ${alpha}` })).type, "reply");
  // a new call (and a new sign-in) with the same code shares the day's count
  const alpha2 = await signIn("correct-horse-1");
  const refused = await turn({ authorization: `Bearer ${alpha2}` });
  assert.deepEqual([refused.type, refused.code], ["error", "daily_limit"]);
  assert.equal(spark.n, 1);
  // the other code has its own allowance; the loopback dev user has none
  assert.equal((await turn({ authorization: `Bearer ${await signIn("battery-staple-2")}` })).type, "reply");
  assert.equal((await turn({})).type, "reply");
  assert.equal((await turn({})).type, "reply");
  assert.equal(spark.n, 4);
});
