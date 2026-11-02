/**
 * F10-L4 · The three ingredient tiers (PRD 22, measured 11/1 on 10 runs of
 * the same fridge):
 *   have  = Spark re-check YES + SAM box for the name   → 0/10 invented
 *   maybe = Spark YES but no SAM box ("맞아?")          → jars like kimchi land here
 *   buy   = in the recipe, Spark NO                      → "I don't see X"
 *           (unless the first look saw it and SAM boxes it → maybe)
 * A seen item that Spark then says NO to, and no recipe needs, is dropped.
 * Pure: the pipeline feeds results in, the list comes out.
 */
import type { FindItem, FindTier, NormBox, NormMask } from "../protocol.ts";
import { cleanName, isStaple, nameKey, sameIngredient } from "./names.ts";

export type Candidate = {
  id: string;
  name: string;
  /** other names merged into this one ("onion" from the recipe into "green onions") */
  aliases: string[];
  fromCamera: boolean;
  inRecipe: boolean;
  optional: boolean;
  count: number | null;
  /** how it looks, from the first look ("red jar, top right") — SAM retry phrase */
  look: string | null;
  yes: boolean | null;
  box: NormBox | null;
  /** SAM mask over `box` (only with GENITA_SAM_MASKS=1) */
  mask?: NormMask | null;
  hint: NormBox | null;
  samDone: boolean;
  confirmed: "yes" | "no" | null;
  order: number;
};

export const MAX_CANDIDATES = 12;

export class Candidates {
  private list: Candidate[] = [];
  private nextId = 1;

  all(): readonly Candidate[] {
    return this.list;
  }

  get(id: string): Candidate | undefined {
    return this.list.find((c) => c.id === id);
  }

  /**
   * Adds a name, or merges it into a same-ingredient candidate. Returns the
   * new candidate (it needs checking) or null when merged / skipped.
   */
  add(raw: string, src: { camera?: boolean; recipe?: boolean; optional?: boolean; count?: number | null; look?: string | null }): Candidate | null {
    const name = cleanName(raw);
    if (!name || name.length > 40) return null;
    if (src.recipe && !src.camera && isStaple(name)) return null;
    const hit = this.list.find((c) => sameIngredient(c.name, name) || c.aliases.some((a) => sameIngredient(a, name)));
    if (hit) {
      if (nameKey(hit.name) !== nameKey(name) && !hit.aliases.includes(name)) hit.aliases.push(name);
      if (src.recipe) {
        // optional only if every recipe mention is optional
        hit.optional = hit.inRecipe ? hit.optional && !!src.optional : !!src.optional;
        hit.inRecipe = true;
      }
      if (src.camera) {
        hit.fromCamera = true;
        hit.count ??= src.count ?? null;
        hit.look ??= src.look ?? null;
      }
      return null;
    }
    if (this.list.length >= MAX_CANDIDATES) return null;
    const c: Candidate = {
      id: `i${this.nextId++}`,
      name,
      aliases: [],
      fromCamera: !!src.camera,
      inRecipe: !!src.recipe,
      optional: !!src.recipe && !!src.optional,
      count: src.camera ? (src.count ?? null) : null,
      look: src.look ?? null,
      yes: null,
      box: null,
      hint: null,
      samDone: false,
      confirmed: null,
      order: this.list.length,
    };
    this.list.push(c);
    return c;
  }
}

export function tierOf(c: Candidate): FindTier | null {
  if (c.confirmed === "yes") return "have";
  if (c.confirmed === "no") return c.inRecipe ? "buy" : null;
  if (c.yes === null || !c.samDone) return "checking";
  if (c.yes) return c.box ? "have" : "maybe";
  // The first look saw it and SAM finds it, but the re-check said NO (kimchi
  // 4/10, eggs 2/10 on 11/2): ask "맞아?" instead of "buy what's in your fridge".
  // "have" stays YES + box only, so this never adds a confident item.
  if (c.fromCamera && (c.box || (c.inRecipe && c.hint))) return "maybe";
  return c.inRecipe ? "buy" : null;
}

const RANK: Record<FindTier, number> = { have: 0, maybe: 1, checking: 2, buy: 3 };

/** Wire list: have → maybe → checking → buy, then first-seen order. Dropped items are left out. */
export function toWire(cands: readonly Candidate[]): FindItem[] {
  const out: (FindItem & { _o: number })[] = [];
  for (const c of cands) {
    const tier = tierOf(c);
    if (!tier) continue;
    const item: FindItem & { _o: number } = {
      id: c.id,
      name: c.name,
      tier,
      from: c.fromCamera && c.inRecipe ? "both" : c.fromCamera ? "camera" : "recipe",
      _o: c.order,
    };
    if (c.count && c.count > 1 && tier !== "buy") item.count = c.count;
    if (c.optional) item.optional = true;
    if (tier === "have" && c.box) item.box = c.box;
    if (tier === "maybe" && c.hint) item.hint = c.hint;
    if (c.confirmed) item.confirmed = c.confirmed;
    out.push(item);
  }
  out.sort((a, b) => RANK[a.tier] - RANK[b.tier] || a._o - b._o);
  return out.map(({ _o, ...i }) => i);
}

/** "About 15 min · You have 4, need rice" and the collapsed "Need rice". */
export function recipeSummary(items: FindItem[], minutes: number | null): { subtitle: string; status: string } {
  const have = items.filter((i) => i.tier === "have" || i.tier === "maybe").length;
  const need = items.filter((i) => i.tier === "buy" && !i.optional).map((i) => i.name);
  const needText = need.length === 0 ? "nothing to buy" : need.length <= 2 ? `need ${need.join(" and ")}` : `need ${need.length} things`;
  const parts = [] as string[];
  if (minutes && minutes > 0) parts.push(`About ${minutes} min`);
  parts.push(`You have ${have}, ${needText}`);
  return { subtitle: parts.join(" · "), status: need.length === 0 ? "You have it all" : needText.charAt(0).toUpperCase() + needText.slice(1) };
}
