/**
 * perf(turn) 11/4 (iPhone build 381 on prod, 21:3x–21:55 KST): speech end → first audio p50 1.74 s, max 6.69 s,
 * 8/20 turns over 3 s. The slow turns were all speculative=none: with the camera on, the app sends `frames` at every
 * speech start and speech end, and a fresh frame turned speculation off (considerSpeculation / holdTurn bailed out)
 * and killed any running guess (setFrames). So every camera turn waited for Spark's whole first-token time after the
 * user stopped (2.7–6.2 s), while camera-off turns in the same session hit the guess (1.0–1.9 s).
 *
 * Now a guess also runs with the camera on: it carries the question's first frame (peeked, not consumed). The
 * speech-end frames keep it unless the line is about what the camera shows ("how do I look?"), which still waits
 * for the newest frames as before. A hit takes the newest frames for the card pipeline and clears them.
 *
 * Also turn.metrics: a typed turn counts from its arrival (the app does the same), and the greeting / initiative /
 * card line say what they are (`trigger`) instead of a bare null that the app logs as -1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, type ClientSink, type SessionDeps } from "../src/session/session.ts";
import { loadConfig } from "../src/config.ts";
import type { AsrEvent } from "../src/meta/transcribe.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import { asksAboutView } from "../src/convo/cameraAsk.ts";

class FakeAsr extends EventEmitter {
  isOpen = false;
  async connect() { this.isOpen = true; }
  sendAudio() {}
  end() { this.isOpen = false; }
  fire(e: AsrEvent) { this.emit("event", e); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const A = "QUFBQQ=="; // the speech-start frame
const B = "QkJCQg=="; // the speech-end frame

function setup() {
  const asr = new FakeAsr();
  const calls: SparkRequest[] = [];
  const answered: Record<string, unknown>[] = [];
  const metrics: Record<string, unknown>[] = [];
  const sink: ClientSink = { sendJson(m) { if ((m as { type?: string }).type === "turn.metrics") metrics.push(m as Record<string, unknown>); }, sendBinary() {}, close() {} };
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
  const session = new Session("camspec", sink, deps);
  return { asr, session, calls, answered, metrics };
}
type H = ReturnType<typeof setup>;

const frames = (h: H, images: string[]) => h.session.onClientText(JSON.stringify({ type: "frames", images }));
const imagesOf = (req: SparkRequest) => JSON.stringify(req.input).match(/input_image/g)?.length ?? 0;

/** the iPhone's camera turn: frame A at speech start, A+B at speech end (CallSession.swift) */
async function cameraTurn(h: H, line: string, opts: { endFrames?: boolean } = {}) {
  const n = h.answered.length;
  h.asr.fire({ type: "speechStart", turnId: 0 });
  await frames(h, [A]);
  h.asr.fire({ type: "partial", text: line }); // looks final → the guess may start now
  await sleep(20);
  h.asr.fire({ type: "speechEnd", turnId: 0 });
  if (opts.endFrames !== false) await frames(h, [A, B]);
  h.asr.fire({ type: "speechComplete", turnId: 0, text: line });
  for (let i = 0; i < 200 && h.answered.length === n; i++) await sleep(5);
}

test("camera red→green: a plain line with the camera on is a speculation hit (one Spark call, the frame went with it)", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await h.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" } }));
  await cameraTurn(h, "I finally finished my big project today.");
  // before: speculative "none" — the fresh frame turned speculation off and the turn waited for Spark from scratch
  assert.equal(h.answered[0]?.speculative, "hit");
  assert.equal(h.calls.length, 1);
  assert.equal(imagesOf(h.calls[0]), 1, "the guess carried the question's first frame");
});

test("camera: GENITA_SPECULATE_CAMERA=0 turns it off (no guess with fresh frames, as before)", async (t) => {
  const h = setup();
  process.env.GENITA_SPECULATE_CAMERA = "0";
  t.after(() => { delete process.env.GENITA_SPECULATE_CAMERA; h.session.close(); });
  await h.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" } }));
  await cameraTurn(h, "I finally finished my big project today.");
  assert.equal(h.answered[0]?.speculative, "none");
  assert.equal(h.calls.length, 1);
  assert.equal(imagesOf(h.calls[0]), 2, "the cold request takes frames A and B");
});

test("camera: a line about what the camera shows still waits for the speech-end frames (both go to Spark)", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await h.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" } }));
  await cameraTurn(h, "How do I look in this?");
  assert.notEqual(h.answered[0]?.speculative, "hit");
  const last = h.calls.at(-1)!;
  assert.equal(imagesOf(last), 2, "the real request carries frames A and B");
});

test("camera: a hit clears the frames — the next typed line carries no image of the old question", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await h.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" } }));
  await cameraTurn(h, "I finally finished my big project today.");
  assert.equal(h.answered[0]?.speculative, "hit");
  await h.session.onClientText(JSON.stringify({ type: "text", text: "Anyway, what's new with you?" }));
  for (let i = 0; i < 200 && h.answered.length < 2; i++) await sleep(5);
  assert.equal(imagesOf(h.calls.at(-1)!), 0);
});

test("camera: on a hit the card pipeline gets the newest frames (A+B), not only the guess's first frame", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await h.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" } }));
  const seen: string[][] = [];
  (h.session as unknown as { finds: unknown }).finds = {
    onTurn: (a: { frames: string[] }) => { seen.push(a.frames); return null; },
    onScreen: () => undefined,
    foundBefore: () => undefined,
    afterProduct: () => false,
    close: () => {},
  };
  await cameraTurn(h, "I finally finished my big project today.");
  assert.equal(h.answered[0]?.speculative, "hit");
  assert.deepEqual(seen.at(-1)?.map((u) => u.slice(-8)), [A, B]);
});

test("camera: a guess built before the camera came on (no frame) is still dropped when frames arrive", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await h.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" } }));
  h.asr.fire({ type: "speechStart", turnId: 0 });
  h.asr.fire({ type: "partial", text: "I finally finished my big project today." });
  await sleep(20);
  await frames(h, [A]);
  h.asr.fire({ type: "speechEnd", turnId: 0 });
  h.asr.fire({ type: "speechComplete", turnId: 0, text: "I finally finished my big project today." });
  for (let i = 0; i < 200 && !h.answered.length; i++) await sleep(5);
  assert.notEqual(h.answered[0]?.speculative, "hit");
  assert.equal(imagesOf(h.calls.at(-1)!), 1, "the real request carries the frame");
});

test("asksAboutView: look / show / wear lines wait for the frames; plain talk does not", () => {
  for (const s of ["How do I look?", "What am I holding?", "Look at this!", "Can you see my dog?", "What color is it?", "what do you think of my outfit", "Is this ripe?", "What can I cook with what's in here?"]) assert.ok(asksAboutView(s), s);
  for (const s of ["I finally finished my big project today.", "I had the weirdest dream last night.", "Do you like spicy food?", "I'm so tired.", "Tell me a joke."]) assert.ok(!asksAboutView(s), s);
});

test("metrics red→green: a typed line counts from its arrival; the greeting says it is one (no bare null)", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await h.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" }, greetAfterMs: 0 }));
  for (let i = 0; i < 200 && !h.metrics.length; i++) await sleep(5);
  const greet = h.metrics[0];
  assert.equal(greet?.trigger, "greeting");
  assert.equal(greet?.speechEndToFirstAudioMs, null, "nobody spoke before the greeting");
  assert.equal(typeof greet?.replyStartToFirstAudioMs, "number");
  await h.session.onClientText(JSON.stringify({ type: "text", text: "I got the job." }));
  for (let i = 0; i < 200 && h.metrics.length < 2; i++) await sleep(5);
  const typed = h.metrics[1];
  assert.equal(typed?.trigger, "text");
  // before: null (logged as -1 by the app) — a typed turn has no speechEnd
  assert.equal(typeof typed?.speechEndToFirstAudioMs, "number");
  assert.equal(typed?.first_audio_ms, typed?.speechEndToFirstAudioMs);
});

test("metrics: a voice turn is trigger voice, measured from speech end", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await h.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" } }));
  await cameraTurn(h, "I finally finished my big project today.");
  assert.equal(h.metrics[0]?.trigger, "voice");
  assert.equal(typeof h.metrics[0]?.speechEndToFirstAudioMs, "number");
});
