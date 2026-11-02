/**
 * npm run prep:e2e -- [image] [--emotions=neutral,happy,warm] [--skip-video]
 *
 * Runs the real onboarding prep once, end to end, through the same code the
 * routes use: classify (Spark + SAM) → import (Spark, synthetic sample) →
 * voices (Spark order + one preview) → companion + runner (Muse Image scene →
 * Kling 3.0 silent clips via fal) → prefs → persona card. Prints per-step
 * timings and output URLs; videos stay as URLs (nothing large is downloaded).
 * Costs real money (Kling ~10 s × N clips). Not a loop: one pass, then exit.
 * Data goes to a fresh temp store unless GENITA_DATA_DIR is set.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { FileStore } from "../src/prep/store.ts";
import { PrepRunner, prepView, newPrepState } from "../src/prep/runner.ts";
import { checkImage, importStyle, orderedVoices, savePrefs, voicePreview, type PrepDeps } from "../src/prep/pipeline.ts";
import { ModalPeterBaker, MouthAtlasBaker } from "../src/prep/lips.ts";
import { DEFAULT_VOICES } from "../src/prep/voices.ts";
import { PREP_EMOTIONS, type PrepEmotion } from "../src/prep/prompts.ts";
import type { CompanionRecord } from "../src/prep/store.ts";
import { fixturePath } from "./fixtures.ts";

const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const args = process.argv.slice(2);
const img = args.find((a) => !a.startsWith("--")) ?? fixturePath("out", "img", "p1.jpg");
const config = loadConfig();
const flag = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const emotions = (flag("emotions")?.split(",") ?? [...PREP_EMOTIONS]) as PrepEmotion[];
const skipVideo = args.includes("--skip-video");

const dataDir = process.env.GENITA_DATA_DIR ?? mkdtempSync(join(tmpdir(), "genita-prep-e2e-"));
const events: string[] = [];
const d: PrepDeps = {
  metaKey: config.metaKey,
  elevenKey: config.elevenKey ?? "",
  ttsModel: config.ttsModel,
  falKey: process.env.FAL_KEY || null,
  store: new FileStore(dataDir),
  voices: DEFAULT_VOICES,
  log: (e, data) => events.push(`${e} ${JSON.stringify(data).slice(0, 200)}`),
  // this script exercises the earlier ElevenLabs + Kling pipeline; `npm run face:e2e` is the Meta-only one
  kling: true,
  serverTts: true,
};
const timings: Record<string, number> = {};
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const out = await fn();
  timings[name] = Math.round(performance.now() - t0);
  console.log(`ok  ${name.padEnd(22)} ${String(timings[name]).padStart(7)} ms`);
  return out;
}

const user = "e2e";
console.log(`data dir: ${dataDir}\nimage: ${img}\nemotions: ${skipVideo ? "(skipped)" : emotions.join(",")}\n`);

const rec = await step("1 classify+headbox", () => checkImage(d, user, readFileSync(img), true));
console.log(`    type=${rec.check.type} passed=${rec.check.passed} reasons=${JSON.stringify(rec.check.reasons.map((r) => r.code))} spark=${rec.ms.check}ms sam=${rec.ms.sam}ms headBox=${JSON.stringify(rec.headBox && { nx1: rec.headBox.nx1, ny1: rec.headBox.ny1, nx2: rec.headBox.nx2, ny2: rec.headBox.ny2 })}`);
if (!rec.check.passed || !rec.check.type) throw new Error("image did not pass");

const sample = readFileSync(new URL("../evals/import/samples/chatgpt-synthetic-1.txt", import.meta.url), "utf8");
const style = await step("2 import style card", () => importStyle(d, user, sample));
console.log(`    items=${style.itemCount} partial=${style.partial} rows=${style.display.map((r) => `${r.title}:${r.items.length}`).join(", ")} toConfirm=${style.toConfirm.length}`);

const v = await step("3 voices (spark order)", () => orderedVoices(d, user, rec.check.type));
console.log(`    order=${v.voices.map((x) => x.name).join(" > ")} suggested=${v.suggested}`);
const mp3 = await step("3b voice preview mp3", () => voicePreview(d, v.voices[0].id));
console.log(`    ${v.voices[0].name} preview ${mp3.length} bytes`);

const voice = v.voices[0];
const prep = newPrepState({ kling: true });
if (skipVideo) for (const e of PREP_EMOTIONS) prep.steps.videos[e] = { status: "done", attempts: 0, url: "(skipped)" };
else for (const e of PREP_EMOTIONS) if (!emotions.includes(e)) prep.steps.videos[e] = { status: "done", attempts: 0, url: "(not requested)" };
const companion: CompanionRecord = { id: "e2e" + Date.now(), userId: user, imageId: rec.id, type: rec.check.type, voiceId: voice.id, name: voice.name, createdAt: new Date().toISOString(), prep };
await d.store.putCompanion(companion);

const runner = new PrepRunner(d, { peter: new ModalPeterBaker(null), atlas: new MouthAtlasBaker() });
let lastProgress = "";
runner.events.on("prep.progress", (p) => {
  const s = `${p.done}/${p.total}`;
  if (s !== lastProgress) console.log(`    prep.progress ${s}`);
  lastProgress = s;
});
// persona runs while clips render, like the survey fills the wait in the app
const prepRun = step("4 prep runner total", () => runner.run(user));
const answers = { help: "Think with me", relationship: "Trusted partner", challenge: 4, pace: 4, presence: ["Warm", "Witty"] };
const withPersona = await step("5 prefs → persona", async () => savePrefs(d, (await d.store.getCompanion(user))!, "right", answers));
console.log(`    summary=${JSON.stringify(withPersona.persona!.summary)}\n    card=${JSON.stringify(withPersona.persona!.card).slice(0, 400)}`);
await prepRun;

const final = prepView((await d.store.getCompanion(user))!);
console.log(`\nprep status=${final.status} progress=${final.progress.done}/${final.progress.total} lips=${final.lips.status} (${final.lips.detail})`);
console.log(`scene (${final.sceneSource}, ${final.steps.scene.ms} ms): ${final.sceneUrl}`);
for (const e of PREP_EMOTIONS) console.log(`video ${e.padEnd(7)} (${final.steps.videos[e].ms ?? "-"} ms): ${final.emotionVideos[e] ?? "-"}`);
console.log("\ntimings ms:", JSON.stringify(timings));
console.log("events:\n  " + events.join("\n  "));
