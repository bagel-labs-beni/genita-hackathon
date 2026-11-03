/**
 * npm run check:spark-open [-- --n 5]
 * Live check of Muse Spark Open on Baseten (meta-models/muse-spark-open-1026): the real memory
 * extraction and call-summary requests, n times each, schema-checked. Prints latency p50 and the
 * pass count, never the key. Needs BASETEN_API_KEY (env or GENITA_ENV_FILE / ~/.config/genita/meta.env).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EXTRACTION_SCHEMA } from "../src/memory/extract.ts";
import { SUMMARY_SCHEMA } from "../src/memory/summaries.ts";
import { SPARK_OPEN_MODEL, setLlmLog, sparkOpenJson, sparkOpenKey } from "../src/meta/sparkOpen.ts";

const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const key = sparkOpenKey();
if (!key) { console.log("BASETEN_API_KEY is not set (or GENITA_SPARK_OPEN=0)"); process.exit(1); }
const nArg = process.argv.indexOf("--n");
const n = Math.max(1, Math.min(20, nArg > 0 ? Number(process.argv[nArg + 1]) || 3 : 3));
setLlmLog((event, data) => console.log(JSON.stringify({ event, ...data })));

const turns = [
  { user: "I finally bought the black jacket for Saturday, the white one felt too formal.", assistant: "Nice pick! Black goes with everything." },
  { user: "I'm making kimchi jjigae tonight, I love spicy food.", assistant: "Sounds cozy. Remind me how it turns out?" },
];
const cases = [
  { schemaName: "memoryExtract", schema: EXTRACTION_SCHEMA, maxOutputTokens: 1200, instructions: "Extract durable first-person facts/preferences and concrete recent episodes the USER stated. Short standalone English sentences. keys: 3-6 lowercase words.", input: JSON.stringify({ turns }) },
  { schemaName: "callSummary", schema: SUMMARY_SCHEMA, maxOutputTokens: 1200, instructions: "Summarize this voice call for the companion's own notes. mood \"\" if unclear.", input: JSON.stringify({ turns: turns.map((t) => ({ user: t.user, companion: t.assistant })) }) },
];

console.log(`model ${SPARK_OPEN_MODEL} on Baseten, n=${n} per request`);
for (const c of cases) {
  const ms: number[] = [];
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    try {
      const out = await sparkOpenJson(key, c, AbortSignal.timeout(60_000));
      ok++;
      if (i === 0) console.log(`  sample ${c.schemaName}:`, JSON.stringify(out).slice(0, 300));
    } catch (err) {
      console.log(`  FAIL ${c.schemaName}:`, String(err).slice(0, 200));
    }
    ms.push(Math.round(performance.now() - t0));
  }
  ms.sort((a, b) => a - b);
  console.log(`${c.schemaName}: ${ok}/${n} schema-valid, p50 ${ms[Math.floor(ms.length / 2)]} ms, max ${ms.at(-1)} ms`);
  if (ok < n) process.exitCode = 1;
}
