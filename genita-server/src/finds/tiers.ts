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
import type { FindItem, FindTier, NormBox } from "../protocol.ts";
import type { SamInstance } from "./instances.ts";
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
  /** every SAM match for the name, best first, each with its mask (only with GENITA_SAM_MASKS=1) */
  instances?: SamInstance[];
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

/** the card's one meta line beside the 56 pt picture holds ~40 characters at 14 pt on a 390 pt phone (#215) */
export const RECIPE_SUBTITLE_MAX = 38;

/**
 * "15 min · Have 3 · 3 to check · Need rice" and the collapsed "Need rice". One line beside the picture with the
 * shopping part whole (#215): the full names when they fit, else without the count, else "Need 3 things".
 * A "maybe" is not had until the user says yes (sweep 11/3 [P2]: kimchi/egg/rice as maybe read "You have 6,
 * nothing to buy"); while items are still being checked there is no count at all ("You have 0, nothing to buy").
 */
export function recipeSummary(items: FindItem[], minutes: number | null): { subtitle: string; status: string } {
  const time = minutes && minutes > 0 ? [`${minutes} min`] : [];
  if (items.some((i) => i.tier === "checking")) return { subtitle: time.join(""), status: "" };
  const have = items.filter((i) => i.tier === "have").length;
  const check = items.filter((i) => i.tier === "maybe").length;
  const need = items.filter((i) => i.tier === "buy" && !i.optional).map((i) => i.name);
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const needText = need.length === 0 ? (check ? "" : "nothing to buy") : need.length <= 2 ? `need ${need.join(" and ")}` : `need ${need.length} things`;
  const counted = need.length === 0 ? (check ? "" : "Nothing to buy") : `Need ${need.length} ${need.length === 1 ? "thing" : "things"}`;
  const haveP = have || !check ? [`Have ${have}`] : [];
  const checkP = check ? [`${check} to check`] : [];
  const options = [
    [...time, ...haveP, ...checkP, cap(needText)],
    [...time, ...checkP, cap(needText)],
    [...time, ...haveP, ...checkP, counted],
    [...time, ...checkP, counted],
    [...time, counted || `${check} to check`],
  ].map((p) => p.filter(Boolean).join(" · "));
  // always one line beside the picture (Codex P2: "15 min · Have 1 · 1 to check · Need 2 things" was 44)
  const subtitle = options.find((o) => o.length <= RECIPE_SUBTITLE_MAX) ?? options[options.length - 1];
  const status = need.length ? cap(needText) : check ? `${check} to check` : "You have it all";
  return { subtitle, status };
}
