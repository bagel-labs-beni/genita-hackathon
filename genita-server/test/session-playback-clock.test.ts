/**
 * AU-49 (IC-02 step 1): the reply stays "speaking" until the app's playback really ends.
 * The app queues each clip at max(its queue end, arrival), so a gap between clips (a line, then a
 * web search, then the answer) pushes the end of playback out. The server used to count only the
 * clip durations from the first audio, went back to "listening" while the answer was still
 * playing, and a voice barge-in in that tail did nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, type ClientSink, type SessionDeps } from "../src/session/session.ts";
import type { Config } from "../src/config.ts";
import type { AsrEvent } from "../src/meta/transcribe.ts";
import type { SparkStreamEvent } from "../src/meta/spark.ts";
import type { TtsChunk } from "../src/tts/types.ts";

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
  async connect() { this.isOpen = true; }
  sendAudio() {}
  end() { this.isOpen = false; }
  fire(e: AsrEvent) { this.emit("event", e); }
}

class FakeClient implements ClientSink {
  json: Record<string, unknown>[] = [];
  bin = 0;
  sendJson(m: Record<string, unknown>) { this.json.push(m); }
  sendBinary() { this.bin++; }
  close() {}
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
/** 24 kHz 16-bit mono PCM of `ms` milliseconds */
const pcm = (ms: number) => Buffer.alloc((ms / 1000) * 24000 * 2);

/**
 * Fake clock. Clip 1 ("Sure, one sec.", 1.5 s of audio) goes out at t=0; generation then stalls
 * (a search) until t=5.5 s and clip 2 (3 s of audio) goes out. The app plays clip 2 from 5.5 s to
 * 8.5 s. The old estimate (first audio + 4.5 s of clips) ended playback at 4.75 s, already past.
 */
function setup() {
  let clock = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const asr = new FakeAsr();
  const client = new FakeClient();
  const deps: SessionDeps = {
    config,
    openAsr: () => asr,
    now: () => clock,
    async *spark(): AsyncGenerator<SparkStreamEvent> {
      yield { type: "text", delta: "<warm> Sure, one sec. " };
      await gate;
      yield { type: "text", delta: "The second one opens at nine tomorrow." };
      yield { type: "done", responseId: "r", text: "", status: "completed" };
    },
    async *tts(req): AsyncGenerator<TtsChunk> {
      await sleep(1);
      if (req.signal?.aborted) return;
      yield { audio: pcm(/second one/.test(req.text) ? 3000 : 1500), model: req.model };
    },
  };
  const session = new Session("pc1", client, deps);
  return { asr, client, session, release, setClock: (t: number) => { clock = t; } };
}

test("AU-49: a gap between clips keeps the reply speaking until the app's queue ends; a voice barge-in there cancels it", async (t) => {
  const { asr, client, session, release, setClock } = setup();
  t.after(() => session.close());
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina", kind: "animal" } }));
  asr.fire({ type: "speechComplete", turnId: 0, text: "which one opens first tomorrow" });
  await client.waitFor((m) => m.type === "audio");
  setClock(5500); // the search took 4 s after the first line finished playing
  release();
  const reply = await client.waitFor((m) => m.type === "reply");
  await sleep(60);
  assert.ok(!client.json.some((m) => m.type === "speaking" && m.on === false), "still speaking: the app plays the answer until 8.5 s");

  // the user talks over the tail of the answer
  setClock(7000);
  asr.fire({ type: "speechStart", turnId: 1 });
  asr.fire({ type: "partial", text: "ok show me" });
  const cancelled = await client.waitFor((m) => m.type === "utterance.cancelled");
  assert.equal(cancelled.reason, "barge_in");
  assert.equal(cancelled.utteranceId, reply.utteranceId);
});

test("AU-49: playback_done still ends the reply at once (before the queue estimate)", async (t) => {
  const { asr, client, session, release, setClock } = setup();
  t.after(() => session.close());
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina", kind: "animal" } }));
  asr.fire({ type: "speechComplete", turnId: 0, text: "which one opens first tomorrow" });
  await client.waitFor((m) => m.type === "audio");
  setClock(5500);
  release();
  const reply = await client.waitFor((m) => m.type === "reply");
  await sleep(20);
  assert.ok(!client.json.some((m) => m.type === "speaking" && m.on === false));
  await session.onClientText(JSON.stringify({ type: "playback_done", utteranceId: reply.utteranceId }));
  assert.ok(client.json.some((m) => m.type === "speaking" && m.on === false && m.utteranceId === reply.utteranceId));
  assert.ok(client.json.some((m) => m.type === "state" && m.state === "listening" && client.json.indexOf(m) > client.json.indexOf(reply)));
});
