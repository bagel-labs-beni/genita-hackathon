/**
 * Finds wiring from the environment (kept out of config.ts so the shared
 * Config type does not change):
 *   GENITA_FINDS=0          → no result cards (spoken answers only)
 *   GENITA_FINDS_DIR        → where cards + illustrations are kept (default ./data/finds)
 *   GENITA_FIND_IMAGES=0    → no Muse Image illustrations (cards say nothing about pictures)
 *   GENITA_SHOP_REGION      → where product search shops (default "US")
 *   GENITA_PRODUCT_HEDGE    → identical product searches raced, first good one wins (default 2, 1 = off)
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
    shopRegion: /^[A-Za-z .-]{2,40}$/.test(env.GENITA_SHOP_REGION ?? "") ? env.GENITA_SHOP_REGION : "US",
    productHedge: Math.min(3, Math.max(1, Number.parseInt(env.GENITA_PRODUCT_HEDGE ?? "2", 10) || 2)),
  };
}

/** I04 "Likes & dislikes" lines from a style card: facts first, suggestions after. */
export function likesFromStyle(style: { display?: Array<{ key: string; items: Array<{ text: string; label: string }> }> } | null | undefined): string[] | undefined {
  const row = style?.display?.find((r) => r.key === "likes");
  if (!row?.items.length) return undefined;
  return [...row.items.filter((i) => i.label !== "suggested"), ...row.items.filter((i) => i.label === "suggested")].map((i) => i.text);
}
