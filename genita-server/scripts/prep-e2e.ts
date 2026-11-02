/**
 * npm run prep:e2e -- [image]
 * Runs classify, synthetic style import, voice ordering, Meta scene → face set,
 * and prefs → persona once. Calls real Meta APIs; uses a fresh temp store unless
 * GENITA_DATA_DIR is set. Optional Meta voice service supplies a WAV preview.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { FileStore } from "../src/prep/store.ts";
import { PrepRunner, prepView, newPrepState } from "../src/prep/runner.ts";
import { checkImage, importStyle, orderedVoices, savePrefs, voicePreview, type PrepDeps } from "../src/prep/pipeline.ts";
import { DEFAULT_VOICES, DEVICE_VOICES } from "../src/prep/voices.ts";
import type { CompanionRecord } from "../src/prep/store.ts";
import { fixturePath } from "./fixtures.ts";

const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const args = process.argv.slice(2);
const img = args.find((a) => !a.startsWith("--")) ?? fixturePath("out", "img", "p1.jpg");
const config = loadConfig();
const dataDir = process.env.GENITA_DATA_DIR ?? mkdtempSync(join(tmpdir(), "genita-prep-e2e-"));
const events: string[] = [];
const d: PrepDeps = {
  metaKey: config.metaKey,
  voice: config.voice,
  store: new FileStore(dataDir),
  voices: config.voice ? DEFAULT_VOICES : DEVICE_VOICES,
  log: (e, data) => events.push(`${e} ${JSON.stringify(data).slice(0, 200)}`),
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
console.log(`data dir: ${dataDir}\nimage: ${img}\n`);

const rec = await step("1 classify+headbox", () => checkImage(d, user, readFileSync(img), true));
console.log(`    type=${rec.check.type} passed=${rec.check.passed} reasons=${JSON.stringify(rec.check.reasons.map((r) => r.code))} spark=${rec.ms.check}ms sam=${rec.ms.sam}ms headBox=${JSON.stringify(rec.headBox && { nx1: rec.headBox.nx1, ny1: rec.headBox.ny1, nx2: rec.headBox.nx2, ny2: rec.headBox.ny2 })}`);
if (!rec.check.passed || !rec.check.type) throw new Error("image did not pass");

const sample = readFileSync(new URL("../evals/import/samples/chatgpt-synthetic-1.txt", import.meta.url), "utf8");
const style = await step("2 import style card", () => importStyle(d, user, sample));
console.log(`    items=${style.itemCount} partial=${style.partial} rows=${style.display.map((r) => `${r.title}:${r.items.length}`).join(", ")} toConfirm=${style.toConfirm.length}`);

const v = await step("3 voices (spark order)", () => orderedVoices(d, user, rec.check.type));
console.log(`    order=${v.voices.map((x) => x.name).join(" > ")} suggested=${v.suggested}`);
if (config.voice) {
  const wav = await step("3b voice preview WAV", () => voicePreview(d, v.voices[0].id));
  console.log(`    ${v.voices[0].name} preview ${wav.length} bytes`);
}

const voice = v.voices[0];
const prep = newPrepState();
const companion: CompanionRecord = { id: "e2e" + Date.now(), userId: user, imageId: rec.id, type: rec.check.type, voiceId: voice.id, name: voice.name, createdAt: new Date().toISOString(), prep };
await d.store.putCompanion(companion);

const runner = new PrepRunner(d);
let lastProgress = "";
runner.events.on("prep.progress", (p) => {
  const s = `${p.done}/${p.total}`;
  if (s !== lastProgress) console.log(`    prep.progress ${s}`);
  lastProgress = s;
});
// persona runs while face images render, like the survey fills the wait in the app
const prepRun = step("4 prep runner total", () => runner.run(user));
const answers = { help: "Think with me", relationship: "Trusted partner", challenge: 4, pace: 4, presence: ["Warm", "Witty"] };
const withPersona = await step("5 prefs → persona", async () => savePrefs(d, (await d.store.getCompanion(user))!, "right", answers));
console.log(`    summary=${JSON.stringify(withPersona.persona!.summary)}\n    card=${JSON.stringify(withPersona.persona!.card).slice(0, 400)}`);
await prepRun;

const final = prepView((await d.store.getCompanion(user))!);
console.log(`\nprep status=${final.status} progress=${final.progress.done}/${final.progress.total} lips=${final.lips.status} (${final.lips.detail})`);
console.log(`scene (${final.sceneSource}, ${final.steps.scene.ms} ms): ${final.sceneUrl}`);
console.log(`face images: ${Object.keys(final.face?.visemes ?? {}).length} visemes`);
console.log("\ntimings ms:", JSON.stringify(timings));
console.log("events:\n  " + events.join("\n  "));
