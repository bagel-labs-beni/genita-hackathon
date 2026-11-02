import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { SERVER_EVENT_FIELDS, checkServerEvent, decodeFrameHeader, encodeFrameHeader, type ServerEvent } from "../src/protocol.ts";
import { Session } from "../src/session/session.ts";
import type { Config } from "../src/config.ts";

const dir = new URL("../../shared/protocol-samples/", import.meta.url);
const load = (side: string) =>
  readdirSync(new URL(side + "/", dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ file: f, obj: JSON.parse(readFileSync(new URL(`${side}/${f}`, dir), "utf8")) as Record<string, unknown> }));

test("every server sample conforms to the TS spec, and every server event type has a sample", () => {
  const samples = load("server");
  for (const { file, obj } of samples) assert.deepEqual(checkServerEvent(obj), [], file);
  const covered = new Set(samples.map((s) => s.obj.type));
  for (const t of Object.keys(SERVER_EVENT_FIELDS)) assert.ok(covered.has(t), `no sample for ${t}`);
});

test("checkServerEvent flags missing and extra fields", () => {
  assert.deepEqual(checkServerEvent({ type: "state" }), ["state: missing state"]);
  assert.deepEqual(checkServerEvent({ type: "state", state: "listening", foo: 1 }), ["state: extra foo"]);
  assert.deepEqual(checkServerEvent({ type: "nope" }), ["unknown type nope"]);
});

test("frame header round-trips", () => {
  const h = encodeFrameHeader(1, 0xfffffffe);
  assert.deepEqual(decodeFrameHeader(h), { kind: 1, seq: 0xfffffffe });
  assert.equal(decodeFrameHeader(Buffer.from("XX123456")), null);
});

test("every client sample is accepted by a live Session (no bad_message / unknown_type)", async () => {
  const config = { metaKey: "x", serverTts: true, kling: false, host: "127.0.0.1", port: 0, sessionToken: null, defaultVoiceId: "v", webSearch: false, asrLanguages: ["English"], bargeInMinMs: 400, bargeInMinWords: 2, maxSessions: 1, maxSessionMs: 1000, sparkFirstTokenTimeoutMs: 1000, sparkHedge: 1, speculate: false, speculateStableMs: 250 } satisfies Config;
  const sent: ServerEvent[] = [];
  const asr = Object.assign(new EventEmitter(), { isOpen: true, connect: async () => {}, sendAudio: () => {}, end: () => {} });
  const session = new Session("p", { sendJson: (m) => sent.push(m), sendBinary: () => {}, close: () => {} }, {
    config,
    openAsr: () => asr,
    async *spark() {
      yield { type: "done" as const, responseId: null, text: "", status: "completed" };
    },
    async *tts() {},
  });
  const samples = load("client");
  const order = (f: string) => (f.startsWith("start.json") ? 0 : f.startsWith("stop") ? 2 : f.startsWith("start") ? 3 : 1);
  for (const { file, obj } of samples.sort((a, b) => order(a.file) - order(b.file))) {
    if (file === "start.minimal.json" || file === "start.device.json") continue; // second start is rejected by design; checked below
    await session.onClientText(JSON.stringify(obj));
    const bad = sent.filter((m) => m.type === "error" && ["bad_message", "unknown_type", "bad_persona", "not_started"].includes(m.code));
    assert.deepEqual(bad, [], file);
  }
  for (const m of sent) assert.deepEqual(checkServerEvent(m as unknown as Record<string, unknown>), []);
  const fresh: ServerEvent[] = [];
  const s2 = new Session("q", { sendJson: (m) => fresh.push(m), sendBinary: () => {}, close: () => {} }, {
    config,
    openAsr: () => asr,
    async *spark() {},
    async *tts() {},
  });
  await s2.onClientText(readFileSync(new URL("client/start.minimal.json", dir), "utf8"));
  assert.equal(fresh[0].type, "ready");
  // start.device.json: the app asks for on-device speech → ready.tts device
  const dev: ServerEvent[] = [];
  const s3 = new Session("r", { sendJson: (m) => dev.push(m), sendBinary: () => {}, close: () => {} }, {
    config,
    openAsr: () => asr,
    async *spark() {},
    async *tts() {},
  });
  await s3.onClientText(readFileSync(new URL("client/start.device.json", dir), "utf8"));
  const ready = dev.find((m) => m.type === "ready");
  assert.ok(ready && ready.type === "ready" && ready.tts === "device", JSON.stringify(dev[0]));
  session.close();
  s2.close();
  s3.close();
});
