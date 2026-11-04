/**
 * Coherence 11/4 (Chelsea's 18:31 call: replies "don't follow from what I said"). A speculative Spark request is
 * built from a partial transcript while the user is still talking. The transcript check (same words) was already
 * there, but the request also froze everything else it was built from: the call's turns, the profile, the memories.
 * If any of that changed before the turn committed (a card's line landed in the history, the server profile arrived
 * late, a Forget scrubbed a line), the "hit" answered from a stale context. Now a guess is only reused when both the
 * words and that context match; otherwise it is a miss and Spark is asked again with the current context.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, type ClientSink, type SessionDeps } from "../src/session/session.ts";
import { loadConfig } from "../src/config.ts";
import type { AsrEvent } from "../src/meta/transcribe.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";

class FakeAsr extends EventEmitter {
  isOpen = false;
  async connect() { this.isOpen = true; }
  sendAudio() {}
  end() { this.isOpen = false; }
  fire(e: AsrEvent) { this.emit("event", e); }
}
const sink: ClientSink = { sendJson() {}, sendBinary() {}, close() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const asr = new FakeAsr();
  const calls: SparkRequest[] = [];
  const answered: Record<string, unknown>[] = [];
  const deps: SessionDeps = {
    config: { ...loadConfig({ MODEL_API_KEY: "k" }), webSearch: false, speculate: true, sparkHedge: 1, serverTts: false },
    openAsr: () => asr,
    async *spark(req): AsyncGenerator<SparkStreamEvent> {
      calls.push(req);
      yield { type: "text", delta: "<happy> Nice one." };
      yield { type: "done", responseId: null, text: "Nice one.", status: "completed" };
    },
    async *tts() {},
    log: (event, data) => event === "turn.answered" && answered.push(data),
  };
  const session = new Session("stale", sink, deps);
  return { asr, session, calls, answered };
}

async function speak(h: ReturnType<typeof setup>, between?: () => void) {
  h.asr.fire({ type: "speechStart", turnId: 0 });
  h.asr.fire({ type: "partial", text: "I got the job." }); // looks final → the guess starts now
  await sleep(20);
  between?.();
  h.asr.fire({ type: "speechEnd", turnId: 0 });
  h.asr.fire({ type: "speechComplete", turnId: 0, text: "I got the job." });
  for (let i = 0; i < 100 && !h.answered.length; i++) await sleep(5);
}

test("speculation: nothing changed while they talked → the guess is reused (hit, one Spark call)", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await h.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" }, user: { name: "Summer", profile: "Into: ramen." } }));
  await speak(h);
  assert.equal(h.answered[0]?.speculative, "hit");
  assert.equal(h.calls.length, 1);
});

test("speculation red→green: a line added to the call while they talked (a card's line) → miss, asked again with it", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await h.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" } }));
  // the Finds card / watch-together path speaks its own line into this call's history (session.remember)
  await speak(h, () => (h.session as unknown as { remember(r: string, t: string): void }).remember("assistant", "Found you dark brown boots, they're on your screen."));
  assert.equal(h.answered[0]?.speculative, "miss", "the guess was built without the card's line");
  assert.equal(h.calls.length, 2);
  assert.match(JSON.stringify(h.calls[1].input), /dark brown boots/, "the real request carries the line");
});

test("speculation red→green: the profile changed while they talked (late server profile) → miss, asked again with it", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await h.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" }, user: { name: "Summer" } }));
  await speak(h, () => {
    const s = h.session as unknown as { user: { name?: string; profile?: string } };
    s.user = { ...s.user, profile: "Into: late-night ramen, aespa." };
  });
  assert.equal(h.answered[0]?.speculative, "miss");
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].instructions ?? "", /late-night ramen/);
});
