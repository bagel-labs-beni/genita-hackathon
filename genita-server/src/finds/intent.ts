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
import { generalIntent } from "./general.ts";

const COOK =
  /\b(cook|cooking|make|making|recipe|recipes|eat|dinner|lunch|breakfast|meal|fridge|ingredients?|leftovers?|hungry|snack)\b|냉장고|요리|해\s*먹|먹을|레시피|재료|저녁|점심|아침|반찬/i;
const CLOTHES =
  /\b(wear|wearing|outfit|outfits|jacket|coat|blazer|dress|shirt|top|skirt|pants|jeans|shoes|sweater|hoodie|look better|which one|this or that|suit|looks? (?:better|best|good|nicer) on me|suits? me (?:better|best))\b|입을|입고|옷|코트|자켓|재킷|원피스|셔츠|바지|신발|어느\s*게|뭐가\s*나아/i;

// F7 product search (D2, D24): voice alone, no camera. A shopping verb plus
// something to buy, or a follow-up that asks for links / "match my style".
const SHOP_VERB =
  /\b(look(?:ing)? for|find(?:ing)?|search(?:ing)? for|shop(?:ping)? for|buy(?:ing)?|get me|pick out|recommend|suggest|where (?:can|do) i (?:get|buy))\b|찾아|사고\s*싶|살\s*만한|골라\s*줘|추천해/i;
const PRODUCT_NOUN =
  /\b(jacket|jackets|coat|coats|blazer|parka|vest|dress|dresses|shirt|shirts|overshirt|t-?shirt|tee|top|tops|sweater|sweaters|cardigan|hoodie|skirt|pants|trousers|jeans|shorts|shoes|sneakers|boots|loafers|sandals|bag|bags|backpack|tote|hat|cap|scarf|belt|watch|sunglasses|outfit|gift|lamp|chair|mug|headphones|earbuds|heels|flats|earrings?|necklaces?|bracelets?|rings|jewelry|jewellery|accessories|wallets?|socks|gloves|perfume)\b|자켓|재킷|코트|셔츠|바지|신발|가방|원피스|모자|선물/i;
/** links that can only mean shop pages */
const SHOP_LINKS = /\b(product links?|links? to (?:buy|shop))\b/i;
/** "send me the links": shop pages only after a product search or with a thing to buy named; otherwise a web
 * answer ("best ramen places in Seoul… send me the links" → the sources sheet, #413) */
const LINKS_ASK = /\b(send me (?:the )?links?)\b|링크\s*보내/i;
/** "send me the links" on its own (a product search only with shopping context) */
export function isLinksAsk(text: string): boolean {
  return LINKS_ASK.test(text);
}
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

/** "identify" (CEO demo 11/4): outline the thing in view and name it — no card, no sheet */
export type Intent = { kind: FindKind | "identify"; url?: string } | null;

/** "What's this?" / "이게 뭐야" about a thing held up to the camera (not a song, a smell or what a word means). */
const IDENTIFY =
  /\b(?:what(?:'s|’s| is) (?:this|that)\b|what (?:am i|i'm|i am) holding|what do you call (?:this|that)|(?:do you |can you tell me )?know what (?:this|that) is|tell me what (?:this|that) is)|(?:이게|이거|이건|저게|저거|저건)\s*(?:뭐|무엇|뭔)/i;
const NOT_VISUAL = /\b(?:like|going on|happening|about|mean|means|meaning|song|sound|noise|smell|music|movie|show|video|episode|word|called|for|supposed)\b/i;
export function isIdentifyAsk(text: string): boolean {
  return IDENTIFY.test(text) && !NOT_VISUAL.test(text) && text.trim().split(/\s+/).length <= 10;
}

/** B: a product ask that points at something on the shared screen ("that jacket", "the coat he's wearing"). */
const DEICTIC = /\b(?:that|those|these|this|same)\b(?!\s+(?:weekend|week|summer|winter|fall|autumn|spring|year|month|time|evening|morning|afternoon|season|trip)\b)|\b(?:on (?:the )?screen|in (?:the|this) (?:video|show|clip|movie|scene))\b|\b(?:he|she|they)(?:'s|’s| is| are|'re) wearing\b|\b(?:his|her|their) (?:jacket|coat|outfit|shoes|dress|shirt|top|bag|hat|sweater|jeans|pants|boots|sneakers)\b/i;
export function refersToScreen(text: string): boolean {
  return DEICTIC.test(text);
}

/**
 * C (demo scene 5): a short "yes" to the outfit verdict's offer ("Want me to find a pair?"), or a goes-with ask
 * ("find me some", "what shoes would go with it"). The runner only takes it right after an outfit verdict.
 */
const ACCEPT = /^(?:(?:oh |ok(?:ay)? |um+ |hmm+ )?(?:yes|yeah|yep|yup|sure|please|ok(?:ay)?|definitely|absolutely|of course|go ahead|go for it|do it|let'?s do it|let'?s see|sounds good|why not)\b[\s,.!]*(?:please|go for it|do it|go ahead|let'?s do it|let'?s see|sure|thanks|thank you)?[\s,.!]*(?:find (?:me )?(?:some|a pair|one|them)|show me(?: some)?)?[\s,.!?]*)$/i;
// "Find me some." ends the line (punctuation after it is fine, Codex r2); the goes-with asks may sit anywhere
const GOES_WITH_ASK = /\b(?:find|show) (?:me )?(?:some|a pair|one|a couple|a few)(?: of (?:those|them|these))?(?: (?:for|to go with) (?:it|this|that|me))?\b[\s,.!?]*$|\b(?:what (?:shoes|accessories|bag|bags|boots|jewelry|else)?\s*(?:would|could|will|might)? ?go(?:es)? with (?:it|this|that|them)|something (?:that )?(?:goes|would go) with (?:it|this|that))\b/i;
/** a bare "yes / sure / go for it": only counts right after the companion offered to find something */
export function isBareAccept(text: string): boolean {
  const t = text.trim();
  return t.split(/\s+/).length <= 9 && ACCEPT.test(t) && !GOES_WITH_ASK.test(t);
}
export function isGoesWithFollowUp(text: string): boolean {
  const t = text.trim();
  if (t.split(/\s+/).length > 9) return false;
  return ACCEPT.test(t) || GOES_WITH_ASK.test(t);
}

/** Choosing between what they hold: "which jacket", "this or that", "looks better on me" (CW-02, AU-61). */
const COMPARE =
  /\b(which (?:one|jacket|coat|blazer|dress|shirt|top|skirt|pants|jeans|shoes|sweater|hoodie|outfit|of (?:these|the two|them))|this or (?:that|this)|(?:this|that) one or|looks? (?:better|best|good|nicer) on me|suits? me (?:better|best))\b|어느\s*게|뭐가\s*나아/i;
/** Wearing it, not eating it: "wear to dinner", "looks better on me" (AU-60). */
const ON_ME = /\b(wear|wearing|outfits?|looks? (?:better|best|good|nicer) on me|suits? me)\b|입을|입고/i;
/** Ordering it: "…that I order online", "to purchase" — a web search even without a shop verb. */
const ORDER = /\b(order|online|purchase|in stock|on sale|cheapest)\b/i;
/** Only these say "shop the web" when they hold clothes up to the camera; "recommend / suggest" stays a pick (AU-61). */
const EXPLICIT_SHOP = /\b(look(?:ing)? for|find(?:ing)?|search(?:ing)? for|shop(?:ping)? for|buy(?:ing)?|get me|where (?:can|do) i (?:get|buy))\b|찾아|사고\s*싶|살\s*만한/i;

/** Chelsea 11/4: a turn no card takes but that asks something the web knows opens a search card (general.ts). */
/** P0 11/4: a choice or "help me pick" — never a describe / observe question about what they have on */
const CHOOSE = /\b(?:which|better|best|or|vs\.?|versus|should i wear|what (?:should|do|can) i wear|what to wear|pick|choose|decide|go with)\b|어느|뭐가\s*나아|입을까|골라/i;

export function classifyTurn(text: string, hasFrames: boolean, afterProduct = false): Intent {
  return cardIntent(text, hasFrames, afterProduct) ?? generalIntent(text);
}

function cardIntent(text: string, hasFrames: boolean, afterProduct = false): Intent {
  const url = findUrl(text);
  if (url) return { kind: "link", url };
  // clothes held up to the camera and a choice between them: an outfit pick, even with "recommend" or "dinner" in it
  // (not when it's about ordering one, or cooking without a word about wearing: "jacket potatoes", Codex r1)
  if (hasFrames && COMPARE.test(text) && CHOOSE.test(text) && (ON_ME.test(text) || GARMENT.test(text)) && !EXPLICIT_SHOP.test(text) && !ORDER.test(text)
    && !SHOP_LINKS.test(text) && !LINKS_ASK.test(text) && !(COOK.test(text) && !ON_ME.test(text))) {
    return { kind: "outfit" };
  }
  // shopping words win over the camera: "look for a jacket" with the camera on is a search, not a try-on
  if (isProductAsk(text, afterProduct)) return { kind: "product" };
  if (!hasFrames) return null;
  const cook = COOK.test(text);
  const clothes = CLOTHES.test(text);
  // "what should I wear to dinner?" names a meal but asks about clothes (AU-60); only a choice opens the outfit card —
  // "what am I wearing?" / "how do I look?" / "do you like my shirt?" are answered out loud from the frame (P0 11/4)
  if (clothes && (!cook || ON_ME.test(text)) && CHOOSE.test(text)) return { kind: "outfit" };
  if (cook) return { kind: "recipe" };
  if (isIdentifyAsk(text)) return { kind: "identify" };
  return null;
}
