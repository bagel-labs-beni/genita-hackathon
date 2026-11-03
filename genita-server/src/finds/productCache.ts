/**
 * S5 without waiting on a web search (11/4, QA build 6: card p50 ~14 s, Spark's search alone 15–23 s).
 *
 * A finished product card is kept in memory under (category, colors asked, the account's taste text). The same
 * ask with the same taste — the same person again, or a demo account with the identical import — gets that card
 * at once; a fresh search runs behind it and refreshes the cache. Calls also warm the cache in the background
 * (shoes in each color the account likes, once per taste per TTL), so the first ask of a call can hit it.
 *
 * Only public product pages travel between accounts, and only between identical taste texts; the situation
 * line and chips (what someone said in their call) are cleared on reuse. Pictures are copied server-side.
 */
import type { FindCard } from "../protocol.ts";

export const PRODUCT_CACHE_TTL_MS = 6 * 60 * 60_000;
const MAX_ENTRIES = 300;

export type CachedProducts = {
  at: number;
  card: FindCard;
  /** where the card's pictures live: the find they were stored under, or bytes kept in memory (a warm search) */
  sourceFindId?: string;
  images?: Map<string, Buffer>;
};

const COLOR_WORD = /^(black|white|grey|gray|navy|blue|red|green|pink|purple|yellow|orange|beige|camel|tan|brown|cream|ivory|olive|burgundy|silver|gold)$/;
const KINDS: Array<[string, RegExp]> = [
  ["boots", /\b(boots?|booties)\b/i],
  ["sneakers", /\b(sneakers?|trainers?)\b/i],
  ["loafers", /\b(loafers?)\b/i],
  ["heels", /\b(heels?|pumps?)\b/i],
  ["flats", /\b(flats|ballet)\b/i],
  ["totes", /\b(totes?)\b/i],
  ["backpacks", /\b(backpacks?|rucksacks?)\b/i],
  ["bags", /\b(bags?|purses?|clutch|crossbody)\b/i],
  ["shoes", /\b(shoes?|oxfords?|derbys?|footwear)\b/i],
];
const SHOE_KINDS = new Set(["boots", "sneakers", "loafers", "heels", "flats", "shoes"]);

/**
 * The one kind of thing an ask is for ("boots", "sneakers", "shoes" …), or null when it names none or several
 * ("black shoes and a bag" is never served from or stored in the cache — Codex P1 #522).
 */
/** anything else to buy named in the ask (a belt, a jacket …): then the ask is more than one kind */
const OTHER_THINGS = /\b(belts?|jackets?|coats?|scarf|scarves|hats?|caps?|watch(?:es)?|sunglasses|jewelry|earrings?|necklaces?|bracelets?|wallets?|socks|gloves|dress(?:es)?|shirts?|pants|jeans|sweaters?|hoodies?|skirts?|accessor(?:y|ies)|lamps?|chairs?|mugs?|headphones|earbuds)\b/i;

export function categoryOf(text: string): string | null {
  if (OTHER_THINGS.test(text)) return null;
  const hits = KINDS.filter(([, re]) => re.test(text)).map(([k]) => k);
  if (hits.length !== 1) return hits.length === 2 && hits.includes("shoes") && hits.every((k) => SHOE_KINDS.has(k)) ? hits.find((k) => k !== "shoes")! : null;
  return hits[0];
}

/** every product is the kind asked for: a "shoes" ask takes any shoe, "boots" only boots, never a bag */
export function cardIsKind(card: FindCard, kind: string): boolean {
  const products = card.products ?? [];
  return products.length > 0 && products.every((p) => {
    const k = KINDS.find(([, re]) => re.test(p.name))?.[0];
    if (!k) return kind !== "bags" ? SHOE_KINDS.has(kind) && kind === "shoes" : false;
    return kind === "shoes" ? SHOE_KINDS.has(k) : k === kind;
  });
}

/** base color words of an ask ("dark brown" → brown) */
export function colorsOf(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => COLOR_WORD.test(w)))].sort();
}

const tasteKey = (taste: string) => taste.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 2000);

export function cacheKey(category: string, colors: string[], taste: string): string {
  return `${category}|${[...colors].sort().join(",")}|${tasteKey(taste)}`;
}

const cache = new Map<string, CachedProducts>();
/** warm searches running or done per key, so parallel calls don't start the same one */
const warming = new Map<string, number>();

export function cacheGet(key: string, now: number): CachedProducts | null {
  const e = cache.get(key);
  if (!e) return null;
  if (now - e.at > PRODUCT_CACHE_TTL_MS) { cache.delete(key); return null; }
  return e;
}

export function cachePut(key: string, entry: CachedProducts): void {
  if (!entry.card.products?.length) return;
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
}

/** true when this warm search should start now (none ran for this key within the TTL) */
export function claimWarm(key: string, now: number): boolean {
  const at = warming.get(key);
  if (at !== undefined && now - at < PRODUCT_CACHE_TTL_MS) return false;
  if (warming.size > MAX_ENTRIES) warming.clear();
  warming.set(key, now);
  return true;
}

export function releaseWarm(key: string): void {
  warming.delete(key);
}

/**
 * No product of the card names a color other than the asked ones (name or chips). A cached card was found by a
 * search for exactly these colors (the key holds them), so a plain "Chelsea Boot" stands; a "Black Chelsea Boot"
 * never answers "dark brown" (prod 11/3 13:00).
 */
export function cardFitsColors(card: FindCard, colors: string[]): boolean {
  const products = card.products ?? [];
  if (!products.length) return false;
  if (!colors.length) return true;
  // the product's own name only: a taste chip ("Brown palette") never vouches for a "Black Boot" (Codex P1 #522)
  return products.every((x) => {
    const w = colorsOf(x.name);
    return !w.length || w.some((c) => colors.includes(c));
  });
}

/** For tests. */
export function clearProductCache(): void {
  cache.clear();
  warming.clear();
}
