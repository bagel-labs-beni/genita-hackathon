/**
 * Which result card (if any) a user turn asks for. Cheap and local so the
 * card work starts in the same tick as the spoken answer:
 *   link in the text           → link card (open_page via web_search)
 *   camera + cooking words     → recipe card with the 3-tier ingredient check
 *   camera + clothes words     → outfit card (two options, taste + visible reason)
 * Anything else stays a spoken answer only.
 */
import type { FindKind } from "../protocol.ts";
import { findUrl } from "./parse.ts";

const COOK =
  /\b(cook|cooking|make|making|recipe|recipes|eat|dinner|lunch|breakfast|meal|fridge|ingredients?|leftovers?|hungry|snack)\b|냉장고|요리|해\s*먹|먹을|레시피|재료|저녁|점심|아침|반찬/i;
const CLOTHES =
  /\b(wear|wearing|outfit|outfits|jacket|coat|blazer|dress|shirt|top|skirt|pants|jeans|shoes|sweater|hoodie|look better|which one|this or that|suit)\b|입을|입고|옷|코트|자켓|재킷|원피스|셔츠|바지|신발|어느\s*게|뭐가\s*나아/i;

export type Intent = { kind: FindKind; url?: string } | null;

export function classifyTurn(text: string, hasFrames: boolean): Intent {
  const url = findUrl(text);
  if (url) return { kind: "link", url };
  if (!hasFrames) return null;
  const cook = COOK.test(text);
  const clothes = CLOTHES.test(text);
  if (clothes && !cook) return { kind: "outfit" };
  if (cook) return { kind: "recipe" };
  return null;
}
