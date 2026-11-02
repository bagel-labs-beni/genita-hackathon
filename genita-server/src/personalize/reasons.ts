/**
 * Reason chips on Finds results (lane 개인화 E): 1–2 short chips that say why a
 * result fits the user, taken from their own stored taste lines — never written
 * by the model, so a chip can't claim something the user didn't share.
 *
 *   outfit / product → "Your style: clean, minimal clothes" (+ a style dislike the result respects)
 *   recipe           → "Your taste: Korean comfort food" + "You said: no cilantro"
 *   link             → none
 *
 * A dislike chip appears only when the card itself doesn't contain the thing.
 * "You said" only for explicit lines; other labels read "Your taste".
 */
import type { FindCard } from "../protocol.ts";
import { isDislike, type EvidenceLabel, type StyleCard } from "../prep/importProfile.ts";

/** fromCall = said in this call (a voice correction) → grey "You said: …" chip */
export type TasteLine = { text: string; label: EvidenceLabel | null; fromCall?: boolean };
/** from "profile" = blue chip (import / HISY corrections), "call" = grey chip (said in this call) */
export type FindReason = { text: string; source: string; from: "profile" | "call" };

const STYLE_PREFIX = /^(?:style|fashion|clothes|clothing|outfits?|wardrobe|aesthetics?|look)\s*(?:and \w+\s*)?:\s*/i;
const FOOD_PREFIX = /^(?:food|cooking|cuisine|diet|eating|meals?|food and cooking)\s*(?:and \w+\s*)?:\s*/i;
const OTHER_PREFIX = /^[A-Z][A-Za-z ,&]{1,30}:\s*/;
const FOOD_WORDS =
  /\b(?:food|cook\w*|meals?|dish\w*|recipes?|spic\w*|cilantro|coriander|sweet|salty|savory|sour|vegetarian|vegan|meat|beef|pork|chicken|fish|seafood|shrimp|rice|noodles?|pasta|soup|stew|salad|korean|italian|mexican|japanese|thai|indian|chinese|onions?|garlic|cheese|dairy|gluten|egg|eggs|coffee|tea|dessert|sugar|flavou?rs?|eat\w*|breakfast|lunch|dinner|snacks?|mushrooms?|tofu|kimchi|bread|baking|fruit|vegetables?|herbs?|mint|olives?|peanuts?|nuts|coconut|tomato\w*|potato\w*|peppers?|chili|chilli)\b/i;
const STYLE_WORDS =
  /\b(?:wear\w*|clothes|clothing|outfits?|style|fits?|fitted|oversized|colou?rs?|black|grey|gray|navy|white|beige|earthy|muted|neutral|minimal\w*|jackets?|coats?|dress\w*|shoes|sneakers|boots|linen|cotton|denim|wool|knit\w*|logos?|brands?|prints?|patterns?|vintage|tailored|streetwear|accessor\w*|jewelry|bags?|layers?|cuts?|silhouettes?|fashion)\b/i;

/** The taste lines a result can cite: from the card (labels known) or the profile text's main "Taste" lines. */
export function tasteLines(src: StyleCard | string | null | undefined): TasteLine[] {
  if (!src) return [];
  if (typeof src !== "string") {
    return (src.sections?.likes ?? []).filter((f) => f.label !== "suggested").map((f) => ({ text: f.text, label: f.label }));
  }
  const out: TasteLine[] = [];
  for (const line of src.split("\n")) {
    if (/^(?:Suggestions|Rules|Also)\b/.test(line)) break;
    const m = line.match(/^- Taste: (.+?)(?: \([^)]*\))?$/);
    if (m) out.push({ text: m[1], label: null });
  }
  return out;
}

type Kind = "style" | "food" | null;
function kindOf(text: string): Kind {
  if (STYLE_PREFIX.test(text)) return "style";
  if (FOOD_PREFIX.test(text)) return "food";
  const body = text.replace(OTHER_PREFIX, "");
  const food = FOOD_WORDS.test(body);
  const style = STYLE_WORDS.test(body);
  return food && !style ? "food" : style && !food ? "style" : null;
}

const GENERAL_FOOD =
  /\b(?:korean|italian|mexican|japanese|thai|indian|chinese|sichuan|french|spanish|greek|vietnamese|mediterranean|middle eastern|comfort|home cooking|home-cooked|weeknight|quick|easy|one-pot|healthy|light|hearty|spicy|mild|vegetarian|vegan|pescatarian|plant-based|low-carb|cuisine)\b/i;

const CUT = /\s+(?:in|with|for|from|over|that|when|which|because|especially|like|and)\s+|[.;:]\s*/i;

/** A chip-sized phrase: "Style: Clean, minimal clothes in black and grey." → "clean, minimal clothes". */
export function shortTaste(text: string): string {
  const dislike = isDislike(text);
  let s = text.replace(STYLE_PREFIX, "").replace(FOOD_PREFIX, "").replace(OTHER_PREFIX, "").trim();
  if (dislike) s = s.replace(/^\s*(?:dislikes?|avoids?|hates?|not into|no|never|doesn't (?:like|eat|want)|does not (?:like|eat|want)|can't stand)\s+/i, "");
  s = s.split(CUT)[0];
  if (dislike || s.split(/\s+/).length > 4) s = s.split(/,\s*/)[0];
  s = s.replace(/[.!,;:\s]+$/, "").trim();
  const words = s.split(/\s+/);
  if (words.length > 4) s = words.slice(0, 4).join(" ");
  // keep proper nouns ("Korean"), lowercase the rest's first letter for "Your style: clean, …"
  if (/^[A-Z][a-z]/.test(s) && !/^(?:Korean|Italian|Mexican|Japanese|Thai|Indian|Chinese|French|Spanish|Greek|Vietnamese|American)\b/.test(s)) s = s[0].toLowerCase() + s.slice(1);
  return s;
}

function cardText(c: FindCard): string {
  const products = (c as FindCard & { products?: Array<{ name?: string }> }).products ?? [];
  return [c.title, c.subtitle, ...c.items.map((i) => i.name), ...c.options.map((o) => o.label), ...c.steps.map((s) => s.text), ...c.why, ...products.map((p) => p.name ?? "")].join(" ").toLowerCase();
}

const contentWords = (s: string) => (s.toLowerCase().match(/[\p{L}]{3,}/gu) ?? []).filter((w) => !/^(?:and|the|very|food|foods|clothes|things)$/.test(w));

/** ≤ 2 chips for a result card, from the user's own taste lines. */
export function reasonChips(lines: TasteLine[], card: FindCard): FindReason[] {
  const want: Kind = card.kind === "recipe" ? "food" : card.kind === "outfit" || card.kind === ("product" as FindCard["kind"]) ? "style" : null;
  if (!want || !lines.length) return [];
  const text = cardText(card);
  const mine = lines.filter((l) => kindOf(l.text) === want);
  const out: FindReason[] = [];
  const respected = (l: TasteLine) => !contentWords(shortTaste(l.text)).some((w) => text.includes(w));
  const echoed = (l: TasteLine) => contentWords(shortTaste(l.text)).some((w) => text.includes(w));
  const push = (l: TasteLine | undefined, label: string, from: FindReason["from"]) => {
    if (!l || out.some((o) => o.source === l.text)) return;
    const phrase = shortTaste(l.text);
    if (phrase) out.push({ text: `${label}: ${isDislike(l.text) ? "no " : ""}${phrase}`.slice(0, 48), source: l.text, from });
  };
  // grey "You said: …" — said in this call (a dislike only when the card respects it)
  const call = mine.filter((l) => l.fromCall);
  push(call.find((l) => (isDislike(l.text) ? respected(l) : echoed(l))) ?? call.find((l) => !isDislike(l.text)), "You said", "call");
  // blue "Your style / Your taste: …" — the stored profile (import, HISY corrections)
  const stored = mine.filter((l) => !l.fromCall);
  const likes = stored.filter((l) => !isDislike(l.text));
  // style lines always speak to an outfit; for a dish, a cuisine / diet / way-of-cooking line does (the recipe was picked
  // with it), an ingredient line only when the dish has it ("noodles" on fried rice reads wrong)
  const general = (l: TasteLine) => want === "style" || GENERAL_FOOD.test(l.text);
  push(likes.find(echoed) ?? likes.find(general), want === "style" ? "Your style" : "Your taste", "profile");
  if (out.length < 2) push(stored.find((l) => isDislike(l.text) && respected(l)), "Your taste", "profile");
  return out.slice(0, 2);
}
