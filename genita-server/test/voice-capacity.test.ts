import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadConfig } from "../src/config.ts";
import { defaultDeps } from "../src/server.ts";
import { Session, type ClientSink } from "../src/session/session.ts";
import { checkServerEvent } from "../src/protocol.ts";
import type { SparkStreamEvent } from "../src/meta/spark.ts";
import type { TtsChunk } from "../src/tts/types.ts";

// Dynamic import lets every missing behavior report its test name during the first red run.
async function seats(max: number) {
  const { createVoiceSeats } = await import("../src/tts/capacity.ts");
  return createVoiceSeats(max);
}

test("voice capacity gate: max 2, idempotent take/release, waiting count and reuse", async () => {
  const gate = await seats(2);
  assert.equal(gate.tryTake("one"), true);
  assert.equal(gate.tryTake("one"), true);
  assert.equal(gate.tryTake("two"), true);
  assert.equal(gate.holders(), 2);
  assert.equal(gate.tryTake("three"), false);
  assert.equal(gate.tryTake("three"), false);
  assert.equal(gate.waiting(), 1);
  gate.release("one");
  gate.release("one");
  assert.equal(gate.holders(), 1);
  assert.equal(gate.tryTake("three"), true);
  assert.equal(gate.waiting(), 0);
  assert.equal(gate.holders(), 2);
  assert.equal(gate.tryTake("four"), false);
  gate.release("four");
  assert.equal(gate.waiting(), 0, "closing an overflow call forgets its wait");
});

test("voice capacity gate: max 0 is unlimited", async () => {
  const gate = await seats(0);
  for (let n = 0; n < 100; n++) assert.equal(gate.tryTake(String(n)), true);
  assert.equal(gate.holders(), 100);
  assert.equal(gate.waiting(), 0);
  gate.release("0");
  gate.release("0");
  assert.equal(gate.holders(), 99);
});

test("voice capacity config: default 8 (11/3 load test: 8 calls on the autoscaled GPU, 0/32 turns fell back), zero unlimited, invalid values stay bounded", () => {
  const config = (value?: string) => loadConfig({ MODEL_API_KEY: "fake", GENITA_VOICE_MAX_CALLS: value });
  assert.equal(config().voiceMaxCalls, 8);
  assert.equal(config("0").voiceMaxCalls, 0);
  assert.equal(config("2").voiceMaxCalls, 2);
  for (const value of ["", "  ", "-1", "2.5", "NaN", "Infinity", "9007199254740992"]) {
    assert.equal(config(value).voiceMaxCalls, 8, value);
  }
});

class FakeAsr extends EventEmitter {
  isOpen = false;
  async connect() { this.isOpen = true; }
  sendAudio() {}
  end() { this.isOpen = false; }
}

class FakeClient implements ClientSink {
  json: Record<string, unknown>[] = [];
  bin: Buffer[] = [];
  sendJson(event: Record<string, unknown>) {
    assert.deepEqual(checkServerEvent(event), [], JSON.stringify(event));
    this.json.push(event);
  }
  sendBinary(frame: Buffer) { this.bin.push(frame); }
  close() {}
  of(type: string) { return this.json.filter((event) => event.type === type); }
  async waitFor(type: string, count = 1) {
    const end = Date.now() + 2000;
    while (this.of(type).length < count) {
      assert.ok(Date.now() < end, `timeout waiting for ${type}; got ${this.json.map((event) => event.type)}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return this.of(type)[count - 1];
  }
}

function latch() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

async function setup(t: TestContext, max = 2, productionGate = false, deviceFallback = true, env: Record<string, string> = {}) {
  // the seat-overflow → `say` tests below are the old device-fallback path: only an injected config reaches it now
  // (11/4 18:3x: the env can no longer turn it on)
  const loaded = loadConfig({ MODEL_API_KEY: "fake", GENITA_VOICE_URL: "https://voice.invalid", GENITA_VOICE_TOKEN: "fake", GENITA_VOICE_MAX_CALLS: String(max), GENITA_SPARK_HEDGE: "1", GENITA_SPECULATE: "0", ...env });
  const config = deviceFallback ? { ...loaded, voice: { ...loaded.voice!, deviceFallback: true } } : loaded;
  // defaultDeps constructs clients only; the harness replaces all vendor methods with fakes.
  const gate = productionGate ? defaultDeps(config, () => {}).voiceSeats! : await seats(max);
  assert.ok(gate);
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const sessions: Session[] = [];
  t.after(() => sessions.forEach((session) => session.close()));
  async function call(id: string, opts: { device?: boolean; interpret?: boolean; voice?: boolean; pause?: ReturnType<typeof latch>; failVoice?: boolean } = {}) {
    const client = new FakeClient();
    const calls: string[] = [];
    const prefetched: number[] = [];
    const session = new Session(id, client, {
      config: opts.voice === false ? { ...config, voice: null } : config,
      voiceSeats: gate,
      openAsr: () => new FakeAsr(),
      async *spark(): AsyncGenerator<SparkStreamEvent> {
        yield { type: "text", delta: "First sentence. " };
        if (opts.pause) await opts.pause.promise;
        yield { type: "text", delta: "Second sentence." };
        yield { type: "done", responseId: "fake", text: "", status: "completed" };
      },
      async *tts(req): AsyncGenerator<TtsChunk> {
        calls.push(req.text);
        if (opts.failVoice) throw new Error("voice down");
        yield { audio: Buffer.alloc(4800), alignment: null, model: "seamless-m4t-v2" };
      },
      voicePrefetch: (speaker) => { prefetched.push(speaker); },
      log: (event, data) => { logs.push({ event, data }); },
    });
    sessions.push(session);
    await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Test companion", kind: "human" }, tts: opts.device ? "device" : "server", mic: false, mode: opts.interpret ? "interpret" : "chat", interpret: { other: "Korean" } }));
    const reply = () => session.onClientText(JSON.stringify({ type: "text", text: "Please pass this along." }));
    return { session, client, calls, prefetched, reply };
  }
  return { gate, config, call, logs };
}

test("voice capacity wiring: production deps share one gate between sessions", async (t) => {
  const { gate, call } = await setup(t, 2, true);
  await call("one");
  await call("two");
  const overflow = await call("three");
  assert.equal(gate.holders(), 2);
  assert.equal(gate.waiting(), 1);
  await overflow.reply(); await overflow.client.waitFor("turn.metrics");
  assert.equal(overflow.calls.length, 0);
  assert.equal(overflow.client.of("say").length, 2);
});

test("voice capacity sessions: third call uses say with zero voice calls and one fallback log", async (t) => {
  const { gate, call, logs } = await setup(t);
  const one = await call("one"), two = await call("two"), three = await call("three");
  for (const c of [one, two, three]) { await c.reply(); await c.client.waitFor("turn.metrics"); }
  for (const c of [one, two]) {
    assert.ok(c.calls.length > 0);
    assert.ok(c.client.of("audio").length > 0);
    assert.ok(c.client.bin.length > 0);
    assert.equal(c.client.of("say").length, 0);
  }
  assert.deepEqual(three.client.of("say").map((event) => event.text), ["First sentence.", "Second sentence."]);
  assert.equal(three.calls.length, 0);
  assert.equal(three.prefetched.length, 0, "overflow must not send filler prefetch to the GPU");
  assert.equal(three.client.of("audio").length, 0);
  assert.equal(three.client.bin.length, 0);
  assert.equal(three.client.of("ready")[0].tts, "server", "wire contract stays unchanged");
  assert.equal(three.client.of("turn.metrics")[0].ttsModel, "device");
  assert.equal(three.client.of("error").length, 0, "capacity is an expected fallback");
  assert.equal(gate.holders(), 2);
  assert.equal(gate.waiting(), 1);
  assert.deepEqual(logs.filter((entry) => entry.event === "voice.capacity_fallback").map((entry) => entry.data), [{ session: "three", sessionId: "three", holders: 2, max: 2 }]);
  await three.reply(); await three.client.waitFor("turn.metrics", 2);
  assert.equal(logs.filter((entry) => entry.event === "voice.capacity_fallback").length, 1);
});

for (const interpret of [false, true]) {
  test(`voice capacity ${interpret ? "interpretation" : "chat"}: running reply stays say; ${interpret ? "interpretation stays on say" : "next reply restores server voice"}`, async (t) => {
    const { gate, call, logs } = await setup(t);
    const pause = latch();
    t.after(() => pause.open());
    const one = await call("one"), two = await call("two"), three = await call("three", { pause, interpret });
    await three.reply();
    await three.client.waitFor("say");
    one.session.close();
    pause.open();
    await three.client.waitFor("turn.metrics");
    assert.equal(three.client.of("say").length, 2);
    assert.equal(three.calls.length, 0, "a free seat must not change the running reply");
    assert.equal(three.client.bin.length, 0);
    assert.equal(gate.holders(), 1);
    assert.equal(logs.filter((entry) => entry.event === "voice.capacity_restored").length, 0);
    await three.reply();
    await three.client.waitFor("turn.metrics", 2);
    if (interpret) {
      // interpretation keeps the device voice while in overflow (no device/server PCM interleaving); chat restores
      assert.equal(three.calls.length, 0);
      assert.equal(three.client.bin.length, 0);
      assert.equal(three.client.of("say").length, 4);
      assert.equal(logs.filter((entry) => entry.event === "voice.capacity_restored").length, 0);
      two.session.close();
      return;
    }
    assert.ok(three.calls.length > 0);
    assert.ok(three.client.of("audio").length > 0);
    assert.ok(three.client.bin.length > 0);
    assert.equal(three.client.of("say").length, 2);
    assert.equal(gate.holders(), 2);
    assert.equal(gate.waiting(), 0);
    assert.equal(logs.filter((entry) => entry.event === "voice.capacity_restored" && entry.data.sessionId === "three").length, 1);
    await three.reply(); await three.client.waitFor("turn.metrics", 3);
    assert.equal(logs.filter((entry) => entry.event === "voice.capacity_restored").length, 1);
    two.session.close();
  });
}

test("voice capacity sessions: explicit device voice and no voice service never take seats", async (t) => {
  const { gate, call, logs } = await setup(t);
  const device = await call("device", { device: true });
  const legacy = await call("legacy", { voice: false });
  assert.equal(gate.holders(), 0);
  await device.reply(); await device.client.waitFor("turn.metrics");
  await legacy.reply(); await legacy.client.waitFor("turn.metrics");
  assert.equal(gate.holders(), 0);
  assert.equal(gate.waiting(), 0);
  assert.equal(device.calls.length, 0);
  assert.equal(logs.filter((entry) => entry.event.startsWith("voice.capacity_")).length, 0);
});

test("voice capacity sessions: every close path releases exactly once, including account deletion", async (t) => {
  const { gate, call } = await setup(t, 1);
  const release = gate.release.bind(gate);
  const released: string[] = [];
  gate.release = (id) => { released.push(id); release(id); };
  for (const [code, reason] of [[1000, "closed"], [1011, "error"], [4000, "idle"], [4001, "max_duration"], [4401, "account_deleted"]] as const) {
    const c = await call(reason);
    assert.equal(gate.holders(), 1);
    c.session.close(code, reason);
    c.session.close(code, reason);
    assert.equal(gate.holders(), 0, reason);
    assert.equal(released.filter((id) => id === reason).length, 1, reason);
  }
  const holder = await call("holder"), overflow = await call("overflow");
  assert.equal(gate.waiting(), 1);
  overflow.session.close(1011, "error");
  assert.equal(gate.waiting(), 0);
  holder.session.close();
  assert.equal(gate.holders(), 0);
});

test("voice capacity sessions: voice outage plus overflow stays on device without touching voice", async (t) => {
  const { call } = await setup(t, 1);
  const holder = await call("holder", { failVoice: true });
  await holder.reply(); await holder.client.waitFor("turn.metrics");
  assert.ok(holder.client.of("say").length > 0);
  const overflow = await call("overflow", { failVoice: true });
  await overflow.reply(); await overflow.client.waitFor("turn.metrics");
  assert.equal(overflow.calls.length, 0);
  assert.equal(overflow.client.of("say").length, 2);
  assert.equal(overflow.client.of("error").length, 0);
});

// 11/4 (Chelsea, build 7: "왜 여자 + 기계식"): by default a full GPU never hands the call to the phone's voice
test("voice capacity default (no device fallback): the third call keeps the companion's server voice, no say, one capacity_over log", async (t) => {
  const { gate, call, logs } = await setup(t, 2, false, false);
  const one = await call("one"), two = await call("two"), three = await call("three");
  for (const c of [one, two, three]) { await c.reply(); await c.client.waitFor("turn.metrics"); }
  for (const c of [one, two, three]) {
    assert.equal(c.client.of("say").length, 0, "no system voice");
    assert.ok(c.calls.length > 0 && c.client.of("audio").length > 0 && c.client.bin.length > 0, "server voice");
    assert.equal(c.client.of("turn.metrics")[0].ttsModel, "seamless-m4t-v2");
  }
  assert.ok(three.prefetched.length > 0, "fillers are prefetched for the over-cap call too");
  assert.equal(gate.holders(), 2);
  assert.equal(logs.filter((e) => e.event === "voice.capacity_fallback").length, 0);
  await three.reply(); await three.client.waitFor("turn.metrics", 2);
  assert.deepEqual(logs.filter((e) => e.event === "voice.capacity_over").map((e) => e.data.sessionId), ["three"], "logged once per stretch");
});

// 11/4 18:3x (Chelsea, TF 341: "robot voice"): a stale GENITA_VOICE_DEVICE_FALLBACK=1 in the env never sends `say` —
// not over the seat cap, not when the voice service fails (the companion's own voice is retried, then captions)
test("no robot voice: GENITA_VOICE_DEVICE_FALLBACK=1 in the env, full GPU and a failing voice service still send no say", async (t) => {
  const { call } = await setup(t, 1, false, false, { GENITA_VOICE_DEVICE_FALLBACK: "1" });
  const holder = await call("holder");
  await holder.reply(); await holder.client.waitFor("turn.metrics");
  const over = await call("over");
  await over.reply(); await over.client.waitFor("turn.metrics");
  const failing = await call("failing", { failVoice: true });
  await failing.reply(); await failing.client.waitFor("turn.metrics");
  for (const c of [holder, over, failing]) {
    assert.equal(c.client.of("say").length, 0, "never the phone's voice");
    assert.ok(!String(c.client.of("turn.metrics")[0].ttsModel ?? "").includes("device"), "ttsModel never device");
  }
  assert.ok(over.client.of("audio").length > 0, "the over-cap call keeps the server voice");
  assert.ok(failing.calls.length > 1, "the failing clause is retried in the companion's own voice");
});
