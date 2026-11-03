/**
 * node --experimental-strip-types scripts/watch-quick-eval.ts [--n=5] [--only=dunk,skate] [--base=<other genita-server dir>] [--out=dir]
 *
 * The quick look's decision alone, without real time (11/4): for each clip in moments.json, the frame pairs the Mac
 * would send around the salient moment (react clips) or anywhere (quiet clips) go to the quick-look prompt n times.
 * Counts: reacted (react clips: should; quiet clips: must not), lines the judge finds invented against the clip's
 * truth, and the call's time to its full JSON. --base runs the same frames through another checkout's prompt too
 * (e.g. origin/main), so a prompt change gets a before/after on identical inputs.
 * Real Spark calls; keys from GENITA_ENV_FILE / ~/.config/genita/meta.env, never printed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sparkStream, sparkText, type SparkRequest } from "../src/meta/spark.ts";

const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const key = process.env.MODEL_API_KEY ?? "";
if (!key) throw new Error("MODEL_API_KEY is not set");

const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const N = Number(arg("n") ?? 5) || 5;
const only = arg("only")?.split(",");
const dir = arg("moments") ?? join(homedir(), "genita-fixtures/genita-watch-moments");
const outDir = arg("out") ?? join(tmpdir(), "genita-watch-quick-eval");
mkdirSync(outDir, { recursive: true });
const FPS = 3;
const LONG = 768;

type Clip = { id: string; file: string; kind: string; salientSec: number; truth: string; expect?: "react" | "quiet" | "optional" };
type Quick = { buildQuickRequest: (q: { companion: { name: string }; frames: string[]; heard: string[] }) => SparkRequest; parseQuick: (raw: string) => { line: string; moment: string } | null };
type F = { at: number; url: string; motion: number };
type Pick = (frames: F[], spikeAt: number | null, lastLookedAt: number) => F[];
const load = async (root: string) => ({
  mod: (await import(pathToFileURL(resolve(root, "src/watch/memo.ts")).href)) as unknown as Quick,
  pick: ((await import(pathToFileURL(resolve(root, "src/watch/watch.ts")).href)) as { quickFrames: Pick }).quickFrames,
});
const variants: { name: string; mod: Quick; pick: Pick }[] = [{ name: "this", ...(await load(".")) }];
const base = arg("base");
if (base) variants.unshift({ name: "base", ...(await load(base)) });
/**
 * --cadence (default): replay the live quick-look cadence on the Mac's frames. A look goes out every LOOK_MS (2 in
 * flight at ~4.2 s each ≈ one per 2.1 s) at 5 phases; each look takes its frames with that checkout's quickFrames()
 * from what arrived since the last look. React clips: the first two looks after the moment, a hit = either reacts.
 * Quiet clips: three looks mid-clip, any reaction is false. --pairs: the old fixed pairs right at the moment.
 */
const PAIRS = args.includes("--pairs");
const LOOK_MS = Number(arg("look-ms") ?? 2100);

/** frames the Mac sends (changed > 0.02 vs the last sent, ≤3 fps), as data URLs with their clip time */
function macFrames(file: string): { t: number; url: string; motion: number }[] {
  const k = `${file.replace(/[^\w]+/g, "_").slice(-70)}_${FPS}fps${LONG}`;
  const fdir = join(outDir, "frames", k);
  if (!existsSync(join(fdir, "0001.jpg"))) {
    mkdirSync(fdir, { recursive: true });
    const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `fps=${FPS},scale='if(gt(iw,ih),min(${LONG},iw),-2)':'if(gt(iw,ih),-2,min(${LONG},ih))'`, "-q:v", "6", join(fdir, "%04d.jpg")]);
    if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr.toString().slice(0, 200)}`);
  }
  const jpgs = readdirSync(fdir).filter((f) => f.endsWith(".jpg")).sort().map((f) => readFileSync(join(fdir, f)));
  const g = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `fps=${FPS},scale=32:18,format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 64 << 20 });
  const px = 32 * 18;
  const out: { t: number; url: string; motion: number }[] = [];
  let last = -1;
  for (let i = 0; i < jpgs.length; i++) {
    let d = 1;
    if (last >= 0 && g.stdout.length >= (i + 1) * px) {
      d = 0;
      for (let p = 0; p < px; p++) d += Math.abs(g.stdout[i * px + p] - g.stdout[last * px + p]);
      d = d / px / 255;
    }
    if (last < 0 || d > 0.02) {
      out.push({ t: i / FPS, url: `data:image/jpeg;base64,${jpgs[i].toString("base64")}`, motion: Math.min(1, +d.toFixed(3)) });
      last = i;
    }
  }
  return out;
}

async function look(mod: Quick, frames: string[]): Promise<{ raw: string; ms: number }> {
  const t = performance.now();
  let raw = "";
  for await (const ev of sparkStream(key, mod.buildQuickRequest({ companion: { name: "Jin" }, frames, heard: [] }), { firstEventTimeoutMs: 8000 })) {
    if (ev.type === "text") raw += ev.delta;
    else if (ev.type === "done" && !raw) raw = ev.text;
  }
  return { raw, ms: Math.round(performance.now() - t) };
}

async function judge(line: string, truth: string): Promise<{ correct: boolean; invented: boolean; why: string }> {
  for (let i = 0; i < 3; i++) {
    try {
      const g = await sparkText(key, {
        input: `A friend watching a video with the user blurted out: "${line}".\nWhat the video shows (ground truth, written by a person who checked it frame by frame): ${truth}\nAnswer as JSON {"correct":bool,"invented":bool,"why":string}: correct = the line fits what is actually happening (the action or moment); invented = it states or names something the ground truth does not support (an invented person, object, event, play, technique, quote or text — e.g. calling a solo dunk an alley-oop). A plain feeling ("whoa", "no way") invents nothing. why = 3 to 10 words.`,
        effort: "low",
      });
      const o = JSON.parse(g.match(/\{[\s\S]*\}/)?.[0] ?? "null") as Record<string, unknown> | null;
      if (o && typeof o.correct === "boolean" && typeof o.invented === "boolean") return { correct: o.correct, invented: o.invented, why: String(o.why ?? "").slice(0, 80) };
    } catch { /* retry */ }
  }
  return { correct: false, invented: false, why: "judge failed", judged: false } as { correct: boolean; invented: boolean; why: string };
}

const spec = JSON.parse(readFileSync(join(dir, "moments.json"), "utf8")) as { clips: Clip[] };
// the quick look stays out of pages (the memo comments on a new page once): a page counts as quiet here
const clips = spec.clips.filter((c) => (!only || only.includes(c.id)) && c.expect !== "optional").map((c) => ((c.expect as string) === "page" ? { ...c, expect: "quiet" as const } : c));
type Job = { clip: Clip; pos: string; frames: string[] };
const rows: Record<string, unknown>[] = [];
const tasks: (() => Promise<void>)[] = [];
const run = async (v: (typeof variants)[number], clip: Clip, pos: string, frames: string[], r: number) => {
  let res: { raw: string; ms: number };
  try { res = await look(v.mod, frames); } catch (err) { rows.push({ variant: v.name, clip: clip.id, pos, run: r, error: String(err).slice(0, 120) }); return null; }
  const q = v.mod.parseQuick(res.raw);
  const verdict = q ? await judge(q.line, clip.truth) : null;
  const seen = (() => { try { return String((JSON.parse(res.raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as { seen?: string }).seen ?? ""); } catch { return ""; } })();
  const row = { variant: v.name, clip: clip.id, expect: clip.expect ?? "react", pos, run: r, ms: res.ms, frames: frames.length, react: !!q, line: q?.line ?? null, seen, ...(verdict ?? {}) };
  return row;
};
for (const clip of clips) {
  const fr = macFrames(clip.file.startsWith("/") ? clip.file : join(dir, clip.file));
  if (PAIRS) {
    const idx = fr.length < 2 ? [] : clip.expect === "quiet"
      ? [Math.floor(fr.length * 0.25), Math.floor(fr.length * 0.5), Math.floor(fr.length * 0.75)].map((i) => Math.max(1, i))
      : (() => { const i = Math.max(1, fr.findIndex((f) => f.t >= clip.salientSec)); return [i, i + 1, i + 2].filter((x) => x < fr.length); })();
    const jobs: Job[] = fr.length < 2 ? [{ clip, pos: "only", frames: fr.map((f) => f.url) }] : idx.map((i) => ({ clip, pos: `t=${fr[i].t.toFixed(2)}`, frames: [fr[i - 1].url, fr[i].url] }));
    for (const v of variants) for (const j of jobs) for (let r = 1; r <= N; r++) tasks.push(async () => { const row = await run(v, clip, j.pos, j.frames, r); if (row) rows.push(row); });
    continue;
  }
  // cadence: N phases spread over one look period
  const all: F[] = fr.map((f) => ({ at: Math.round(f.t * 1000), url: f.url, motion: f.motion }));
  const endMs = all.length ? all.at(-1)!.at + 1000 : 0;
  for (const v of variants) for (let r = 1; r <= N; r++) {
    const phase = Math.round(((r - 1) * LOOK_MS) / N);
    const looks: { L: number; frames: string[] }[] = [];
    let lastLooked = -Infinity;
    for (let L = phase; L <= endMs; L += LOOK_MS) {
      const have = all.filter((f) => f.at <= L);
      if (!have.length) continue;
      const picked = v.pick(have, null, lastLooked);
      lastLooked = picked.at(-1)?.at ?? lastLooked;
      looks.push({ L, frames: picked.map((f) => f.url) });
    }
    const S = clip.salientSec * 1000;
    const chosen = clip.expect === "quiet" ? looks.slice(Math.max(0, Math.floor(looks.length / 2) - 1)).slice(0, 3) : looks.filter((l) => l.L >= S).slice(0, 2);
    tasks.push(async () => {
      const got = [];
      for (const l of chosen) { const row = await run(v, clip, `L=${l.L}`, l.frames, r); if (row) got.push(row); }
      const hit = got.find((g) => g.react);
      rows.push({ variant: v.name, clip: clip.id, expect: clip.expect ?? "react", pos: `phase=${phase}`, run: r, looks: got.length, ms: got.length ? Math.max(...got.map((g) => g.ms)) : 0, frames: got.map((g) => g.frames), react: !!hit, line: hit?.line ?? null, seen: got.map((g) => g.seen).join(" | "), correct: hit ? (hit as { correct?: boolean }).correct : undefined, invented: got.some((g) => (g as { invented?: boolean }).invented), why: got.filter((g) => (g as { invented?: boolean }).invented).map((g) => `${g.line}: ${(g as { why?: string }).why}`).join("; ") });
    });
  }
}

// 4 at a time: the quick look's own concurrency is 2 per call
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => { while (next < tasks.length) await tasks[next++](); }));

const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const summary: Record<string, unknown> = {};
for (const v of variants) {
  const mine = rows.filter((r) => r.variant === v.name && !r.error);
  const react = mine.filter((r) => r.expect === "react");
  const quiet = mine.filter((r) => r.expect === "quiet");
  const said = mine.filter((r) => r.react);
  summary[v.name] = {
    salientReact: `${react.filter((r) => r.react).length}/${react.length}`,
    quietReact: `${quiet.filter((r) => r.react).length}/${quiet.length}`,
    invented: `${said.filter((r) => r.invented).length}/${said.length}`,
    msP50: med(mine.map((r) => r.ms as number)),
    errors: rows.filter((r) => r.variant === v.name && r.error).length,
    // a judge that failed 3 times is not "nothing invented" (Codex #542 P2)
    judgeFailed: said.filter((r) => r.why === "judge failed" || String(r.why ?? "").includes("judge failed")).length,
    byClip: Object.fromEntries(clips.map((c) => {
      const x = mine.filter((r) => r.clip === c.id);
      return [c.id, `${x.filter((r) => r.react).length}/${x.length} react, ${x.filter((r) => r.invented).length} invented`];
    })),
    inventedLines: said.filter((r) => r.invented).map((r) => `${r.clip}: ${r.line} (${r.why})`),
  };
}
const file = join(outDir, `watch-quick-eval-${Date.now()}.json`);
writeFileSync(file, JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 1));
console.log("saved", file);
