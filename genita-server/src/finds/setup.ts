/**
 * Finds wiring from the environment (kept out of config.ts so the shared
 * Config type does not change):
 *   GENITA_FINDS=0          → no result cards (spoken answers only)
 *   GENITA_FINDS_DIR        → where cards + illustrations are kept (default ./data/finds)
 *   GENITA_FIND_IMAGES=0    → no Muse Image illustrations (cards say nothing about pictures)
 */
import { join } from "node:path";
import { FileFindsStore } from "./store.ts";
import { metaVendors } from "./vendors.ts";
import type { FindsDeps } from "./runner.ts";

export function findsFromEnv(metaKey: string, env: NodeJS.ProcessEnv = process.env): FindsDeps | undefined {
  if (env.GENITA_FINDS === "0") return undefined;
  return {
    vendors: metaVendors(metaKey),
    store: new FileFindsStore(env.GENITA_FINDS_DIR ?? join(process.cwd(), "data/finds")),
    images: env.GENITA_FIND_IMAGES !== "0",
    imageBase: "/v1/finds",
  };
}
