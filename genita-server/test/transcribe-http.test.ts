import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { defaultDeps, startServer } from "../src/server.ts";
import { loadConfig, type Config } from "../src/config.ts";
import type { AsrEvent } from "../src/meta/transcribe.ts";
import { ASR_RATE, createTranscribeRoute, decodeAudio, MAX_AUDIO_MS, PER_MINUTE, upsample16to24 } from "../src/transcribe/http.ts";

const config: Config = { ...loadConfig({ MODEL_API_KEY: "x" }), host: "127.0.0.1", port: 0, sessionToken: "transcribe-test-token" };
const SAID = "I actually prefer warm colors";

/** A Muse Transcribe stand-in: counts the bytes, answers on endStream (or never, or fails). */
class FakeAsr extends EventEmitter {
  bytes = 0;
  ended = 0;
  isOpen = false;
  private readonly mode: "ok" | "hang" | "refuse" | "drop" | "partial";
  private readonly text: string;
  constructor(mode: "ok" | "hang" | "refuse" | "drop" | "partial" = "ok", text = SAID) { super(); this.mode = mode; this.text = text; }
  async connect() {
    if (this.mode === "refuse") throw new Error("connect ECONNREFUSED");
    this.isOpen = true;
    this.emit("status", "connected");
  }
  sendAudio(pcm: Buffer) {
    this.bytes += pcm.length;
    if (this.mode === "drop" && this.bytes > 9600) { this.isOpen = false; this.emit("status", "reconnecting"); }
    if (this.mode === "partial" && this.bytes === pcm.length) this.emit("event", { type: "partial", text: "I actually" } satisfies AsrEvent);
  }
  end() {
    this.ended++;
    if (this.mode === "hang" || this.mode === "partial" || this.ended > 1) return;
    setImmediate(() => {
      this.emit("event", { type: "speechStart", turnId: 1 } satisfies AsrEvent);
      this.emit("event", { type: "speechComplete", turnId: 1, text: this.text } satisfies AsrEvent);
      this.isOpen = false;
      this.emit("status", "closed");
    });
  }
}

const pcm = (ms: number, rate = ASR_RATE) => {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
  return b;
};
const wav = (samples: Buffer, rate: number) => {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii"); h.writeUInt32LE(36 + samples.length, 4); h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii"); h.writeUInt32LE(samples.length, 40);
  return Buffer.concat([h, samples]);
};

type Log = { event: string; data: Record<string, unknown> };

/** the route alone on a plain HTTP server (user = x-user header), fast pacing */
async function routeServer(t: import("node:test").TestContext, asr: () => FakeAsr, opts: { deadlineMs?: number; settleMs?: number; speedup?: number; bodyMs?: number } = {}) {
  const logs: Log[] = [];
  const route = createTranscribeRoute({ openAsr: asr, log: (event, data) => logs.push({ event, data }), env: {}, speedup: 1000, ...opts });
  const server: Server = createServer((req, res) => { void route.handle(req, res, String(req.headers["x-user"] ?? "u1")); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: Buffer, type = "application/octet-stream", user = "u1") =>
    fetch(base + "/v1/transcribe", { method: "POST", headers: { "content-type": type, "x-user": user }, body: new Uint8Array(body) });
  return { logs, post };
}

test("POST /v1/transcribe is wired: auth first, then Muse Transcribe; GENITA_TRANSCRIBE_HTTP=0 is a 404", async (t) => {
  const opened: FakeAsr[] = [];
  const log = () => {};
  const deps = { ...defaultDeps(config, log), openAsr: () => { const a = new FakeAsr(); opened.push(a); return a; } };
  const server = await startServer(config, log, deps, {});
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (token?: string) => fetch(base + "/v1/transcribe", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: new Uint8Array(pcm(600)),
  });
  assert.equal((await post()).status, 401);
  assert.equal((await post("wrong")).status, 401);
  assert.equal(opened.length, 0, "no vendor call before auth");
  const ok = await post(config.sessionToken ?? undefined);
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { text: string }).text, SAID);
  assert.equal(opened.length, 1);

  const offDeps = { ...defaultDeps(config, log), openAsr: () => { throw new Error("must not open"); } };
  const off = await startServer(config, log, offDeps, { GENITA_TRANSCRIBE_HTTP: "0" });
  t.after(() => new Promise<void>((r) => off.close(() => r())));
  const offBase = `http://127.0.0.1:${(off.address() as AddressInfo).port}`;
  const r = await fetch(offBase + "/v1/transcribe", { method: "POST", headers: { authorization: `Bearer ${config.sessionToken}` }, body: new Uint8Array(pcm(600)) });
  assert.equal(r.status, 404);
});

test("a clip goes up whole (plus the endpointing tail), the text comes back, and the log has sizes only", async (t) => {
  const made: FakeAsr[] = [];
  const { logs, post } = await routeServer(t, () => { const a = new FakeAsr(); made.push(a); return a; });
  const audio = pcm(1000);
  const r = await post(audio);
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { text: string }).text, SAID);
  assert.ok(made[0].bytes >= audio.length + ASR_RATE * 2 * 0.7, `clip + ~800 ms silence, got ${made[0].bytes}`);
  assert.equal(made[0].ended, 1, "one endStream");
  const line = logs.find((l) => l.event === "transcribe.request");
  assert.deepEqual(Object.keys(line?.data ?? {}).sort(), ["audioMs", "bytes", "chars", "code", "ms", "status", "turns", "userId"]);
  assert.equal(line?.data.audioMs, 1000);
  assert.equal(line?.data.chars, SAID.length);
  assert.ok(!JSON.stringify(logs).includes("warm"), "never the words");
});

test("16 kHz WAV is resampled to 24 kHz; other formats are 415; too long is 413; too short never calls Meta", async (t) => {
  const made: FakeAsr[] = [];
  const { post } = await routeServer(t, () => { const a = new FakeAsr(); made.push(a); return a; });
  const r = await post(wav(pcm(1000, 16_000), 16_000), "audio/wav");
  assert.equal(r.status, 200);
  assert.ok(Math.abs(made[0].bytes - (ASR_RATE * 2 * 1.8)) < 2000, `1 s at 24 kHz + tail, got ${made[0].bytes}`);
  assert.equal((await post(wav(pcm(500, 44_100), 44_100), "audio/wav")).status, 415);
  assert.equal((await post(Buffer.from("not audio"), "audio/wav")).status, 415);
  assert.equal((await post(pcm(500), "audio/mpeg")).status, 415);
  assert.equal((await post(pcm(MAX_AUDIO_MS + 1500))).status, 413);
  const short = await post(pcm(100));
  assert.equal(short.status, 200);
  assert.equal(((await short.json()) as { text: string }).text, "");
  assert.equal(made.length, 1, "only the first clip reached the vendor");
});

test("per user: one at a time and 10 a minute (429); another user is not limited", async (t) => {
  const { post } = await routeServer(t, () => new FakeAsr());
  const [a, b] = await Promise.all([post(pcm(600)), post(pcm(600))]);
  assert.deepEqual([a.status, b.status].sort(), [200, 429]);
  for (let i = 1; i < PER_MINUTE; i++) assert.equal((await post(pcm(600))).status, 200, `request ${i + 1}`);
  const over = await post(pcm(600));
  assert.equal(over.status, 429);
  assert.equal(((await over.json()) as { error: string }).error, "rate_limited");
  assert.equal((await post(pcm(600), "application/octet-stream", "u2")).status, 200);
});

test("vendor failures: refused → 502, dropped → 502 without a reconnect, silence past the deadline → the partial or empty", async (t) => {
  const refuse = await routeServer(t, () => new FakeAsr("refuse"));
  assert.equal((await refuse.post(pcm(600))).status, 502);
  const dropped: FakeAsr[] = [];
  const drop = await routeServer(t, () => { const a = new FakeAsr("drop"); dropped.push(a); return a; });
  const d = await drop.post(pcm(1000));
  assert.equal(d.status, 502);
  assert.ok(dropped[0].ended >= 1, "the stream is ended, not reopened");
  const partial = await routeServer(t, () => new FakeAsr("partial"), { settleMs: 300 });
  const p = await partial.post(pcm(600));
  assert.equal(p.status, 200);
  assert.equal(((await p.json()) as { text: string }).text, "I actually");
  const hang = await routeServer(t, () => new FakeAsr("hang"), { settleMs: 300 });
  const h = await hang.post(pcm(600));
  assert.equal(h.status, 200);
  assert.equal(((await h.json()) as { text: string }).text, "");
});

test("decodeAudio: raw L16 at 16 kHz is resampled, an odd byte is dropped", () => {
  assert.equal(upsample16to24(pcm(1000, 16_000)).length, ASR_RATE * 2);
  assert.equal(decodeAudio(Buffer.alloc(4801), "application/octet-stream").length, 4800);
  assert.equal(decodeAudio(pcm(1000, 16_000), "audio/L16; rate=16000").length, ASR_RATE * 2);
  assert.throws(() => decodeAudio(Buffer.alloc(10), "audio/L16; rate=8000"));
});

test("a 30 s clip goes up whole inside the deadline (faster than 4× when it must)", async (t) => {
  const made: FakeAsr[] = [];
  const { post } = await routeServer(t, () => { const a = new FakeAsr(); made.push(a); return a; }, { speedup: 4, deadlineMs: 7000, settleMs: 2500 });
  const audio = pcm(MAX_AUDIO_MS);
  const t0 = Date.now();
  const r = await post(audio);
  assert.equal(r.status, 200);
  assert.ok(made[0].bytes >= audio.length, `all ${audio.length} bytes sent, got ${made[0].bytes}`);
  assert.ok(Date.now() - t0 < 7000, "inside the deadline");
});

test("the app hangs up mid-send: Meta stops getting audio, the stream ends, the slot frees", async (t) => {
  const made: FakeAsr[] = [];
  const { post } = await routeServer(t, () => { const a = new FakeAsr("hang"); made.push(a); return a; }, { speedup: 1, deadlineMs: 7000 });
  const ac = new AbortController();
  const req = fetch((await post(pcm(100))).url, { method: "POST", headers: { "content-type": "application/octet-stream", "x-user": "u1" }, body: new Uint8Array(pcm(5000)), signal: ac.signal }).catch(() => null);
  await new Promise((r) => setTimeout(r, 400));
  ac.abort();
  await req;
  await new Promise((r) => setTimeout(r, 300));
  const sentAtAbort = made[0].bytes;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(made[0].bytes, sentAtAbort, "no audio after the hang-up");
  assert.ok(made[0].ended >= 1, "endStream sent");
  assert.ok(sentAtAbort < ASR_RATE * 2 * 5, "stopped before the whole clip");
  assert.equal((await post(pcm(100))).status, 200, "the user's slot is free again");
});

test("a body that never finishes is cut at bodyMs (408) and frees the slot", async (t) => {
  const { post } = await routeServer(t, () => new FakeAsr(), { bodyMs: 300 });
  const { request } = await import("node:http");
  const url = new URL((await post(pcm(100))).url);
  const status = await new Promise<number | string>((resolve) => {
    const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/octet-stream", "content-length": "48000", "x-user": "u1" } }, (res) => resolve(res.statusCode ?? 0));
    req.on("error", () => resolve("reset"));
    req.write(Buffer.alloc(1000)); // and never the rest
  });
  assert.ok(status === 408 || status === "reset", String(status));
  assert.equal((await post(pcm(100))).status, 200, "the slot is free");
});

test("GENITA_PAUSED / the pause file also stops /v1/transcribe (503 paused) before any Meta call", async (t) => {
  const opened: FakeAsr[] = [];
  const log = () => {};
  const paused: Config = { ...config, paused: true };
  const deps = { ...defaultDeps(paused, log), openAsr: () => { const a = new FakeAsr(); opened.push(a); return a; } };
  const server = await startServer(paused, log, deps, {});
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const r = await fetch(base + "/v1/transcribe", { method: "POST", headers: { authorization: `Bearer ${config.sessionToken}`, "content-type": "application/octet-stream" }, body: new Uint8Array(pcm(600)) });
  assert.equal(r.status, 503);
  assert.equal(opened.length, 0);
});
