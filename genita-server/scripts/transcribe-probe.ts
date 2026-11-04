/**
 * Live probe for POST /v1/transcribe: starts THIS server locally (loopback, a one-off dev token, the real Meta key)
 * and sends a bundled WAV through it to Muse Voice Transcribe. Prints the text and the latency. Never targets a
 * deployed server: there is no URL option.
 *
 *   set -a; . ~/.config/genita/meta.env; set +a   # MODEL_API_KEY (never printed)
 *   npm run probe:transcribe [-- path/to/clip.wav] [--runs 3]
 *
 * The fixture is macOS `say` → afconvert (16 kHz mono s16): "I actually prefer warm colors."
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";

const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const runs = runsAt >= 0 ? Math.max(1, Number(args[runsAt + 1]) || 1) : 3;
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--runs")
  ?? fileURLToPath(new URL("../test/fixtures/transcribe/warm-colors-16k.wav", import.meta.url));
if (!process.env.MODEL_API_KEY) { console.error("MODEL_API_KEY is not set (source ~/.config/genita/meta.env)"); process.exit(2); }

const token = randomUUID();
// no DATABASE_URL: no accounts, the dev token is the principal; loopback only
const env = { MODEL_API_KEY: process.env.MODEL_API_KEY, GENITA_ASR_LANGUAGES: process.env.GENITA_ASR_LANGUAGES ?? "English,Korean" };
const config = { ...loadConfig(env), host: "127.0.0.1", port: 0, sessionToken: token };
const server = await startServer(config, () => {}, undefined, env, null);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const body = new Uint8Array(readFileSync(file));
const ms: number[] = [];
try {
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = await fetch(base + "/v1/transcribe", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "audio/wav" }, body });
    const took = Math.round(performance.now() - t0);
    const out = (await r.json()) as { text?: string; error?: string; ms?: number };
    ms.push(took);
    console.log(JSON.stringify({ run: i + 1, status: r.status, text: out.text, error: out.error, ms: took }));
    if (i + 1 < runs) await new Promise((res) => setTimeout(res, 7000)); // stays under 10 a minute
  }
  const sorted = [...ms].sort((a, b) => a - b);
  console.log(JSON.stringify({ file: file.split("/").pop(), bytes: body.length, n: ms.length, p50_ms: sorted[Math.floor(sorted.length / 2)], max_ms: sorted.at(-1) }));
} finally {
  server.close();
  setTimeout(() => process.exit(0), 200).unref();
}
