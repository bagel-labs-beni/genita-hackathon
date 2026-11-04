/**
 * DEMO 11/4 (Chelsea, build 10): "Hey Summer" … ~3 s … the rest. With the server voice the greeting's opener now waits
 * for Spark's first sentence (capped by GENITA_GREET_OPENER_WAIT_MS) and that sentence's voice is asked for together
 * with the opener's, so the two play back to back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Session, greetOpenerWaitMs, type ClientSink } from "../src/session/session.ts";
import type { Config } from "../src/config.ts";
import type { SparkStreamEvent } from "../src/meta/spark.ts";
import type { TtsChunk } from "../src/tts/types.ts";

const voice = { url: "https://v", token: "t", speakers: { human: 3, animal: 5, character: 9 }, speed: 1, timeoutMs: 500, model: "seamless" as const };
const config: Config = {
  metaKey: "x", serverTts: true, voice, host: "127.0.0.1", port: 0, sessionToken: null, defaultVoiceId: "voice", webSearch: false,
  asrLanguages: ["English"], bargeInMinMs: 400, bargeInMinWords: 2, maxSessions: 4, maxSessionMs: 60_000,
  sparkFirstTokenTimeoutMs: 8000, sparkHedge: 1, speculate: false, speculateStableMs: 250,
};
const persona = { name: "Mina", kind: "human", traits: ["warm"] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client implements ClientSink {
  json: { t: number; m: Record<string, unknown> }[] = [];
  sendJson(m: Record<string, unknown>) { this.json.push({ t: Date.now(), m }); }
  sendBinary() {}
  close() {}
  async waitFor(pred: (m: Record<string, unknown>) => boolean, ms = 4000) {
    const t0 = Date.now();
    for (;;) {
      const hit = this.json.find((x) => pred(x.m));
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`timeout; got ${this.json.map((x) => x.m.type).join(",")}`);
      await sleep(2);
    }
  }
}

/** Spark's greeting after `sparkMs`; each voice request renders in `renderMs` (100 ms of audio per clause). */
function run(sparkMs: number, renderMs: number, fails: { opener?: number; answer?: number } = {}) {
  const client = new Client();
  const calls: { t: number; text: string }[] = [];
  const session = new Session("gap", client, {
    config, openAsr: () => { throw new Error("no asr"); }, greetOpener: true,
    async *spark(_req, { signal }): AsyncGenerator<SparkStreamEvent> {
      await sleep(sparkMs);
      if (signal?.aborted) return;
      yield { type: "text", delta: "<happy> How did the interview go?" };
      yield { type: "done", responseId: "r", text: "", status: "completed" };
    },
    async *tts(req): AsyncGenerator<TtsChunk> {
      if ((req as { cachedOnly?: boolean }).cachedOnly) throw new Error("voice: not_cached");
      calls.push({ t: Date.now(), text: req.text });
      await sleep(renderMs);
      const kind = /Summer/.test(req.text) ? "opener" : "answer";
      if ((fails[kind] ?? 0) > 0) { fails[kind]!--; throw new Error("voice network: voice_timeout"); }
      if (req.signal?.aborted) return;
      yield { audio: Buffer.alloc(4800), alignment: null, model: "seamless-m4t-v2" };
    },
  });
  return { client, calls, session };
}

test("greetOpenerWaitMs: 2500 by default, 0 turns the hold off, capped at 5 s", () => {
  assert.equal(greetOpenerWaitMs({}), 2500);
  assert.equal(greetOpenerWaitMs({ GENITA_GREET_OPENER_WAIT_MS: "0" }), 0);
  assert.equal(greetOpenerWaitMs({ GENITA_GREET_OPENER_WAIT_MS: "99999" }), 5000);
  assert.equal(greetOpenerWaitMs({ GENITA_GREET_OPENER_WAIT_MS: "x" }), 2500);
});

test("server voice: the opener waits for Spark's first sentence, and both voices are asked for together", async () => {
  const { client, calls, session } = run(400, 50);
  const t0 = Date.now();
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false, user: { name: "Summer" }, greetAfterMs: 0 }));
  await client.waitFor((m) => m.type === "reply" && m.final === true);
  const answer = calls.find((c) => /interview/.test(c.text));
  const opener = calls.find((c) => /Summer/.test(c.text));
  assert.ok(opener && answer, JSON.stringify(calls));
  assert.ok(opener.t - t0 >= 350, `the opener waited for Spark (${opener.t - t0} ms)`);
  assert.ok(answer.t - opener.t < 60, `the answer's voice was asked for with the opener's, not after it played (${answer.t - opener.t} ms)`);
  const audio = client.json.filter((x) => x.m.type === "audio");
  assert.ok(audio.length >= 2);
  // the answer's first audio lands within one render of the opener's: no long gap after "Hey, Summer!"
  assert.ok(audio[audio.length - 1].t - audio[0].t < 150, `gap ${audio[audio.length - 1].t - audio[0].t} ms`);
  session.close();
});

test("server voice: a slow Spark holds the opener only up to GENITA_GREET_OPENER_WAIT_MS", async () => {
  const saved = process.env.GENITA_GREET_OPENER_WAIT_MS;
  process.env.GENITA_GREET_OPENER_WAIT_MS = "150";
  try {
    const { client, calls, session } = run(900, 20);
    const t0 = Date.now();
    await session.onClientText(JSON.stringify({ type: "start", persona, mic: false, user: { name: "Summer" }, greetAfterMs: 0 }));
    const first = await client.waitFor((m) => m.type === "audio");
    assert.ok(first.t - t0 < 600, `the opener went out at the cap (${first.t - t0} ms), not after Spark`);
    assert.ok(calls[0] && /Summer/.test(calls[0].text));
    await client.waitFor((m) => m.type === "reply" && m.final === true);
    session.close();
  } finally {
    if (saved === undefined) delete process.env.GENITA_GREET_OPENER_WAIT_MS;
    else process.env.GENITA_GREET_OPENER_WAIT_MS = saved;
  }
});

test("GENITA_GREET_OPENER_WAIT_MS=0: the opener goes out at once (the old order)", async () => {
  const saved = process.env.GENITA_GREET_OPENER_WAIT_MS;
  process.env.GENITA_GREET_OPENER_WAIT_MS = "0";
  try {
    const { client, session } = run(400, 20);
    const t0 = Date.now();
    await session.onClientText(JSON.stringify({ type: "start", persona, mic: false, user: { name: "Summer" }, greetAfterMs: 0 }));
    const first = await client.waitFor((m) => m.type === "audio");
    assert.ok(first.t - t0 < 250, `opener at ready (${first.t - t0} ms)`);
    await client.waitFor((m) => m.type === "reply" && m.final === true);
    session.close();
  } finally {
    if (saved === undefined) delete process.env.GENITA_GREET_OPENER_WAIT_MS;
    else process.env.GENITA_GREET_OPENER_WAIT_MS = saved;
  }
});

test("Codex #708 P1: a cold GPU that fails the opener twice and the early answer once still voices the answer", async () => {
  const { client, calls, session } = run(50, 10, { opener: 2, answer: 1 });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false, user: { name: "Summer" }, greetAfterMs: 0 }));
  await client.waitFor((m) => m.type === "reply" && m.final === true, 8000);
  await sleep(100);
  const answers = calls.filter((c) => /interview/.test(c.text));
  assert.ok(answers.length >= 2, `the failed early answer was asked for again (${answers.length})`);
  assert.equal(client.json.filter((x) => x.m.type === "audio").length, 2, "opener + answer voiced");
  assert.equal(client.json.filter((x) => x.m.type === "error").length, 0, "no tts_unavailable");
  session.close();
});
