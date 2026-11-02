/**
 * The companion never starts talking while the user is talking (latency lane, 11/3). Faster answers
 * made it likelier that a reply was ready while the user, after a pause the ASR took for the end of
 * the turn, had already started again; the first sound then went out over them for up to the 400 ms
 * barge-in window. Now the first sound waits while the user is speaking: they keep talking → the
 * barge-in cancels the reply before any sound; a short "yeah" → the reply plays right after it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, type ClientSink, type SessionDeps } from "../src/session/session.ts";
import { loadConfig } from "../src/config.ts";
import type { AsrEvent } from "../src/meta/transcribe.ts";
import type { SparkStreamEvent } from "../src/meta/spark.ts";
import type { TtsChunk } from "../src/tts/types.ts";

class FakeAsr extends EventEmitter {
  isOpen = false;
  async connect() { this.isOpen = true; }
  sendAudio() {}
  end() { this.isOpen = false; }
  fire(e: AsrEvent) { this.emit("event", e); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const voice = { url: "https://v", token: "t", speakers: { human: 0, animal: 0, character: 0 }, speed: 1, timeoutMs: 2000, model: "seamless" as const };

function setup(device: boolean) {
  const asr = new FakeAsr();
  const sent: { t: string; at: number }[] = [];
  const t0 = Date.now();
  const sink: ClientSink = {
    sendJson: (m) => sent.push({ t: m.type === "state" ? `state:${m.state}` : String(m.type), at: Date.now() - t0 }),
    sendBinary: () => sent.push({ t: "bin", at: Date.now() - t0 }),
    close() {},
  };
  const deps: SessionDeps = {
    config: { ...loadConfig({ MODEL_API_KEY: "k" }), webSearch: false, speculate: false, sparkHedge: 1, serverTts: !device, voice: device ? null : voice },
    openAsr: () => asr,
    async *spark(): AsyncGenerator<SparkStreamEvent> {
      await sleep(30); // the answer is ready 30 ms after the turn ends
      yield { type: "text", delta: "<happy> Oh nice! Tell me more." };
      yield { type: "done", responseId: null, text: "", status: "completed" };
    },
    async *tts(): AsyncGenerator<TtsChunk> {
      yield { audio: Buffer.alloc(960), alignment: null, model: "seamless-m4t-v2" };
    },
  };
  return { asr, sent, session: new Session("h1", sink, deps) };
}

async function turnThenResume(device: boolean, resumeMs: number) {
  const { asr, sent, session } = setup(device);
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" }, bargeIn: { minMs: 120 }, tts: device ? "device" : "server" }));
  asr.fire({ type: "speechStart", turnId: 0 });
  asr.fire({ type: "speechEnd", turnId: 0 });
  asr.fire({ type: "speechComplete", turnId: 0, text: "Hey, I just got home." });
  await sleep(10);
  asr.fire({ type: "speechStart", turnId: 1 }); // the user goes on before the answer is ready
  await sleep(resumeMs);
  return { asr, sent };
}

for (const device of [false, true]) {
  const sound = device ? "say" : "bin";
  test(`hold (${device ? "device" : "server"} voice): the user keeps talking → the reply is cancelled before any sound`, async () => {
    const { sent } = await turnThenResume(device, 300);
    assert.equal(sent.filter((m) => m.t === sound).length, 0, sent.map((m) => m.t).join(","));
    assert.ok(sent.some((m) => m.t === "utterance.cancelled"));
  });

  test(`hold (${device ? "device" : "server"} voice): a short backchannel → the reply plays right after it`, async () => {
    const { asr, sent } = await turnThenResume(device, 60);
    assert.equal(sent.filter((m) => m.t === sound).length, 0, "nothing while the user is speaking");
    asr.fire({ type: "speechEnd", turnId: 1 }); // "yeah" ended before the 120 ms barge-in
    await sleep(80);
    assert.ok(sent.filter((m) => m.t === sound).length > 0, sent.map((m) => m.t).join(","));
    assert.equal(sent.filter((m) => m.t === "utterance.cancelled").length, 0);
  });
}
