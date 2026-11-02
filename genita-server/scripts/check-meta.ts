/**
 * npm run check:meta -- <image.jpg>
 * One live call per non-realtime client (Spark JSON, SAM 3.1, files upload,
 * Muse Image generation) to prove request shapes. Prints shapes, never keys.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { sparkJson } from "../src/meta/spark.ts";
import { jpegDataUrl, museImageGenerate, samDetect, uploadFile } from "../src/meta/media.ts";
import { fixturePath } from "./fixtures.ts";

const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const img = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? fixturePath("out", "dogf.jpg");
const { metaKey } = loadConfig();
const skipImage = process.argv.includes("--no-image");

async function step(name: string, fn: () => Promise<unknown>) {
  const t0 = performance.now();
  try {
    const out = await fn();
    console.log(`ok   ${name} ${Math.round(performance.now() - t0)}ms`, JSON.stringify(out).slice(0, 240));
  } catch (err) {
    console.log(`FAIL ${name} ${Math.round(performance.now() - t0)}ms`, String(err).slice(0, 300));
    process.exitCode = 1;
  }
}

await step("spark json_schema", () =>
  sparkJson<{ items: string[] }>(metaKey, {
    input: "List three kimchi jjigae ingredients as short lowercase names.",
    schemaName: "items",
    schema: { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"], additionalProperties: false },
  }),
);
const jpg = readFileSync(img);
await step("sam 3.1 boxes", () => samDetect(metaKey, jpegDataUrl(jpg), "the dog's mouth"));
await step("files upload", () => uploadFile(metaKey, jpg, "frame.jpg", "image/jpeg"));
if (!skipImage) await step("muse image generation", async () => (await museImageGenerate(metaKey, "A small red ceramic mug on a wooden table, soft daylight", "1024x1024")).length + " bytes");
