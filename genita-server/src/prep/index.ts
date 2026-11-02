/** Onboarding prep: Meta scene → face set, with optional clip generation until #158 integration. */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { FileStore, type PrepStore } from "./store.ts";
import { PrepRunner } from "./runner.ts";
import { createPrepRoutes, type PrepRoutes } from "./routes.ts";
import { DEVICE_VOICES, voicesFromEnv } from "./voices.ts";
import type { PrepDeps, PrepLog } from "./pipeline.ts";

export type Prep = { routes: PrepRoutes; runner: PrepRunner; deps: PrepDeps };

export function createPrep(config: Config, log: PrepLog, env: NodeJS.ProcessEnv = process.env, store?: PrepStore): Prep {
  const deps: PrepDeps = {
    metaKey: config.metaKey,
    voice: config.voice,
    falKey: config.kling ? env.FAL_KEY || null : null,
    store: store ?? new FileStore(env.GENITA_DATA_DIR || join(homedir(), ".genita-data")),
    voices: config.serverTts ? voicesFromEnv(env.GENITA_VOICES) : DEVICE_VOICES,
    log,
    kling: config.kling,
  };
  const runner = new PrepRunner(deps);
  void runner.resumeAll().catch((err) => log("prep.resume_failed", { message: String(err).slice(0, 200) }));
  return { routes: createPrepRoutes(deps, runner), runner, deps };
}
