/** `npm run local` / `npm run dev:local`: one Meta key, no cloud accounts. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyLocalDefaults, loadLocalEnv } from "../src/localMode.ts";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  const env = applyLocalDefaults(loadLocalEnv(process.env, serverRoot), serverRoot);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

// The standard entry point already migrates DATABASE_URL before it starts listening.
await import("../src/main.ts");
console.log([
  "Genita local mode",
  `  HTTP: http://127.0.0.1:${process.env.PORT}`,
  `  WebSocket: ws://127.0.0.1:${process.env.PORT}/v1/session`,
  `  Data: ${process.env.GENITA_DATA_DIR}`,
  "  Sign in with email: the code is printed here",
  process.env.GENITA_VOICE_URL && process.env.GENITA_VOICE_TOKEN
    ? "  Voice: your configured Meta GPU"
    : "  Voice: device voice (no GPU configured)",
].join("\n"));
