import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { defaultDeps } from "../src/server.ts";

test("config: only MODEL_API_KEY is required; every vendor flag is off by default", () => {
  const c = loadConfig({ MODEL_API_KEY: "m" });
  assert.equal(c.metaKey, "m");
  assert.equal(c.serverTts, false);
  assert.equal(c.kling, false);
  assert.equal(c.peter, false);
  assert.equal(c.elevenKey, null);
});

test("config: a vendor key alone does not turn its path on, and is not read while the flag is off", () => {
  const c = loadConfig({ MODEL_API_KEY: "m", ELEVENLABS_API_KEY: "e", FAL_KEY: "f", GENITA_PETER_URL: "wss://p", GENITA_PETER_TOKEN: "t" });
  assert.equal(c.serverTts, false);
  assert.equal(c.elevenKey, null);
  assert.equal(c.kling, false);
  assert.equal(c.peter, false);
});

test("config: missing MODEL_API_KEY throws", () => {
  assert.throws(() => loadConfig({}), /MODEL_API_KEY/);
});

test("config: GENITA_SERVER_TTS=1 needs ELEVENLABS_API_KEY", () => {
  assert.throws(() => loadConfig({ MODEL_API_KEY: "m", GENITA_SERVER_TTS: "1" }), /ELEVENLABS_API_KEY/);
  const c = loadConfig({ MODEL_API_KEY: "m", GENITA_SERVER_TTS: "1", ELEVENLABS_API_KEY: "e" });
  assert.equal(c.serverTts, true);
  assert.equal(c.elevenKey, "e");
});

test("config: GENITA_KLING=1 needs FAL_KEY; GENITA_PETER=1 needs the worker URL and token", () => {
  assert.throws(() => loadConfig({ MODEL_API_KEY: "m", GENITA_KLING: "1" }), /FAL_KEY/);
  assert.equal(loadConfig({ MODEL_API_KEY: "m", GENITA_KLING: "1", FAL_KEY: "f" }).kling, true);
  assert.throws(() => loadConfig({ MODEL_API_KEY: "m", GENITA_PETER: "1", GENITA_PETER_URL: "wss://p" }), /GENITA_PETER_TOKEN/);
  assert.throws(() => loadConfig({ MODEL_API_KEY: "m", GENITA_PETER: "1", GENITA_PETER_TOKEN: "t" }), /GENITA_PETER_URL/);
  assert.equal(loadConfig({ MODEL_API_KEY: "m", GENITA_PETER: "1", GENITA_PETER_URL: "wss://p", GENITA_PETER_TOKEN: "t" }).peter, true);
});

test("server deps: flags off → no Peter factory even with Peter env set, and the TTS dep refuses without calling a vendor", async () => {
  const saved = { url: process.env.GENITA_PETER_URL, token: process.env.GENITA_PETER_TOKEN };
  process.env.GENITA_PETER_URL = "wss://peter.invalid";
  process.env.GENITA_PETER_TOKEN = "t";
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error("no network in tests");
  }) as typeof fetch;
  try {
    const deps = defaultDeps(loadConfig({ MODEL_API_KEY: "m" }), () => {});
    assert.equal(deps.openPeter, undefined);
    await assert.rejects(async () => {
      for await (const _ of deps.tts({ voiceId: "v", text: "hi", emotion: null, model: "eleven_v4_turbo" })) void _;
    }, /tts_off/);
    assert.equal(fetched, 0, "no ElevenLabs request");
  } finally {
    globalThis.fetch = realFetch;
    if (saved.url === undefined) delete process.env.GENITA_PETER_URL;
    else process.env.GENITA_PETER_URL = saved.url;
    if (saved.token === undefined) delete process.env.GENITA_PETER_TOKEN;
    else process.env.GENITA_PETER_TOKEN = saved.token;
  }
});
