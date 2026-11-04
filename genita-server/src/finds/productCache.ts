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

const COLOR_WORD = /^(black|white|grey|gray|navy|blue|red|green|pink|purple|yellow|orange|beige|camel|tan|brown|cream|ivory|olive|burgundy|silver|gold|teal|khaki|charcoal|maroon|rust|mustard|lavender|mint|coral|taupe|nude|chocolate|cognac|sand|stone|oatmeal|ecru|wine|plum|lilac|turquoise|copper|bronze|bone|espresso|mocha|cherry|oxblood|indigo|denim)$/;
const SHADE = /^(dark|light|pale|deep|bright|soft|muted|dusty|neon|pastel|off|hot|baby|forest|royal|navy)$/;
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
 * Every thing-to-buy word an ask can name (the finds label list and more): an ask whose words are not all of one
 * kind ("black shoes and a blazer", "… and a belt") is never served from or stored in the cache (Codex #522 r2/r3).
 */
const THING = /\b(jackets?|coats?|blazers?|parkas?|vests?|dress(?:es)?|shirts?|overshirts?|tees?|t-shirts?|tops?|blouses?|sweaters?|cardigans?|hoodies?|skirts?|pants|trousers|jeans|shorts|leggings|suits?|ties?|gowns?|pajamas|swimsuits?|bikinis?|socks|gloves|belts?|hats?|caps?|beanies?|scarf|scarves|watch(?:es)?|sunglasses|glasses|jewelry|rings?|earrings?|necklaces?|bracelets?|wallets?|umbrellas?|perfume|makeup|lipstick|accessor(?:y|ies)|lamps?|chairs?|mugs?|headphones|earbuds|phones?|cases?|laptops?|gifts?|sandals?|slippers?|slides|mules?|clogs?|flip[- ]?flops?|boots?|booties|sneakers?|trainers?|loafers?|heels?|pumps?|flats|ballet|totes?|backpacks?|rucksacks?|bags?|purses?|clutch|crossbody|shoes?|oxfords?|derbys?|footwear)\b/gi;

const kindOfWord = (w: string) => KINDS.find(([, re]) => re.test(w))?.[0] ?? null;

/** The one kind of thing an ask is for ("boots", "sneakers", "shoes" …), or null when it names none, several, or anything else. */
export function categoryOf(text: string): string | null {
  const words = text.match(THING) ?? [];
  if (!words.length) return null;
  const kinds = new Set<string>();
  for (const w of words) {
    const k = kindOfWord(w);
    if (!k) return null;                       // a blazer, a belt, sandals …: not a cached kind
    kinds.add(k);
  }
  const hits = [...kinds];
  if (hits.length === 1) return hits[0];
  // "boots (shoes)": the narrower shoe kind
  return hits.length === 2 && hits.includes("shoes") && hits.every((k) => SHOE_KINDS.has(k)) ? hits.find((k) => k !== "shoes")! : null;
}

/** every product is the kind asked for — named so in its own name ("a shoes ask" takes any shoe); a product of no known kind (a belt) never passes (Codex #522 r3) */
export function cardIsKind(card: FindCard, kind: string): boolean {
  const products = card.products ?? [];
  return products.length > 0 && products.every((p) => {
    const name = p.name.replace(/[-_/]+/g, " ");
    const words = name.match(THING) ?? [];
    if (!words.length) return false;
    const ks = words.map(kindOfWord);
    if (ks.some((k) => !k)) return false;   // "Leather Belt", "Slide Sandal"
    return ks.every((k) => (kind === "shoes" ? SHOE_KINDS.has(k!) : k === kind));
  });
}

/** words a plain "find me <color> <kind>" ask may hold beside its color and kind */
const FILLER = new Set(("a an the some any pair pairs of can could would you me my i i'd id we us find get show see look looking for find need want like love please " +
  "that this these those with go goes going match matches matching to on in it its and or but just new nice good great cute something " +
  "outfit look style wear wearing today tonight now recommend suggest pick picks one ones two three couple few links link send buy shop yeah ok okay so hey also maybe what which " +
  "are is be would should will gonna wanna some more other another them they there here up").split(" "));

/**
 * The ask is nothing but a color and a kind ("Can you find me some dark brown shoes that go with this?"): any other
 * word ("running", "waterproof", "for a wedding") narrows it, so the cache is not used for it (Codex #522 r5).
 */
export function plainAsk(text: string): boolean {
  const words = text.toLowerCase().replace(/[’']/g, "'").match(/[a-z']+/g) ?? [];
  return words.every((w) => FILLER.has(w) || COLOR_WORD.test(w) || SHADE.test(w) || !!kindOfWord(w));
}

/** base color words of an ask ("dark brown" → brown) */
export function colorsOf(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => COLOR_WORD.test(w)))].sort();
}

/** the colors as asked, shades kept ("dark brown", "light brown" are different keys — Codex #522 r3) */
export function colorPhrases(text: string): string[] {
  const w = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const out = new Set<string>();
  w.forEach((x, i) => { if (COLOR_WORD.test(x)) out.add(i > 0 && SHADE.test(w[i - 1]) && w[i - 1] !== x ? `${w[i - 1]} ${x}` : x); });
  return [...out].sort();
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

/** accounts deleted in this process: nothing is cached for them again (a search finishing during DELETE /me) */
const forgotten = new Set<string>();
const ownerOf = (key: string) => key.match(/\|account:([^|]*)\|/)?.[1] ?? null;

/**
 * DELETE /me (Codex #522 r6 P1): this account's cached cards (its taste text is in the key, its chips in the card)
 * and warm-ups go now, and none is stored again.
 */
export function forgetProductCache(owner: string): void {
  const o = owner.toLowerCase();
  forgotten.add(o);
  if (forgotten.size > 10_000) forgotten.delete(forgotten.values().next().value as string);
  for (const k of [...cache.keys()]) if (ownerOf(k) === o) cache.delete(k);
  for (const k of [...warming.keys()]) if (ownerOf(k) === o) warming.delete(k);
}

export function cachePut(key: string, entry: CachedProducts): void {
  if (!entry.card.products?.length) return;
  const o = ownerOf(key);
  if (o !== null && forgotten.has(o)) return;
  // expired cards go on every write, not only when their own key is read again
  const now = Date.now();
  for (const [k, e] of cache) if (now - e.at > PRODUCT_CACHE_TTL_MS) cache.delete(k);
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
  // the product's own name only: a taste chip ("Brown palette") never vouches for a "Black Boot" (Codex P1 #522);
  // shades count as their color, the same rule the search ranks by ("chocolate" fits "dark brown", handover b9-6)
  const asked = colorFamilies(colors.join(" "));
  return products.every((x) => !offColor(x.name, asked));
}

/** For tests. */
export function clearProductCache(): void {
  cache.clear();
  warming.clear();
  forgotten.clear();
}

/** Color words that are the same color to someone asking for it ("dark brown" → a chocolate or espresso boot). */
const COLOR_FAMILY: Record<string, string> = {
  brown: "brown", chocolate: "brown", espresso: "brown", mocha: "brown", cognac: "brown",
  tan: "tan", camel: "tan", beige: "tan", sand: "tan", khaki: "tan", taupe: "tan", oatmeal: "tan", nude: "tan",
  black: "black",
  grey: "grey", gray: "grey", charcoal: "grey", stone: "grey",
  white: "white", ivory: "white", cream: "white", bone: "white", ecru: "white",
  navy: "blue", blue: "blue", indigo: "blue", denim: "blue", teal: "blue", turquoise: "blue",
  red: "red", burgundy: "red", wine: "red", maroon: "red", oxblood: "red", cherry: "red", rust: "red",
  green: "green", olive: "green", mint: "green",
  pink: "pink", coral: "pink", purple: "purple", plum: "purple", lavender: "purple", lilac: "purple",
  yellow: "yellow", mustard: "yellow", orange: "orange", silver: "silver", gold: "gold", copper: "gold", bronze: "gold",
};
export const colorFamilies = (text: string): Set<string> => new Set(colorsOf(text).map((c) => COLOR_FAMILY[c] ?? c));
const GOODS = /^(?:boots?|shoes?|sneakers?|loafers?|sandals?|heels?|flats|mules|jackets?|coats?|blazers?|parkas?|dress(?:es)?|shirts?|overshirts?|tees?|t-shirts?|tops?|sweaters?|cardigans?|hoodies?|skirts?|pants|trousers|jeans|shorts|bags?|totes?|backpacks?|belts?|hats?|caps?|scarf|scarves|watch(?:es)?|wallets?|socks|gloves|ones?)$/;
/**
 * The color the thing to buy is asked in, in the order said: "dark brown boots", "black leather loafers", "another
 * one in brown". Not a color they rule out ("no black ones") or one of what they own ("my brown trench", Codex r1).
 */
export function colorAsks(text: string): string[] {
  const w = text.toLowerCase().match(/[a-z]+(?:-[a-z]+)?/g) ?? [];
  const out: string[] = [];
  w.forEach((x, i) => {
    if (!colorsOf(x).length) return;
    const before = w.slice(Math.max(0, i - 3), i);
    if (before.some((b) => /^(no|not|without|except|than|my|your|his|her|their|our)$/.test(b))) return;
    const after = w.slice(i + 1, i + 4);
    const names = after.some((a) => GOODS.test(a)) || w.slice(Math.max(0, i - 2), i).some((b) => /^(in|colou?r)$/.test(b));
    if (names) out.push(x);
  });
  return out;
}
/** The color asked for: this turn's, else the latest one in the search it refines ("black…", "in brown instead" → brown). */
export function askedColors(question: string, previous?: string): Set<string> {
  const now = colorAsks(question);
  if (now.length) return colorFamilies(now.join(" "));
  const before = colorAsks(previous ?? "");
  return before.length ? colorFamilies(before[before.length - 1]) : new Set();
}
/**
 * FD-02 "color request match 100%" (AU-78): a product whose own name names only other colors than the one asked
 * for ("Black Chelsea Boot" for "dark brown boots"). A name with no color word is not off-color.
 */
export function offColor(name: string, asked: Set<string>): boolean {
  if (!asked.size) return false;
  const has = colorFamilies(name);
  return has.size > 0 && ![...has].some((c) => asked.has(c));
}
