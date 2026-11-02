import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, FRAME_HEADER_BYTES, type ClientSink, type SessionDeps } from "../src/session/session.ts";
import type { Config } from "../src/config.ts";
import { checkServerEvent } from "../src/protocol.ts";
import type { AsrEvent } from "../src/meta/transcribe.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import type { TtsChunk } from "../src/tts/elevenlabs.ts";

// these tests cover server TTS mode (GENITA_SERVER_TTS=1); device mode: session-device.test.ts
const config: Config = {
  metaKey: "x",
  elevenKey: "y",
  serverTts: true,
  kling: false,
  peter: false,
  host: "127.0.0.1",
  port: 0,
  sessionToken: null,
  ttsModel: "eleven_v4_turbo",
  ttsFallbackModel: "eleven_v3",
  defaultVoiceId: "voice",
  webSearch: false,
  asrLanguages: ["English", "Korean"],
  bargeInMinMs: 400,
  bargeInMinWords: 2,
  maxSessions: 4,
  maxSessionMs: 60_000,
  sparkFirstTokenTimeoutMs: 8000,
  sparkHedge: 1,
  speculate: false,
  speculateStableMs: 250,
};

class FakeAsr extends EventEmitter {
  isOpen = false;
  audio = 0;
  async connect() {
    this.isOpen = true;
  }
  sendAudio(pcm: Buffer) {
    this.audio += pcm.length;
  }
  end() {
    this.isOpen = false;
  }
  fire(e: AsrEvent) {
    this.emit("event", e);
  }
}

class FakeClient implements ClientSink {
  json: Record<string, unknown>[] = [];
  bin: Buffer[] = [];
  closed: [number, string] | null = null;
  sendJson(m: Record<string, unknown>) {
    // every event the session emits must match the wire spec (F0-L4)
    assert.deepEqual(checkServerEvent(m), [], JSON.stringify(m));
    this.json.push(m);
  }
  sendBinary(b: Buffer) {
    this.bin.push(b);
  }
  close(code: number, reason: string) {
    this.closed = [code, reason];
  }
  types() {
    return this.json.map((m) => m.type);
  }
  waitFor(pred: (m: Record<string, unknown>) => boolean, ms = 2000): Promise<Record<string, unknown>> {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        const hit = this.json.find(pred);
        if (hit) return resolve(hit);
        if (Date.now() - t0 > ms) return reject(new Error(`timeout; got ${this.types().join(",")}`));
        setTimeout(tick, 2);
      };
      tick();
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(opts: { sparkText?: string; ttsChunks?: number; ttsDelayMs?: number } = {}) {
  const asr = new FakeAsr();
  const client = new FakeClient();
  const sparkCalls: SparkRequest[] = [];
  const ttsCalls: string[] = [];
  let ttsAborted = 0;
  const deps: SessionDeps = {
    config,
    openAsr: () => asr,
    async *spark(req, { signal }): AsyncGenerator<SparkStreamEvent> {
      sparkCalls.push(req);
      const text = opts.sparkText ?? "<happy> Hey you! That sounds great.";
      for (const piece of text.match(/.{1,6}/gs) ?? []) {
        if (signal?.aborted) return;
        await sleep(1);
        yield { type: "text", delta: piece };
      }
      yield { type: "done", responseId: "r1", text, status: "completed" };
    },
    async *tts(req): AsyncGenerator<TtsChunk> {
      ttsCalls.push(req.text);
      for (let i = 0; i < (opts.ttsChunks ?? 2); i++) {
        await sleep(opts.ttsDelayMs ?? 1);
        if (req.signal?.aborted) {
          ttsAborted++;
          return;
        }
        // 20 ms of audio per chunk
        yield { audio: Buffer.alloc(960), alignment: { chars: ["a", "b"], startsSec: [0.0, 0.01], endsSec: [0.01, 0.02] }, model: req.model };
      }
    },
  };
  const session = new Session("s1", client, deps);
  return { asr, client, session, sparkCalls, ttsCalls, ttsAborted: () => ttsAborted };
}

const persona = { name: "Mina", kind: "animal", traits: ["warm"] };

test("start → ready with lip plan; a voice turn streams reply text, framed audio and a final reply", async () => {
  const { asr, client, session, ttsCalls } = setup();
  await session.onClientText(JSON.stringify({ type: "start", persona, lip: "atlas" }));
  const ready = client.json.find((m) => m.type === "ready")!;
  assert.deepEqual(ready.lip, { requested: "atlas", active: "atlas", reason: null });
  assert.equal(ready.tts, "server");

  asr.fire({ type: "speechStart", turnId: 0 });
  asr.fire({ type: "speechEnd", turnId: 0 });
  asr.fire({ type: "speechComplete", turnId: 0, text: "I got the job" });
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "Hey you! That sounds great.");
  assert.equal(reply.emotion, "happy");
  assert.deepEqual(ttsCalls, ["Hey you!", "That sounds great."]);

  const audio = client.json.filter((m) => m.type === "audio");
  assert.equal(audio.length, 4);
  assert.ok(Array.isArray(audio[0].mouth), "atlas sessions get mouth cues");
  assert.equal(client.bin.length, 4);
  const frame = client.bin[0];
  assert.equal(frame.subarray(0, 2).toString("latin1"), "GA");
  assert.equal(frame.readUInt8(2), 1);
  assert.equal(frame.readUInt32LE(4), audio[0].seq);
  assert.equal(frame.length, FRAME_HEADER_BYTES + 960);
  // second sentence's timeline continues after the first sentence's audio
  assert.equal(audio[2].offsetMs, 40);

  const deltas = client.json.filter((m) => m.type === "reply.delta").map((m) => m.text).join("");
  assert.equal(deltas, "Hey you! That sounds great.");
  const states = client.json.filter((m) => m.type === "state").map((m) => m.state);
  assert.deepEqual(states.slice(0, 3), ["listening", "thinking", "speaking"]);
  await client.waitFor((m) => m.type === "state" && m.state === "listening" && client.json.indexOf(m) > 0, 2000);
  session.close();
});

test("server-mode session on the real 'off' TTS dep (no GENITA_SERVER_TTS): reply text streams, no audio, no tts error, back to listening", async () => {
  const { loadConfig } = await import("../src/config.ts");
  const { defaultDeps } = await import("../src/server.ts");
  const meta = loadConfig({ MODEL_API_KEY: "m" });
  assert.equal(meta.elevenKey, null, "config loads without ElevenLabs");
  // (with serverTts off a real session runs in device mode and never calls tts: session-device.test.ts)
  const { asr, client, session } = setup();
  (session as unknown as { deps: SessionDeps }).deps.tts = defaultDeps(meta, () => {}).tts; // the real "off" dep, no vendor call
  await session.onClientText(JSON.stringify({ type: "start", persona, lip: "none" }));
  asr.fire({ type: "speechStart", turnId: 0 });
  asr.fire({ type: "speechEnd", turnId: 0 });
  asr.fire({ type: "speechComplete", turnId: 0, text: "I got the job" });
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "Hey you! That sounds great.");
  assert.equal(client.json.filter((m) => m.type === "reply.delta").map((m) => m.text).join(""), "Hey you! That sounds great.");
  assert.equal(client.bin.length, 0, "no audio frames");
  assert.equal(client.json.filter((m) => m.type === "error").length, 0, "text-only is not an error");
  await client.waitFor((m) => m.type === "state" && m.state === "listening" && client.json.indexOf(m) > 0, 2000);
  session.close();
});

test("barge-in: two words while speaking cancel Spark+TTS, tell the app, and stop audio", async () => {
  const { asr, client, session, ttsAborted } = setup({
    sparkText: "<warm> Once upon a time there was a fox. It lived in a forest. It loved snow. The end.",
    ttsChunks: 50,
    ttsDelayMs: 5,
  });
  await session.onClientText(JSON.stringify({ type: "start", persona }));
  asr.fire({ type: "speechComplete", turnId: 0, text: "tell me a story" });
  await client.waitFor((m) => m.type === "state" && m.state === "speaking");
  asr.fire({ type: "speechStart", turnId: 1 });
  asr.fire({ type: "partial", text: "wait stop" });
  const cancelled = await client.waitFor((m) => m.type === "utterance.cancelled");
  assert.equal(cancelled.reason, "barge_in");
  const audioCount = client.bin.length;
  await sleep(40);
  assert.equal(client.bin.length, audioCount, "no audio after cancel");
  assert.ok(ttsAborted() >= 1, "TTS request saw the abort");
  assert.ok(!client.json.some((m) => m.type === "reply"), "cancelled reply never finalizes");
  session.close();
});

test("a Korean transcript in chat mode is interpreted, not answered as chat", async () => {
  const { asr, client, session, sparkCalls } = setup({ sparkText: "<neutral> He's asking how to get to City Hall." });
  await session.onClientText(JSON.stringify({ type: "start", persona }));
  asr.fire({ type: "speechComplete", turnId: 0, text: "실례합니다, 시청 어떻게 가요?" });
  await client.waitFor((m) => m.type === "reply");
  assert.deepEqual(client.json.find((m) => m.type === "interpret.detected"), { type: "interpret.detected", from: "Korean", to: "English" });
  assert.match(sparkCalls[0].instructions ?? "", /Someone near the user just spoke Korean/);
  session.close();
});

test("camera frames attach as input_image to the next turn only", async () => {
  const { client, session, sparkCalls } = setup({ sparkText: "<curious> That's a red mug." });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "frames", images: ["AAAA", "BBBB"] }));
  await session.onClientText(JSON.stringify({ type: "text", text: "what am I holding?" }));
  await client.waitFor((m) => m.type === "reply");
  const last = (sparkCalls[0].input as Array<{ role: string; content: unknown }>).at(-1)!;
  assert.ok(Array.isArray(last.content));
  const parts = last.content as Array<{ type: string; image_url?: string }>;
  assert.deepEqual(parts.map((p) => p.type), ["input_text", "input_image", "input_image"]);
  assert.equal(parts[1].image_url, "data:image/jpeg;base64,AAAA");
  assert.match(sparkCalls[0].instructions ?? "", /camera frames are attached/);
  session.close();
});

test("messages before start are rejected; peter without a worker degrades to the fallback", async () => {
  const { client, session } = setup();
  await session.onClientText(JSON.stringify({ type: "text", text: "hi" }));
  assert.equal(client.json[0].code, "not_started");
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Peter", kind: "human" }, lip: { mode: "peter", fallback: "none" } }));
  const ready = client.json.find((m) => m.type === "ready")!;
  assert.deepEqual(ready.lip, { requested: "peter", active: "none", reason: "peter_not_deployed" });
  session.close();
});

test("a reply opening with the same interjection as a recent reply is spoken and captioned without it", async () => {
  const { client, session, ttsCalls } = setup({ sparkText: "<happy> Oh, that's huge! Tell me more." });
  await session.onClientText(
    JSON.stringify({ type: "start", persona, mic: false, history: [{ role: "user", text: "hi" }, { role: "assistant", text: "Oh, hey you!" }] }),
  );
  await session.onClientText(JSON.stringify({ type: "text", text: "I got the job" }));
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "That's huge! Tell me more.");
  assert.equal(ttsCalls[0], "That's huge!");
  const captions = client.json.filter((m) => m.type === "reply.delta").map((m) => m.text).join("");
  assert.equal(captions, "That's huge! Tell me more.");
  session.close();
});

test("an empty Spark answer (e.g. a web search that never produced text) is retried once without tools", async () => {
  const asr = new FakeAsr();
  const client = new FakeClient();
  const calls: SparkRequest[] = [];
  const session = new Session("s2", client, {
    config: { ...config, webSearch: true },
    openAsr: () => asr,
    async *spark(req): AsyncGenerator<SparkStreamEvent> {
      calls.push(req);
      if (calls.length === 1) {
        yield { type: "tool", name: "web_search", status: "completed" };
        yield { type: "done", responseId: "r1", text: "", status: "incomplete" };
        return;
      }
      yield { type: "text", delta: "<happy> Try a comedy special tonight." };
      yield { type: "done", responseId: "r2", text: "x", status: "completed" };
    },
    async *tts(): AsyncGenerator<TtsChunk> {
      yield { audio: Buffer.alloc(96), alignment: null, model: "m" };
    },
  });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "what should I watch tonight?" }));
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "Try a comedy special tonight.");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].tools?.length);
  assert.equal(calls[1].tools, undefined);
  session.close();
});

function specSetup() {
  const asr = new FakeAsr();
  const client = new FakeClient();
  const calls: { input: string; aborted: () => boolean }[] = [];
  const session = new Session("spec", client, {
    config: { ...config, speculate: true, speculateStableMs: 1000 },
    openAsr: () => asr,
    async *spark(req, { signal }): AsyncGenerator<SparkStreamEvent> {
      const input = req.input as Array<{ content: unknown }>;
      calls.push({ input: String(input.at(-1)!.content), aborted: () => !!signal?.aborted });
      await sleep(5);
      if (signal?.aborted) return;
      yield { type: "text", delta: "<happy> Congrats!" };
      yield { type: "done", responseId: "r", text: "x", status: "completed" };
    },
    async *tts(): AsyncGenerator<TtsChunk> {
      yield { audio: Buffer.alloc(96), alignment: null, model: "m" };
    },
  });
  return { asr, client, session, calls };
}

test("speculation: a punctuated partial starts Spark early; a matching final reuses it (hit)", async () => {
  const { asr, client, session, calls } = specSetup();
  await session.onClientText(JSON.stringify({ type: "start", persona }));
  asr.fire({ type: "speechStart", turnId: 0 });
  asr.fire({ type: "partial", text: "I got the job." });
  assert.equal(calls.length, 1, "speculative call started on the partial");
  asr.fire({ type: "speechEnd", turnId: 0 });
  asr.fire({ type: "speechComplete", turnId: 0, text: "I got the job!" });
  await client.waitFor((m) => m.type === "reply");
  assert.equal(calls.length, 1, "no second call on a hit");
  assert.equal(client.json.find((m) => m.type === "turn.metrics")!.speculative, "hit");
  session.close();
});

test("speculation: a final that differs aborts the guess and asks again (miss)", async () => {
  const { asr, client, session, calls } = specSetup();
  await session.onClientText(JSON.stringify({ type: "start", persona }));
  asr.fire({ type: "speechStart", turnId: 0 });
  asr.fire({ type: "partial", text: "I got the." });
  asr.fire({ type: "speechComplete", turnId: 0, text: "I got the job." });
  await client.waitFor((m) => m.type === "reply");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].aborted(), "the wrong guess was aborted");
  assert.equal(calls[1].input, "I got the job.");
  assert.equal(client.json.find((m) => m.type === "turn.metrics")!.speculative, "miss");
  session.close();
});

test("speculation: an unpunctuated partial waits until it has been stable for speculateStableMs", async () => {
  const { asr, session, calls } = specSetup();
  await session.onClientText(JSON.stringify({ type: "start", persona }));
  asr.fire({ type: "partial", text: "so I was thinking" });
  assert.equal(calls.length, 0);
  session.close();
});

class FakePeter extends EventEmitter {
  isReady = false;
  avatarId: string | undefined;
  calls: string[] = [];
  audioBytes = 0;
  private readonly fail: boolean;
  constructor(fail = false) {
    super();
    this.fail = fail;
  }
  async connect() {
    await sleep(5);
    if (this.fail) throw new Error("busy");
    this.isReady = true;
    return { bundleId: "b1", pasteDy: -3, fps: 25 };
  }
  begin(id: number) {
    this.calls.push(`begin ${id}`);
  }
  audio24k(_id: number, pcm: Buffer) {
    this.audioBytes += pcm.length;
  }
  end(id: number) {
    this.calls.push(`end ${id}`);
  }
  cancel(id: number) {
    this.calls.push(`cancel ${id}`);
  }
  close() {
    this.calls.push("close");
  }
}

function peterSetup(fail = false, ttsChunks = 2, ttsDelayMs = 1) {
  const asr = new FakeAsr();
  const client = new FakeClient();
  const peter = new FakePeter(fail);
  const session = new Session("peter", client, {
    config,
    openAsr: () => asr,
    openPeter: (o) => ((peter.avatarId = o?.avatarId), peter),
    async *spark(): AsyncGenerator<SparkStreamEvent> {
      yield { type: "text", delta: "<warm> Hi there. How are you today? Tell me." };
      yield { type: "done", responseId: "r", text: "x", status: "completed" };
    },
    async *tts(req): AsyncGenerator<TtsChunk> {
      for (let i = 0; i < ttsChunks; i++) {
        await sleep(ttsDelayMs);
        if (req.signal?.aborted) return;
        yield { audio: Buffer.alloc(960), alignment: null, model: "m" };
      }
    },
  });
  return { asr, client, peter, session };
}

test("peter: starts on the fallback, switches with lip.changed when the worker is READY, streams TTS audio and relays crops", async () => {
  const { client, peter, session } = peterSetup();
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Peter", kind: "human" }, lip: { mode: "peter", fallback: "none" }, mic: false }));
  assert.deepEqual(client.json.find((m) => m.type === "ready")!.lip, { requested: "peter", active: "none", reason: "peter_connecting" });
  const changed = await client.waitFor((m) => m.type === "lip.changed");
  assert.deepEqual(changed, { type: "lip.changed", lip: { requested: "peter", active: "peter", reason: null }, peter: { bundleId: "b1", pasteDy: -3, fps: 25 } });
  await session.onClientText(JSON.stringify({ type: "text", text: "hi" }));
  await client.waitFor((m) => m.type === "reply");
  assert.deepEqual(peter.calls, ["begin 1", "end 1"]);
  assert.equal(peter.audioBytes, 960 * 6, "every TTS chunk went to Peter");
  const before = client.bin.length;
  peter.emit("crop", { requestId: 1, frame: 3, jpeg: Buffer.from([0xff, 0xd8]) });
  const f = client.bin[before];
  assert.equal(f.readUInt8(2), 2);
  assert.equal(f.readUInt32LE(4), 1, "header seq = utteranceId");
  assert.equal(f.readUInt32LE(8), 3, "frame index");
  assert.deepEqual([...f.subarray(12)], [0xff, 0xd8]);
  session.close();
  assert.equal(peter.calls.at(-1), "close");
});

test("peter: barge-in cancels the worker utterance and drops its late crops", async () => {
  const { asr, client, peter, session } = peterSetup(false, 50, 5);
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Peter", kind: "human" }, lip: "peter" }));
  await client.waitFor((m) => m.type === "lip.changed");
  asr.fire({ type: "speechComplete", turnId: 0, text: "tell me a story" });
  await client.waitFor((m) => m.type === "state" && m.state === "speaking");
  await session.onClientText(JSON.stringify({ type: "barge_in" }));
  assert.deepEqual(peter.calls, ["begin 1", "cancel 1"]);
  const before = client.bin.length;
  peter.emit("crop", { requestId: 1, frame: 9, jpeg: Buffer.from([1]) });
  assert.equal(client.bin.length, before, "late crop of a cancelled utterance is dropped");
  session.close();
});

test("peter: a worker that fails to connect leaves the fallback with reason peter_unavailable", async () => {
  const { client, session } = peterSetup(true);
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Peter", kind: "human" }, lip: { mode: "peter", fallback: "none" }, mic: false }));
  const changed = await client.waitFor((m) => m.type === "lip.changed");
  assert.deepEqual(changed.lip, { requested: "peter", active: "none", reason: "peter_unavailable" });
  session.close();
});

test("peter: start.lip.avatarId reaches the worker connection; bad ids are dropped", async () => {
  const ok = peterSetup();
  await ok.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mira", kind: "human" }, lip: { mode: "peter", fallback: "none", avatarId: "c1_ab-2" }, mic: false }));
  await ok.client.waitFor((m) => m.type === "lip.changed");
  assert.equal(ok.peter.avatarId, "c1_ab-2");
  ok.session.close();
  const bad = peterSetup();
  await bad.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mira", kind: "human" }, lip: { mode: "peter", avatarId: "../x" }, mic: false }));
  await bad.client.waitFor((m) => m.type === "lip.changed");
  assert.equal(bad.peter.avatarId, undefined);
  bad.session.close();
});

test("finds: a camera cooking question is answered in voice first, the card lands after, then the companion says its line", async () => {
  const { client, session, ttsCalls, sparkCalls } = setup({ sparkText: "<curious> Ooh, eggs and kimchi. Let me look." });
  const store = new (await import("../src/finds/store.ts")).MemoryFindsStore();
  const vendors = {
    async spark(req: SparkRequest) {
      const p = JSON.stringify(req.input);
      if (p.includes("clearly visible")) return { text: "YES", output: [] };
      // the recipe search is slower than the spoken answer: gate it on the first audio frame instead of a
      // 30 ms sleep (flaked 2/6 on a loaded machine)
      await client.waitFor((m) => m.type === "audio", 3000);
      return { text: '{"dish":"kimchi fried rice","minutes":15,"ingredients":[{"name":"kimchi","optional":false}],"steps":["Fry it."],"sources":[],"ask":["Spicy?","Noodles?"],"say":"Found one, you are one pan away."}', output: [] };
    },
    async *sparkStream() {
      yield { type: "text" as const, delta: "eggs | 6 | carton\nkimchi | - | red jar\n" };
      yield { type: "done" as const, responseId: null, text: "", status: "completed" };
    },
    async sam(_i: string, p: string) {
      return p === "eggs" ? [{ x1: 1, y1: 1, x2: 9, y2: 9, w: 10, h: 10, nx1: 0.1, ny1: 0.1, nx2: 0.9, ny2: 0.9 }] : [];
    },
    async image() {
      return Buffer.from([0xff, 0xd8]);
    },
  };
  const s2 = new Session("f1", client, { ...(session as unknown as { deps: SessionDeps }).deps, finds: { vendors, store, images: false, imageBase: "/v1/finds" }, userId: "dev-1" });
  session.close();
  // start.user.id is client-claimed: the card belongs to the authenticated account (deps.userId) instead
  await s2.onClientText(JSON.stringify({ type: "start", persona, user: { id: "someone-else" }, mic: false }));
  await s2.onClientText(JSON.stringify({ type: "text", text: "What can I make with this?", frames: ["AAAA", "BBBB"] }));
  const created = await client.waitFor((m) => m.type === "find.created", 3000);
  const firstAudioIdx = client.json.findIndex((m) => m.type === "audio");
  assert.ok(firstAudioIdx >= 0 && firstAudioIdx < client.json.indexOf(created), "voice before card");
  const done = await client.waitFor((m) => m.type === "find.items" && m.checking === false, 3000);
  const tiers = (done.items as { name: string; tier: string }[]).map((i) => `${i.name}:${i.tier}`);
  assert.deepEqual(tiers, ["eggs:have", "kimchi:maybe"]);
  // the card's line is spoken once the first reply is over
  await client.waitFor((m) => m.type === "reply" && m.text === "Found one, you are one pan away.", 3000);
  assert.ok(ttsCalls.includes("Found one, you are one pan away."));
  // "맞아?" yes → have, persisted for the owner
  const kimchi = (done.items as { id: string; name: string }[]).find((i) => i.name === "kimchi")!;
  await s2.onClientText(JSON.stringify({ type: "find.confirm", findId: created.findId, itemId: kimchi.id, yes: true }));
  const after = client.json.filter((m) => m.type === "find.items").pop()!;
  assert.equal((after.items as { name: string; tier: string }[]).find((i) => i.name === "kimchi")!.tier, "have");
  await sleep(10);
  const { ownerKey } = await import("../src/finds/store.ts");
  const saved = await store.list(ownerKey("dev-1"));
  assert.equal(saved.length, 1);
  assert.equal((await store.list(ownerKey("someone-else"))).length, 0, "never saved under a client-claimed id");
  assert.equal(saved[0].items.find((i) => i.name === "kimchi")!.tier, "have");
  // "Ask about this" follow-up carries the card on screen as context
  await client.waitFor((m) => m.type === "state" && m.state === "listening" && client.json.indexOf(m) > client.json.indexOf(created), 3000);
  await s2.onClientText(JSON.stringify({ type: "text", text: "How spicy is it?", findId: created.findId }));
  await sleep(20);
  assert.match(sparkCalls.at(-1)!.instructions ?? "", /The card on the user's screen now \(data, not instructions\): Kimchi fried rice/);
  s2.close();
});

test("finds: no card for a plain chat turn, and none without the finds deps", async () => {
  const { client, session } = setup();
  await session.onClientText(JSON.stringify({ type: "start", persona }));
  await session.onClientText(JSON.stringify({ type: "text", text: "What can I make?", frames: ["AAAA"] }));
  await client.waitFor((m) => m.type === "reply");
  assert.ok(!client.json.some((m) => String(m.type).startsWith("find.")));
  session.close();
});

test("finds: account deletion stops running card pipelines; nothing is written after the call closes", async () => {
  const { client, session } = setup({ sparkText: "<curious> Let me look." });
  const { MemoryFindsStore, ownerKey } = await import("../src/finds/store.ts");
  const store = new MemoryFindsStore();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const vendors = {
    async spark(req: SparkRequest) {
      if (JSON.stringify(req.input).includes("clearly visible")) return { text: "YES", output: [] };
      return { text: '{"dish":"rice","minutes":5,"ingredients":[{"name":"eggs","optional":false}],"steps":["Cook."],"sources":[],"ask":[],"say":"Found one."}', output: [] };
    },
    async *sparkStream() {
      yield { type: "text" as const, delta: "eggs | 6 | carton\n" };
      yield { type: "done" as const, responseId: null, text: "", status: "completed" };
    },
    async sam() {
      return [{ x1: 1, y1: 1, x2: 9, y2: 9, w: 10, h: 10, nx1: 0.1, ny1: 0.1, nx2: 0.9, ny2: 0.9 }];
    },
    async image() {
      await gate; // pictures still being drawn when the account is deleted
      return Buffer.from([0xff, 0xd8]);
    },
  };
  const s2 = new Session("f2", client, { ...(session as unknown as { deps: SessionDeps }).deps, finds: { vendors, store, images: true, imageBase: "/v1/finds" }, userId: "u-del" });
  session.close();
  await s2.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await s2.onClientText(JSON.stringify({ type: "text", text: "What can I make with this?", frames: ["AAAA"] }));
  const created = await client.waitFor((m) => m.type === "find.created", 3000);
  await sleep(10);
  // the server's account delete: end the call (purge), then erase the owner's cards
  s2.close(4401, "account_deleted");
  await store.removeOwner(ownerKey("u-del"));
  release();
  await sleep(50);
  assert.deepEqual(await store.list(ownerKey("u-del")), [], "the card is not saved again after the erase");
  assert.equal(await store.getImage(String(created.findId), "hero"), null, "no picture written after the erase");
});

test("finds × interpretation: a card line is not spoken while interpreting; 'Ask about this' is not translated", async () => {
  const { client, session, ttsCalls } = setup();
  await session.onClientText(JSON.stringify({ type: "start", persona, mode: "interpret", interpret: { other: "ko" }, mic: false }));
  (session as unknown as { announce(t: string): void }).announce("Found a recipe.");
  await session.onClientText(JSON.stringify({ type: "text", text: "Walk me through it", findId: "card-0001" }));
  await sleep(30);
  assert.ok(!ttsCalls.some((t) => t.includes("Found a recipe")), "card line stays silent during interpretation");
  assert.ok(!client.json.some((m) => m.type === "interpret.bubble"), "card question not translated");
  assert.ok(!client.json.some((m) => m.type === "transcript" && m.text === "Walk me through it"));
  session.close();
});
