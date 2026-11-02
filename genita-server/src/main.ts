import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
const server = await startServer(config, log);
const addr = server.address();
console.log(`genita-server listening on ${typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : addr} (ws /v1/session)`);
