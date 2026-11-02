/**
 * npm run face:e2e -- <photo> <outDir>
 *
 * Meta-only prep, end to end, with the real Meta API and the same code the
 * routes use: image check (Spark + SAM) → scene (Muse Image) → face set
 * (Muse Image expressions + visemes, SAM drift check). No fal, Kling, Peter
 * or ElevenLabs. Writes the face set to <outDir>: neutral/blink/smile/warm and
 * the visemes as image files + manifest.json (file names instead of URLs, plus
 * timings). Costs 14–30 Muse Image edits. One pass, then exit.
 *
 * Key: MODEL_API_KEY from the env or ~/.config/genita/meta.env (never printed).
 * Data goes to a fresh temp store unless GENITA_DATA_DIR is set.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, type CompanionRecord } from "../src/prep/store.ts";
import { PrepRunner, newPrepState } from "../src/prep/runner.ts";
import { checkImage, type PrepDeps } from "../src/prep/pipeline.ts";
import { DEVICE_VOICES } from "../src/prep/voices.ts";
import { faceManifest } from "../src/prep/face.ts";
import { sniffImage } from "../src/prep/classify.ts";

const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
if (!process.env.MODEL_API_KEY && existsSync(envFile)) process.loadEnvFile(envFile);
const metaKey = process.env.MODEL_API_KEY;
if (!metaKey) throw new Error("MODEL_API_KEY is not set");
const [photo, outDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!photo || !outDir) throw new Error("usage: npm run face:e2e -- <photo> <outDir>");

const dataDir = process.env.GENITA_DATA_DIR ?? mkdtempSync(join(tmpdir(), "genita-face-e2e-"));
const t0 = performance.now();
const at = () => `${((performance.now() - t0) / 1000).toFixed(1).padStart(6)} s`;
const d: PrepDeps = {
  metaKey,
  falKey: null,
  store: new FileStore(dataDir),
  voices: DEVICE_VOICES,
  log: (e, data) => {
    if (e === "face.edit_rejected" || e === "scene.done" || e === "face.done" || e === "prep.attempt_failed") console.log(`${at()}  ${e} ${JSON.stringify(data).slice(0, 240)}`);
  },
};
console.log(`photo: ${photo}\nout:   ${outDir}\ndata:  ${dataDir}\n`);

const user = "e2e";
const rec = await checkImage(d, user, readFileSync(photo), true);
const checkMs = Math.round(performance.now() - t0);
console.log(`${at()}  check type=${rec.check.type} passed=${rec.check.passed} spark=${rec.ms.check}ms sam=${rec.ms.sam}ms`);
if (!rec.check.passed || !rec.check.type) throw new Error(`image did not pass: ${rec.check.reasons.map((r) => r.code).join(",")}`);

const companion: CompanionRecord = { id: `e2e${Date.now()}`, userId: user, imageId: rec.id, type: rec.check.type, voiceId: DEVICE_VOICES[0].id, name: "E2E", createdAt: new Date().toISOString(), prep: newPrepState() };
await d.store.putCompanion(companion);
const runner = new PrepRunner(d);
let last = "";
runner.events.on("prep.progress", (p) => {
  const s = `${p.done}/${p.total}`;
  if (s !== last) console.log(`${at()}  progress ${s}`);
  last = s;
});
await runner.run(user);
const totalMs = Math.round(performance.now() - t0);

const c = (await d.store.getCompanion(user))!;
const face = c.prep.steps.face?.face;
if (c.prep.status !== "ready" || !face) throw new Error(`prep ${c.prep.status}: ${c.prep.steps.face?.error ?? c.prep.steps.scene.error ?? ""}`);

mkdirSync(outDir, { recursive: true });
const ext = (b: Buffer) => ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" })[sniffImage(b) ?? "image/png"] ?? "bin";
const files: Record<string, string> = {};
for (const key of ["neutral", ...Object.keys(face.items)]) {
  const b = await d.store.getAsset(c.userId, c.id, key);
  if (!b || (key !== "neutral" && face.items[key as keyof typeof face.items]?.status !== "done")) continue;
  files[key] = `${key}.${ext(b)}`;
  writeFileSync(join(outDir, files[key]), b);
}
const manifest = faceManifest(face, (k) => files[k]);
const timing = {
  type: c.type,
  photoToFaceReadyMs: totalMs,
  checkMs,
  sceneMs: c.prep.steps.scene.ms ?? null,
  faceMs: face.ms,
  attempts: c.prep.attempts,
  edits: Object.keys(face.items).length,
  rejected: manifest.rejected.length,
  passedOnRetry: Object.values(face.items).filter((i) => i?.status === "done" && i.retried).length,
};
writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ ...manifest, e2e: timing }, null, 1));
console.log(`\n${JSON.stringify(timing)}\nrejected: ${JSON.stringify(manifest.rejected)}\nwrote ${Object.keys(files).length} images + manifest.json`);
