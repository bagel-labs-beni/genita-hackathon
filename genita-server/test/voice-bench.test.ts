import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { VoiceConfig } from "../src/config.ts";
import { runVoiceCapacityBench } from "../scripts/voice-capacity-bench.ts";

const pcm = Buffer.alloc(4_800, 1).toString("base64");

async function fakeVoice(opts: { failEvery?: number } = {}) {
  let inFlight = 0;
  let requests = 0;
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/tts") {
      res.writeHead(404).end();
      return;
    }
    requests++;
    if (opts.failEvery && requests % opts.failEvery === 0) {
      res.writeHead(500, { "content-type": "application/json" }).end('{"error":"synthetic"}');
      return;
    }
    inFlight++;
    const delay = 30 + inFlight * 55;
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    setTimeout(() => {
      res.write(`${JSON.stringify({ audio_base64: pcm, alignment: null })}\n`);
      res.end(`${JSON.stringify({ done: true, audio_ms: 100 })}\n`);
      inFlight--;
    }, delay);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

const voice = (url: string): VoiceConfig => ({
  url,
  token: "test-token",
  speakers: { human: 3, animal: 3, character: 3 },
  speed: 1,
  timeoutMs: 1_000,
  model: "seamless",
});

test("voice bench: reports quantiles, rising first sound, and threshold recommendation", async () => {
  const fake = await fakeVoice();
  try {
    const result = await runVoiceCapacityBench({
      voice: voice(fake.url),
      calls: [1, 2, 4],
      replies: 2,
      gapMs: 1,
      startStaggerMs: 0,
      jitterMs: 0,
      warmup: false,
      maxMinutes: 1,
      firstSoundThresholdMs: 200,
      lang: "mix",
    });
    assert.equal(result.rows.length, 3);
    for (const row of result.rows) {
      assert.notEqual(row.firstSound.p50, null);
      assert.notEqual(row.firstSound.p90, null);
      if (row.firstSound.p50 === null || row.firstSound.p90 === null) throw new Error("first-sound samples missing");
      assert.ok(row.firstSound.p50 >= 0 && row.firstSound.p90 >= row.firstSound.p50);
    }
    const light = result.rows[0].firstSound.p50;
    const heavy = result.rows[2].firstSound.p50;
    if (light === null || heavy === null) throw new Error("first-sound samples missing");
    assert.ok(heavy > light, "load raises first-sound latency");
    assert.equal(result.recommendedCalls, 2);
  } finally {
    await fake.close();
  }
});

test("voice bench: counts upstream errors without a real voice service", async () => {
  const fake = await fakeVoice({ failEvery: 3 });
  try {
    const result = await runVoiceCapacityBench({
      voice: voice(fake.url),
      calls: [1],
      replies: 3,
      gapMs: 1,
      startStaggerMs: 0,
      jitterMs: 0,
      warmup: false,
      maxMinutes: 1,
      firstSoundThresholdMs: 500,
      lang: "eng",
    });
    assert.ok(result.rows[0].errors > 0);
    assert.equal(result.recommendedCalls, null);
  } finally {
    await fake.close();
  }
});
