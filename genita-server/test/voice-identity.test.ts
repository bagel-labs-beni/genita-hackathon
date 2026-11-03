/**
 * 11/4 (Chelsea, build 7 TF 311: "지금 목소리 왜 여자 + 기계식이야"): the companion's voice follows its face and the
 * user's pick, end to end. Was: every companion got Tara (female, speaker 72) at "Use this image", whatever the face.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { FileStore, type ImageRecord } from "../src/prep/store.ts";
import { createPrepRoutes } from "../src/prep/routes.ts";
import { PrepRunner } from "../src/prep/runner.ts";
import { DEFAULT_VOICES, orderForFace } from "../src/prep/voices.ts";
import { resetVoiceProbe, type PrepDeps } from "../src/prep/pipeline.ts";
import { CLASSIFY_SCHEMA, interpretCheck, type ClassifyRaw } from "../src/prep/classify.ts";
import { loadConfig, type VoiceConfig } from "../src/config.ts";
import { Session, type ClientSink } from "../src/session/session.ts";
import type { SparkStreamEvent } from "../src/meta/spark.ts";
import type { TtsChunk } from "../src/tts/types.ts";

const ids = (v: { id: string }[]) => v.map((x) => x.id);

test("orderForFace: the face's gender first (curated order kept inside each group); either/unknown keeps Tara first", () => {
  assert.deepEqual(ids(orderForFace(DEFAULT_VOICES, "male")), ["19", "26", "72", "9"]);
  assert.deepEqual(ids(orderForFace(DEFAULT_VOICES, "female")), ["72", "9", "19", "26"]);
  for (const fit of ["either", undefined, null, "bogus"]) assert.deepEqual(ids(orderForFace(DEFAULT_VOICES, fit)), ["72", "9", "19", "26"]);
});

test("image check asks Spark which voice suits the face (strict schema: listed and required)", () => {
  const props = CLASSIFY_SCHEMA.properties as Record<string, { enum?: readonly string[] }>;
  assert.deepEqual(props.voice_fit.enum, ["male", "female", "either"]);
  assert.ok((CLASSIFY_SCHEMA.required as readonly string[]).includes("voice_fit"));
});

function raw(fit?: ClassifyRaw["voice_fit"]): ClassifyRaw {
  return { subject: "person", face_count: 1, front_facing: true, face_covered: false, sharp: true, well_lit: true, text_on_image: false, ...(fit ? { voice_fit: fit } : {}) };
}

test("pick → save → call: a man's face is suggested Leo; the voice the user picks (Leah) is the speaker the call uses", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "voice-identity-"));
  const store = new FileStore(dir);
  const svc = createServer((_req, res) => (res.writeHead(200), res.end("{}")));
  await new Promise<void>((r) => svc.listen(0, "127.0.0.1", r));
  const voice: VoiceConfig = { url: `http://127.0.0.1:${(svc.address() as AddressInfo).port}`, token: "t", speakers: { human: 72, animal: 16, character: 68 }, speed: 1, timeoutMs: 1000, model: "seamless" };
  const d: PrepDeps = { metaKey: "", store, voice, voices: DEFAULT_VOICES, log: () => {} };
  const routes = createPrepRoutes(d, new PrepRunner(d));
  const http = createServer((req, res) => (routes.handles(req) ? void routes.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(() => { http.close(); svc.close(); rmSync(dir, { recursive: true, force: true }); resetVoiceProbe(); });
  const img = (id: string, user: string, fit?: ClassifyRaw["voice_fit"]): ImageRecord => ({
    id, userId: user, mime: "image/jpeg", bytes: 3, check: interpretCheck(raw(fit)), headBox: null, rightsAck: true, createdAt: new Date().toISOString(), ms: { check: 1, sam: 1 },
  });
  for (const [id, user, fit] of [["m", "u1", "male"], ["f", "u2", "female"], ["old", "u3", undefined]] as const) await store.putImage(img(id, user, fit), Buffer.from([0xff, 0xd8, 0xff]));
  const voices = async (user: string, image: string) => (await (await fetch(`${base}/v1/companion/voices?imageId=${image}`, { headers: { "x-genita-user": user } })).json()) as { suggested: string; voices: { id: string }[] };

  const man = await voices("u1", "m");
  assert.equal(man.suggested, "19", "a man's face: Leo is the recommended voice (was Tara)");
  assert.deepEqual(ids(man.voices), ["19", "26", "72", "9"]);
  assert.equal((await voices("u2", "f")).suggested, "72");
  assert.equal((await voices("u3", "old")).suggested, "72", "a photo checked before 11/4 keeps the old order");

  // the companion is made with the suggested voice ("Use this image"), then V04 saves the user's pick
  await store.putCompanion({ id: "c1", userId: "u1", imageId: "m", type: "human", voiceId: man.suggested, name: "Leo", createdAt: new Date().toISOString(), prep: { status: "pending" } as never });
  const put = await fetch(`${base}/v1/companion/voice`, { method: "PUT", headers: { "x-genita-user": "u1", "content-type": "application/json" }, body: JSON.stringify({ voiceId: "9" }) });
  assert.equal(put.status, 200);
  assert.equal((await store.getCompanion("u1"))?.voiceId, "9");

  // the call: the app sends no voice (iPhone CallScreen voiceId nil); the server reads the account's saved voice (server.ts)
  const config = { ...loadConfig({ MODEL_API_KEY: "k", GENITA_VOICE_URL: voice.url, GENITA_VOICE_TOKEN: "t", GENITA_VOICE_SPEAKERS: "human:72,animal:16,character:68", GENITA_SPARK_HEDGE: "1", GENITA_SPECULATE: "0" }) };
  const json: Record<string, unknown>[] = [];
  const sink: ClientSink = { sendJson: (m) => void json.push(m), sendBinary: () => {}, close: () => {} };
  const spoken: string[] = [];
  const session = new Session("s1", sink, {
    config,
    openAsr: () => Object.assign(new EventEmitter(), { isOpen: false, async connect() {}, sendAudio() {}, end() {} }) as never,
    async *spark(): AsyncGenerator<SparkStreamEvent> { yield { type: "text", delta: "Hi there. " }; yield { type: "done", responseId: "r", text: "", status: "completed" }; },
    async *tts(req): AsyncGenerator<TtsChunk> { spoken.push(req.voiceId); yield { audio: Buffer.alloc(4800), alignment: null, model: "seamless-m4t-v2" }; },
    companionVoiceId: () => store.getCompanion("u1").then((c) => c?.voiceId ?? null),
  });
  t.after(() => session.close());
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Leo", kind: "human" }, mic: false }));
  assert.equal(json.find((m) => m.type === "ready")?.voiceId, "seamless:9", "the call speaks with the picked voice");
  await session.onClientText(JSON.stringify({ type: "text", text: "hi" }));
  for (let k = 0; k < 200 && !json.some((m) => m.type === "reply"); k++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(spoken.length > 0 && spoken.every((v) => v === "seamless:9"), JSON.stringify(spoken));
});

test("config: the phone-voice fallback is off unless GENITA_VOICE_DEVICE_FALLBACK=1", () => {
  const base = { MODEL_API_KEY: "k", GENITA_VOICE_URL: "https://v", GENITA_VOICE_TOKEN: "t" };
  assert.equal(loadConfig(base).voice?.deviceFallback, undefined);
  assert.equal(loadConfig({ ...base, GENITA_VOICE_DEVICE_FALLBACK: "1" }).voice?.deviceFallback, true);
});

test("config: raw Seamless voice by default (post:false, no emotion pitch/tone sent); GENITA_VOICE_POST=1 turns post.py on", async () => {
  const { createSeamless } = await import("../src/tts/seamless.ts");
  const base = { MODEL_API_KEY: "k", GENITA_VOICE_URL: "https://v", GENITA_VOICE_TOKEN: "t" };
  const bodies: Record<string, unknown>[] = [];
  const f = (async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(`${JSON.stringify({ audio_base64: Buffer.alloc(480).toString("base64"), alignment: null })}\n{"done":true}\n`, { status: 200 });
  }) as unknown as typeof fetch;
  for (const env of [base, { ...base, GENITA_VOICE_POST: "1" }]) {
    const c = createSeamless(loadConfig(env).voice!, { fetch: f });
    for await (const _ of c.speak({ voiceId: "seamless:19", text: "Oh wow, you actually finished it? That's amazing!", emotion: "excited", model: "seamless-m4t-v2", lang: "en" })) void _;
  }
  assert.equal(bodies[0].post, false, "default: raw voice");
  assert.equal("emotion" in bodies[0], false, "default: no varispeed pitch / tone for the emotion");
  assert.equal(bodies[0].speed, 1.1, "the emotion still sets the speaking rate on the server");
  assert.equal(bodies[0].speaker, 19);
  assert.equal("post" in bodies[1], false, "GENITA_VOICE_POST=1: the post chain as before");
  assert.equal(bodies[1].emotion, "excited");
});
