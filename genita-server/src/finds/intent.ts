/**
 * Which result card (if any) a user turn asks for. Cheap and local so the
 * card work starts in the same tick as the spoken answer:
 *   link in the text           → link card (open_page via web_search)
 *   camera + cooking words     → recipe card with the 3-tier ingredient check
 *   shopping ask (no camera)   → product card: 2 product detail pages (F7 PF-1)
 *   camera + clothes words     → outfit card (two options, taste + visible reason)
 * Anything else stays a spoken answer only.
 */
import type { FindKind } from "../protocol.ts";
import { findUrl } from "./parse.ts";

const COOK =
  /\b(cook|cooking|make|making|recipe|recipes|eat|dinner|lunch|breakfast|meal|fridge|ingredients?|leftovers?|hungry|snack)\b|냉장고|요리|해\s*먹|먹을|레시피|재료|저녁|점심|아침|반찬/i;
const CLOTHES =
  /\b(wear|wearing|outfit|outfits|jacket|coat|blazer|dress|shirt|top|skirt|pants|jeans|shoes|sweater|hoodie|look better|which one|this or that|suit|looks? (?:better|best|good|nicer) on me|suits? me (?:better|best))\b|입을|입고|옷|코트|자켓|재킷|원피스|셔츠|바지|신발|어느\s*게|뭐가\s*나아/i;

// F7 product search (D2, D24): voice alone, no camera. A shopping verb plus
// something to buy, or a follow-up that asks for links / "match my style".
const SHOP_VERB =
  /\b(look(?:ing)? for|find(?:ing)?|search(?:ing)? for|shop(?:ping)? for|buy(?:ing)?|get me|pick out|recommend|suggest|where (?:can|do) i (?:get|buy))\b|찾아|사고\s*싶|살\s*만한|골라\s*줘|추천해/i;
const PRODUCT_NOUN =
  /\b(jacket|jackets|coat|coats|blazer|parka|vest|dress|dresses|shirt|shirts|overshirt|t-?shirt|tee|top|tops|sweater|sweaters|cardigan|hoodie|skirt|pants|trousers|jeans|shorts|shoes|sneakers|boots|loafers|sandals|bag|bags|backpack|tote|hat|cap|scarf|belt|watch|sunglasses|outfit|gift|lamp|chair|mug|headphones|earbuds)\b|자켓|재킷|코트|셔츠|바지|신발|가방|원피스|모자|선물/i;
/** links that can only mean shop pages */
const SHOP_LINKS = /\b(product links?|links? to (?:buy|shop))\b/i;
/** "send me the links": shop pages only after a product search or with a thing to buy named; otherwise a web
 * answer ("best ramen places in Seoul… send me the links" → the sources sheet, #413) */
const LINKS_ASK = /\b(send me (?:the )?links?)\b|링크\s*보내/i;
/** follow-ups that only make sense after a product search ("match my style", "a couple that…", "cheaper") */
const REFINE = /\b(match(?:es)? my style|a couple (?:of )?(?:options|ones|that|more)|cheaper|another (?:one|color|colour)|in (?:black|navy|grey|gray|white|beige))\b/i;

/**
 * "can we look for a jacket for this weekend?" · "send me the links". "Find a couple that match my style"
 * counts when it has a shopping verb or follows a product search in this call; "does this jacket match
 * my style?" with the camera on stays an outfit question.
 */
export function isProductAsk(text: string, afterProduct = false): boolean {
  if (SHOP_LINKS.test(text)) return true;
  if (LINKS_ASK.test(text) && (afterProduct || PRODUCT_NOUN.test(text))) return true;
  if (SHOP_VERB.test(text) && PRODUCT_NOUN.test(text)) return true;
  if (REFINE.test(text) && (afterProduct || /\b(find|look for|search for|shop for|get me)\b/i.test(text))) return true;
  return false;
}

/** Wearing words: "what to wear", "pick an outfit" (also "…wear to dinner", which COOK alone would take). */
const WEAR = /\b(wear|wearing|outfits?)\b|입을|입고|옷/i;
/** Clothes named without "which one / this or that", which also fit "Python or JavaScript?". */
const GARMENT =
  /\b(jacket|coat|blazer|dress|shirt|skirt|pants|jeans|shoes|sweater|hoodie)\b|코트|자켓|재킷|원피스|셔츠|바지|신발/i;

/** "What should I wear?" without a camera: wearing words, or a garment that isn't about cooking; never a product search. */
export function isOutfitAsk(text: string, afterProduct = false): boolean {
  if (findUrl(text) || isProductAsk(text, afterProduct)) return false;
  return WEAR.test(text) || (GARMENT.test(text) && !COOK.test(text));
}

export type Intent = { kind: FindKind; url?: string } | null;

export function classifyTurn(text: string, hasFrames: boolean, afterProduct = false): Intent {
  const url = findUrl(text);
  if (url) return { kind: "link", url };
  // shopping words win over the camera: "look for a jacket" with the camera on is a search, not a try-on
  if (isProductAsk(text, afterProduct)) return { kind: "product" };
  if (!hasFrames) return null;
  const cook = COOK.test(text);
  const clothes = CLOTHES.test(text);
  if (clothes && !cook) return { kind: "outfit" };
  if (cook) return { kind: "recipe" };
  return null;
}
