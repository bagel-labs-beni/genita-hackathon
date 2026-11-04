import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, FRAME_HEADER_BYTES, type ClientSink, type SessionDeps } from "../src/session/session.ts";
import type { Config } from "../src/config.ts";
import { checkServerEvent } from "../src/protocol.ts";
import type { AsrEvent } from "../src/meta/transcribe.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import type { TtsChunk } from "../src/tts/types.ts";

// these tests cover server TTS mode (Meta voice service); device mode: session-device.test.ts
const config: Config = {
  metaKey: "x",
  serverTts: true,
  host: "127.0.0.1",
  port: 0,
  sessionToken: null,
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

function greetingScheduler() {
  let pending: (() => void) | null = null;
  return {
    schedule(fn: () => void) {
      pending = fn;
      return () => { if (pending === fn) pending = null; };
    },
    fire() {
      const fn = pending;
      pending = null;
      fn?.();
    },
  };
}

function setup(opts: { sparkText?: string; ttsChunks?: number; ttsDelayMs?: number; deps?: Partial<SessionDeps> } = {}) {
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
    ...opts.deps,
  };
  const session = new Session("s1", client, deps);
  return { asr, client, session, sparkCalls, ttsCalls, ttsAborted: () => ttsAborted };
}

const persona = { name: "Mina", kind: "animal", traits: ["warm"] };

for (const [text, expected] of [
  ["<curious> I'll look that up. Tofu works.", "Tofu works."],
  ["<curious> 기억을 찾아볼게요. 두부가 좋아요.", "두부가 좋아요."],
  // conversation engine v1 (prod smoke 11/3): an announcement is never spoken; announcement-only retries, then says it doesn't know
  ["<curious> I'll look that up.", process.env.GENITA_CONVO_V1 === "0" ? "I'll look that up." : "Hmm, not sure off the top of my head."],
  ["<warm> Let me think — tofu works.", "Let me think — tofu works."],
  // an announcement after real content is kept (v1 drops only a leading one, Codex #356 r6)
  ["<warm> Tofu works. I'll look that up.", "Tofu works. I'll look that up."],
] as const) test(`first narration only, with more content required: ${text}`, async (t) => {
  const { session, client } = setup({ sparkText: text });
  t.after(() => session.close());
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "What works?" }));
  assert.equal((await client.waitFor((m) => m.type === "reply")).text, expected);
});

for (const [text, expected] of [
  ["<curious> One sec, looking that up. Tofu works.", "Tofu works."],
  ["<curious> 잠시만요, 검색해 볼게요. 두부가 좋아요.", "두부가 좋아요."],
  ["<curious> I'll look that up — tofu works.", "Tofu works."],
  ["<warm> One sec, the tofu is burning.", "One sec, the tofu is burning."],
  ["<warm> One sec,", "One sec,"],
] as const) test(`eager first clause protects wait prefixes: ${text}`, async (t) => {
  const { session, client, ttsCalls } = setup({ sparkText: text, deps: { config: { ...config, voice: {
    url: "http://voice.invalid", token: "fake", speakers: { human: 0, animal: 0, character: 0 }, speed: 1, timeoutMs: 1000, model: "seamless",
  } } } });
  t.after(() => session.close());
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "What works?" }));
  assert.equal((await client.waitFor((m) => m.type === "reply")).text, expected);
  assert.deepEqual(ttsCalls, [expected]);
});

test("a web_search after narration also suppresses the first clause", async (t) => {
  const { session, client, ttsCalls } = setup({ deps: { async *spark(): AsyncGenerator<SparkStreamEvent> {
    yield { type: "text", delta: "<curious> Let me search the web for that." };
    yield { type: "tool", name: "web_search", status: "in_progress" };
    yield { type: "text", delta: "Tofu works." };
    yield { type: "done", responseId: "r", text: "", status: "completed" };
  } } });
  t.after(() => session.close());
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "Find a recipe." }));
  assert.equal((await client.waitFor((m) => m.type === "reply")).text, "Tofu works.");
  assert.deepEqual(ttsCalls, ["Tofu works."]);
});

test("tool narration with no answer is retried instead of producing an empty reply", async (t) => {
  const calls: SparkRequest[] = [];
  const { session, client, ttsCalls } = setup({ deps: { async *spark(req): AsyncGenerator<SparkStreamEvent> {
    calls.push(req);
    if (calls.length === 1) {
      yield { type: "text", delta: "<curious> Let me search the web for that." };
      yield { type: "tool", name: "web_search", status: "completed" };
      yield { type: "done", responseId: "r1", text: "", status: "incomplete" };
      return;
    }
    yield { type: "text", delta: "Tofu works." };
    yield { type: "done", responseId: "r2", text: "Tofu works.", status: "completed" };
  } } });
  t.after(() => session.close());
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "Find a recipe." }));
  assert.equal((await client.waitFor((m) => m.type === "reply")).text, "Tofu works.");
  assert.deepEqual(ttsCalls, ["Tofu works."]);
  assert.equal(calls.length, 2);
  assert.equal(client.json.filter((m) => m.type === "reply.delta").map((m) => m.text).join(""), "Tofu works.");
});

test("interpretation preserves a translated tool announcement as content", async (t) => {
  const text = "I'll look that up. Tofu works.";
  const { session, client, ttsCalls } = setup({ sparkText: text });
  t.after(() => session.close());
  // explicit interpretation mode (chat no longer auto-interprets a Hangul line: English only, 11/3)
  await session.onClientText(JSON.stringify({ type: "start", persona, mode: "interpret", interpret: { other: "Korean" }, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "기억을 찾아볼게요. 두부가 좋아요." }));
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.equal(reply.interpret, true);
  assert.equal(reply.text, text);
  assert.deepEqual(ttsCalls, ["I'll look that up.", "Tofu works."]);
});

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

test("server-mode session on the real 'off' TTS dep (no Meta voice service): reply text streams, no audio, no tts error, back to listening", async () => {
  const { loadConfig } = await import("../src/config.ts");
  const { defaultDeps } = await import("../src/server.ts");
  const meta = loadConfig({ MODEL_API_KEY: "m" });
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

test("GENITA_ENGLISH_ONLY=0: a Korean transcript in chat mode is interpreted, not answered as chat", async () => {
  process.env.GENITA_ENGLISH_ONLY = "0";
  try {
    const { asr, client, session, sparkCalls } = setup({ sparkText: "<neutral> He's asking how to get to City Hall." });
    await session.onClientText(JSON.stringify({ type: "start", persona }));
    asr.fire({ type: "speechComplete", turnId: 0, text: "실례합니다, 시청 어떻게 가요?" });
    await client.waitFor((m) => m.type === "reply");
    assert.deepEqual(client.json.find((m) => m.type === "interpret.detected"), { type: "interpret.detected", from: "Korean", to: "English" });
    assert.match(sparkCalls[0].instructions ?? "", /Someone near the user just spoke Korean/);
    session.close();
  } finally {
    delete process.env.GENITA_ENGLISH_ONLY;
  }
});

test("English only (default): a Korean transcript in chat mode gets a normal English chat reply, no translation", async () => {
  const { asr, client, session, sparkCalls } = setup({ sparkText: "<curious> Wait, say that again?" });
  await session.onClientText(JSON.stringify({ type: "start", persona }));
  asr.fire({ type: "speechComplete", turnId: 0, text: "실례합니다, 시청 어떻게 가요?" });
  await client.waitFor((m) => m.type === "reply");
  assert.equal(client.json.find((m) => m.type === "interpret.detected"), undefined);
  assert.doesNotMatch(sparkCalls[0].instructions ?? "", /Someone near the user just spoke/);
  assert.match(sparkCalls[0].instructions ?? "", /Reply in English/);
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

test("messages before start are rejected; unknown lip modes degrade to none", async () => {
  const { client, session } = setup();
  await session.onClientText(JSON.stringify({ type: "text", text: "hi" }));
  assert.equal(client.json[0].code, "not_started");
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Companion", kind: "human" }, lip: { mode: "retired", fallback: "none" } }));
  const ready = client.json.find((m) => m.type === "ready")!;
  assert.deepEqual(ready.lip, { requested: "none", active: "none", reason: null });
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

test("an empty Spark answer (e.g. a web search that never produced text) is retried once with the same tools", async () => {
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
  assert.deepEqual(calls[1], calls[0]);
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

test("finds: fridge (D23, #122) — short line at once, boxes, then only checked items are named, then the dish", async () => {
  const { client, session, ttsCalls, sparkCalls } = setup({ sparkText: "<curious> Ooh, I see eggs, kimchi, milk and leftover chicken!" });
  const store = new (await import("../src/finds/store.ts")).MemoryFindsStore();
  const vendors = {
    async spark(req: SparkRequest) {
      const p = JSON.stringify(req.input);
      if (p.includes("clearly visible")) return { text: "YES", output: [] };
      await sleep(5);
      return { text: '{"dish":"kimchi fried rice","minutes":15,"ingredients":[{"name":"kimchi","optional":false}],"steps":["Fry it."],"sources":[],"ask":["Spicy?","Noodles?"],"say":"Found one, you are one pan away."}', output: [] };
    },
    async *sparkStream() {
      // the first look also "sees" chicken — Spark YES, but SAM finds no box: never named
      yield { type: "text" as const, delta: "eggs | 6 | carton\nkimchi | - | red jar\nchicken | - | container\n" };
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
  const before = sparkCalls.length;
  await s2.onClientText(JSON.stringify({ type: "text", text: "What can I make with this?", frames: ["AAAA", "BBBB"] }));
  // ① the short line, not a full answer from the raw photo (which named milk and chicken)
  const ack = await client.waitFor((m) => m.type === "reply", 3000);
  assert.equal(ack.text, "Ooh, nice haul.");
  assert.equal(sparkCalls.length, before, "no full Spark answer about the photo");
  const created = await client.waitFor((m) => m.type === "find.created", 3000);
  // ③ only checked items, after their boxes ②
  const line = "I can see eggs. You could make kimchi fried rice, if you have kimchi. First, fry it.";
  const said = await client.waitFor((m) => m.type === "reply" && m.text === line, 5000);
  const boxes = client.json.findIndex((m) => m.type === "observe.boxes");
  const lineStart = client.json.findIndex((m) => m.type === "reply.delta" && m.utteranceId === said.utteranceId);
  assert.ok(boxes >= 0 && boxes < lineStart, "boxes are up before the line starts");
  assert.ok(!ttsCalls.some((t) => /chicken|milk|see [^.]*kimchi/i.test(t)), `named only checked items: ${ttsCalls.join(" | ")}`);
  const done = await client.waitFor((m) => m.type === "find.items" && m.checking === false, 3000);
  const tiers = (done.items as { name: string; tier: string }[]).map((i) => `${i.name}:${i.tier}`);
  assert.deepEqual(tiers, ["eggs:have", "kimchi:maybe", "chicken:maybe"]);
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

test("finds: a product ask by voice → a quick in-character reaction (no tools, no products), then the card and its line; saved to the account", async () => {
  const REACT = "<happy> Ooh, a light jacket for the weekend? Love that.";
  const { client, session, ttsCalls, sparkCalls } = setup({ sparkText: REACT });
  const { MemoryFindsStore, ownerKey } = await import("../src/finds/store.ts");
  const store = new MemoryFindsStore();
  const P = ["https://shop.example.com/products/chore-jacket", "https://store.example.com/product/overshirt-123456.html"];
  const likesAsked: string[] = [];
  const vendors = {
    async spark(req: SparkRequest) {
      assert.match(JSON.stringify(req.input), /Clean, minimal clothes/, "the account's own import line");
      await sleep(80); // a real search takes 10–30 s; the reaction must not wait for it
      return {
        text: JSON.stringify({ label: "Light jacket", title: "Two for the weekend", style_line: "Clean, minimal clothes.", situation_line: "This weekend", items: P.map((url, i) => ({ name: `Jacket ${i + 1}`, url, store: "Shop", price: "", taste: "Clean, minimal", situation: "For the weekend" })), say: "Two, both simple cuts." }),
        output: P.map((url) => ({ type: "web_search_call", status: "completed", action: { type: "open_page", url } })),
      };
    },
    async *sparkStream() {
      yield { type: "done" as const, responseId: null, text: "", status: "completed" };
    },
    async sam() { return []; },
    async image() { return Buffer.from([0xff, 0xd8]); },
    async pageFacts() { return { kind: "product" as const }; },
    async productImage() { return null; },
  };
  const s2 = new Session("fp", client, {
    ...(session as unknown as { deps: SessionDeps }).deps,
    finds: { vendors, store, images: true, imageBase: "/v1/finds", likes: async (u: string) => (likesAsked.push(u), ["Clean, minimal clothes."]) },
    userId: "acct-7",
  });
  session.close();
  await s2.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  const before = sparkCalls.length;
  await s2.onClientText(JSON.stringify({ type: "text", text: "Jin, can we look for a jacket for this weekend?" }));
  const ack = await client.waitFor((m) => m.type === "reply", 3000);
  assert.equal(ack.text, "Ooh, a light jacket for the weekend? Love that.", "demo S5: a natural reaction, not a silent wait or 'On it.'");
  const asked = sparkCalls.slice(before);
  assert.equal(asked.length, 1, "one reaction call for the turn");
  assert.equal(asked[0].tools, undefined, "no web_search or memory tools: nothing to narrate, nothing to guess");
  assert.match(asked[0].instructions ?? "", /search for this is already running/, "the reaction line is the last instruction");
  assert.match(asked[0].instructions ?? "", /talk to them as you/);
  const started = await client.waitFor((m) => m.type === "find.started", 3000);
  assert.equal(started.kind, "product");
  const created = await client.waitFor((m) => m.type === "find.created", 3000);
  const ackDelta = client.json.find((m) => m.type === "reply.delta" && /Ooh/.test(String(m.text)))!;
  assert.ok(client.json.indexOf(ackDelta) < client.json.indexOf(created), "the short line comes before the card");
  const card = created.card as { products: { url: string }[] };
  assert.deepEqual(card.products.map((p) => p.url), P);
  await client.waitFor((m) => m.type === "reply" && m.text === "Two, both simple cuts.", 3000);
  assert.equal(ttsCalls.at(-1), "Two, both simple cuts.");
  assert.ok(ttsCalls.some((t) => /light jacket for the weekend/.test(t)), "the reaction was spoken");
  await sleep(10);
  assert.deepEqual(likesAsked, ["acct-7"]);
  const saved = await store.list(ownerKey("acct-7"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].kind, "product");
  s2.close();
});

test("finds: demo S5 — if the reaction call fails, the product turn still says the short ack (never silence)", async () => {
  const { client, session } = setup({ deps: { async *spark() { throw new Error("upstream 503"); } } });
  const { MemoryFindsStore } = await import("../src/finds/store.ts");
  const vendors = {
    async spark() { await sleep(50); return { text: "", output: [] }; },
    async *sparkStream() { yield { type: "done" as const, responseId: null, text: "", status: "completed" }; },
    async sam() { return []; }, async image() { return Buffer.from([0xff, 0xd8]); }, async pageFacts() { return null; }, async productImage() { return null; },
  };
  const s2 = new Session("fp2", client, { ...(session as unknown as { deps: SessionDeps }).deps, finds: { vendors, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds" }, userId: "acct-8" });
  session.close();
  await s2.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await s2.onClientText(JSON.stringify({ type: "text", text: "Can you find me some white sneakers?" }));
  const ack = await client.waitFor((m) => m.type === "reply" && !!m.text, 3000);
  assert.equal(ack.text, "On it.");
  s2.close();
});

test("finds: demo S5 — an empty reaction (done, no text) still says the short ack, and no tool-carrying retry", async () => {
  const { client, session, sparkCalls } = setup({ deps: { async *spark(req) { sparkCalls.push(req); yield { type: "done" as const, responseId: "r", text: "", status: "completed" }; } } });
  const { MemoryFindsStore } = await import("../src/finds/store.ts");
  const vendors = {
    async spark() { await sleep(50); return { text: "", output: [] }; },
    async *sparkStream() { yield { type: "done" as const, responseId: null, text: "", status: "completed" }; },
    async sam() { return []; }, async image() { return Buffer.from([0xff, 0xd8]); }, async pageFacts() { return null; }, async productImage() { return null; },
  };
  const s2 = new Session("fp3", client, { ...(session as unknown as { deps: SessionDeps }).deps, finds: { vendors, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds" }, userId: "acct-9" });
  session.close();
  await s2.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  const before = sparkCalls.length;
  await s2.onClientText(JSON.stringify({ type: "text", text: "Can you find me some white sneakers?" }));
  const ack = await client.waitFor((m) => m.type === "reply" && !!m.text, 3000);
  assert.equal(ack.text, "On it.");
  assert.ok(sparkCalls.slice(before).every((r) => !r.tools?.length), "never a full answer with web_search on a product turn");
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

// ───────────── F2-L26 rename by voice · D21 first-call wait ─────────────

const GREET = "The call just connected. Greet the user.";
const asksGreeting = (reqs: SparkRequest[]) => reqs.filter((r) => JSON.stringify(r.input).includes(GREET)).length;

test("rename: 'Call yourself Max' renames for the rest of the call, persists via the dep, and emits companion.named", async () => {
  const saved: Array<[string, string]> = [];
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const { client, session, sparkCalls } = setup({ deps: {
    userId: "u1",
    renameCompanion: async (u, n) => void saved.push([u, n]),
    log: (event, data) => logs.push({ event, data }),
  } });
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin", kind: "human" } }));
  await session.onClientText(JSON.stringify({ type: "text", text: "Call yourself Max" }));
  const named = await client.waitFor((m) => m.type === "companion.named");
  assert.deepEqual(named, { type: "companion.named", name: "Max" });
  await client.waitFor((m) => m.type === "reply");
  assert.deepEqual(saved, [["u1", "Max"]]);
  // the reply to the rename turn already uses the new name and is told to acknowledge it
  assert.match(sparkCalls[0].instructions!, /^You are Max,/);
  assert.match(sparkCalls[0].instructions!, /renamed you from Jin to Max/);
  // the event comes before the reply's first caption
  assert.ok(client.json.indexOf(named) < client.json.findIndex((m) => m.type === "reply.delta"));

  await sleep(80);
  await session.onClientText(JSON.stringify({ type: "text", text: "What's your name?" }));
  await client.waitFor((m) => m.type === "reply" && client.json.filter((x) => x.type === "reply").length === 2);
  assert.match(sparkCalls[1].instructions!, /^You are Max,/);
  assert.doesNotMatch(sparkCalls[1].instructions!, /renamed you/, "the acknowledgement line is for the rename turn only");
  assert.equal(client.json.filter((m) => m.type === "companion.named").length, 1);
  assert.deepEqual(logs.filter((m) => m.event === "companion.named"), [
    { event: "companion.named", data: { session: "s1", sessionId: "s1", userId: "u1", by: "voice", chars: 3 } },
  ], "one funnel log per successful voice rename, with no raw name");
  session.close();
});

test("rename: by voice too; questions are not renames; no rename while interpreting", async () => {
  const saved: string[] = [];
  const a = setup({ deps: { userId: "u1", renameCompanion: async (_u, n) => void saved.push(n) } });
  await a.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" } }));
  a.asr.fire({ type: "speechComplete", turnId: 0, text: "What should I call you?" });
  await a.client.waitFor((m) => m.type === "reply");
  assert.equal(a.client.json.filter((m) => m.type === "companion.named").length, 0);
  assert.match(a.sparkCalls[0].instructions!, /^You are Jin,/);
  await sleep(80);
  a.asr.fire({ type: "speechComplete", turnId: 1, text: "Your name is Max now." });
  await a.client.waitFor((m) => m.type === "companion.named");
  assert.deepEqual(saved, ["Max"]);
  a.session.close();

  const b = setup({ deps: { userId: "u1", renameCompanion: async (_u, n) => void saved.push(n) } });
  await b.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" }, mode: "interpret" }));
  await b.session.onClientText(JSON.stringify({ type: "text", text: "Call yourself Max" }));
  await sleep(60);
  assert.equal(b.client.json.filter((m) => m.type === "companion.named").length, 0);
  assert.deepEqual(saved, ["Max"], "nothing persisted from interpretation");
  b.session.close();
});

test("rename: works without a rename dep (no store / no user) — the call still renames itself", async () => {
  const { client, session, sparkCalls } = setup();
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" } }));
  await session.onClientText(JSON.stringify({ type: "text", text: "I'll call you Max" }));
  await client.waitFor((m) => m.type === "reply");
  assert.ok(client.json.some((m) => m.type === "companion.named"));
  assert.match(sparkCalls[0].instructions!, /^You are Max,/);
  session.close();
});

test("D21 greetAfterMs: the user speaks inside the window → no greeting, the user's turn is answered", async () => {
  const clock = greetingScheduler();
  const { asr, client, session, sparkCalls } = setup({ deps: { greetScheduler: clock.schedule } });
  // the window outlasts the user's whole reply, so only the cancel (not "busy replying") keeps the greeting out
  await session.onClientText(JSON.stringify({ type: "start", persona, greetAfterMs: 700 }));
  asr.fire({ type: "speechStart", turnId: 0 });
  asr.fire({ type: "speechEnd", turnId: 0 });
  asr.fire({ type: "speechComplete", turnId: 0, text: "Hey, what should I call you?" });
  await client.waitFor((m) => m.type === "reply");
  await client.waitFor((m) => m.type === "state" && m.state === "listening" && client.json.indexOf(m) > 2);
  clock.fire();
  // the greeting's Spark call started during the window (11/3 pre-start) and was dropped unheard
  assert.ok(asksGreeting(sparkCalls) <= 1, "at most the pre-started call");
  assert.equal(client.json.filter((m) => m.type === "reply").length, 1);
  // the user's first line was an ordinary turn (kept in history), not swallowed as "the greeting"
  await session.onClientText(JSON.stringify({ type: "text", text: "anyway" }));
  await client.waitFor((m) => m.type === "reply" && client.json.filter((x) => x.type === "reply").length === 2);
  assert.ok(JSON.stringify(sparkCalls.at(-1)!.input).includes("what should I call you"));
  session.close();
});

test("D21 greetAfterMs: typed text inside the window also cancels the greeting", async () => {
  const clock = greetingScheduler();
  const { client, session, sparkCalls } = setup({ deps: { greetScheduler: clock.schedule } });
  await session.onClientText(JSON.stringify({ type: "start", persona, greetAfterMs: 700 }));
  await session.onClientText(JSON.stringify({ type: "text", text: "hi" }));
  await client.waitFor((m) => m.type === "reply");
  clock.fire();
  assert.ok(asksGreeting(sparkCalls) <= 1, "at most the pre-started call, never said");
  assert.equal(client.json.filter((m) => m.type === "reply").length, 1, "no greeting reply");
  await session.onClientText(JSON.stringify({ type: "text", text: "anyway" }));
  await client.waitFor((m) => m.type === "reply" && client.json.filter((x) => x.type === "reply").length === 2);
  assert.ok(JSON.stringify(sparkCalls.at(-1)!.input).includes('"hi"'), "the typed line is a normal turn");
  session.close();
});

test("D21 greetAfterMs: silence → exactly one greeting after about the window, without the memory dependency", async () => {
  const clock = greetingScheduler();
  const { client, session, sparkCalls } = setup({ deps: { greetScheduler: clock.schedule } });
  await session.onClientText(JSON.stringify({ type: "start", persona, greetAfterMs: 150 }));
  // pre-started (11/3): the greeting's Spark answer runs during the window; nothing is said before it ends
  assert.equal(asksGreeting(sparkCalls), 1, "started at once");
  assert.ok(!client.json.some((m) => m.type === "reply" || m.type === "say"), "nothing said inside the window");
  clock.fire();
  const reply = await client.waitFor((m) => m.type === "reply", 2000);
  assert.equal(asksGreeting(sparkCalls), 1);
  assert.ok(!client.json.some((m) => m.type === "transcript"), "no synthetic user transcript");
  assert.equal(reply.text, "Hey you! That sounds great.");
  // the greeting prompt is not kept as a user line in the history
  await client.waitFor((m) => m.type === "state" && m.state === "listening" && client.json.indexOf(m) > client.json.indexOf(reply));
  await session.onClientText(JSON.stringify({ type: "text", text: "how are you" }));
  await client.waitFor((m) => m.type === "reply" && client.json.filter((x) => x.type === "reply").length === 2);
  assert.ok(!JSON.stringify(sparkCalls[1].input).includes(GREET));
  session.close();
});

test("D21: without greetAfterMs (and no memory) nothing changes — no greeting; values are clamped to 0–3000", async () => {
  const a = setup();
  await a.session.onClientText(JSON.stringify({ type: "start", persona }));
  assert.equal(a.sparkCalls.length, 0);
  a.session.close();

  const clock = greetingScheduler();
  const b = setup({ deps: { greetScheduler: clock.schedule } });
  await b.session.onClientText(JSON.stringify({ type: "start", persona, greetAfterMs: -50 }));
  clock.fire();
  await b.client.waitFor((m) => m.type === "reply", 1000); // clamped to 0 → greets right away
  b.session.close();

  const c = setup();
  await c.session.onClientText(JSON.stringify({ type: "start", persona, greetAfterMs: "2000" }));
  assert.equal(c.sparkCalls.length, 0, "a non-number is ignored");
  c.session.close();

  const d = setup();
  await d.session.onClientText(JSON.stringify({ type: "start", persona, greetAfterMs: 2000, mode: "interpret" }));
  d.session.close();
  assert.equal(asksGreeting(d.sparkCalls), 0, "never greets into interpretation");
});

test("rename (Codex P2): a failed save keeps the old name — no companion.named, the call stays consistent", async () => {
  const { client, session, sparkCalls } = setup({ deps: { userId: "u1", renameCompanion: async () => { throw new Error("db down"); } } });
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" } }));
  await session.onClientText(JSON.stringify({ type: "text", text: "Call yourself Max" }));
  await client.waitFor((m) => m.type === "reply");
  assert.equal(client.json.filter((m) => m.type === "companion.named").length, 0);
  assert.match(sparkCalls[0].instructions!, /^You are Jin,/);
  session.close();
});

test("rename (Codex P2): the save finishes before companion.named goes out", async () => {
  let saved = false;
  const { client, session } = setup({ deps: { userId: "u1", renameCompanion: async () => { await sleep(30); saved = true; } } });
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" } }));
  let savedAtEvent: boolean | null = null;
  const orig = client.sendJson.bind(client);
  client.sendJson = (m) => { if (m.type === "companion.named") savedAtEvent = saved; orig(m); };
  await session.onClientText(JSON.stringify({ type: "text", text: "Call yourself Max" }));
  await client.waitFor((m) => m.type === "reply");
  assert.equal(savedAtEvent, true);
  session.close();
});

test("D21 (Codex P2): a greeting the window could not deliver (companion busy) is dropped, not given to the user's next turn", async () => {
  const clock = greetingScheduler();
  const { client, session, sparkCalls } = setup({ ttsChunks: 30, ttsDelayMs: 5, deps: { userId: "u1", renameCompanion: async () => {}, greetScheduler: clock.schedule } });
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" }, greetAfterMs: 50 }));
  // the companion is already speaking on its own (e.g. a watch reaction / card line) when the window ends
  (session as unknown as { dispatch(e: unknown): void }).dispatch({ type: "self_speak", text: "Ooh, look at that.", origin: "card" });
  await client.waitFor((m) => m.type === "state" && m.state === "thinking");
  clock.fire();
  await client.waitFor((m) => m.type === "reply");
  await client.waitFor((m) => m.type === "state" && m.state === "listening" && client.json.indexOf(m) > 3, 3000);
  await session.onClientText(JSON.stringify({ type: "text", text: "Call yourself Max" }));
  await client.waitFor((m) => m.type === "companion.named");
  assert.ok(asksGreeting(sparkCalls) <= 1, "only the pre-started call, never said");
  assert.ok(!JSON.stringify(sparkCalls.at(-1)!.input).includes(GREET), "the next turn is not the greeting");
  session.close();
});

test("GENITA_BACKCHANNEL=1: a long user turn that pauses mid-sentence gets one backchannel event, never a reply", async () => {
  process.env.GENITA_BACKCHANNEL = "1";
  let clock = 0;
  const { asr, client, session, sparkCalls } = setup({ deps: { now: () => clock } });
  try {
    await session.onClientText(JSON.stringify({ type: "start", persona }));
    asr.fire({ type: "speechStart", turnId: 0 });
    clock += 4000;
    asr.fire({ type: "partial", text: "so today at work my manager pulled me into this meeting and then he started" });
    const bc = await client.waitFor((m) => m.type === "backchannel", 3000);
    assert.equal(bc.kind, "mm");
    assert.equal(sparkCalls.length, 0, "no reply was started");
  } finally {
    delete process.env.GENITA_BACKCHANNEL;
    session.close();
  }
});

test("GENITA_BACKCHANNEL=0 (rollback): the same pause sends nothing", async () => {
  process.env.GENITA_BACKCHANNEL = "0";
  let clock = 0;
  const { asr, client, session } = setup({ deps: { now: () => clock } });
  await session.onClientText(JSON.stringify({ type: "start", persona }));
  asr.fire({ type: "speechStart", turnId: 0 });
  clock += 4000;
  asr.fire({ type: "partial", text: "so today at work my manager pulled me into this meeting and then he started" });
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(!client.json.some((m) => m.type === "backchannel"));
  session.close();
  delete process.env.GENITA_BACKCHANNEL;
});

test("GENITA_BACKCHANNEL=1, server voice: the cue carries the companion's own 'Mm-hm.' as base64 PCM (11/4)", async () => {
  process.env.GENITA_BACKCHANNEL = "1";
  let clock = 0;
  const { asr, client, session, ttsCalls } = setup({ deps: { now: () => clock } });
  try {
    await session.onClientText(JSON.stringify({ type: "start", persona }));
    asr.fire({ type: "speechStart", turnId: 0 });
    clock += 4000;
    asr.fire({ type: "partial", text: "so today at work my manager pulled me into this meeting and then he started" });
    const bc = await client.waitFor((m) => m.type === "backchannel", 3000);
    assert.equal(bc.kind, "mm");
    assert.ok(typeof bc.audio === "string" && Buffer.from(String(bc.audio), "base64").length > 0, "audio attached");
    assert.ok(ttsCalls.includes("Mm-hm."), JSON.stringify(ttsCalls));
  } finally {
    delete process.env.GENITA_BACKCHANNEL;
    session.close();
  }
});

test("Codex #475 P2: a cue whose voice lookup outlives its pause (the user spoke again) is never sent", async () => {
  process.env.GENITA_BACKCHANNEL = "1";
  let clock = 0;
  const { asr, client, session } = setup({ deps: { now: () => clock }, ttsDelayMs: 300 });
  try {
    await session.onClientText(JSON.stringify({ type: "start", persona }));
    asr.fire({ type: "speechStart", turnId: 0 });
    clock += 4000;
    asr.fire({ type: "partial", text: "so today at work my manager pulled me into this meeting and then he started" });
    await sleep(1300); // the pause fired, the cue's voice lookup is running
    asr.fire({ type: "partial", text: "so today at work my manager pulled me into this meeting and then he started yelling" });
    await sleep(800);
    assert.ok(!client.json.some((m) => m.type === "backchannel"), "the stale cue was dropped");
  } finally {
    delete process.env.GENITA_BACKCHANNEL;
    session.close();
  }
});

test("Codex #475 P1: the uplink is never cut; a cue's echo ('mm-hm') in that turn's transcript is dropped, the user's words stay", async () => {
  process.env.GENITA_BACKCHANNEL = "1";
  let clock = 0;
  const { asr, client, session, sparkCalls } = setup({ deps: { now: () => clock } });
  try {
    await session.onClientText(JSON.stringify({ type: "start", persona }));
    asr.fire({ type: "speechStart", turnId: 0 });
    clock += 4000;
    asr.fire({ type: "partial", text: "so today at work my manager pulled me into this meeting and then he started" });
    await client.waitFor((m) => m.type === "backchannel", 3000);
    asr.fire({ type: "speechComplete", turnId: 0, text: "so today at work my manager pulled me into this meeting and then he started mm-hm yelling at me" });
    await client.waitFor((m) => m.type === "reply", 3000);
    const final = client.json.find((m) => m.type === "transcript" && m.final === true);
    assert.equal(final?.text, "so today at work my manager pulled me into this meeting and then he started yelling at me");
    assert.doesNotMatch(JSON.stringify(sparkCalls.at(-1)?.input), /mm-hm/i);
  } finally {
    delete process.env.GENITA_BACKCHANNEL;
    session.close();
  }
});

test("AU-70: a typed turn right after find.focus waits for the card from Finds (Codex P2: same receive batch)", async () => {
  const { client, session, sparkCalls } = setup();
  const { MemoryFindsStore, ownerKey } = await import("../src/finds/store.ts");
  class SlowStore extends MemoryFindsStore {
    override async get(owner: string, id: string) {
      await sleep(40);
      return super.get(owner, id);
    }
  }
  const store = new SlowStore();
  await store.put(ownerKey("dev-1"), { id: "11111111-aaaa-4bbb-8ccc-000000000001", kind: "recipe", createdAt: "2026-11-03T10:00:00Z", eyebrow: "", title: "Yesterday's kimchi stew", subtitle: "", items: [], steps: [{ text: "Simmer it." }], options: [], why: [], ask: [], sources: [], how: [] });
  const vendors = { async spark() { return { text: "", output: [] }; }, async *sparkStream() {}, async sam() { return []; }, async image() { return null; } };
  const s2 = new Session("f2", client, { ...(session as unknown as { deps: SessionDeps }).deps, finds: { vendors, store, images: false, imageBase: "/v1/finds" } as never, userId: "dev-1" });
  session.close();
  await s2.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  const before = sparkCalls.length;
  await Promise.all([
    s2.onClientText(JSON.stringify({ type: "find.focus", findId: "11111111-aaaa-4bbb-8ccc-000000000001" })),
    s2.onClientText(JSON.stringify({ type: "text", text: "How long does it take?" })),
  ]);
  await client.waitFor((m) => m.type === "reply", 3000);
  assert.ok(sparkCalls.length > before);
  assert.match(JSON.stringify(sparkCalls.at(-1)), /Yesterday's kimchi stew/);
  s2.close();
});

test("AU-70 (Codex r2): a spoken question right after find.focus waits for the card from Finds", async () => {
  const { asr, client, session, sparkCalls } = setup();
  const { MemoryFindsStore, ownerKey } = await import("../src/finds/store.ts");
  class SlowStore extends MemoryFindsStore {
    override async get(owner: string, id: string) {
      await sleep(60);
      return super.get(owner, id);
    }
  }
  const store = new SlowStore();
  await store.put(ownerKey("dev-1"), { id: "11111111-aaaa-4bbb-8ccc-000000000009", kind: "recipe", createdAt: "2026-11-03T10:00:00Z", eyebrow: "", title: "Yesterday's tofu stew", subtitle: "", items: [], steps: [{ text: "Simmer it." }], options: [], why: [], ask: [], sources: [], how: [] });
  const vendors = { async spark() { return { text: "", output: [] }; }, async *sparkStream() {}, async sam() { return []; }, async image() { return null; } };
  const s2 = new Session("f3", client, { ...(session as unknown as { deps: SessionDeps }).deps, finds: { vendors, store, images: false, imageBase: "/v1/finds" } as never, userId: "dev-1" });
  session.close();
  await s2.onClientText(JSON.stringify({ type: "start", persona }));
  const before = sparkCalls.length;
  const focus = s2.onClientText(JSON.stringify({ type: "find.focus", findId: "11111111-aaaa-4bbb-8ccc-000000000009" }));
  asr.fire({ type: "speechStart", turnId: 0 });
  asr.fire({ type: "speechEnd", turnId: 0 });
  asr.fire({ type: "speechComplete", turnId: 0, text: "How long does it take?" });
  await focus;
  await client.waitFor((m) => m.type === "reply", 3000);
  assert.ok(sparkCalls.length > before);
  assert.match(JSON.stringify(sparkCalls.at(-1)), /Yesterday's tofu stew/);
  s2.close();
});

test("AU-70 (Codex r3): a turn barged in while the card loads never starts its search afterwards", async () => {
  const { asr, client, session } = setup();
  const { MemoryFindsStore, ownerKey } = await import("../src/finds/store.ts");
  class SlowStore extends MemoryFindsStore {
    override async get(owner: string, id: string) {
      await sleep(80);
      return super.get(owner, id);
    }
  }
  const store = new SlowStore();
  await store.put(ownerKey("dev-1"), { id: "11111111-aaaa-4bbb-8ccc-00000000000a", kind: "recipe", createdAt: "2026-11-03T10:00:00Z", eyebrow: "", title: "Stew", subtitle: "", items: [], steps: [], options: [], why: [], ask: [], sources: [], how: [] });
  const vendors = { async spark() { return { text: "", output: [] }; }, async *sparkStream() {}, async sam() { return []; }, async image() { return null; } };
  const s2 = new Session("f4", client, { ...(session as unknown as { deps: SessionDeps }).deps, finds: { vendors, store, images: false, imageBase: "/v1/finds" } as never, userId: "dev-1" });
  session.close();
  await s2.onClientText(JSON.stringify({ type: "start", persona }));
  const focus = s2.onClientText(JSON.stringify({ type: "find.focus", findId: "11111111-aaaa-4bbb-8ccc-00000000000a" }));
  asr.fire({ type: "speechStart", turnId: 0 });
  asr.fire({ type: "speechEnd", turnId: 0 });
  asr.fire({ type: "speechComplete", turnId: 0, text: "Can you find me black boots?" });
  await sleep(10);
  await s2.onClientText(JSON.stringify({ type: "barge_in" }));
  await focus;
  await sleep(50);
  assert.ok(!client.json.some((m) => m.type === "find.started"), "no search for a turn that was cancelled");
  s2.close();
});

test("AU-70 (Codex r4): overlapping focus reads (slow A, fast B) settle, the typed turn is about B; a typed turn barged in meanwhile is dropped", async () => {
  const { client, session, sparkCalls } = setup();
  const { MemoryFindsStore, ownerKey } = await import("../src/finds/store.ts");
  class ByIdStore extends MemoryFindsStore {
    override async get(owner: string, id: string) {
      await sleep(id.endsWith("a1") ? 100 : 10);
      return super.get(owner, id);
    }
  }
  const store = new ByIdStore();
  const mk = (id: string, title: string) => ({ id, kind: "recipe" as const, createdAt: "2026-11-03T10:00:00Z", eyebrow: "", title, subtitle: "", items: [], steps: [], options: [], why: [], ask: [], sources: [], how: [] });
  await store.put(ownerKey("dev-1"), mk("11111111-aaaa-4bbb-8ccc-0000000000a1", "Card A"));
  await store.put(ownerKey("dev-1"), mk("11111111-aaaa-4bbb-8ccc-0000000000b2", "Card B"));
  await store.put(ownerKey("dev-1"), mk("22222222-aaaa-4bbb-8ccc-0000000000a1", "Card C"));
  const vendors = { async spark() { return { text: "", output: [] }; }, async *sparkStream() {}, async sam() { return []; }, async image() { return null; } };
  const s2 = new Session("f5", client, { ...(session as unknown as { deps: SessionDeps }).deps, finds: { vendors, store, images: false, imageBase: "/v1/finds" } as never, userId: "dev-1" });
  session.close();
  await s2.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  const before = sparkCalls.length;
  const t0 = performance.now();
  await Promise.all([
    s2.onClientText(JSON.stringify({ type: "find.focus", findId: "11111111-aaaa-4bbb-8ccc-0000000000a1" })),
    s2.onClientText(JSON.stringify({ type: "find.focus", findId: "11111111-aaaa-4bbb-8ccc-0000000000b2" })),
    s2.onClientText(JSON.stringify({ type: "text", text: "How long does it take?" })),
  ]);
  assert.ok(performance.now() - t0 < 1500, "no stall");
  await client.waitFor((m) => m.type === "reply", 3000);
  assert.ok(sparkCalls.length > before);
  assert.match(JSON.stringify(sparkCalls.at(-1)), /Card B/);
  // a typed product ask, then barge_in while a card loads: no search for it
  const n = client.json.length;
  const p = Promise.all([
    s2.onClientText(JSON.stringify({ type: "find.focus", findId: "22222222-aaaa-4bbb-8ccc-0000000000a1" })),
    s2.onClientText(JSON.stringify({ type: "text", text: "Can you find me black boots?" })),
  ]);
  await sleep(5);
  await s2.onClientText(JSON.stringify({ type: "barge_in" }));
  await p;
  await sleep(30);
  assert.ok(!client.json.slice(n).some((m) => m.type === "find.started"), "dropped");
  s2.close();
});

test("AU-70 (Codex r5): an Ask chip on an earlier card, barged in or switched to interpreting while it loads, is dropped", async () => {
  const { client, session } = setup();
  const { MemoryFindsStore, ownerKey } = await import("../src/finds/store.ts");
  class SlowStore extends MemoryFindsStore {
    override async get(owner: string, id: string) {
      await sleep(60);
      return super.get(owner, id);
    }
  }
  const store = new SlowStore();
  const mk = (id: string) => ({ id, kind: "recipe" as const, createdAt: "2026-11-03T10:00:00Z", eyebrow: "", title: "Stew", subtitle: "", items: [], steps: [], options: [], why: [], ask: [], sources: [], how: [] });
  await store.put(ownerKey("dev-1"), mk("33333333-aaaa-4bbb-8ccc-0000000000c1"));
  const vendors = { async spark() { return { text: "", output: [] }; }, async *sparkStream() {}, async sam() { return []; }, async image() { return null; } };
  const s2 = new Session("f6", client, { ...(session as unknown as { deps: SessionDeps }).deps, finds: { vendors, store, images: false, imageBase: "/v1/finds" } as never, userId: "dev-1" });
  session.close();
  await s2.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  const n = client.json.length;
  const p = s2.onClientText(JSON.stringify({ type: "text", text: "Can you find me black boots?", findId: "33333333-aaaa-4bbb-8ccc-0000000000c1" }));
  await sleep(5);
  await s2.onClientText(JSON.stringify({ type: "barge_in" }));
  await p;
  await sleep(30);
  assert.ok(!client.json.slice(n).some((m) => m.type === "transcript" || m.type === "find.started"), "dropped");
  s2.close();
});

test("AU-70 (Codex r6): an Ask chip still loading its card never runs after a newer typed question", async () => {
  const { client, session, sparkCalls } = setup();
  const { MemoryFindsStore, ownerKey } = await import("../src/finds/store.ts");
  class SlowStore extends MemoryFindsStore {
    override async get(owner: string, id: string) {
      await sleep(60);
      return super.get(owner, id);
    }
  }
  const store = new SlowStore();
  await store.put(ownerKey("dev-1"), { id: "44444444-aaaa-4bbb-8ccc-0000000000d1", kind: "recipe", createdAt: "2026-11-03T10:00:00Z", eyebrow: "", title: "Old card", subtitle: "", items: [], steps: [], options: [], why: [], ask: [], sources: [], how: [] });
  const vendors = { async spark() { return { text: "", output: [] }; }, async *sparkStream() {}, async sam() { return []; }, async image() { return null; } };
  const s2 = new Session("f7", client, { ...(session as unknown as { deps: SessionDeps }).deps, finds: { vendors, store, images: false, imageBase: "/v1/finds" } as never, userId: "dev-1" });
  session.close();
  await s2.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  const n = client.json.length;
  const old = s2.onClientText(JSON.stringify({ type: "text", text: "Is it spicy?", findId: "44444444-aaaa-4bbb-8ccc-0000000000d1" }));
  await sleep(5);
  await s2.onClientText(JSON.stringify({ type: "text", text: "What time is it?" }));
  await old;
  await sleep(30);
  const said = client.json.slice(n).filter((m) => m.type === "transcript").map((m) => m.text);
  assert.deepEqual(said, ["What time is it?"]);
  assert.ok(sparkCalls.length > 0);
  s2.close();
});
