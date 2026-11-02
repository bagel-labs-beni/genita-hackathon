import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { loadConfig } from "../src/config.ts";
import { startServer, defaultDeps } from "../src/server.ts";
import { checkImage, makeScene, voicePreview, type PrepDeps } from "../src/prep/pipeline.ts";
import { FileStore } from "../src/prep/store.ts";
import { DEFAULT_VOICES } from "../src/prep/voices.ts";
import { createPrep } from "../src/prep/index.ts";
import { PrepRunner, newPrepState, prepView } from "../src/prep/runner.ts";
import { fakePng } from "./helpers/fakeMedia.ts";

const voice = { url: "https://voice.test", token: "test-token", speakers: { human: 0, animal: 1, character: 2 }, speed: 1, timeoutMs: 1000, model: "seamless" as const };
function fixture(t: import("node:test").TestContext): PrepDeps {
  const dir = mkdtempSync(join(tmpdir(), "genita-meta-only-"));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });
  return { metaKey: "test-meta", store: new FileStore(dir), voices: DEFAULT_VOICES, log: () => {} };
}

test("full human and animal prep only requests Meta hosts", async (t) => {
  for (const kind of ["human", "animal"] as const) await t.test(kind, async (t) => {
    const d = fixture(t);
    const seen: URL[] = [];
    const models: string[] = [];
    const image = fakePng(1000, 2000, "meta-scene");
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      seen.push(url);
      assert.equal(url.hostname, "api.meta.ai", `unexpected prep host: ${url.hostname}`);
      if (url.pathname === "/v1/images/edits") {
        models.push(String((init!.body as FormData).get("model")));
        return Response.json({ data: [{ b64_json: image.toString("base64") }] });
      }
      assert.equal(url.pathname, "/v1/responses");
      const body = JSON.parse(String(init!.body));
      models.push(body.model);
      let text: string;
      if (body.model === "muse-spark-1.3") {
        text = JSON.stringify({ subject: kind === "human" ? "person" : "animal", face_count: 1, front_facing: true, face_covered: false, sharp: true, well_lit: true, text_on_image: false });
      } else {
        assert.equal(body.model, "sam-3.1");
        const prompt = body.input[0].content[0].text;
        text = /mouth|lips|muzzle/.test(prompt)
          ? "<|box;x1=420;y1=760;x2=580;y2=820;w=1000;h=2000|>"
          : "<|box;x1=300;y1=400;x2=700;y2=900;w=1000;h=2000|>";
      }
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });
    }) as typeof fetch;
    const checked = await checkImage(d, "u1", image, true);
    assert.equal(checked.check.type, kind);
    assert.equal(checked.check.passed, true);
    await d.store.putCompanion({ id: "c1", userId: "u1", imageId: checked.id, type: kind, voiceId: "0", name: "Jin", createdAt: new Date().toISOString(), prep: newPrepState() });
    await new PrepRunner(d).run("u1");
    const view = prepView((await d.store.getCompanion("u1"))!);
    assert.equal(view.status, "ready");
    assert.deepEqual(view.progress, { done: 14, total: 14 });
    assert.equal(Object.keys(view.face!.visemes).length, 10);
    assert.equal(models.filter((m) => m === "muse-image-1.0").length, 14);
    assert.deepEqual([...new Set(models)].sort(), ["muse-image-1.0", "muse-spark-1.3", "sam-3.1"]);
    assert.ok(seen.length > 14);
    assert.ok(seen.every((url) => url.hostname === "api.meta.ai"));
  });
});

test("MODEL_API_KEY alone boots the server and completes a device-voice session without upstream I/O", async (t) => {
  const prep = fixture(t);
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error("upstream I/O forbidden"); }) as typeof fetch;
  const config = { ...loadConfig({ MODEL_API_KEY: "test-meta" }), port: 0 };
  const deps = defaultDeps(config, () => {});
  // Isolate the real server/session/voice path from unrelated feature services.
  deps.memory = undefined;
  deps.finds = undefined;
  // connection warm-up opens sockets to api.meta.ai on purpose (latency lane); its hosts are tested in keepalive.test.ts
  deps.prewarm = undefined;
  deps.openAsr = () => { throw new Error("mic disabled"); };
  deps.spark = async function* () {
    yield { type: "text", delta: "<warm> Hello there." };
    yield { type: "done", responseId: "test", status: "completed", text: "<warm> Hello there." };
  };
  assert.equal(createPrep(config, () => {}, {}, prep.store).deps.metaKey, "test-meta");
  const server = await startServer(config, () => {}, deps, { GENITA_DATA_DIR: (prep.store as FileStore).dir }, null);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/session`);
  t.after(() => ws.terminate());
  const events: Record<string, any>[] = [];
  let binaries = 0;
  const reply = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("device reply timed out")), 3000);
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
    ws.on("message", (data, binary) => {
      if (binary) { binaries++; return; }
      const event = JSON.parse(data.toString());
      events.push(event);
      if (event.type === "ready") ws.send(JSON.stringify({ type: "text", text: "Hello" }));
      if (event.type === "reply") { clearTimeout(timer); resolve(); }
    });
  });
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "start", persona: { name: "Companion", kind: "human" }, mic: false, tts: "server", lip: { mode: "retired", fallback: "atlas" } }));
  await reply;
  assert.equal(events.find((e) => e.type === "ready")?.tts, "device");
  assert.equal(events.find((e) => e.type === "ready")?.lip.active, "none");
  assert.equal(events.find((e) => e.type === "say")?.text, "Hello there.");
  assert.equal(events.find((e) => e.type === "reply")?.text, "Hello there.");
  assert.equal(events.some((e) => e.type === "audio" || e.type === "lip.changed"), false);
  assert.equal(binaries, 0);
  assert.equal(requests, 0);
  const closed = once(ws, "close");
  ws.send(JSON.stringify({ type: "stop" }));
  await closed;
});

test("scene retries Muse Image once, with no alternate model or host; second failure propagates", async (t) => {
  const d = fixture(t);
  const calls: { url: string; model: unknown }[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), model: (init?.body as FormData).get("model") });
    return calls.length === 1 ? new Response("unavailable", { status: 503 }) : Response.json({ data: [{ b64_json: Buffer.from("scene").toString("base64") }] });
  }) as typeof fetch;
  const result = await makeScene(d, Buffer.from("input"), "image/png", "human");
  assert.equal(result.source, "muse-image");
  assert.equal(result.bytes.toString(), "scene");
  assert.deepEqual(calls, Array(2).fill({ url: "https://api.meta.ai/v1/images/edits", model: "muse-image-1.0" }));
  calls.length = 0;
  globalThis.fetch = (async (url) => { calls.push({ url: String(url), model: null }); return new Response("unavailable", { status: 503 }); }) as typeof fetch;
  await assert.rejects(() => makeScene(d, Buffer.from("input"), "image/png", "human"), /meta 503/);
  assert.equal(calls.length, 2);
  const ctl = new AbortController();
  calls.length = 0;
  globalThis.fetch = (async (url) => { calls.push({ url: String(url), model: null }); ctl.abort(); throw new Error("aborted"); }) as typeof fetch;
  await assert.rejects(() => makeScene(d, Buffer.from("input"), "image/png", "human", ctl.signal), /aborted/);
  assert.equal(calls.length, 1, "cancelled requests never retry");
});

test("voice preview uses Meta PCM as WAV and a new cache version; no voice service fails without I/O", async (t) => {
  const d = fixture(t);
  await d.store.putVoicePreview("0", "v1", Buffer.from("old-cache"));
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    assert.equal(String(url), "https://voice.test/v1/tts");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "seamless");
    assert.equal(body.speaker, 0);
    return new Response(JSON.stringify({ audio_base64: Buffer.alloc(480, 1).toString("base64") }) + '\n' + JSON.stringify({ done: true }) + '\n');
  }) as typeof fetch;
  await assert.rejects(() => voicePreview(d, "0"), /voice_unavailable/);
  assert.equal(calls, 0);
  const wav = await voicePreview({ ...d, voice }, "0");
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.subarray(8, 12).toString(), "WAVE");
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(40), 480);
  assert.deepEqual(await voicePreview({ ...d, voice }, "0"), wav);
  assert.equal(calls, 1);
});
