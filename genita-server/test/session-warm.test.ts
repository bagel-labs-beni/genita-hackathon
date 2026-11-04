import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, type ClientSink, type SessionDeps } from "../src/session/session.ts";
import { loadConfig } from "../src/config.ts";
import type { AsrEvent } from "../src/meta/transcribe.ts";
import type { SparkStreamEvent } from "../src/meta/spark.ts";

class FakeAsr extends EventEmitter {
  isOpen = false;
  async connect() { this.isOpen = true; }
  sendAudio() {}
  end() { this.isOpen = false; }
  fire(e: AsrEvent) { this.emit("event", e); }
}
const sink: ClientSink = { sendJson() {}, sendBinary() {}, close() {} };

function setup() {
  const asr = new FakeAsr();
  let clock = 0;
  const warms: number[] = [];
  const voiceFlags: boolean[] = [];
  const deps: SessionDeps = {
    config: { ...loadConfig({ MODEL_API_KEY: "k" }), webSearch: false, speculate: false },
    openAsr: () => asr,
    async *spark(): AsyncGenerator<SparkStreamEvent> { yield { type: "text", delta: "Hi." }; },
    async *tts() {},
    now: () => clock,
    prewarm: (o) => (warms.push(clock), voiceFlags.push(o.voice)),
  };
  const session = new Session("w1", sink, deps);
  return { asr, session, warms, voiceFlags, tick: (ms: number) => (clock += ms) };
}

test("warm-up: a call start opens the vendor connections once", async () => {
  const { session, warms } = setup();
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" } }));
  assert.deepEqual(warms, [0]);
});

test("warm-up: the user starting to talk after a long quiet re-opens them; a busy call does not", async () => {
  const { asr, session, warms, tick } = setup();
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" } }));
  tick(10_000);
  asr.fire({ type: "speechStart", turnId: 0 });
  assert.equal(warms.length, 1, "10 s after the last warm-up the sockets are still open");
  tick(50_000);
  asr.fire({ type: "speechStart", turnId: 1 });
  assert.deepEqual(warms, [0, 60_000], "after 45 s+ of quiet the next turn warms up first");
});

test("warm-up: a turn that just used the vendors counts as warm; device speech never warms the voice", async () => {
  const { asr, session, warms, voiceFlags, tick } = setup();
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" }, tts: "device" }));
  tick(40_000);
  asr.fire({ type: "speechStart", turnId: 0 });
  asr.fire({ type: "speechEnd", turnId: 0 });
  asr.fire({ type: "speechComplete", turnId: 0, text: "hi there." });
  await new Promise((r) => setTimeout(r, 20));
  tick(20_000); // 60 s after the start, 20 s after a reply used the sockets
  asr.fire({ type: "speechStart", turnId: 1 });
  assert.deepEqual(warms, [0]);
  assert.deepEqual(voiceFlags, [false]);
});

test("latency log: on a speculation hit, first token = when Spark sent it, not when the reply read it", async () => {
  const asr = new FakeAsr();
  let clock = 0;
  let release!: () => void;
  const tokenGate = new Promise<void>((r) => (release = r));
  const logs: Record<string, unknown>[] = [];
  const deps: SessionDeps = {
    config: { ...loadConfig({ MODEL_API_KEY: "k" }), webSearch: false, speculate: true, sparkHedge: 1 },
    openAsr: () => asr,
    async *spark(): AsyncGenerator<SparkStreamEvent> {
      await tokenGate;
      yield { type: "text", delta: "<happy> Nice one." };
      yield { type: "done", responseId: null, text: "Nice one.", status: "completed" };
    },
    async *tts() {},
    now: () => clock,
    log: (event, data) => event === "turn.answered" && logs.push(data),
  };
  const session = new Session("w2", sink, deps);
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" } }));
  asr.fire({ type: "speechStart", turnId: 0 });
  clock = 100;
  asr.fire({ type: "partial", text: "I got the job." }); // looks final → speculation starts now
  clock = 200;
  release();
  await new Promise((r) => setTimeout(r, 20)); // the token is buffered at t=200
  clock = 900;
  asr.fire({ type: "speechEnd", turnId: 0 });
  clock = 1000;
  asr.fire({ type: "speechComplete", turnId: 0, text: "I got the job." });
  for (let i = 0; i < 100 && !logs.length; i++) await new Promise((r) => setTimeout(r, 5));
  const stages = logs[0]?.stages as Record<string, number>;
  assert.equal(logs[0]?.speculative, "hit");
  assert.equal(stages.specStart, 100 - 900);
  assert.equal(stages.firstToken, 200 - 900, "token arrived 700 ms before speechEnd");
});
