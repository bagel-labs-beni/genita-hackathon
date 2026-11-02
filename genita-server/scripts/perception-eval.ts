/**
 * npm run eval:perception -- [--out=dir] [--people=4] [--repeats=2]
 *
 * PERC-1 (#319) eval, real Meta vendors. Keys come from GENITA_ENV_FILE / ~/.config/genita/meta.env and are never printed.
 *  1. Labeled stills: Muse Image makes webcam-style face close-ups (9 expressions + gaze away/down) for a few
 *     synthetic people, downscaled to 256 px like the app's crop (macOS `sips`). Cached in --out.
 *  2. Reads: the production perceive request (buildPerceiveRequest + parseSample) on each still, `repeats` times →
 *     expression / gaze accuracy and Spark latency p50 / p95.
 *  3. False comments: 5-minute timelines of neutral/focused reads only (real reads, resampled, a normal back-and-forth)
 *     through the production trigger rules → triggers per minute that should all be 0.
 *  4. Conversation sim: a scripted 5-minute call (smile after a joke, a laugh, confusion after an answer, looking away,
 *     tiredness) built from the real reads → expected triggers caught, unexpected ones, and unprompted reactions per minute
 *     through the engine's budget (idle only, none in the first 20 s, ≥ 60 s apart, ≤ 3 per call).
 * Nothing is uploaded beyond the Meta calls; the stills are synthetic.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { metaJson } from "../src/meta/http.ts";
import { sparkStream } from "../src/meta/spark.ts";
import { buildPerceiveRequest, parseSample } from "../src/perception/schema.ts";
import { initialTracker, observe, type Convo } from "../src/perception/rules.ts";
import type { Expression, Gaze, PerceptionSample, TriggerKind } from "../src/perception/types.ts";

const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const KEY = process.env.MODEL_API_KEY;
if (!KEY) throw new Error("MODEL_API_KEY missing");

const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const outDir = arg("out", join(tmpdir(), "genita-perception-eval"));
const PEOPLE = Number(arg("people", "4"));
const REPEATS = Number(arg("repeats", "2"));
mkdirSync(outDir, { recursive: true });

type Label = { id: string; expression: Expression; gaze: Gaze; prompt: string };
const PEOPLE_DESC = [
  "a woman with shoulder-length dark hair",
  "a man with short hair and light stubble",
  "an older woman with gray hair",
  "a young man with curly hair",
  "a man with glasses",
  "a woman with her hair tied back",
].slice(0, PEOPLE);
const LOOKS: { key: string; expression: Expression; gaze: Gaze; how: string }[] = [
  { key: "smile", expression: "smile", gaze: "at_screen", how: "smiling warmly with closed lips, looking straight into the camera" },
  { key: "laugh", expression: "laugh", gaze: "at_screen", how: "laughing out loud, mouth open, eyes crinkled, looking at the camera" },
  { key: "neutral", expression: "neutral", gaze: "at_screen", how: "a relaxed neutral expression, looking straight into the camera" },
  { key: "frown", expression: "frown", gaze: "at_screen", how: "frowning with displeasure, looking at the camera" },
  { key: "surprised", expression: "surprised", gaze: "at_screen", how: "surprised, eyebrows raised, mouth slightly open, looking at the camera" },
  { key: "confused", expression: "confused", gaze: "at_screen", how: "confused and puzzled, brows knit, head slightly tilted, looking at the camera" },
  { key: "tired", expression: "tired", gaze: "at_screen", how: "visibly exhausted, heavy drooping eyelids, mid-yawn, looking at the camera" },
  { key: "sad", expression: "sad", gaze: "at_screen", how: "sad and downcast, corners of the mouth turned down, looking at the camera" },
  { key: "focused", expression: "focused", gaze: "at_screen", how: "calm and attentive, reading something on the screen with relaxed brows, lips closed" },
  { key: "away", expression: "neutral", gaze: "away", how: "neutral expression, head and eyes turned to look far off to the side, not at the camera" },
  { key: "down", expression: "neutral", gaze: "down", how: "neutral expression, looking down at a phone below the camera, eyes lowered" },
];
const labels: (Label & { person: number })[] = PEOPLE_DESC.flatMap((who, p) =>
  LOOKS.map((l) => ({
    id: `p${p}-${l.key}`,
    person: p,
    expression: l.expression,
    gaze: l.gaze,
    prompt: `Photorealistic front-camera video call frame, close-up of the face and shoulders of ${who} at home, ${l.how}. Natural indoor light, slight webcam softness, no text.`,
  })),
);

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

// ───────────── 1. stills ─────────────
async function still(l: Label): Promise<string | null> {
  const small = join(outDir, `${l.id}.jpg`);
  if (existsSync(small)) return small;
  const big = join(outDir, `${l.id}.png`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const d = await metaJson<{ data: { b64_json: string }[] }>(KEY!, "/images/generations", { model: "muse-image-1.0", prompt: l.prompt, size: "1024x1024", response_format: "b64_json", n: 1 });
      writeFileSync(big, Buffer.from(d.data[0].b64_json, "base64"));
      // the app's crop: long side 256 px, JPEG q 0.6
      const r = spawnSync("sips", ["-Z", "256", "-s", "format", "jpeg", "-s", "formatOptions", "60", big, "--out", small], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`sips: ${r.stderr}`);
      spawnSync("rm", ["-f", big]);
      return small;
    } catch (e) {
      console.error(`gen ${l.id} failed: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  return null;
}

// ───────────── 2. reads ─────────────
type Read = { id: string; person: number; label: Expression; gazeLabel: Gaze; sample: PerceptionSample | null; ms: number };
async function readOnce(l: Label & { person: number }, path: string): Promise<Read> {
  const url = `data:image/jpeg;base64,${readFileSync(path).toString("base64")}`;
  const t0 = performance.now();
  let text = "";
  try {
    for await (const ev of sparkStream(KEY!, buildPerceiveRequest(url), { firstEventTimeoutMs: 15_000 })) {
      if (ev.type === "text") text += ev.delta;
      else if (ev.type === "done" && ev.text) text = ev.text;
    }
  } catch (e) {
    console.error(`read ${l.id}: ${(e as Error).message.slice(0, 160)}`);
  }
  return { id: l.id, person: l.person, label: l.expression, gazeLabel: l.gaze, sample: parseSample(text), ms: Math.round(performance.now() - t0) };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
};
const GROUP: Record<Expression, string> = { smile: "positive", laugh: "positive", neutral: "calm", focused: "calm", frown: "negative", sad: "negative", confused: "confused", tired: "tired", surprised: "surprised" };

// seeded RNG so a re-run of the sims on the same reads gives the same numbers
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];

// ───────────── 3/4. timelines ─────────────
type Seg = { from: number; to: number; look: string; convo: (at: number) => Convo; expect?: TriggerKind };
const QUIET: Convo = { companionSpeaking: false, lastReplyEndAt: null, userSpeaking: false, lastUserSpeechAt: null };
/** a normal back-and-forth: companion talks 8 s, user talks 6 s, 4 s pause */
function chat(at: number): Convo {
  const t = at % 18_000;
  const cycle = at - t;
  if (t < 8000) return { companionSpeaking: true, lastReplyEndAt: cycle > 0 ? cycle - 4000 : null, userSpeaking: false, lastUserSpeechAt: cycle > 0 ? cycle - 4000 - 0 : null };
  if (t < 14_000) return { companionSpeaking: false, lastReplyEndAt: cycle + 8000, userSpeaking: true, lastUserSpeechAt: cycle };
  return { companionSpeaking: false, lastReplyEndAt: cycle + 8000, userSpeaking: false, lastUserSpeechAt: cycle + 14_000 };
}
const UNPROMPTED = new Set<TriggerKind>(["looked_away", "looks_tired", "engagement_drop"]);

function simulate(segs: Seg[], reads: Map<string, PerceptionSample[]>, person: number, everyMs = 2500) {
  let t = initialTracker();
  const fired: { kind: TriggerKind; at: number }[] = [];
  const spoken: { kind: TriggerKind; at: number }[] = [];
  for (const seg of segs) {
    for (let at = seg.from; at < seg.to; at += everyMs) {
      const pool = reads.get(`p${person}-${seg.look}`) ?? [];
      if (!pool.length) continue;
      const c = seg.convo(at);
      const r = observe(t, pick(pool), at, c);
      t = r.tracker;
      for (const tr of r.triggers) {
        fired.push({ kind: tr.kind, at });
        // engine budget (conversation-engine DESIGN.md): idle only, none in the first 20 s, ≥ 60 s apart, ≤ 3 per call
        const idle = !c.companionSpeaking && !c.userSpeaking;
        const last = spoken.at(-1)?.at ?? -Infinity;
        if (UNPROMPTED.has(tr.kind) && idle && at >= 20_000 && at - last >= 60_000 && spoken.length < 3) spoken.push({ kind: tr.kind, at });
      }
    }
  }
  return { fired, spoken };
}

async function main() {
  console.log(`out: ${outDir} · people ${PEOPLE} · repeats ${REPEATS}`);
  const t0 = performance.now();
  const paths = await pool(labels, 4, still);
  const ready = labels.map((l, i) => ({ l, path: paths[i] })).filter((x): x is { l: (typeof labels)[number]; path: string } => !!x.path);
  console.log(`stills: ${ready.length}/${labels.length} (${Math.round((performance.now() - t0) / 1000)} s)`);

  const jobs = ready.flatMap((x) => Array.from({ length: REPEATS }, () => x));
  const reads = await pool(jobs, 4, (x) => readOnce(x.l, x.path));
  writeFileSync(join(outDir, "reads.json"), JSON.stringify(reads, null, 1));

  const ok = reads.filter((r) => r.sample);
  const kept = ok.filter((r) => r.sample!.confidence >= 0.6);
  const exprRight = kept.filter((r) => r.sample!.expression === r.label).length;
  const groupRight = kept.filter((r) => GROUP[r.sample!.expression] === GROUP[r.label]).length;
  const gazeRight = ok.filter((r) => r.sample!.gaze === r.gazeLabel).length;
  const ms = reads.map((r) => r.ms);
  const perLabel: Record<string, string> = {};
  for (const look of LOOKS) {
    const rs = kept.filter((r) => r.id.endsWith(`-${look.key}`));
    const hit = rs.filter((r) => (look.key === "away" || look.key === "down" ? r.sample!.gaze === look.gaze : r.sample!.expression === look.expression)).length;
    perLabel[look.key] = `${hit}/${rs.length}`;
  }
  const confusion: Record<string, Record<string, number>> = {};
  for (const r of kept) {
    confusion[r.label] ??= {};
    confusion[r.label][r.sample!.expression] = (confusion[r.label][r.sample!.expression] ?? 0) + 1;
  }

  // pools of real reads per still (low-confidence reads stay in: the rules must drop them)
  const byId = new Map<string, PerceptionSample[]>();
  for (const r of ok) byId.set(r.id, [...(byId.get(r.id) ?? []), r.sample!]);
  // neutral pool for a person = neutral + focused reads
  for (let p = 0; p < PEOPLE; p++) byId.set(`p${p}-calm`, [...(byId.get(`p${p}-neutral`) ?? []), ...(byId.get(`p${p}-focused`) ?? [])]);

  // 3. false comments: 5 min of calm faces in a normal chat, per person
  let falseTriggers = 0;
  let falseSpoken = 0;
  const falseKinds: Record<string, number> = {};
  for (let p = 0; p < PEOPLE; p++) {
    const r = simulate([{ from: 0, to: 300_000, look: "calm", convo: chat }], byId, p);
    falseTriggers += r.fired.length;
    falseSpoken += r.spoken.length;
    for (const f of r.fired) falseKinds[f.kind] = (falseKinds[f.kind] ?? 0) + 1;
  }
  const minutes = PEOPLE * 5;

  // 4. scripted call
  const replyEnded = (end: number) => (_at: number): Convo => ({ ...QUIET, lastReplyEndAt: end, lastUserSpeechAt: end - 10_000 });
  const speakingUntil = (_at: number): Convo => ({ ...QUIET, companionSpeaking: true, lastUserSpeechAt: _at - 6000 });
  const silent = (since: number) => (_at: number): Convo => ({ ...QUIET, lastReplyEndAt: since, lastUserSpeechAt: since - 4000 });
  const script: Seg[] = [
    { from: 0, to: 60_000, look: "calm", convo: chat },
    { from: 60_000, to: 66_000, look: "calm", convo: speakingUntil }, // the joke
    { from: 66_000, to: 70_000, look: "smile", convo: replyEnded(66_000), expect: "smiled_at_reply" },
    { from: 70_000, to: 100_000, look: "calm", convo: chat },
    { from: 100_000, to: 104_000, look: "laugh", convo: silent(90_000), expect: "laughed" },
    { from: 104_000, to: 128_000, look: "calm", convo: chat },
    { from: 128_000, to: 134_000, look: "calm", convo: speakingUntil }, // an answer
    { from: 134_000, to: 139_000, look: "confused", convo: replyEnded(134_000), expect: "looks_confused" },
    { from: 139_000, to: 168_000, look: "calm", convo: chat },
    { from: 168_000, to: 184_000, look: "away", convo: silent(166_000), expect: "looked_away" },
    { from: 184_000, to: 196_000, look: "calm", convo: chat },
    { from: 196_000, to: 216_000, look: "tired", convo: silent(194_000), expect: "looks_tired" },
    { from: 216_000, to: 300_000, look: "calm", convo: chat },
  ];
  const expectedKinds = script.filter((s) => s.expect).map((s) => s.expect!);
  let caught = 0;
  let unexpected = 0;
  let spokenTotal = 0;
  const missed: Record<string, number> = {};
  const extra: Record<string, number> = {};
  let maxPerMinute = 0;
  for (let p = 0; p < PEOPLE; p++) {
    const r = simulate(script, byId, p);
    for (const s of script.filter((x) => x.expect)) {
      // the trigger must come inside its segment (+ up to 2.5 s for the next frame)
      const hit = r.fired.some((f) => f.kind === s.expect && f.at >= s.from && f.at <= s.to + 2500);
      if (hit) caught++;
      else missed[s.expect!] = (missed[s.expect!] ?? 0) + 1;
    }
    for (const f of r.fired) {
      const seg = script.find((s) => f.at >= s.from && f.at < s.to + 2500 && s.expect === f.kind);
      if (!seg) { unexpected++; extra[f.kind] = (extra[f.kind] ?? 0) + 1; }
    }
    spokenTotal += r.spoken.length;
    for (let m = 0; m < 5; m++) maxPerMinute = Math.max(maxPerMinute, r.spoken.filter((s) => s.at >= m * 60_000 && s.at < (m + 1) * 60_000).length);
  }

  const summary = {
    stills: ready.length,
    reads: reads.length,
    parsed: ok.length,
    kept_conf_ge_0_6: kept.length,
    expression_accuracy_strict: `${exprRight}/${kept.length} = ${((100 * exprRight) / Math.max(1, kept.length)).toFixed(1)}%`,
    expression_accuracy_grouped: `${groupRight}/${kept.length} = ${((100 * groupRight) / Math.max(1, kept.length)).toFixed(1)}%`,
    gaze_accuracy: `${gazeRight}/${ok.length} = ${((100 * gazeRight) / Math.max(1, ok.length)).toFixed(1)}%`,
    per_label: perLabel,
    confusion,
    spark_ms: { p50: pct(ms, 50), p95: pct(ms, 95), max: Math.max(...ms), n: ms.length },
    false_comments: { minutes, triggers: falseTriggers, per_min: +(falseTriggers / minutes).toFixed(3), spoken: falseSpoken, kinds: falseKinds },
    conversation_sim: {
      calls: PEOPLE,
      expected: expectedKinds.length * PEOPLE,
      caught,
      missed,
      unexpected,
      unexpected_kinds: extra,
      unprompted_spoken_per_call: +(spokenTotal / PEOPLE).toFixed(2),
      max_unprompted_in_any_minute: maxPerMinute,
    },
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

await main();
