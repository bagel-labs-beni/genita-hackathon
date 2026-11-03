/**
 * PERC-1 (#319) session wiring: `perception.frame` reaches the controller only with GENITA_PERCEPTION on,
 * `ready.perception` tells the app to send, and the engine's seam `session.perception` exposes the contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, type ClientSink } from "../src/session/session.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { checkServerEvent } from "../src/protocol.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import type { PerceptionTrigger } from "../src/perception/types.ts";

const base: Config = {
  metaKey: "x", serverTts: false, host: "127.0.0.1", port: 0, sessionToken: null, defaultVoiceId: "voice", webSearch: false,
  asrLanguages: ["English"], bargeInMinMs: 400, bargeInMinWords: 2, maxSessions: 4, maxSessionMs: 60_000,
  sparkFirstTokenTimeoutMs: 8000, sparkHedge: 1, speculate: false, speculateStableMs: 250,
};
const JPEG = Buffer.from("face").toString("base64");
const FACE = JSON.stringify({ expression: "smile", intensity: 0.8, gaze: "at_screen", engagement: 0.8, notable: null, confidence: 0.9 });
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

class Client implements ClientSink {
  json: Record<string, unknown>[] = [];
  sendJson(m: Record<string, unknown>) {
    assert.deepEqual(checkServerEvent(m), [], JSON.stringify(m));
    this.json.push(m);
  }
  sendBinary() {}
  close() {}
}

function setup(cfg: Partial<Config>) {
  const client = new Client();
  const asr = Object.assign(new EventEmitter(), { isOpen: true, connect: async () => {}, sendAudio: () => {}, end: () => {} });
  const faceCalls: SparkRequest[] = [];
  const session = new Session("perc", client, {
    config: { ...base, ...cfg },
    openAsr: () => asr,
    async *spark(req): AsyncGenerator<SparkStreamEvent> {
      const isFace = (req.text as { format?: { name?: string } } | undefined)?.format?.name === "face_read";
      if (isFace) faceCalls.push(req);
      const text = isFace ? FACE : "Sure thing.";
      yield { type: "text", delta: text };
      yield { type: "done", responseId: null, text, status: "completed" };
    },
    async *tts() {},
  });
  return { session, client, faceCalls };
}
const start = (s: Session) => s.onClientText(JSON.stringify({ type: "start", persona: { name: "Mia" }, mic: false, tts: "device" }));
const frame = (s: Session) => s.onClientText(JSON.stringify({ type: "perception.frame", image: JPEG }));

test("config: GENITA_PERCEPTION=1 turns perception on; default off", () => {
  assert.equal(loadConfig({ MODEL_API_KEY: "k" } as NodeJS.ProcessEnv).perception, false);
  assert.equal(loadConfig({ MODEL_API_KEY: "k", GENITA_PERCEPTION: "1" } as NodeJS.ProcessEnv).perception, true);
});

test("flag off: no ready.perception, frames are ignored silently, no Spark read, no seam", async () => {
  const { session, client, faceCalls } = setup({});
  await start(session);
  assert.equal(client.json.find((m) => m.type === "ready")!.perception, undefined);
  await frame(session);
  await settle();
  assert.equal(faceCalls.length, 0);
  assert.equal(client.json.filter((m) => m.type === "error").length, 0);
  assert.equal(session.perception, null);
  session.close();
});

test("flag on: ready.perception true, a frame becomes a Spark face read and a live context line", async () => {
  const { session, client, faceCalls } = setup({ perception: true });
  await start(session);
  assert.equal(client.json.find((m) => m.type === "ready")!.perception, true);
  await frame(session);
  await settle();
  assert.equal(faceCalls.length, 1);
  assert.match(session.perception!.contextLine()!, /smiling/);
  // the frame never goes into the conversation's own turn frames
  assert.equal(client.json.filter((m) => m.type === "error").length, 0);
  session.close();
  assert.equal(session.perception!.contextLine(), null, "closed: state gone");
});

test("flag on: a smile during the companion's reply fires smiled_at_reply to the engine's subscriber", async () => {
  const { session } = setup({ perception: true });
  await start(session);
  const got: PerceptionTrigger[] = [];
  session.perception!.onTrigger((t) => got.push(t));
  await session.onClientText(JSON.stringify({ type: "text", text: "tell me a joke" }));
  await settle();
  await frame(session); // device voice: the reply is "speaking" until playback_done
  await settle();
  assert.deepEqual(got.map((t) => t.kind), ["smiled_at_reply"]);
  assert.equal(session.perception!.pendingHint(), "The user smiled at what you just said.");
  session.close();
});

test("flag on: no face reads while interpreting (nobody reacts there)", async () => {
  const { session, faceCalls } = setup({ perception: true });
  await start(session);
  await session.onClientText(JSON.stringify({ type: "mode", mode: "interpret" }));
  await frame(session);
  await settle();
  assert.equal(faceCalls.length, 0);
  session.close();
});
