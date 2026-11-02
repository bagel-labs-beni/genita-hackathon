import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, FRAME_HEADER_BYTES, type ClientSink, type SessionDeps } from "../src/session/session.ts";
import type { Config } from "../src/config.ts";
import type { AsrEvent } from "../src/meta/transcribe.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import type { TtsChunk } from "../src/tts/elevenlabs.ts";

const config: Config = {
  metaKey: "x",
  elevenKey: "y",
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
