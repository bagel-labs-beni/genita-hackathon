/**
 * Onboarding prep wiring. server.ts calls createPrep() once and forwards
 * matching HTTP requests to `routes`. Env (all optional except FAL_KEY for
 * clip generation):
 *   FAL_KEY                    Kling 3.0 + CDN upload (pending #158)
 *   GENITA_DATA_DIR            file store root (default ~/.genita-data) when DATABASE_URL is unset;
 *                              with DATABASE_URL, server.ts passes the Postgres store (src/prep/pgStore.ts)
 *   GENITA_VOICES              "id:Name:Blurb,…" to override the four V04 voices
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { FileStore, type PrepStore } from "./store.ts";
import { PrepRunner } from "./runner.ts";
import { createPrepRoutes, type PrepRoutes } from "./routes.ts";
import { voicesFromEnv } from "./voices.ts";
import type { PrepDeps, PrepLog } from "./pipeline.ts";

export type Prep = { routes: PrepRoutes; runner: PrepRunner; deps: PrepDeps };

export function createPrep(config: Config, log: PrepLog, env: NodeJS.ProcessEnv = process.env, store?: PrepStore): Prep {
  const deps: PrepDeps = {
    metaKey: config.metaKey,
    voice: config.voice,
    falKey: config.kling ? env.FAL_KEY || null : null,
    store: store ?? new FileStore(env.GENITA_DATA_DIR || join(homedir(), ".genita-data")),
    voices: voicesFromEnv(env.GENITA_VOICES),
    log,
  };
  const runner = new PrepRunner(deps);
  void runner.resumeAll().catch((err) => log("prep.resume_failed", { message: String(err).slice(0, 200) }));
  return { routes: createPrepRoutes(deps, runner), runner, deps };
}
