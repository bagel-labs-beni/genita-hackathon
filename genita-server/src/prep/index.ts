/**
 * Onboarding prep wiring. server.ts calls createPrep() once and forwards
 * matching HTTP requests to `routes`. Env (all optional):
 *   GENITA_KLING=1             earlier pipeline: fal gpt-image-2 scene fallback + Kling clips + lips step (needs FAL_KEY).
 *                              Off (default): scene → face set, Meta APIs only; FAL_KEY is not read.
 *   GENITA_PETER=1             Peter avatar cache bake + session lip "peter" for humans (needs the two below)
 *   GENITA_SERVER_TTS=1        ElevenLabs voices + previews. Off (default): device voice descriptors
 *   FAL_KEY                    Kling 3.0 + gpt-image-2 fallback + CDN upload (GENITA_KLING=1 only)
 *   GENITA_DATA_DIR            file store root (default ~/.genita-data) when DATABASE_URL is unset;
 *                              with DATABASE_URL, server.ts passes the Postgres store (src/prep/pgStore.ts)
 *   GENITA_VOICES              "id:Name:Blurb,…" to override the four ElevenLabs V04 voices
 *   GENITA_PETER_PREPARE_URL   Modal Peter prepare API (deploy/modal-peter `api`), e.g. https://<ws>--genita-peter-api.modal.run
 *   GENITA_PETER_TOKEN         bearer for it (= the worker's WORKER_TOKEN); falls back to GENITA_PETER_WORKER_TOKEN
 *
 * The flags are read from env here until Config carries them (unit S adds
 * Config.{serverTts,kling,peter}); the meanings are the same.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { FileStore, type PrepStore } from "./store.ts";
import { PrepRunner } from "./runner.ts";
import { createPrepRoutes, type PrepRoutes } from "./routes.ts";
import { ModalPeterBaker, MouthAtlasBaker } from "./lips.ts";
import { DEVICE_VOICES, voicesFromEnv } from "./voices.ts";
import type { PrepDeps, PrepLog } from "./pipeline.ts";

export type Prep = { routes: PrepRoutes; runner: PrepRunner; deps: PrepDeps };

export function createPrep(config: Config, log: PrepLog, env: NodeJS.ProcessEnv = process.env, store?: PrepStore): Prep {
  const kling = env.GENITA_KLING === "1";
  const peter = env.GENITA_PETER === "1";
  const serverTts = env.GENITA_SERVER_TTS === "1";
  const deps: PrepDeps = {
    metaKey: config.metaKey,
    elevenKey: serverTts ? config.elevenKey || null : null,
    ttsModel: config.ttsModel,
    falKey: kling ? env.FAL_KEY || null : null,
    store: store ?? new FileStore(env.GENITA_DATA_DIR || join(homedir(), ".genita-data")),
    voices: serverTts ? voicesFromEnv(env.GENITA_VOICES) : DEVICE_VOICES,
    log,
    kling,
    peter,
    serverTts,
  };
  const peterBaker = peter ? new ModalPeterBaker(env.GENITA_PETER_PREPARE_URL || null, env.GENITA_PETER_TOKEN || env.GENITA_PETER_WORKER_TOKEN || null) : new ModalPeterBaker(null);
  const runner = new PrepRunner(deps, { peter: peterBaker, atlas: new MouthAtlasBaker() });
  log("prep.pipeline", { pipeline: kling ? "kling" : "meta", peter, serverTts });
  if (!config.paused) void runner.resumeAll().catch((err) => log("prep.resume_failed", { message: String(err).slice(0, 200) }));
  return { routes: createPrepRoutes(deps, runner), runner, deps };
}
