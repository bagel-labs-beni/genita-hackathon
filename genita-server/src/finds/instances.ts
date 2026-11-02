/**
 * GENITA_SAM_MASKS: every SAM match for an ingredient, each with its own
 * outline ("tomatoes" on a counter → one item per tomato), capped so the
 * camera overlay stays readable.
 *
 *   matches  score ≥ MIN_SCORE (when SAM sent one), best first, at most MAX_PER_PROMPT;
 *            a duplicate (IoU > 0.7) or a part inside a better match (80% of it
 *            covered: garlic cloves inside the bulb) is dropped
 *   phrasing "tomato" vs "tomatoes": the one with the higher best score, then more
 *            matches ("garlics" finds cloves at 0.6–0.87, "garlic" the bulb at 0.94)
 *   overlay  at most MAX_BOX_ITEMS items. Over the cap, the ingredient with the
 *            most matches is merged into one item (union box + union mask), then
 *            the next, until it fits.
 */
import type { NormBox, NormMask } from "../protocol.ts";
import type { SamBox } from "../meta/sam.ts";
import { SamMaskError, decodeSamMask, toWireMask, unionMasks, type PlacedMask } from "../meta/samMask.ts";

export const MIN_SCORE = 0.5;
export const MAX_PER_PROMPT = 12;
export const MAX_BOX_ITEMS = 12;
const DUPLICATE_IOU = 0.7;
const INSIDE = 0.8;

export type SamInstance = {
  box: NormBox;
  /** wire mask over `box`; null when SAM sent none or it did not decode */
  mask: NormMask | null;
  score: number | null;
  /** source-pixel placement, kept for merging */
  placed: PlacedMask | null;
  frame: { w: number; h: number };
};

export type BoxItem = { label: string; box: NormBox; mask?: NormMask };

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function normBox(x1: number, y1: number, x2: number, y2: number, w: number, h: number): NormBox | null {
  const b = { x1: round4(clamp01(x1 / w)), y1: round4(clamp01(y1 / h)), x2: round4(clamp01(x2 / w)), y2: round4(clamp01(y2 / h)) };
  return b.x2 > b.x1 && b.y2 > b.y1 ? b : null;
}

const area = (b: SamBox) => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
function inter(a: SamBox, b: SamBox): number {
  return Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
}
/** b repeats or sits inside the better match k */
function overlaps(k: SamBox, b: SamBox): boolean {
  const i = inter(k, b);
  const u = area(k) + area(b) - i;
  return (u > 0 && i / u > DUPLICATE_IOU) || (area(b) > 0 && i / area(b) > INSIDE);
}

/** SAM boxes for one prompt → kept matches, best first. */
export function instancesOf(boxes: readonly SamBox[]): SamInstance[] {
  const ranked = boxes
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.w && b.h && (b.score === undefined || b.score >= MIN_SCORE))
    .sort((p, q) => (q.b.score ?? 0) - (p.b.score ?? 0) || p.i - q.i)
    .map(({ b }) => b);
  const kept: SamBox[] = [];
  for (const b of ranked) if (kept.length < MAX_PER_PROMPT && !kept.some((k) => overlaps(k, b))) kept.push(b);
  const out: SamInstance[] = [];
  for (const b of kept) {
    const box = normBox(b.x1, b.y1, b.x2, b.y2, b.w!, b.h!);
    if (!box) continue;
    let placed: PlacedMask | null = null;
    try {
      if (b.mask) placed = { x1: b.x1, y1: b.y1, ...decodeSamMask(b.mask) };
    } catch (e) {
      if (!(e instanceof SamMaskError)) throw e;
    }
    // a bad payload drops the mask, never the box
    out.push({ box, mask: placed ? toWireMask(placed) : null, score: b.score ?? null, placed, frame: { w: b.w!, h: b.h! } });
  }
  return out;
}

/** The better of several phrasings' matches: higher best score, then more matches, then the earlier one. */
export function pickPhrasing<T extends { instances?: readonly SamInstance[] } | null>(hits: readonly T[]): T | null {
  const best = (h: T) => h?.instances?.[0]?.score ?? 0;
  const count = (h: T) => h?.instances?.length ?? 1;
  let pick: T | null = null;
  for (const h of hits) if (h && (!pick || best(h) > best(pick) || (best(h) === best(pick) && count(h) > count(pick)))) pick = h;
  return pick;
}

/** One item covering every instance: union box, union mask (only if every instance has one). */
export function mergeInstances(list: readonly SamInstance[]): SamInstance {
  if (list.length === 1) return list[0];
  const box: NormBox = {
    x1: Math.min(...list.map((i) => i.box.x1)),
    y1: Math.min(...list.map((i) => i.box.y1)),
    x2: Math.max(...list.map((i) => i.box.x2)),
    y2: Math.max(...list.map((i) => i.box.y2)),
  };
  const frame = list[0].frame;
  if (!list.every((i) => i.placed)) return { box, mask: null, score: list[0].score, placed: null, frame };
  const placed = unionMasks(list.map((i) => i.placed!));
  // the union raster spans exactly its own pixel box, so draw it over that box
  const pbox = normBox(placed.x1, placed.y1, placed.x1 + placed.width - 1, placed.y1 + placed.height - 1, frame.w, frame.h) ?? box;
  return { box: pbox, mask: toWireMask(placed), score: list[0].score, placed, frame };
}

/** Overlay items for the ingredients in order, at most `cap`, merging the biggest groups first. */
export function boxItems(groups: readonly { label: string; instances: readonly SamInstance[] }[], cap = MAX_BOX_ITEMS): BoxItem[] {
  const lists = groups.map((g) => [...g.instances]);
  let total = lists.reduce((n, l) => n + l.length, 0);
  while (total > cap) {
    let k = -1;
    for (let i = 0; i < lists.length; i++) if (lists[i].length > 1 && (k < 0 || lists[i].length > lists[k].length)) k = i;
    if (k < 0) break;
    total -= lists[k].length - 1;
    lists[k] = [mergeInstances(lists[k])];
  }
  const items: BoxItem[] = [];
  groups.forEach((g, i) => {
    for (const inst of lists[i]) items.push({ label: g.label, box: inst.box, ...(inst.mask ? { mask: inst.mask } : {}) });
  });
  return items.slice(0, cap);
}
