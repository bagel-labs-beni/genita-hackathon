/** Onboarding prep: Meta scene → face set. */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { getOps } from "../ops/limits.ts";
import { FileStore, type PrepStore } from "./store.ts";
import { PrepRunner } from "./runner.ts";
import { createPrepRoutes, type PrepRoutes } from "./routes.ts";
import { DEVICE_VOICES, voicesFromEnv } from "./voices.ts";
import type { PrepDeps, PrepLog } from "./pipeline.ts";
import { Personalize } from "../personalize/service.ts";
import { Insights } from "../insights/service.ts";

export type Prep = { routes: PrepRoutes; runner: PrepRunner; deps: PrepDeps };

export function createPrep(config: Config, log: PrepLog, env: NodeJS.ProcessEnv = process.env, store?: PrepStore): Prep {
  const deps: PrepDeps = {
    metaKey: config.metaKey,
    voice: config.voice,
    store: store ?? new FileStore(env.GENITA_DATA_DIR || join(homedir(), ".genita-data")),
    voices: config.serverTts ? voicesFromEnv(env.GENITA_VOICES) : DEVICE_VOICES,
    log,
    // AWS box: /opt/genita/pyflow (bootstrap.sh); "0" turns the flow step off
    python: env.GENITA_PYFLOW === "0" ? null : env.GENITA_PYFLOW || "python3",
    // photo polish + confirm before prep (11/4); "0" = straight to today's flow
    photoPolish: env.GENITA_PHOTO_POLISH !== "0",
  };
  // lane 개인화: HISY story, corrections, first-call asks, call growth (same store; the server hands it to calls)
  deps.personalize = new Personalize({ store: deps.store, metaKey: config.metaKey, log });
  // SUM insight report (Chelsea 11/4); GENITA_INSIGHTS=0 turns it off (the app keeps the old SUM)
  deps.insights = new Insights({ personalize: deps.personalize, store: deps.store, metaKey: config.metaKey, log, enabled: env.GENITA_INSIGHTS !== "0" });
  const runner = new PrepRunner(deps);
  if (!getOps().isPaused("prep.resume")) void runner.resumeAll().catch((err) => log("prep.resume_failed", { message: String(err).slice(0, 200) }));
  return { routes: createPrepRoutes(deps, runner), runner, deps };
}
