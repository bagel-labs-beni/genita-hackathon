import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { defaultDeps } from "../src/server.ts";

test("config: only MODEL_API_KEY is required; device voice is the default", () => {
  const c = loadConfig({ MODEL_API_KEY: "m" });
  assert.equal(c.metaKey, "m");
  assert.equal(c.serverTts, false);
  assert.equal(c.voice, null);
  assert.equal(c.defaultVoiceId, "seamless:0");
});

test("config: missing MODEL_API_KEY throws", () => {
  assert.throws(() => loadConfig({}), /MODEL_API_KEY/);
});

test("server deps: without Meta voice, TTS refuses without any network request", async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; throw new Error("no network in tests"); }) as typeof fetch;
  try {
    const deps = defaultDeps(loadConfig({ MODEL_API_KEY: "m" }), () => {});
    await assert.rejects(async () => {
      for await (const _ of deps.tts({ voiceId: "0", text: "hi", emotion: null, model: "seamless-m4t-v2" })) void _;
    }, /tts_off/);
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
