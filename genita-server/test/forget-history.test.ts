import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { Session, type SessionDeps } from "../src/session/session.ts";
import type { SparkRequest } from "../src/meta/spark.ts";
import { InMemoryMemoryRepository, JsonMemoryRepository } from "../src/memory/repository.ts";
import { MemoryService } from "../src/memory/service.ts";

const FACT = "My favorite instrument is the oboe.";
const OTHER_FACT = "My favorite hobby is pottery.";
const config = { ...loadConfig({ MODEL_API_KEY: "fake", GENITA_SPECULATE: "0", GENITA_SPARK_HEDGE: "1", GENITA_WEB_SEARCH: "0" }), port: 0 };
const inputOf = (request: SparkRequest) => JSON.stringify(request.input);
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("test timed out");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function setup(t: TestContext, repo = new InMemoryMemoryRepository()) {
  const memory = new MemoryService({ repository: repo, state: repo, extract: async () => [] });
  const requests: SparkRequest[] = [];
  const logs: string[] = [];
  const deps: SessionDeps = {
    config, memory,
    openAsr() { throw new Error("ASR forbidden"); },
    async *spark(request) {
      requests.push(request);
      yield { type: "text", delta: "All right." };
      yield { type: "done", responseId: null, text: "All right.", status: "completed" };
    },
    async *tts() { throw new Error("TTS forbidden"); },
  };
  const server = await startServer(config, (event) => logs.push(event), deps, {}, null);
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await memory.drain();
  });
  async function open(user = "synthetic-a", start: Record<string, unknown> = {}) {
    const ws = new WebSocket(`${url.replace("http:", "ws:")}/v1/session`, { headers: { "x-genita-user": user } });
    sockets.push(ws);
    const events: Array<{ type: string; sessionId?: string }> = [];
    ws.on("message", (data) => events.push(JSON.parse(String(data))));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false, ...start }));
    await waitFor(() => events.some((event) => event.type === "ready"));
    const call = {
      ws, events,
      sessionId: events.find((event) => event.type === "ready")!.sessionId!,
      async say(text: string) {
        const before = events.filter((event) => event.type === "reply").length;
        ws.send(JSON.stringify({ type: "text", text }));
        await waitFor(() => events.filter((event) => event.type === "reply").length > before);
        return requests.findLast((request) => inputOf(request).includes(text))!;
      },
      async close() {
        const before = logs.filter((event) => event === "session.close").length;
        const closed = once(ws, "close"); ws.close(); await closed;
        await waitFor(() => logs.filter((event) => event === "session.close").length > before);
      },
    };
    return call;
  }
  async function forget(all: boolean) {
    const saved = await memory.remember("synthetic-a", FACT, "fact", "old-call"); assert.ok(saved);
    const response = await fetch(`${url}${all ? "/v1/memories" : `/me/memories/${saved.id}`}`, { method: "DELETE", headers: { "x-genita-user": "synthetic-a" } });
    assert.equal(response.status, 204);
    assert.deepEqual(await memory.list("synthetic-a"), []);
  }
  return { memory, requests, open, forget };
}

for (const all of [false, true]) {
  const label = all ? "forget-all" : "single forget";
  test(`${label}: ended call's cached turns never return in the next model input`, async (t) => {
    const { open, forget, requests } = await setup(t);
    const phone = await open(); await phone.say(FACT); await phone.close();
    await forget(all);
    requests.length = 0;
    const mac = await open(); await mac.say("What is my favorite instrument?");
    assert.doesNotMatch(JSON.stringify(requests), /oboe/);
  });

  test(`${label}: active call and its next device lose old turns; new turns still hand off`, async (t) => {
    const { open, forget } = await setup(t);
    const phone = await open(); await phone.say(FACT);
    await forget(all);
    const next = await phone.say("Let us discuss gardening now.");
    assert.doesNotMatch(inputOf(next), /oboe/);
    const mac = await open();
    const continued = await mac.say("Still with me?");
    assert.doesNotMatch(inputOf(continued), /oboe/);
    assert.match(inputOf(continued), /gardening/);
  });

  test(`${label}: a stopped call's late socket close cannot replace newer safe history`, async (t) => {
    const { open, forget } = await setup(t);
    const phone = await open(); await phone.say(FACT);
    let stopped = false;
    const close = Session.prototype.close;
    t.mock.method(Session.prototype, "close", function (this: Session, ...args: Parameters<Session["close"]>) {
      close.apply(this, args);
      if (this.id === phone.sessionId) stopped = true;
    });
    // Stop the Session (and its Forget subscription), but hold the close handshake until AFTER Forget.
    phone.ws.pause(); phone.ws.send(JSON.stringify({ type: "stop" }));
    await waitFor(() => stopped);
    await forget(all);
    const fresh = await open(); await fresh.say("Let us discuss gardening now."); await fresh.close();
    const lateClose = once(phone.ws, "close"); phone.ws.resume(); await lateClose;
    // The next call must read the new cache, not the old call's late close.
    const mac = await open(); const request = await mac.say("Still with me?");
    assert.doesNotMatch(inputOf(request), /oboe/);
    assert.match(inputOf(request), /gardening/);
  });
}

test("client handoff history is ignored after persisted Forget, including after a service restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "genita-forget-history-"));
  // retries: the memory repository may still be flushing when this runs (ENOTEMPTY flake, also on main)
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const file = join(dir, "memories.json");
  const repo = new JsonMemoryRepository(file);
  const old = new MemoryService({ repository: repo, state: repo, extract: async () => [] });
  await old.forget("synthetic-a");
  const { open, requests } = await setup(t, new JsonMemoryRepository(file));
  const mac = await open("synthetic-a", { handoff: true, history: [{ role: "user", text: FACT }], historyRevision: 0 });
  await mac.say("What is my favorite instrument?");
  assert.doesNotMatch(JSON.stringify(requests), /oboe/);
});

test("Forget isolates users and leaves normal ended-call handoff intact", async (t) => {
  const { open, forget } = await setup(t);
  const other = await open("synthetic-b"); await other.say(OTHER_FACT); await other.close();
  const phone = await open(); await phone.say(FACT); await phone.close();
  await forget(false);
  const mac = await open("synthetic-b"); const request = await mac.say("What is my favorite hobby?");
  assert.match(inputOf(request), /pottery/);
  assert.doesNotMatch(inputOf(request), /oboe/);
});

test("Forget while start is awaiting memory cannot restore client handoff history", async (t) => {
  const { memory, open, forget, requests } = await setup(t);
  let opening = false;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const original = memory.opening.bind(memory);
  t.mock.method(memory, "opening", async (...args: Parameters<MemoryService["opening"]>) => {
    const item = await original(...args);
    opening = true;
    await blocked;
    return item;
  });
  const starting = open("synthetic-a", { handoff: true, history: [{ role: "user", text: FACT }] });
  try {
    await waitFor(() => opening);
    await forget(false);
  } finally { release(); }
  const mac = await starting;
  await mac.say("What is my favorite instrument?");
  assert.doesNotMatch(JSON.stringify(requests), /oboe/);
});

for (const ended of [false, true]) {
  test(`persisted revision rejects ${ended ? "cached" : "live"} stale turns even without a Forget notification`, async (t) => {
    const { memory, open, forget, requests } = await setup(t);
    // Model a missed in-process notification: safety must still depend on persisted revision checks.
    t.mock.method(memory, "subscribe", () => () => {});
    const phone = await open(); await phone.say(FACT);
    if (ended) await phone.close();
    await forget(false);
    requests.length = 0;
    const mac = await open(); await mac.say("What is my favorite instrument?");
    assert.doesNotMatch(JSON.stringify(requests), /oboe/);
  });
}
