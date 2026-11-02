/**
 * npm run watch-sim -- [--qa] [--react file1.mp4 file2.mp4 ...] [--blank] [--out=dir]
 *
 * Real keys, real vendors. Acts like the Mac while it shares its screen
 * (F5-L7 uplink) and measures watch together end to end:
 *   --qa     T5 set (5 clips × 10 questions, GENITA_FIXTURES_DIR/suite/t5):
 *            play each clip in real time (1 fps JPEG frames ≤1024 px + system
 *            audio PCM), then ask its questions as typed turns; Spark judges
 *            each answer against the clip's ground truth like T5 did.
 *            Latency = question sent → first TTS audio (client clock).
 *   --react  play the files back to back as one share; count proactive
 *            reactions, gate blocks and rule violations (≥30 s apart, never
 *            during the video's dialogue).
 *   --blank  black screen: 5 questions about the screen; count answers that
 *            claim to see something.
 * Keys come from GENITA_ENV_FILE / ~/.config/genita/meta.env and are never printed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { sparkText } from "../src/meta/spark.ts";
import { fixturePath } from "./fixtures.ts";

const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const SR = 24000;
const CHUNK = (SR * 2 * 80) / 1000;
const args = process.argv.slice(2);
const T5 = args.includes("--qa") || (!args.includes("--react") && !args.includes("--blank")) ? fixturePath("suite") : undefined;
const outDir = args.find((a) => a.startsWith("--out="))?.slice(6) ?? join(tmpdir(), "genita-watch-sim");
mkdirSync(outDir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

type Media = { pcm: Buffer; frames: Buffer[]; durationSec: number };

function prepare(file: string): Media {
  const key = file.replace(/[^\w]+/g, "_").slice(-80);
  const dir = join(outDir, "frames", key);
  if (!existsSync(join(dir, "0001.jpg"))) {
    mkdirSync(dir, { recursive: true });
    const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", "fps=1,scale='if(gt(iw,ih),min(1024,iw),-2)':'if(gt(iw,ih),-2,min(1024,ih))'", "-q:v", "6", join(dir, "%04d.jpg")]);
    if (r.status !== 0) throw new Error(`ffmpeg frames: ${r.stderr.toString().slice(0, 200)}`);
  }
  const frames = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort().map((f) => readFileSync(join(dir, f)));
  const a = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"], { maxBuffer: 256 << 20 });
  const pcm = a.status === 0 ? a.stdout : Buffer.alloc(0);
  return { pcm, frames, durationSec: Math.max(frames.length, pcm.length / (SR * 2)) };
}

type Ev = Record<string, unknown> & { type: string; _t: number };

class Call {
  main!: WebSocket;
  watch!: WebSocket;
  ev: Ev[] = [];
  wev: Ev[] = [];
  sessionId = "";
  private readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  async open(): Promise<void> {
    this.main = new WebSocket(`${this.url}/v1/session`);
    this.main.on("message", (d, bin) => {
      if (!bin) this.ev.push({ ...JSON.parse(d.toString()), _t: performance.now() });
    });
    await new Promise((r) => this.main.once("open", r));
    this.main.send(
      JSON.stringify({
        type: "start",
        persona: { name: "Jin", kind: "human", traits: ["warm", "dry humor"], speakingStyle: "short, playful" },
        user: { name: "Chelsea" },
        mic: false,
        lip: "none",
      }),
    );
    const ready = await this.wait((e) => e.type === "ready");
    this.sessionId = String(ready.sessionId);
    this.watch = new WebSocket(`${this.url}/v1/watch?session=${this.sessionId}`);
    this.watch.on("message", (d, bin) => {
      if (!bin) this.wev.push({ ...JSON.parse(d.toString()), _t: performance.now() });
    });
    await new Promise((r) => this.watch.once("open", r));
  }
  wait(pred: (e: Ev) => boolean, from = 0, ms = 30_000, list: "ev" | "wev" = "ev"): Promise<Ev> {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        const hit = this[list].slice(from).find(pred);
        if (hit) return resolve(hit);
        if (Date.now() - t0 > ms) return reject(new Error("timeout"));
        setTimeout(tick, 5);
      };
      tick();
    });
  }
  /** Streams one file like the Mac: 1 fps frames + real-time system audio. */
  async play(m: Media, blank = false): Promise<void> {
    const t0 = performance.now();
    let sent = 0;
    let nextFrame = 0;
    const totalMs = m.durationSec * 1000;
    while (true) {
      const el = performance.now() - t0;
      if (nextFrame < m.frames.length && el >= nextFrame * 1000) {
        this.watch.send(JSON.stringify({ type: "frame", image: m.frames[nextFrame].toString("base64"), blank }));
        nextFrame++;
      }
      const due = Math.min(m.pcm.length, Math.floor((el / 1000) * SR) * 2);
      while (sent + CHUNK <= due) {
        this.watch.send(m.pcm.subarray(sent, sent + CHUNK));
        sent += CHUNK;
      }
      if (el >= totalMs && nextFrame >= m.frames.length) break;
      await sleep(20);
    }
    // the video ends: keep feeding silence 1.5 s so the transcriber closes the last line
    for (let i = 0; i < 19; i++) {
      this.watch.send(Buffer.alloc(CHUNK));
      await sleep(80);
    }
  }
  /** Typed question → first audio, reply text. */
  async ask(q: string): Promise<{ a: string; firstAudioMs: number | null; replyMs: number; firstTokenMs: number | null }> {
    const from = this.ev.length;
    const t = performance.now();
    this.main.send(JSON.stringify({ type: "text", text: q }));
    const reply = await this.wait((e) => e.type === "reply", from, 40_000);
    const fa = this.ev.slice(from).find((e) => e.type === "audio");
    const met = await this.wait((e) => e.type === "turn.metrics", from, 5_000).catch(() => null);
    this.main.send(JSON.stringify({ type: "playback_done", utteranceId: reply.utteranceId }));
    await sleep(300);
    return {
      a: String(reply.text),
      firstAudioMs: fa ? Math.round(fa._t - t) : null,
      replyMs: Math.round(reply._t - t),
      firstTokenMs: met ? (met.replyStartToFirstTokenMs as number) : null,
    };
  }
  close() {
    this.watch?.close();
    this.main?.close();
  }
}

const config = loadConfig();
const logs: Record<string, unknown>[] = [];
const server = await startServer({ ...config, port: 0 }, (event, data) => {
  logs.push({ t: Math.round(performance.now()), event, ...data });
  if (event.startsWith("watch.") && !["watch.asr.status", "watch.open", "watch.close"].includes(event)) console.log(event, JSON.stringify(data).slice(0, 220));
});
const addr = server.address();
const url = `ws://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 8787}`;

async function judge(truth: string, q: string, a: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try {
      const g = await sparkText(config.metaKey, {
        input: `Scene ground truth: ${truth}\nQuestion: ${q}\nAnswer given: ${a}\nIs the answer correct according to the ground truth? Reply only YES or NO.`,
        effort: "low",
      });
      return g.toUpperCase().includes("YES");
    } catch {
      await sleep(2000);
    }
  }
  return false;
}

const result: Record<string, unknown> = {};

if (T5) {
  const t5 = JSON.parse(readFileSync(join(T5, "t5.json"), "utf8")) as Record<string, { title: string; prompt: string; qa: { q: string; correct: boolean; sec: number }[] }>;
  const only = args.find((a) => a.startsWith("--clips="))?.slice(8).split(",");
  const rows: Record<string, unknown>[] = [];
  for (const key of Object.keys(t5).sort()) {
    if (only && !only.includes(key)) continue;
    const clip = t5[key];
    const media = prepare(join(T5, "t5", `${key}.mp4`));
    const call = new Call(url);
    await call.open();
    call.watch.send(JSON.stringify({ type: "start", source: "YouTube" }));
    console.log(`\n▶ ${key} ${clip.title} (${media.durationSec.toFixed(1)} s, ${media.frames.length} frames)`);
    await call.play(media);
    await sleep(1500);
    for (const { q, correct: t5correct } of clip.qa) {
      const r = await call.ask(q);
      const ok = await judge(clip.prompt, q, r.a);
      rows.push({ clip: key, q, ...r, correct: ok, t5correct });
      console.log(`${ok ? "✓" : "✗"} ${(r.firstAudioMs ?? 0) / 1000}s  ${q} → ${r.a}`);
    }
    const reactions = call.wev.filter((e) => e.type === "reaction").length;
    rows.push({ clip: key, reactions });
    call.close();
    await sleep(500);
  }
  const qa = rows.filter((r) => "q" in r) as { clip: string; correct: boolean; t5correct: boolean; firstAudioMs: number | null; replyMs: number; firstTokenMs: number | null }[];
  const fa = qa.map((r) => r.firstAudioMs).filter((x): x is number => x !== null);
  result.qa = {
    correct: qa.filter((r) => r.correct).length,
    total: qa.length,
    t5BaselineCorrect: qa.filter((r) => r.t5correct).length,
    perClip: Object.fromEntries([...new Set(qa.map((r) => r.clip))].map((c) => [c, `${qa.filter((r) => r.clip === c && r.correct).length}/${qa.filter((r) => r.clip === c).length}`])),
    firstAudioP50Ms: median(fa),
    firstAudioMaxMs: Math.max(...fa),
    firstTokenP50Ms: median(qa.map((r) => r.firstTokenMs ?? NaN).filter((x) => !Number.isNaN(x))),
    replyP50Ms: median(qa.map((r) => r.replyMs)),
    rows,
  };
}

if (args.includes("--react")) {
  const files = args.slice(args.indexOf("--react") + 1).filter((a) => !a.startsWith("--"));
  const call = new Call(url);
  await call.open();
  call.watch.send(JSON.stringify({ type: "start", source: "YouTube" }));
  const t0 = performance.now();
  let total = 0;
  for (const f of files) {
    const m = prepare(f);
    total += m.durationSec;
    console.log(`\n▶ ${f} (${m.durationSec.toFixed(1)} s)`);
    await call.play(m);
  }
  await sleep(3000);
  const reacts = call.wev.filter((e) => e.type === "reaction");
  const times = reacts.map((e) => (e._t - t0) / 1000);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const lines = logs.filter((l) => l.event === "watch.line").length;
  const spoken = call.ev.filter((e) => e.type === "reply").map((e) => e.text);
  result.react = {
    shareSec: Math.round(total),
    reactions: reacts.length,
    perFiveMin: +((reacts.length / total) * 300).toFixed(1),
    atSec: times.map((t) => +t.toFixed(1)),
    minGapSec: gaps.length ? +Math.min(...gaps).toFixed(1) : null,
    gapViolations: gaps.filter((g) => g < 30).length,
    laughEmotion: call.ev.filter((e) => e.type === "speaking" && e.emotion === "laugh").length,
    spoken,
    dialogueLines: lines,
    memos: logs.filter((l) => l.event === "watch.memo").length,
    blocked: logs.filter((l) => l.event === "watch.react.blocked").map((l) => l.why),
  };
  call.close();
}

if (args.includes("--blank")) {
  const call = new Call(url);
  await call.open();
  call.watch.send(JSON.stringify({ type: "start", source: "Netflix" }));
  const black = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=1024x576:d=1", "-frames:v", "1", "-f", "mjpeg", "-"], { maxBuffer: 8 << 20 }).stdout;
  for (let i = 0; i < 3; i++) {
    call.watch.send(JSON.stringify({ type: "frame", image: black.toString("base64"), blank: true }));
    await sleep(1000);
  }
  // the companion says once that the window shows up black (MS-3)
  const said = await call.wait((e) => e.type === "reply", 0, 15_000).catch(() => null);
  if (said) call.main.send(JSON.stringify({ type: "playback_done", utteranceId: said.utteranceId }));
  await sleep(500);
  const qs = ["What's on my screen right now?", "Who is that guy?", "Do you like this scene?", "What color is her dress?", "Can you see the subtitles?"];
  const rows = [];
  for (const q of qs) {
    const r = await call.ask(q);
    const claims = await sparkText(config.metaKey, {
      input: `A friend was told the shared screen shows up black and they cannot see it. Asked "${q}", they answered: "${r.a}". Does the answer claim to see or describe something specific on the screen (anything beyond saying it is black or that they can't see)? Reply only YES or NO.`,
      effort: "low",
    });
    rows.push({ q, a: r.a, claimsToSee: claims.toUpperCase().includes("YES"), firstAudioMs: r.firstAudioMs });
    console.log(q, "→", r.a);
  }
  result.blank = {
    spokeOnce: said ? String(said.text) : null,
    claimsToSee: rows.filter((r) => r.claimsToSee).length,
    total: rows.length,
    stateBlank: call.wev.some((e) => e.type === "state" && e.blank === true),
    rows,
  };
  call.close();
}

const file = join(outDir, `watch-sim-${Date.now()}.json`);
writeFileSync(file, JSON.stringify({ result, logs }, null, 1));
const { rows: _r, ...qaSummary } = (result.qa ?? {}) as Record<string, unknown>;
console.log("\nRESULT", JSON.stringify({ qa: result.qa ? qaSummary : undefined, react: result.react, blank: result.blank && { ...(result.blank as object), rows: undefined } }, null, 1));
console.log("saved", file);
server.close();
process.exit(0);
