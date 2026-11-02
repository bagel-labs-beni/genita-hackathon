import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import type { SessionDeps } from "../src/session/session.ts";
import type { SparkRequest } from "../src/meta/spark.ts";
import { InMemoryMemoryRepository } from "../src/memory/repository.ts";
import { MemoryService } from "../src/memory/service.ts";

// #349: the review-D repro, using real local sockets/ownership and synthetic model replies only.
const OLD = "The old topic is pottery.";
const LATEST = "The latest decision is the cobalt teapot.";
const inputOf = (req: SparkRequest) => JSON.stringify(req.input);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for the local server");
    await tick();
  }
}

async function setup(t: TestContext) {
  const config = loadConfig({ MODEL_API_KEY: "fake", PORT: "0", GENITA_SPARK_HEDGE: "1",
    GENITA_WEB_SEARCH: "0", GENITA_SPECULATE: "0", GENITA_HTTP_KEEPALIVE_MS: "0" });
  const repo = new InMemoryMemoryRepository();
  const memory = new MemoryService({ repository: repo, state: repo, extract: async () => [] });
  const requests: SparkRequest[] = [];
  const logs: Array<{ event: string; session: unknown }> = [];
  const sockets: WebSocket[] = [];
  const data = await mkdtemp(join(tmpdir(), "genita-stale-history-"));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("external calls forbidden"); });
  const deps: SessionDeps = {
    config, memory,
    openAsr() { throw new Error("ASR forbidden"); },
    async *spark(req) {
      requests.push(req);
      yield { type: "text", delta: "Sure." };
      yield { type: "done", responseId: null, text: "Sure.", status: "completed" };
    },
    async *tts() { throw new Error("TTS forbidden"); },
  };
  const server = await startServer(config, (event, info) => logs.push({ event, session: info.session }), deps, { GENITA_DATA_DIR: data }, null);
  t.after(async () => {
    sockets.forEach((ws) => ws.terminate());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await memory.drain();
    await rm(data, { recursive: true, force: true });
  });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const { port } = address;
  async function claim(device: "iphone" | "mac", user: string) {
    await new Promise<void>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path: "/v1/handoff/claim", method: "POST",
        headers: { "x-genita-user": user, "content-type": "application/json" } }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += String(chunk); });
        res.on("end", () => {
          try { assert.equal(res.statusCode, 200); assert.equal(JSON.parse(body).accepted, true); resolve(); }
          catch (err) { reject(err); }
        });
      });
      req.on("error", reject);
      req.end(JSON.stringify({ device }));
    });
  }
  async function open(device: "iphone" | "mac" = "iphone", user = "synthetic-a") {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/session?device=${device}`, { headers: { "x-genita-user": user } });
    sockets.push(ws);
    const events: Array<{ type: string; sessionId?: string; utteranceId?: number }> = [];
    ws.on("message", (buf) => events.push(JSON.parse(String(buf))));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
    await until(() => events.some((event) => event.type === "ready"));
    await claim(device, user);
    return {
      async say(text: string) {
        const before = events.filter((event) => event.type === "reply").length;
        ws.send(JSON.stringify({ type: "text", text }));
        await until(() => events.filter((event) => event.type === "reply").length > before);
        const reply = events.findLast((event) => event.type === "reply")!;
        ws.send(JSON.stringify({ type: "playback_done", utteranceId: reply.utteranceId }));
        // A pong is ordered after playback_done, so the next turn cannot race its server handler.
        const pong = once(ws, "pong"); ws.ping(); await pong;
        return requests.findLast((req) => inputOf(req).includes(text))!;
      },
      claim: () => claim(device, user),
      async close() {
        const sessionId = events.find((event) => event.type === "ready")!.sessionId;
        const closed = once(ws, "close"); ws.close(); await closed;
        await until(() => logs.some((log) => log.event === "session.close" && log.session === sessionId));
      },
    };
  }
  return { open };
}

for (const capped of [false, true]) {
  const label = capped ? "at the 16-message history cap" : "below the history cap";
  async function oldPhone(open: Awaited<ReturnType<typeof setup>>["open"]) {
    const phone = await open();
    await phone.say(OLD);
    if (capped) for (let i = 1; i < 8; i++) await phone.say(`Earlier pottery detail number ${i}.`);
    return phone;
  }

  test(`#349 ${label}: newer cache beats an older still-open device`, async (t) => {
    const { open } = await setup(t);
    await oldPhone(open);
    const mac = await open("mac"); await mac.say(LATEST); await mac.close();
    const next = await open();
    assert.match(inputOf(await next.say("What did we just decide?")), /cobalt teapot/);
  });

  test(`#349 ${label}: an older device closing late cannot overwrite newer cached turns`, async (t) => {
    const { open } = await setup(t);
    const phone = await oldPhone(open);
    const mac = await open("mac"); await mac.say(LATEST); await mac.close();
    await phone.close();
    const next = await open();
    assert.match(inputOf(await next.say("What was our decision?")), /cobalt teapot/);
  });

  test(`#349 ${label}: live history follows turn order rather than socket order or length`, async (t) => {
    const { open } = await setup(t);
    const phone = await oldPhone(open);
    const mac = await open("mac"); await mac.say(LATEST);
    await phone.claim(); await phone.say("The final choice is an amber bowl.");
    const next = await open();
    const input = inputOf(await next.say("What is the final choice?"));
    assert.match(input, /amber bowl/);
    assert.doesNotMatch(input, /cobalt teapot/);
  });
}

test("#349: closing an idle inherited snapshot never promotes it over later conversation progress", async (t) => {
  const { open } = await setup(t);
  const phone = await open(); await phone.say(OLD);
  const idle = await open("mac");
  await phone.claim(); await phone.say(LATEST); await phone.close();
  await idle.close();
  const next = await open();
  assert.match(inputOf(await next.say("What was our decision?")), /cobalt teapot/);
});

test("#349: competing live and cached history never crosses account boundaries", async (t) => {
  const { open } = await setup(t);
  const phone = await open(); await phone.say(OLD);
  const mac = await open("mac"); await mac.say(LATEST); await mac.close();
  const other = await open("mac", "synthetic-b"); await other.say("My project is a saffron kite."); await other.close();
  const next = await open();
  const input = inputOf(await next.say("What did we just decide?"));
  assert.match(input, /cobalt teapot/);
  assert.doesNotMatch(input, /saffron kite/);
  const otherNext = await open("iphone", "synthetic-b");
  const otherInput = inputOf(await otherNext.say("What is my project?"));
  assert.match(otherInput, /saffron kite/);
  assert.doesNotMatch(otherInput, /pottery|cobalt/);
});
