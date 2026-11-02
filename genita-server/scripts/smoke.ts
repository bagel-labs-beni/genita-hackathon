/**
 * npm run smoke [-- file1.mp3 file2.wav ...] [--turns=6] [--no-barge]
 *
 * Real keys, real vendors. Starts the server in-process on loopback, then acts
 * like the app: streams mic PCM (24 kHz s16le) in real time, 80 ms frames,
 * with silence between utterances, and measures on the client side:
 *   end of speech (last voiced frame sent) → first TTS audio frame received.
 * Then a barge-in check: speak over the companion's reply and time
 * speech start → utterance.cancelled.
 * Keys come from GENITA_ENV_FILE / ~/.config/genita/meta.env and are never printed.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";

const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const SR = 24000;
const FRAME = (SR * 2 * 80) / 1000; // 80 ms = 3840 bytes
const QA = join(homedir(), "genita-fixtures/genita-lipsync-test-20261101");
const args = process.argv.slice(2);
const doBarge = !args.includes("--no-barge");
const turnsArg = Number(args.find((a) => a.startsWith("--turns="))?.slice(8) ?? 6);
let files = args.filter((a) => !a.startsWith("--"));
if (!files.length) {
  files = [join(QA, "out/en.mp3"), ...Array.from({ length: 19 }, (_, i) => join(QA, `suite/t3/u${i}.mp3`))].filter((f) => existsSync(f)).slice(0, turnsArg);
}
if (!files.length) {
  console.error("No input audio. Pass files: npm run smoke -- a.mp3 b.wav");
  process.exit(2);
}

function toPcm(file: string): Buffer {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"], { maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${file}: ${r.stderr.toString().slice(0, 200)}`);
  return r.stdout;
}

/** byte offsets of the first and last voiced 20 ms windows */
function voicedSpan(pcm: Buffer): { start: number; end: number } {
  const win = (SR * 2 * 20) / 1000;
  const rms: number[] = [];
  for (let o = 0; o + win <= pcm.length; o += win) {
    let s = 0;
    for (let i = o; i < o + win; i += 2) s += pcm.readInt16LE(i) ** 2;
    rms.push(Math.sqrt(s / (win / 2)));
  }
  const thr = Math.max(...rms) * 0.08;
  const first = rms.findIndex((v) => v > thr);
  let last = rms.length - 1;
  while (last > 0 && rms[last] <= thr) last--;
  return { start: first * win, end: (last + 1) * win };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const config = { ...loadConfig(), host: "127.0.0.1", port: 0, sessionToken: null };
const server = await startServer(config, () => {});
const port = (server.address() as { port: number }).port;
const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/session`);
await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));

// ── client state ──
type Msg = Record<string, unknown> & { type: string };
const inbox: { t: number; m: Msg }[] = [];
let firstAudioAfter: { since: number; at: number | null } | null = null;
const replyAudio: Buffer[] = [];
let captureAudio = true;
let binCount = 0;
ws.on("message", (data, isBinary) => {
  const t = performance.now();
  if (isBinary) {
    binCount++;
    if (firstAudioAfter && firstAudioAfter.at === null) firstAudioAfter.at = t;
    if (captureAudio) replyAudio.push((data as Buffer).subarray(8));
    return;
  }
  inbox.push({ t, m: JSON.parse(data.toString()) });
});
const waitMsg = async (pred: (m: Msg) => boolean, from: number, ms = 20000): Promise<{ t: number; m: Msg }> => {
  const t0 = performance.now();
  for (;;) {
    const hit = inbox.slice(from).find((x) => pred(x.m));
    if (hit) return hit;
    if (performance.now() - t0 > ms) throw new Error("timeout waiting; last: " + inbox.slice(-3).map((x) => x.m.type).join(","));
    await sleep(5);
  }
};

// ── mic: one real-time sender, silence unless an utterance is queued ──
type Queued = { pcm: Buffer; voicedStart: number; voicedEnd: number; onStart?: (t: number) => void; onEnd?: (t: number) => void; onFileEnd?: (t: number) => void };
const queue: Queued[] = [];
let micRunning = true;
const mic = (async () => {
  const silence = Buffer.alloc(FRAME);
  const t0 = performance.now();
  let sent = 0;
  let cur: Queued | null = null;
  let off = 0;
  let startFired = false;
  let endFired = false;
  while (micRunning) {
    if (!cur && queue.length) {
      cur = queue.shift()!;
      off = 0;
      startFired = endFired = false;
    }
    let frame: Buffer = silence;
    if (cur) {
      frame = cur.pcm.subarray(off, off + FRAME);
      if (frame.length < FRAME) frame = Buffer.concat([frame, Buffer.alloc(FRAME - frame.length)]);
      off += FRAME;
    }
    ws.send(frame);
    sent++;
    const now = performance.now();
    if (cur) {
      if (!startFired && off > cur.voicedStart) (startFired = true), cur.onStart?.(now);
      if (!endFired && off >= cur.voicedEnd) (endFired = true), cur.onEnd?.(now);
      if (off >= cur.pcm.length) {
        cur.onFileEnd?.(now);
        cur = null;
      }
    }
    const target = t0 + sent * 80;
    const d = target - performance.now();
    if (d > 0) await sleep(d);
  }
})();

ws.send(
  JSON.stringify({
    type: "start",
    persona: { name: "Genita", kind: "character", traits: ["warm", "witty", "curious"], speakingStyle: "short and playful" },
    user: { name: "Chelsea" },
    lip: "atlas",
  }),
);
const ready = await waitMsg((m) => m.type === "ready", 0);
console.log("ready:", JSON.stringify({ lip: ready.m.lip, audio: ready.m.audio, voiceId: ready.m.voiceId }));
await sleep(1200);

const rows: Record<string, unknown>[] = [];
for (const [i, file] of files.entries()) {
  const pcm = toPcm(file);
  const span = voicedSpan(pcm);
  const from = inbox.length;
  let endAt = 0;
  let fileEndAt = 0;
  const ended = new Promise<void>((r) =>
    queue.push({
      pcm,
      voicedStart: span.start,
      voicedEnd: span.end,
      onFileEnd: (t) => (fileEndAt = t),
      onEnd: (t) => {
        endAt = t;
        firstAudioAfter = { since: t, at: null };
        r();
      },
    }),
  );
  if (i === 0) captureAudio = true;
  await ended;
  const reply = await waitMsg((m) => m.type === "reply", from, 30000);
  const transcript = inbox.slice(from).find((x) => x.m.type === "transcript" && x.m.final)?.m.text;
  const metrics = inbox.slice(from).find((x) => x.m.type === "turn.metrics")?.m;
  const fa = firstAudioAfter as { since: number; at: number | null } | null;
  const latency = fa?.at ? Math.round(fa.at - endAt) : null;
  const fromFileEnd = fa?.at && fileEndAt ? Math.round(fa.at - fileEndAt) : null;
  const row = { file: file.split("/").slice(-2).join("/"), heard: transcript, reply: reply.m.text, emotion: reply.m.emotion, endToFirstAudioMs: latency, fileEndToFirstAudioMs: fromFileEnd, server: metrics };
  rows.push(row);
  console.log(`turn ${i + 1}: ${latency} ms (file end: ${fromFileEnd} ms)  heard="${transcript}"  reply="${reply.m.text}"`);
  console.log(`         server: ${JSON.stringify(metrics)}`);
  if (i === 0) {
    captureAudio = false;
    mkdirSync(".smoke", { recursive: true });
    const pcmOut = Buffer.concat(replyAudio);
    const hdr = Buffer.alloc(44);
    hdr.write("RIFF", 0);
    hdr.writeUInt32LE(36 + pcmOut.length, 4);
    hdr.write("WAVEfmt ", 8);
    hdr.writeUInt32LE(16, 16);
    hdr.writeUInt16LE(1, 20);
    hdr.writeUInt16LE(1, 22);
    hdr.writeUInt32LE(SR, 24);
    hdr.writeUInt32LE(SR * 2, 28);
    hdr.writeUInt16LE(2, 32);
    hdr.writeUInt16LE(16, 34);
    hdr.write("data", 36);
    hdr.writeUInt32LE(pcmOut.length, 40);
    writeFileSync(".smoke/turn1-reply.wav", Buffer.concat([hdr, pcmOut]));
  }
  // let the companion "finish speaking" before the next turn
  await waitMsg((m) => m.type === "state" && m.state === "listening", inbox.indexOf(reply), 30000).catch(() => {});
  await sleep(600);
}

let barge: Record<string, unknown> | null = null;
if (doBarge) {
  // ask for something long, then talk over the first audio
  const from = inbox.length;
  const ask = toPcm(files[0]);
  const askSpan = voicedSpan(ask);
  queue.push({ pcm: ask, voicedStart: askSpan.start, voicedEnd: askSpan.end });
  const speaking = await waitMsg((m) => m.type === "state" && m.state === "speaking", from, 30000);
  await sleep(300);
  const over = toPcm(files[1] ?? files[0]);
  const overSpan = voicedSpan(over);
  let speakAt = 0;
  queue.push({ pcm: over, voicedStart: overSpan.start, voicedEnd: overSpan.end, onStart: (t) => (speakAt = t) });
  try {
    const cancelled = await waitMsg((m) => m.type === "utterance.cancelled", inbox.indexOf(speaking), 15000);
    const asrStart = inbox.slice(inbox.indexOf(speaking)).find((x) => x.m.type === "speech.start");
    barge = {
      speechStartToCancelledMs: Math.round(cancelled.t - speakAt),
      asrSpeechStartToCancelledMs: asrStart ? Math.round(cancelled.t - asrStart.t) : null,
      reason: cancelled.m.reason,
      audioFramesAfterCancel: 0,
    };
    const binBefore = binCount;
    await sleep(500);
    barge.audioFramesAfterCancel = binCount - binBefore;
  } catch {
    const done = inbox.slice(from).some((x) => x.m.type === "reply");
    barge = { cancelled: false, note: done ? "reply finished before the barge-in threshold" : "no cancel seen" };
  }
  console.log("barge-in:", JSON.stringify(barge));
  await waitMsg((m) => m.type === "reply", inbox.length - 1, 30000).catch(() => {});
}

const lat = rows.map((r) => r.endToFirstAudioMs).filter((x): x is number => typeof x === "number");
const openers: Record<string, number> = {};
for (const r of rows) {
  const w = String(r.reply ?? "").trim().split(/[\s,!?.]/)[0]?.toLowerCase();
  if (w) openers[w] = (openers[w] ?? 0) + 1;
}
const spec: Record<string, number> = {};
for (const r of rows) {
  const k = String((r.server as Record<string, unknown> | undefined)?.speculative ?? "n/a");
  spec[k] = (spec[k] ?? 0) + 1;
}
const summary = {
  turns: rows.length,
  config: { sparkHedge: config.sparkHedge, speculate: config.speculate },
  speculative: spec,
  firstWords: { maxSame: Math.max(0, ...Object.values(openers)), counts: openers },
  endOfSpeechToFirstAudioMs: { p50: median(lat), min: Math.min(...lat), max: Math.max(...lat), all: lat },
  fileEndToFirstAudioMs: { p50: median(rows.map((r) => r.fileEndToFirstAudioMs).filter((x): x is number => typeof x === "number")) },
  serverSpeechEndToFirstAudioP50: median(rows.map((r) => (r.server as Record<string, number> | undefined)?.speechEndToFirstAudioMs).filter((x): x is number => typeof x === "number")),
  barge,
  savedReplyAudio: ".smoke/turn1-reply.wav",
};
console.log("\nSUMMARY " + JSON.stringify(summary, null, 1));
writeFileSync(".smoke/last.json", JSON.stringify({ rows, summary }, null, 1));
micRunning = false;
await mic;
ws.close();
server.close();
process.exit(0);
