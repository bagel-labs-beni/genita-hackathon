/**
 * npm run smoke:interpret [-- --turns=10] [--call]
 *
 * F8-L1 done check, real vendors: starts the server on loopback, opens a
 * session in interpret mode and plays the T7 clips (Korean and English
 * alternating, same files as the 11/1 T7/T7b reference) as mic audio in real
 * time. Per turn it measures, on the client:
 *   end of voice (last voiced 20 ms sent) → first translation audio frame
 *   end of file (the T7b definition)       → first translation audio frame
 * and checks speaker side (Korean = them, English = me), that the translation
 * is in the other language (no mixing) and flags suspiciously long outputs
 * (advice added). --call sends the Korean clips as the Mac call's sound
 * (framed kind 4) and the English ones as the held mic (INT-M1/M2).
 * --record=<file> also saves the session for ios-app/Tools/call-replay (handshake + timeline, TTS
 * audio as lengths only), e.g. --turns=3 --record=../ios-app/Tools/call-replay/session-int.json.
 * Keys come from GENITA_ENV_FILE / ~/.config/genita/meta.env and are never printed.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { encodeFrameHeader, CLIENT_FRAME_KIND_CALL, CLIENT_FRAME_KIND_MIC } from "../src/protocol.ts";

const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const SR = 24000;
const FRAME = (SR * 2 * 80) / 1000;
const T7 = join(homedir(), "genita-fixtures/genita-lipsync-test-20261101/suite/t7");
const args = process.argv.slice(2);
const turns = Number(args.find((a) => a.startsWith("--turns="))?.slice(8) ?? 10);
const callMode = args.includes("--call");
const recordTo = args.find((a) => a.startsWith("--record="))?.slice(9);
const recorded: { t: number; event?: Record<string, unknown>; frame?: { header: string; pcmBytes: number } }[] = [];
let recordFrom = -1;
// same order as rt.py t7(): ko0, en0, ko1, en1, …
const KO = ["실례합니다, 여기서 시청 가려면 어떻게 가요?", "이 근처에 맛있는 식당 있어요?", "사진 좀 찍어 주실 수 있어요?", "이거 얼마예요?", "화장실이 어디에 있나요?"];
const EN = ["Take line two and get off at City Hall.", "There is a great noodle place around the corner.", "Sure, say cheese!", "That one is fifteen thousand won.", "It is on the second floor, next to the elevator."];
const said = KO.flatMap((k, i) => [k, EN[i]]);
const files = Array.from({ length: Math.min(turns, 10) }, (_, i) => ({ file: join(T7, `${i}.mp3`), lang: i % 2 === 0 ? "ko" : "en", said: said[i] }));

function toPcm(file: string): Buffer {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"], { maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${file}`);
  return r.stdout;
}
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
const hasHangul = (s: string) => /\p{Script=Hangul}/u.test(s);

const config = { ...loadConfig(), host: "127.0.0.1", port: 0, sessionToken: null };
const server = await startServer(config, () => {});
const port = (server.address() as { port: number }).port;
const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/session`);
await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));

type Msg = Record<string, unknown> & { type: string };
const inbox: { t: number; m: Msg }[] = [];
const firstAudioAt = new Map<number, number>();
let lastAudioUtt = 0;
ws.on("message", (data, isBinary) => {
  const t = performance.now();
  if (isBinary) {
    if (!firstAudioAt.has(lastAudioUtt)) firstAudioAt.set(lastAudioUtt, t);
    const b = data as Buffer;
    if (recordFrom >= 0) recorded.push({ t: Math.round(t - recordFrom), frame: { header: b.subarray(0, 8).toString("base64"), pcmBytes: b.length - 8 } });
    return;
  }
  const m = JSON.parse(data.toString());
  if (recordFrom >= 0) recorded.push({ t: Math.round(t - recordFrom), event: m });
  if (m.type === "audio") lastAudioUtt = m.utteranceId;
  inbox.push({ t, m });
});
const waitMsg = async (pred: (m: Msg) => boolean, from: number, ms = 20000) => {
  const t0 = performance.now();
  for (;;) {
    const hit = inbox.slice(from).find((x) => pred(x.m));
    if (hit) return hit;
    if (performance.now() - t0 > ms) throw new Error("timeout; last: " + inbox.slice(-3).map((x) => x.m.type).join(","));
    await sleep(5);
  }
};

// one real-time sender per channel; silence unless a clip is queued
type Queued = { pcm: Buffer; voicedEnd: number; onEnd: (t: number) => void; onFileEnd: (t: number) => void };
const queues: Record<"mic" | "call", Queued[]> = { mic: [], call: [] };
let running = true;
const sender = (ch: "mic" | "call") =>
  (async () => {
    const silence = Buffer.alloc(FRAME);
    const t0 = performance.now();
    let sent = 0;
    let cur: Queued | null = null;
    let off = 0;
    let ended = false;
    while (running) {
      if (!cur && queues[ch].length) {
        cur = queues[ch].shift()!;
        off = 0;
        ended = false;
      }
      let frame: Buffer = silence;
      if (cur) {
        frame = cur.pcm.subarray(off, off + FRAME);
        if (frame.length < FRAME) frame = Buffer.concat([frame, Buffer.alloc(FRAME - frame.length)]);
        off += FRAME;
      }
      ws.send(callMode ? Buffer.concat([encodeFrameHeader(ch === "call" ? CLIENT_FRAME_KIND_CALL : CLIENT_FRAME_KIND_MIC, 0), frame]) : frame);
      sent++;
      const now = performance.now();
      if (cur) {
        if (!ended && off >= cur.voicedEnd) (ended = true), cur.onEnd(now);
        if (off >= cur.pcm.length) cur.onFileEnd(now), (cur = null);
      }
      const d = t0 + sent * 80 - performance.now();
      if (d > 0) await sleep(d);
    }
  })();
const senders = [sender("mic"), ...(callMode ? [sender("call")] : [])];

ws.send(
  JSON.stringify({
    type: "start",
    persona: { name: "Jin", kind: "human" },
    mode: "interpret",
    lip: "none",
    ...(callMode ? { interpret: { source: "call", app: "FaceTime" } } : {}),
  }),
);
await waitMsg((m) => m.type === "ready", 0);
await sleep(1200);
const handshake = inbox.map((x) => x.m);
recordFrom = performance.now();

const rows: Record<string, unknown>[] = [];
for (const [i, f] of files.entries()) {
  const pcm = toPcm(f.file);
  const span = voicedSpan(pcm);
  const from = inbox.length;
  const ch: "mic" | "call" = callMode && f.lang === "ko" ? "call" : "mic";
  if (callMode && ch === "mic") ws.send(JSON.stringify({ type: "hold", on: true }));
  let endAt = 0;
  let fileEndAt = 0;
  const fileDone = new Promise<void>((r) => queues[ch].push({ pcm, voicedEnd: span.end, onEnd: (t) => (endAt = t), onFileEnd: (t) => ((fileEndAt = t), r()) }));
  await fileDone;
  if (callMode && ch === "mic") ws.send(JSON.stringify({ type: "hold", on: false }));
  let row: Record<string, unknown>;
  try {
    const reply = await waitMsg((m) => m.type === "reply", from, 30000);
    const uid = reply.m.utteranceId as number;
    const bubble = inbox.slice(from).filter((x) => x.m.type === "interpret.bubble" && x.m.utteranceId === uid).at(-1)?.m;
    const metrics = inbox.slice(from).find((x) => x.m.type === "turn.metrics" && x.m.utteranceId === uid)?.m;
    const fa = firstAudioAt.get(uid);
    const heard = String((bubble?.original as Record<string, unknown> | undefined)?.text ?? "");
    const translation = String(reply.m.text ?? "");
    const expectSpeaker = f.lang === "ko" ? "them" : "me";
    row = {
      turn: i,
      lang: f.lang,
      said: f.said,
      heard,
      speaker: bubble?.speaker,
      speakerOk: bubble?.speaker === expectSpeaker,
      translation,
      mixedOk: f.lang === "ko" ? !hasHangul(translation) : hasHangul(translation),
      lengthRatio: Math.round((translation.length / Math.max(1, heard.length)) * 100) / 100,
      endToFirstAudioMs: fa ? Math.round(fa - endAt) : null,
      fileEndToFirstAudioMs: fa ? Math.round(fa - fileEndAt) : null,
      server: metrics,
    };
  } catch (err) {
    const b = inbox.slice(from).filter((x) => x.m.type === "interpret.bubble").at(-1)?.m;
    row = { turn: i, lang: f.lang, said: f.said, error: String(err).slice(0, 120), lastBubble: b };
  }
  rows.push(row);
  console.log(`turn ${i} [${f.lang}] ${row.endToFirstAudioMs} ms (file end ${row.fileEndToFirstAudioMs} ms) ${row.speaker} heard="${row.heard}" → "${row.translation}"`);
  await waitMsg((m) => m.type === "state" && m.state === "listening", inbox.length - 1, 30000).catch(() => {});
  await sleep(600);
}

const ok = rows.filter((r) => typeof r.endToFirstAudioMs === "number");
const lat = ok.map((r) => r.endToFirstAudioMs as number);
const fileLat = ok.map((r) => r.fileEndToFirstAudioMs as number);
const spec: Record<string, number> = {};
for (const r of ok) {
  const k = String((r.server as Record<string, unknown> | undefined)?.speculative ?? "n/a");
  spec[k] = (spec[k] ?? 0) + 1;
}
const summary = {
  mode: callMode ? "call" : "face",
  turns: rows.length,
  relayed: ok.length,
  speakerOk: rows.filter((r) => r.speakerOk).length,
  mixedOk: rows.filter((r) => r.mixedOk).length,
  longOutputs: rows.filter((r) => (r.lengthRatio as number) > 2.5).length,
  speculative: spec,
  endOfVoiceToFirstAudioMs: { p50: median(lat), min: Math.min(...lat), max: Math.max(...lat), all: lat },
  fileEndToFirstAudioMs: { p50: median(fileLat), min: Math.min(...fileLat), max: Math.max(...fileLat), all: fileLat },
  serverSpeechEndToFirstAudioP50: median(ok.map((r) => (r.server as Record<string, number>)?.speechEndToFirstAudioMs).filter((x) => typeof x === "number")),
};
console.log("\nSUMMARY " + JSON.stringify(summary, null, 1));
if (recordTo) {
  const source = `genita-server feat/interpret, real vendors, ${new Date().toISOString().slice(0, 10)} (npm run smoke:interpret -- ${args.join(" ")}). PCM replaced by a quiet tone of the same length.`;
  writeFileSync(recordTo, JSON.stringify({ source, handshake, timeline: recorded }));
  console.log(`recorded ${recorded.length} items → ${recordTo}`);
}
mkdirSync(".smoke", { recursive: true });
writeFileSync(`.smoke/interpret-${callMode ? "call" : "face"}.json`, JSON.stringify({ rows, summary }, null, 1));
running = false;
await Promise.all(senders);
ws.close();
server.close();
process.exit(0);
