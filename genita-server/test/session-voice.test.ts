/**
 * Server voice from the Meta voice service (D3, Seamless on Modal): audio + timing frames as
 * in server TTS mode, the voice is a Seamless speaker per companion kind, sentences carry their
 * language (interpretation: kor/eng), and a failing voice service hands the rest of the reply to
 * the app's own voice (`say`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, deviceSpeechEstimateMs, type ClientSink } from "../src/session/session.ts";
import type { Config } from "../src/config.ts";
import { checkServerEvent } from "../src/protocol.ts";
import type { AsrEvent } from "../src/meta/transcribe.ts";
import type { SparkStreamEvent } from "../src/meta/spark.ts";
import type { TtsChunk } from "../src/tts/elevenlabs.ts";

const config: Config = {
  metaKey: "x",
  elevenKey: null,
  serverTts: false,
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
  async connect() {
    this.isOpen = true;
  }
  sendAudio() {}
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
  sendJson(m: Record<string, unknown>) {
    assert.deepEqual(checkServerEvent(m), [], JSON.stringify(m));
    this.json.push(m);
  }
  sendBinary(b: Buffer) {
    this.bin.push(b);
  }
  close() {}
  of(type: string) {
    return this.json.filter((m) => m.type === type);
  }
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const persona = { name: "Companion", kind: "animal", traits: ["warm"] };
const voice = { url: "https://v", token: "t", speakers: { human: 3, animal: 5, character: 9 }, speed: 1, timeoutMs: 500, model: "seamless" as const };

type TtsReq = { voiceId: string; text: string; lang?: string; signal?: AbortSignal };

function setup(opts: { sparkText?: string; failAt?: number; chunkDelayMs?: number } = {}) {
  const asr = new FakeAsr();
  const client = new FakeClient();
  const calls: TtsReq[] = [];
  const prefetched: number[] = [];
  const session = new Session("v1", client, {
    config: { ...config, serverTts: true, voice },
    openAsr: () => asr,
    async *spark(_req, { signal }): AsyncGenerator<SparkStreamEvent> {
      const text = opts.sparkText ?? "<happy> Oh wow, you're back! How was it?";
      for (const piece of text.match(/.{1,6}/gs) ?? []) {
        if (signal?.aborted) return;
        await sleep(1);
        yield { type: "text", delta: piece };
      }
      yield { type: "done", responseId: "r1", text, status: "completed" };
    },
    async *tts(req): AsyncGenerator<TtsChunk> {
      const i = calls.push(req) - 1;
      if (opts.failAt !== undefined && i >= opts.failAt) throw new Error("voice 503: down");
      await sleep(opts.chunkDelayMs ?? 1);
      if (req.signal?.aborted) return;
      yield { audio: Buffer.alloc(4800), alignment: { chars: [...req.text], startsSec: [...req.text].map((_, k) => k * 0.02), endsSec: [...req.text].map((_, k) => k * 0.02 + 0.02) }, model: "seamless-m4t-v2" };
    },
    voicePrefetch: (s) => prefetched.push(s),
  });
  return { asr, client, session, calls, prefetched };
}

test("voice service: ready.tts server, voice = the kind's Seamless speaker, fillers prefetched", async () => {
  const { client, session, prefetched } = setup();
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  const ready = client.of("ready")[0];
  assert.equal(ready.tts, "server");
  assert.equal(ready.voiceId, "seamless:5", "animal default");
  assert.deepEqual(prefetched, [5]);
  session.close();
});

test("voice service: start.voiceId seamless:<n> picks that speaker; ElevenLabs ids map to the kind default", async () => {
  const a = setup();
  await a.session.onClientText(JSON.stringify({ type: "start", persona, voiceId: "seamless:42", mic: false }));
  assert.equal(a.client.of("ready")[0].voiceId, "seamless:42");
  a.session.close();
  const b = setup();
  await b.session.onClientText(JSON.stringify({ type: "start", persona: { ...persona, kind: "human", voice: { id: "7PbNGDB5sJCFnOZuMPNL" } }, mic: false }));
  assert.equal(b.client.of("ready")[0].voiceId, "seamless:3");
  b.session.close();
});

test("voice service: first clause is cut at its comma; audio frames + words timing; no say", async () => {
  const { client, session, calls } = setup();
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "back" }));
  await client.waitFor((m) => m.type === "reply");
  assert.deepEqual(calls.map((c) => c.text), ["Oh wow,", "you're back!", "How was it?"]);
  assert.ok(calls.every((c) => c.voiceId === "seamless:5" && c.lang === "en-US"));
  const audio = client.of("audio");
  assert.equal(audio.length, 3);
  assert.equal(client.bin.length, 3);
  assert.deepEqual(audio.map((a) => a.offsetMs), [0, 100, 200], "each clause continues the reply timeline");
  assert.ok((audio[0].words as unknown[]).length > 0, "word timing for the mouth engine");
  assert.equal(client.of("say").length, 0);
  assert.equal(client.of("turn.metrics")[0].ttsModel, "seamless-m4t-v2");
  session.close();
});

test("voice service: Korean (interpretation) sentences carry ko-KR so the service speaks kor", async () => {
  const { client, session, calls } = setup({ sparkText: "<neutral> 네, 바로 저 모퉁이 돌면 있어요." });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "where?" }));
  await client.waitFor((m) => m.type === "reply");
  assert.ok(calls.length >= 1 && calls.every((c) => c.lang === "ko-KR"), JSON.stringify(calls.map((c) => c.lang)));
  session.close();
});

test("voice service down mid-reply: tts_unavailable once, the rest goes to the app as say, nothing lost", async () => {
  const { client, session, calls } = setup({ failAt: 1 });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "back" }));
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "Oh wow, you're back! How was it?");
  assert.equal(client.of("audio").length, 1, "first clause was voiced");
  assert.equal(client.of("error").filter((e) => e.code === "tts_unavailable").length, 1);
  assert.deepEqual(client.of("say").map((s) => s.text), ["you're back!", "How was it?"]);
  assert.equal(calls.length, 2, "no more service calls after the failure in this reply");
  assert.equal(client.of("turn.metrics")[0].ttsModel, "seamless-m4t-v2+device");
  session.close();
});

test("voice service down from the start: every sentence becomes say, first_audio fires on the first", async () => {
  const { client, session } = setup({ failAt: 0 });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "back" }));
  await client.waitFor((m) => m.type === "reply");
  assert.deepEqual(client.of("say").map((s) => s.text), ["Oh wow,", "you're back!", "How was it?"]);
  assert.ok(client.json.some((m) => m.type === "state" && m.state === "speaking"));
  assert.equal(client.of("turn.metrics")[0].ttsModel, "device");
  session.close();
});

test("voice service: barge-in stops the stream; no audio frame after utterance.cancelled", async () => {
  const { client, session, calls } = setup({ chunkDelayMs: 40, sparkText: "<happy> Oh wow, that is a long story. Tell me everything. Start from the top." });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "story" }));
  await client.waitFor((m) => m.type === "audio");
  await session.onClientText(JSON.stringify({ type: "barge_in" }));
  const cancelled = await client.waitFor((m) => m.type === "utterance.cancelled");
  const binBefore = client.bin.length;
  await sleep(200);
  const after = client.json.slice(client.json.indexOf(cancelled));
  assert.equal(after.filter((m) => m.type === "audio" || m.type === "say").length, 0);
  assert.equal(client.bin.length, binBefore, "no binary after cancel");
  assert.ok(calls.some((c) => c.signal?.aborted), "the in-flight voice request was aborted");
  session.close();
});

test("voice service: when the opener guard drops a whole first clause ('Oh,'), the next clause starts with a capital", async () => {
  const { client, session } = setup({ sparkText: "<happy> Oh, perfect cozy night! Want a comedy?" });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false, history: [{ role: "assistant", text: "Oh, hi there." }] }));
  await session.onClientText(JSON.stringify({ type: "text", text: "movie?" }));
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "Perfect cozy night! Want a comedy?");
  session.close();
});

test("voice service fails mid-sentence: the unspoken words of that sentence go to say", async () => {
  const asr = new FakeAsr();
  const client = new FakeClient();
  const session = new Session("v2", client, {
    config: { ...config, serverTts: true, voice },
    openAsr: () => asr,
    async *spark(): AsyncGenerator<SparkStreamEvent> {
      yield { type: "text", delta: "<happy> We should totally get noodles tonight. Okay?" };
      yield { type: "done", responseId: "r", text: "", status: "completed" };
    },
    async *tts(req): AsyncGenerator<TtsChunk> {
      if (req.text.startsWith("Okay")) throw new Error("voice 503");
      const said = "We should totally ";
      yield { audio: Buffer.alloc(4800), alignment: { chars: [...said], startsSec: [...said].map((_, k) => k * 0.02), endsSec: [...said].map((_, k) => k * 0.02 + 0.02) }, model: "seamless-m4t-v2" };
      throw new Error("voice network: reset");
    },
  });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "dinner?" }));
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "We should totally get noodles tonight. Okay?");
  assert.deepEqual(client.of("say").map((s) => s.text), ["get noodles tonight.", "Okay?"]);
  session.close();
});

function midFail(text: string, voiced: string | null) {
  const client = new FakeClient();
  const session = new Session("v3", client, {
    config: { ...config, serverTts: true, voice },
    openAsr: () => new FakeAsr(),
    async *spark(): AsyncGenerator<SparkStreamEvent> {
      yield { type: "text", delta: text };
      yield { type: "done", responseId: "r", text: "", status: "completed" };
    },
    async *tts(): AsyncGenerator<TtsChunk> {
      const a = voiced === null ? null : { chars: [...voiced], startsSec: [...voiced].map(() => 0), endsSec: [...voiced].map(() => 0) };
      yield { audio: Buffer.alloc(4800), alignment: a, model: "seamless-m4t-v2" };
      throw new Error("voice network: reset");
    },
  });
  return { client, session };
}

test("mid-sentence failure counts voiced words in the spoken form ('$123' = 4 words), so nothing is lost", async () => {
  const { client, session } = midFail("<neutral> Pay $123 now and leave.", "Pay one hundred twenty-three dollars ");
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "x" }));
  await client.waitFor((m) => m.type === "reply");
  assert.deepEqual(client.of("say").map((s) => s.text), ["now and leave."]);
  session.close();
});

test("mid-sentence failure without timing (MMS backup) says the whole sentence again rather than drop it", async () => {
  const { client, session } = midFail("<neutral> We should get noodles tonight.", null);
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "x" }));
  await client.waitFor((m) => m.type === "reply");
  assert.deepEqual(client.of("say").map((s) => s.text), ["We should get noodles tonight."]);
  session.close();
});
