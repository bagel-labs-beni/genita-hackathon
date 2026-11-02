/**
 * Onboarding prep wiring. server.ts calls createPrep() once and forwards
 * matching HTTP requests to `routes`. Env (all optional except FAL_KEY for
 * clip generation):
 *   FAL_KEY                    Kling 3.0 + gpt-image-2 fallback + CDN upload
 *   GENITA_DATA_DIR            file store root (default ~/.genita-data) when DATABASE_URL is unset;
 *                              with DATABASE_URL, server.ts passes the Postgres store (src/prep/pgStore.ts)
 *   GENITA_VOICES              "id:Name:Blurb,…" to override the four V04 voices
 *   GENITA_PETER_PREPARE_URL   Modal Peter prepare API (deploy/modal-peter `api`), e.g. https://<ws>--genita-peter-api.modal.run
 *   GENITA_PETER_TOKEN         bearer for it (= the worker's WORKER_TOKEN); falls back to GENITA_PETER_WORKER_TOKEN
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { FileStore, type PrepStore } from "./store.ts";
import { PrepRunner } from "./runner.ts";
import { createPrepRoutes, type PrepRoutes } from "./routes.ts";
import { ModalPeterBaker, MouthAtlasBaker } from "./lips.ts";
import { voicesFromEnv } from "./voices.ts";
import type { PrepDeps, PrepLog } from "./pipeline.ts";

export type Prep = { routes: PrepRoutes; runner: PrepRunner; deps: PrepDeps };

export function createPrep(config: Config, log: PrepLog, env: NodeJS.ProcessEnv = process.env, store?: PrepStore): Prep {
  const deps: PrepDeps = {
    metaKey: config.metaKey,
    elevenKey: config.elevenKey,
    ttsModel: config.ttsModel,
    falKey: env.FAL_KEY || null,
    store: store ?? new FileStore(env.GENITA_DATA_DIR || join(homedir(), ".genita-data")),
    voices: voicesFromEnv(env.GENITA_VOICES),
    log,
  };
  const runner = new PrepRunner(deps, { peter: new ModalPeterBaker(env.GENITA_PETER_PREPARE_URL || null, env.GENITA_PETER_TOKEN || env.GENITA_PETER_WORKER_TOKEN || null), atlas: new MouthAtlasBaker() });
  void runner.resumeAll().catch((err) => log("prep.resume_failed", { message: String(err).slice(0, 200) }));
  return { routes: createPrepRoutes(deps, runner), runner, deps };
}
