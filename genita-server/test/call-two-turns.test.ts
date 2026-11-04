/**
 * DEMO P0 (11/4, TF 331 / prod cfb90f5e): in a call the companion answered the first spoken turn and never the
 * second. Two consecutive voice turns with the mic on, the first reply fully played and acked (playback_done),
 * must both be answered.
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
  frames = 0;
  async connect() { this.isOpen = true; }
  sendAudio() { this.frames++; }
  end() { this.isOpen = false; }
  fire(e: AsrEvent) { this.emit("event", e); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const voice = { url: "https://v", token: "t", speakers: { human: 0, animal: 0, character: 0 }, speed: 1, timeoutMs: 2000, model: "seamless" as const };

function setup(device: boolean) {
  const asr = new FakeAsr();
  const sent: Record<string, unknown>[] = [];
  const asked: string[] = [];
  const sink: ClientSink = {
    sendJson: (m) => sent.push(m as Record<string, unknown>),
    sendBinary: () => sent.push({ type: "bin" }),
    close() {},
  };
  const deps: SessionDeps = {
    config: { ...loadConfig({ MODEL_API_KEY: "k" }), webSearch: false, speculate: false, sparkHedge: 1, serverTts: !device, voice: device ? null : voice },
    openAsr: () => asr,
    async *spark(req: { input?: unknown }): AsyncGenerator<SparkStreamEvent> {
      asked.push(JSON.stringify(req).slice(-200));
      await sleep(10);
      yield { type: "text", delta: "<happy> Oh nice! Tell me more." };
      yield { type: "done", responseId: null, text: "", status: "completed" };
    },
    async *tts(): AsyncGenerator<TtsChunk> {
      yield { audio: Buffer.alloc(960), alignment: null, model: "seamless-m4t-v2" };
    },
  };
  return { asr, sent, asked, session: new Session("two-turns", sink, deps) };
}

const states = (sent: Record<string, unknown>[]) => sent.filter((m) => m.type === "state").map((m) => m.state).join(">");
const replies = (sent: Record<string, unknown>[]) => sent.filter((m) => m.type === "reply");

async function voiceTurn(asr: FakeAsr, session: Session, turnId: number, text: string) {
  asr.fire({ type: "speechStart", turnId });
  for (let i = 0; i < 5; i++) session.onClientAudio(Buffer.alloc(3840));
  asr.fire({ type: "partial", text });
  asr.fire({ type: "speechEnd", turnId });
  asr.fire({ type: "speechComplete", turnId, text });
}

async function waitFor(pred: () => boolean, ms: number) {
  const until = Date.now() + ms;
  while (!pred() && Date.now() < until) await sleep(10);
  return pred();
}

for (const device of [false, true]) {
  test(`two voice turns (${device ? "device" : "server"} voice): the second is answered too`, async () => {
    const { asr, sent, session } = setup(device);
    await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" }, tts: device ? "device" : "server" }));
    await session.onClientText(JSON.stringify({ type: "audio_start" }));

    await voiceTurn(asr, session, 0, "Hey, I just got home from work.");
    assert.ok(await waitFor(() => replies(sent).length === 1, 4000), `turn 1 answered: ${states(sent)}`);
    const u1 = replies(sent)[0].utteranceId as number;
    await session.onClientText(JSON.stringify({ type: "playback_done", utteranceId: u1 }));
    assert.ok(await waitFor(() => states(sent).endsWith("listening"), 2000), `back to listening: ${states(sent)}`);

    await sleep(50);
    await voiceTurn(asr, session, 1, "I made pasta for dinner tonight.");
    const ok = await waitFor(() => replies(sent).length === 2, 4000);
    session.close();
    assert.ok(ok, `turn 2 answered: states=${states(sent)} finals=${sent.filter((m) => m.type === "transcript" && m.final).map((m) => m.text).join(" | ")}`);
  });
}
