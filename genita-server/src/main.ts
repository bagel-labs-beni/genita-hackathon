import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { defaultDeps, startServer } from "./server.ts";

const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
const deps = defaultDeps(config, log);
const server = await startServer(config, log, deps);
// 11/4: the cold-GPU lines for the curated voices (loaded from disk, or rendered once the GPU answers; quiet)
deps.voiceWarm?.();
const addr = server.address();
console.log(`genita-server listening on ${typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : addr} (ws /v1/session)`);
