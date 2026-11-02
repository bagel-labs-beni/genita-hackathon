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
  const deps: SessionDeps = {
    config: { ...loadConfig({ MODEL_API_KEY: "k" }), webSearch: false, speculate: false },
    openAsr: () => asr,
    async *spark(): AsyncGenerator<SparkStreamEvent> { yield { type: "text", delta: "Hi." }; },
    async *tts() {},
    now: () => clock,
    prewarm: () => warms.push(clock),
  };
  const session = new Session("w1", sink, deps);
  return { asr, session, warms, tick: (ms: number) => (clock += ms) };
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
