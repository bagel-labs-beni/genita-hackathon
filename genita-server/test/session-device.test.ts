/**
 * Device voice mode (lane L4 · metaface spec "Protocol"): the server sends each
 * reply sentence as a `say` event and the app speaks it on-device. No server voice
 * call, no `audio` events, no binary frames.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, deviceSpeechEstimateMs, type ClientSink } from "../src/session/session.ts";
import type { Config } from "../src/config.ts";
import { checkServerEvent } from "../src/protocol.ts";
import type { AsrEvent } from "../src/meta/transcribe.ts";
import type { SparkStreamEvent } from "../src/meta/spark.ts";
import type { TtsChunk } from "../src/tts/types.ts";
import { speechLang } from "../src/text/language.ts";

const config: Config = {
  metaKey: "x",
  serverTts: false,
  kling: false,
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

function setup(opts: { sparkText?: string; pieceDelayMs?: number; cfg?: Partial<Config> } = {}) {
  const asr = new FakeAsr();
  const client = new FakeClient();
  let ttsCalls = 0;
  const session = new Session("d1", client, {
    config: { ...config, ...opts.cfg },
    openAsr: () => asr,
    async *spark(_req, { signal }): AsyncGenerator<SparkStreamEvent> {
      const text = opts.sparkText ?? "<happy> Hey you! That sounds great.";
      for (const piece of text.match(/.{1,6}/gs) ?? []) {
        if (signal?.aborted) return;
        await sleep(opts.pieceDelayMs ?? 1);
        yield { type: "text", delta: piece };
      }
      yield { type: "done", responseId: "r1", text, status: "completed" };
    },
    // device mode must never reach the server TTS vendor
    tts(): AsyncIterable<TtsChunk> {
      ttsCalls++;
      throw new Error("tts must not be called in device mode");
    },
  });
  return { asr, client, session, ttsCalls: () => ttsCalls };
}

test("device mode is the default without server TTS: ready.tts device, lip none/device_tts", async () => {
  const { client, session } = setup();
  await session.onClientText(JSON.stringify({ type: "start", persona, lip: "atlas", mic: false }));
  const ready = client.of("ready")[0];
  assert.equal(ready.tts, "device");
  assert.deepEqual(ready.lip, { requested: "atlas", active: "none", reason: "device_tts" });
  session.close();
});

test("device mode: a voice turn sends one plain-text `say` per sentence, no audio, no TTS call", async () => {
  const { asr, client, session, ttsCalls } = setup();
  await session.onClientText(JSON.stringify({ type: "start", persona }));
  asr.fire({ type: "speechStart", turnId: 0 });
  asr.fire({ type: "speechEnd", turnId: 0 });
  asr.fire({ type: "speechComplete", turnId: 0, text: "I got the job" });
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "Hey you! That sounds great.");

  const says = client.of("say");
  assert.deepEqual(
    says.map(({ utteranceId, sentence, text, emotion, lang }) => ({ utteranceId, sentence, text, emotion, lang })),
    [
      { utteranceId: 1, sentence: 0, text: "Hey you!", emotion: "happy", lang: "en-US" },
      { utteranceId: 1, sentence: 1, text: "That sounds great.", emotion: "happy", lang: "en-US" },
    ],
  );
  assert.equal(ttsCalls(), 0, "server voice dep never called");
  assert.equal(client.of("audio").length, 0, "no audio events");
  assert.equal(client.bin.length, 0, "no binary frames");

  // speaking{on,emotion} goes out right before the first say; state flips to speaking on it
  const idx = (m: Record<string, unknown>) => client.json.indexOf(m);
  const speakingOn = client.json.find((m) => m.type === "speaking" && m.on === true)!;
  assert.equal(speakingOn.emotion, "happy");
  assert.ok(idx(speakingOn) < idx(says[0]));
  const speakingState = client.json.find((m) => m.type === "state" && m.state === "speaking")!;
  assert.ok(idx(speakingState) < idx(says[0]), "first say drives first_audio");
  assert.equal(client.json.filter((m) => m.type === "speaking" && m.on === true).length, 1, "one speaking:on per emotion change");

  const metrics = client.of("turn.metrics")[0];
  assert.equal(metrics.ttsModel, "device");
  assert.equal(typeof metrics.speechEndToFirstAudioMs, "number");
  session.close();
});

test("device mode: tags are stripped from say.text (emotion and [audio] tags)", async () => {
  const { client, session } = setup({ sparkText: "<amused> [laughs] That's so funny. <warm> I mean it." });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "joke" }));
  await client.waitFor((m) => m.type === "reply");
  const says = client.of("say");
  assert.deepEqual(says.map((s) => s.text), ["That's so funny.", "I mean it."]);
  assert.deepEqual(says.map((s) => s.emotion), ["amused", "warm"]);
  const on = client.json.filter((m) => m.type === "speaking" && m.on === true).map((m) => m.emotion);
  assert.deepEqual(on, ["amused", "warm"]);
  session.close();
});

test("device mode: playback_done ends speaking at once", async () => {
  const { client, session } = setup();
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "hi" }));
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.ok(!client.json.some((m) => m.type === "speaking" && m.on === false), "still speaking until the device finishes");
  await session.onClientText(JSON.stringify({ type: "playback_done", utteranceId: reply.utteranceId }));
  assert.ok(client.json.some((m) => m.type === "speaking" && m.on === false));
  assert.equal(client.json.at(-1)!.type, "state");
  assert.equal(client.json.at(-1)!.state, "listening");
  session.close();
});

test("device mode: without playback_done, speaking ends on the 70 ms/char + 1.5 s estimate", async () => {
  const { client, session } = setup({ sparkText: "<happy> Hi." });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "hi" }));
  await client.waitFor((m) => m.type === "reply");
  const t0 = Date.now();
  await sleep(1000);
  assert.ok(!client.json.some((m) => m.type === "speaking" && m.on === false), "not before the estimate (3 chars → 1.71 s)");
  await client.waitFor((m) => m.type === "speaking" && m.on === false, 2000);
  const waited = Date.now() - t0;
  assert.ok(waited < 2000, `ended near the estimate, waited ${waited} ms after reply`);
  await client.waitFor((m) => m.type === "state" && m.state === "listening" && client.json.indexOf(m) > 2);
  session.close();
});

test("deviceSpeechEstimateMs: 70 ms per character + 1.5 s, capped at 60 s", () => {
  assert.equal(deviceSpeechEstimateMs(0), 1500);
  assert.equal(deviceSpeechEstimateMs(100), 8500);
  assert.equal(deviceSpeechEstimateMs(5000), 60_000);
});

test("device mode: barge-in mid reply cancels and no say follows utterance.cancelled", async () => {
  const { asr, client, session, ttsCalls } = setup({
    sparkText: "<warm> Once upon a time there was a fox. It lived in a forest. It loved snow. It had friends. The end.",
    pieceDelayMs: 8,
  });
  await session.onClientText(JSON.stringify({ type: "start", persona }));
  asr.fire({ type: "speechComplete", turnId: 0, text: "tell me a story" });
  await client.waitFor((m) => m.type === "say");
  asr.fire({ type: "speechStart", turnId: 1 });
  asr.fire({ type: "partial", text: "wait stop" });
  const cancelled = await client.waitFor((m) => m.type === "utterance.cancelled");
  assert.equal(cancelled.reason, "barge_in");
  await sleep(150); // the rest of the story would have streamed by now
  const after = client.json.slice(client.json.indexOf(cancelled));
  assert.equal(after.filter((m) => m.type === "say").length, 0, "no say after cancel");
  assert.ok(client.of("say").length < 5, "the story was cut");
  assert.ok(!client.json.some((m) => m.type === "reply"), "cancelled reply never finalizes");
  assert.equal(ttsCalls(), 0);
  session.close();
});

test("device mode: start.tts:server is refused when the server has no server TTS", async () => {
  const { client, session, ttsCalls } = setup();
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "P", kind: "human" }, tts: "server", lip: { mode: "retired", fallback: "none" }, mic: false }));
  const ready = client.of("ready")[0];
  assert.equal(ready.tts, "device");
  assert.deepEqual(ready.lip, { requested: "none", active: "none", reason: "device_tts" });
  await session.onClientText(JSON.stringify({ type: "text", text: "hi" }));
  await client.waitFor((m) => m.type === "reply");
  assert.equal(ttsCalls(), 0);
  assert.ok(client.of("say").length > 0);
  session.close();
});

test("server TTS on: default stays server; start.tts:device switches this call to device", async () => {
  const on = { serverTts: true } as Partial<Config>;
  const a = setup({ cfg: on });
  await a.session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  assert.equal(a.client.of("ready")[0].tts, "server");
  a.session.close();
  const b = setup({ cfg: on });
  await b.session.onClientText(JSON.stringify({ type: "start", persona, tts: "device", mic: false }));
  assert.equal(b.client.of("ready")[0].tts, "device");
  await b.session.onClientText(JSON.stringify({ type: "text", text: "hi" }));
  await b.client.waitFor((m) => m.type === "reply");
  assert.equal(b.ttsCalls(), 0);
  assert.ok(b.client.of("say").length > 0);
  b.session.close();
});

test("say.lang: Hangul text → ko-KR; else the reply language (interpretation: the target)", async () => {
  // a Korean turn in chat mode is interpreted to English → en-US
  const en = setup({ sparkText: "<neutral> He's asking how to get to City Hall." });
  await en.session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await en.session.onClientText(JSON.stringify({ type: "text", text: "실례합니다, 시청 어떻게 가요?" }));
  await en.client.waitFor((m) => m.type === "reply");
  assert.equal(en.client.of("say")[0].lang, "en-US");
  en.session.close();
  // interpret mode, English turn → Korean target → ko-KR
  const ko = setup({ sparkText: "<neutral> 시청은 저쪽이에요." });
  // F8 interpreter (#114): my English needs the other language set to be relayed
  await ko.session.onClientText(JSON.stringify({ type: "start", persona, mode: "interpret", interpret: { other: "Korean" }, mic: false }));
  await ko.session.onClientText(JSON.stringify({ type: "text", text: "City Hall is that way." }));
  await ko.client.waitFor((m) => m.type === "reply");
  assert.equal(ko.client.of("say")[0].lang, "ko-KR");
  assert.equal(ko.client.bin.length, 0, "device mode: interpretation sends say text, no audio frames");
  ko.session.close();
});

test("speechLang maps text + language name to a BCP-47 tag", () => {
  assert.equal(speechLang("안녕하세요!", "English"), "ko-KR");
  assert.equal(speechLang("Hello there.", "English"), "en-US");
  assert.equal(speechLang("Hello there.", "Korean"), "ko-KR");
  assert.equal(speechLang("Hola.", "Spanish"), "es-ES");
  assert.equal(speechLang("Bonjour.", "fr-CA"), "fr-CA");
  assert.equal(speechLang("Hello.", "Unrecognized language"), "en-US");
});
