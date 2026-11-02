/** Onboarding prep: Meta scene → face set. */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { FileStore, type PrepStore } from "./store.ts";
import { PrepRunner } from "./runner.ts";
import { createPrepRoutes, type PrepRoutes } from "./routes.ts";
import { DEVICE_VOICES, voicesFromEnv } from "./voices.ts";
import type { PrepDeps, PrepLog } from "./pipeline.ts";
import { Personalize } from "../personalize/service.ts";

export type Prep = { routes: PrepRoutes; runner: PrepRunner; deps: PrepDeps };

export function createPrep(config: Config, log: PrepLog, env: NodeJS.ProcessEnv = process.env, store?: PrepStore): Prep {
  const deps: PrepDeps = {
    metaKey: config.metaKey,
    voice: config.voice,
    store: store ?? new FileStore(env.GENITA_DATA_DIR || join(homedir(), ".genita-data")),
    voices: config.serverTts ? voicesFromEnv(env.GENITA_VOICES) : DEVICE_VOICES,
    log,
  };
  // lane 개인화: HISY story, corrections, first-call asks, call growth (same store; the server hands it to calls)
  deps.personalize = new Personalize({ store: deps.store, metaKey: config.metaKey, log });
  const runner = new PrepRunner(deps);
  void runner.resumeAll().catch((err) => log("prep.resume_failed", { message: String(err).slice(0, 200) }));
  return { routes: createPrepRoutes(deps, runner), runner, deps };
}
