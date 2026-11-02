/**
 * npm run bench:latency -- [--dir=<folder of .pcm24/.mp3/.wav>] [--turns=20] [--pauses=500,800,1200] [--tts=server|device] [--out=file.json]
 *
 * End-of-speech → first-sound, broken into stages, with real vendors (Meta Transcribe + Spark, and the
 * Meta voice service when GENITA_VOICE_URL/TOKEN are set). Runs the server in-process, so client and
 * server share one clock: the numbers are the server-side path with zero client network. Run it
 * in-region (us-east) for the deployed path; add the measured client RTT for a far client.
 *
 * Stages per turn (ms):
 *   hangover      voiced end of the audio → ASR speechEnd (Meta endpointing wait)
 *   asrFinal      speechEnd → speechComplete (final transcript)
 *   specLead      how long before speechComplete Spark was started on a partial (speculation hit only)
 *   sparkTtft     Spark start (speculative or not) → first text token
 *   toSentence    first token → first sentence/clause boundary
 *   ttsFirst      first sentence → first audio chunk (or `say` in device mode)
 *   total         voiced end → first audio
 *   serverTotal   speechEnd → first audio (what turn.metrics calls speechEndToFirstAudioMs)
 *
 * --pauses: each utterance is also sent split at its quietest word gap (--split, default 30–70% in) with that much
 * silence inserted. A turn is a false end-of-turn if the server starts answering (state thinking)
 * before the second half has been spoken; "talkedOver" if audio started before it.
 * Keys come from GENITA_ENV_FILE / ~/.config/genita/{meta,voice}.env and are never printed.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";

for (const f of [process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env"), join(homedir(), ".config/genita/voice.env")]) {
  if (existsSync(f)) process.loadEnvFile(f);
}

const SR = 24000;
const FRAME = (SR * 2 * 80) / 1000;
const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const tts = arg("tts") ?? (process.env.GENITA_VOICE_URL ? "server" : "device");
const turns = Number(arg("turns") ?? 20);
const pauses = (arg("pauses") ?? "").split(",").filter(Boolean).map(Number);
const dir = arg("dir") ?? process.env.GENITA_FIXTURES_DIR ?? "";
const outFile = arg("out");
const skipPlain = args.includes("--pauses-only");
// --split=0.2-0.45: where in the voiced span the pause goes (early = more likely mid-sentence)
const [splitLo, splitHi] = (arg("split") ?? "0.3-0.7").split("-").map(Number);

function toPcm(file: string): Buffer {
  if (file.endsWith(".pcm24")) return readFileSync(file);
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"], { maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${file}`);
  return r.stdout;
}

const WIN = (SR * 2 * 20) / 1000;
function rmsWindows(pcm: Buffer): number[] {
  const out: number[] = [];
  for (let o = 0; o + WIN <= pcm.length; o += WIN) {
    let s = 0;
    for (let i = o; i < o + WIN; i += 2) s += pcm.readInt16LE(i) ** 2;
    out.push(Math.sqrt(s / (WIN / 2)));
  }
  return out;
}
function voicedSpan(pcm: Buffer): { start: number; end: number } {
  const rms = rmsWindows(pcm);
  const thr = Math.max(...rms) * 0.08;
  const first = rms.findIndex((v) => v > thr);
  let last = rms.length - 1;
  while (last > 0 && rms[last] <= thr) last--;
  return { start: first * WIN, end: (last + 1) * WIN };
}
/** split at the quietest 60 ms inside --split (default 30–70%) of the voiced span, insert `ms` of silence */
function withPause(pcm: Buffer, ms: number): { pcm: Buffer; firstEnd: number } {
  const rms = rmsWindows(pcm);
  const span = voicedSpan(pcm);
  const a = Math.floor(span.start / WIN + splitLo * ((span.end - span.start) / WIN));
  const b = Math.floor(span.start / WIN + splitHi * ((span.end - span.start) / WIN));
  let best = a;
  let bestE = Infinity;
  for (let i = a; i + 2 < b; i++) {
    const e = rms[i] + rms[i + 1] + rms[i + 2];
    if (e < bestE) (bestE = e), (best = i + 1);
  }
  const cut = best * WIN;
  const gap = Buffer.alloc(Math.round((SR * ms) / 1000) * 2);
  return { pcm: Buffer.concat([pcm.subarray(0, cut), gap, pcm.subarray(cut)]), firstEnd: cut };
}

const pct = (xs: number[], p: number) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  return Math.round(s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── server in-process, logs captured for the stage timeline ──
const answered = new Map<number, Record<string, unknown>>();
const serverErrors: string[] = [];
const config = { ...loadConfig(), host: "127.0.0.1", port: 0, sessionToken: null };
const server = await startServer(config, (event, data) => {
  if (event === "turn.answered") answered.set(data.utteranceId as number, data);
  if (/error|empty|down/.test(event)) serverErrors.push(`${event}: ${JSON.stringify(data).slice(0, 200)}`);
});
const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/v1/session`, { headers: { "x-genita-user": `bench${Date.now()}` } });
await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));

type Msg = Record<string, unknown> & { type: string };
const inbox: { t: number; m: Msg }[] = [];
const firstAudio: { t: number; u: number }[] = [];
ws.on("message", (data, isBinary) => {
  const t = performance.now();
  if (isBinary) return void firstAudio.push({ t, u: -1 });
  const m = JSON.parse(data.toString()) as Msg;
  if (m.type === "say" || m.type === "audio") firstAudio.push({ t, u: m.utteranceId as number });
  inbox.push({ t, m });
});
const waitMsg = async (pred: (m: Msg) => boolean, from: number, ms = 20000) => {
  const t0 = performance.now();
  for (;;) {
    const hit = inbox.slice(from).find((x) => pred(x.m));
    if (hit) return hit;
    if (performance.now() - t0 > ms) return null;
    await sleep(5);
  }
};

type Queued = { pcm: Buffer; marks: { at: number; fn: (t: number) => void }[] };
const queue: Queued[] = [];
let micRunning = true;
void (async () => {
  const silence = Buffer.alloc(FRAME);
  const t0 = performance.now();
  let sent = 0;
  let cur: Queued | null = null;
  let off = 0;
  while (micRunning) {
    if (!cur && queue.length) (cur = queue.shift()!), (off = 0);
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
      const c: Queued = cur;
      for (const mark of c.marks) if (off >= mark.at && mark.at >= 0) (mark.fn(now), (mark.at = -1));
      if (off >= c.pcm.length) cur = null;
    }
    const d = t0 + sent * 80 - performance.now();
    if (d > 0) await sleep(d);
  }
})();

ws.send(JSON.stringify({
  type: "start",
  persona: { name: "Genita", kind: "character", traits: ["warm", "witty", "curious"], speakingStyle: "short and playful" },
  user: { name: "Chelsea" },
  lip: "none",
  tts,
}));
const ready = await waitMsg((m) => m.type === "ready", 0);
if (!ready) throw new Error("no ready");
console.log("ready:", JSON.stringify({ tts: ready.m.tts, voiceId: ready.m.voiceId }));
await sleep(2500); // let the voice prefetch fillers

const files = existsSync(dir)
  ? readdirSync(dir).filter((f) => /^u\d+\.(pcm24|mp3|wav)$/.test(f)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0])).map((f) => join(dir, f)).slice(0, turns)
  : args.filter((a) => !a.startsWith("--"));
if (!files.length) throw new Error("no input audio (--dir or files)");

async function settle(from: number) {
  // quiet = listening and no new message for 1.2 s
  for (;;) {
    const n = inbox.length;
    await sleep(1200);
    const last = inbox.at(-1)?.m;
    if (inbox.length === n && last && (last.type !== "state" || last.state === "listening")) {
      const st = [...inbox.slice(from)].reverse().find((x) => x.m.type === "state");
      if (!st || st.m.state === "listening") return;
    }
  }
}

type Row = Record<string, unknown>;
const plain: Row[] = [];
const paused: Row[] = [];

async function runTurn(file: string, pauseMs: number | null): Promise<Row> {
  const raw = toPcm(file);
  const { pcm, firstEnd } = pauseMs === null ? { pcm: raw, firstEnd: -1 } : withPause(raw, pauseMs);
  const span = voicedSpan(pcm);
  const from = inbox.length;
  const fa0 = firstAudio.length;
  let voicedEndAt = 0;
  let firstPartEndAt = 0;
  const done = new Promise<void>((r) =>
    queue.push({
      pcm,
      marks: [
        { at: span.end, fn: (t) => ((voicedEndAt = t), r()) },
        ...(firstEnd > 0 ? [{ at: firstEnd, fn: (t: number) => (firstPartEndAt = t) }] : []),
      ],
    }),
  );
  await done;
  const reply = await waitMsg((m) => m.type === "reply", from, 30000);
  await settle(from);
  const msgs = inbox.slice(from);
  const finals = msgs.filter((x) => x.m.type === "transcript" && x.m.final && x.m.source === "voice");
  const thinking = msgs.filter((x) => x.m.type === "state" && x.m.state === "thinking");
  const fa = firstAudio.slice(fa0)[0];
  const lastFinal = finals.at(-1);
  const lastMetrics = [...msgs].reverse().find((x) => x.m.type === "turn.metrics");
  const uid = lastMetrics?.m.utteranceId as number | undefined;
  const stages = (uid !== undefined ? answered.get(uid)?.stages : undefined) as Record<string, number | null> | undefined;
  const speechEnd = [...msgs].reverse().find((x) => x.m.type === "speech.end" && x.t <= (lastFinal?.t ?? Infinity));
  const replyFirstAudio = uid !== undefined ? firstAudio.slice(fa0).find((x) => x.u === uid) : undefined;
  const row: Row = {
    file: file.split("/").pop(),
    pauseMs,
    heard: finals.map((x) => x.m.text).join(" | "),
    reply: reply?.m.text,
    finals: finals.length,
    hangover: speechEnd ? Math.round(speechEnd.t - voicedEndAt) : null,
    totalMs: replyFirstAudio ? Math.round(replyFirstAudio.t - voicedEndAt) : null,
    stages,
    speculative: lastMetrics?.m.speculative,
    errors: msgs.filter((x) => x.m.type === "error").map((x) => `${x.m.code}: ${String(x.m.message).slice(0, 80)}`),
    // every partial, ms relative to the voiced end (negative = while still talking)
    partials: msgs.filter((x) => x.m.type === "transcript" && !x.m.final).map((x) => `${Math.round(x.t - voicedEndAt)}:${String(x.m.text).slice(-24)}`),
  };
  if (pauseMs !== null) {
    row.falseEot = thinking.some((x) => x.t < voicedEndAt) || finals.some((x) => x.t < voicedEndAt);
    row.talkedOver = !!fa && fa.t < voicedEndAt;
    row.cancelled = msgs.filter((x) => x.m.type === "utterance.cancelled").length;
    row.pauseStartToVoicedEnd = Math.round(voicedEndAt - firstPartEndAt);
  }
  return row;
}

const order: [string, number | null][] = [];
if (!skipPlain) for (const f of files) order.push([f, null]);
for (const p of pauses) for (const f of files) order.push([f, p]);
for (const [i, [f, p]] of order.entries()) {
  const row = await runTurn(f, p);
  (p === null ? plain : paused).push(row);
  const s = row.stages as Record<string, number | null> | undefined;
  console.log(
    `${i + 1}/${order.length} ${row.file}${p !== null ? ` pause=${p}` : ""} total=${row.totalMs} hang=${row.hangover} ` +
      `lastPartial=${s?.lastPartial} complete=${s?.complete} spec=${row.speculative} specStart=${s?.specStart} tok=${s?.firstToken} sent=${s?.firstSentence} audio=${s?.firstAudio} tools=${s?.toolsBeforeText}` +
      (p !== null ? ` falseEot=${row.falseEot} talkedOver=${row.talkedOver}` : "") +
      `  heard="${row.heard}"`,
  );
}

function stageTable(rows: Row[]) {
  const get = (fn: (r: Row, s: Record<string, number | null>) => number | null | undefined) =>
    rows.map((r) => (r.stages ? fn(r, r.stages as Record<string, number | null>) : null)).filter((x): x is number => typeof x === "number");
  const sparkStart = (s: Record<string, number | null>) => (s.specStart ?? s.replyStart);
  const stages: Record<string, number[]> = {
    hangover: rows.map((r) => r.hangover).filter((x): x is number => typeof x === "number"),
    lastPartialBeforeEnd: get((_, s) => (s.lastPartial !== null ? -s.lastPartial! : null)),
    asrFinal: get((_, s) => s.complete),
    specLead: get((_, s) => (s.specStart !== null && s.complete !== null ? s.complete - s.specStart! : null)),
    sparkTtft: get((_, s) => (s.firstToken !== null && sparkStart(s) !== null ? s.firstToken! - sparkStart(s)! : null)),
    speechEndToFirstToken: get((_, s) => s.firstToken),
    toSentence: get((_, s) => (s.firstSentence !== null && s.firstToken !== null ? s.firstSentence! - s.firstToken! : null)),
    ttsFirst: get((_, s) => (s.firstAudio !== null && s.firstSentence !== null ? s.firstAudio! - s.firstSentence! : null)),
    serverTotal: get((_, s) => s.firstAudio),
    total: rows.map((r) => r.totalMs).filter((x): x is number => typeof x === "number"),
  };
  const out: Record<string, { p50: number | null; p90: number | null; n: number }> = {};
  for (const [k, xs] of Object.entries(stages)) out[k] = { p50: pct(xs, 0.5), p90: pct(xs, 0.9), n: xs.length };
  const spec = rows.map((r) => r.speculative);
  return { stages: out, speculative: { hit: spec.filter((x) => x === "hit").length, miss: spec.filter((x) => x === "miss").length, none: spec.filter((x) => x === "none").length }, toolTurns: get((_, s) => s.toolsBeforeText).filter((x) => x > 0).length };
}

const summary: Record<string, unknown> = { tts, n: plain.length };
if (plain.length) summary.plain = stageTable(plain);
if (paused.length) {
  summary.pauses = Object.fromEntries(
    pauses.map((p) => {
      const rs = paused.filter((r) => r.pauseMs === p);
      return [p, { n: rs.length, falseEot: rs.filter((r) => r.falseEot).length, talkedOver: rs.filter((r) => r.talkedOver).length, totalP50: pct(rs.map((r) => r.totalMs as number), 0.5) }];
    }),
  );
}
summary.serverErrors = serverErrors;
console.log("SUMMARY " + JSON.stringify(summary));
if (outFile) writeFileSync(outFile, JSON.stringify({ summary, plain, paused }, null, 1));
micRunning = false;
ws.close();
server.close();
setTimeout(() => process.exit(0), 500).unref();
