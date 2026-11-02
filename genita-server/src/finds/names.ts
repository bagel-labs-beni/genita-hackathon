/**
 * Ingredient names: clean what Spark or a web recipe gives us, and decide
 * when two names are the same thing (PRD 22: "green onion" in the fridge
 * absorbs the recipe's "onion"; that one merge removed the only invented
 * item in the 11/1 run). Pure.
 */

const SYNONYMS: Record<string, string> = {
  scallion: "green onion",
  "spring onion": "green onion",
  "welsh onion": "green onion",
  대파: "green onion",
  파: "green onion",
  쪽파: "green onion",
  "steamed rice": "cooked rice",
  "white rice": "cooked rice",
  "leftover rice": "cooked rice",
  "day-old rice": "cooked rice",
  밥: "cooked rice",
  김치: "kimchi",
  두부: "tofu",
  계란: "egg",
  달걀: "egg",
  우유: "milk",
  "bean curd": "tofu",
  "whole milk": "milk",
  "chicken egg": "egg",
};

/** Pantry basics a fridge card should not ask you to buy. */
const STAPLES = new Set([
  "salt",
  "pepper",
  "black pepper",
  "water",
  "ice",
  "sugar",
  "oil",
  "vegetable oil",
  "neutral oil",
  "cooking oil",
  "canola oil",
]);

/** A longer name with one of these in front is a different ingredient, not a kind of the shorter one. */
const DIFFERENT_THING = new Set(["coconut", "almond", "oat", "soy", "fish", "oyster", "peanut", "chili", "hot", "rice", "corn", "baking", "sweet"]);

const DESCRIPTORS =
  /\b(fresh|large|small|medium|chopped|diced|minced|sliced|thinly|finely|roughly|cubed|crushed|grated|shredded|beaten|optional|to taste|for garnish|extra[- ]firm|firm|soft|silken|packed|ripe|leftover|day[- ]old|cold|whole)\b/g;
const UNITS = /^(\d+[\d/.\s-]*|a|an|one|two|three|some)?\s*(cups?|tbsp|tsp|tablespoons?|teaspoons?|g|kg|ml|l|oz|lbs?|pounds?|cloves?|pieces?|slices?|stalks?|bunch(es)?|cans?|packs?|pinch(es)?|handfuls?|of)?\s+/i;

function singular(w: string): string {
  if (w.length <= 3 || /ss$|us$|is$/.test(w)) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + "y";
  if (/(tomato|potato)es$/.test(w)) return w.slice(0, -2);
  if (/(ch|sh|x)es$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Short lowercase display name: "1 cup diced kimchi" → "kimchi", "Eggs" → "eggs". */
export function cleanName(raw: string): string {
  let s = raw.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[,;:].*$/, " ").replace(/[*_"“”]/g, " ");
  s = s.replace(UNITS, " ");
  s = s.replace(UNITS, " "); // "1 cup of"
  s = s.replace(/^\d+[\d/.\s-]*/, " ");
  return s.replace(/\s+/g, " ").trim();
}

/** Matching key: singular, descriptors dropped, synonyms folded. "Green Onions" → "green onion". */
export function nameKey(raw: string): string {
  const clean = cleanName(raw);
  if (SYNONYMS[clean]) return SYNONYMS[clean];
  let s = clean.replace(DESCRIPTORS, " ").replace(/\s+/g, " ").trim();
  if (!s) s = clean;
  s = s.split(" ").map(singular).join(" ");
  return SYNONYMS[s] ?? s;
}

export function isStaple(raw: string): boolean {
  return STAPLES.has(nameKey(raw));
}

/**
 * Same ingredient for the fridge check? Equal keys, or one key is the other
 * plus words in front ("onion" ⊂ "green onion", "rice" ⊂ "cooked rice",
 * "tofu" ⊂ "firm tofu") unless the extra word makes it another food
 * ("coconut milk" is not "milk").
 */
export function sameIngredient(a: string, b: string): boolean {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (ka === kb) return true;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  const ls = long.split(" ");
  const ss = short.split(" ");
  if (ss.length >= ls.length) return false;
  if (ls.slice(-ss.length).join(" ") !== short) return false;
  const extra = ls.slice(0, ls.length - ss.length);
  return !extra.some((w) => DIFFERENT_THING.has(w));
}
