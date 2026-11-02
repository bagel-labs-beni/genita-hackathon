/**
 * SAM 3.1 on the Meta Responses API answers with box tokens in its text:
 *   <|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|>
 * x/y are pixels of the image as SAM saw it; w/h are that image's size, so
 * nx/ny are 0..1 coordinates the apps can draw on any preview size.
 * Each box is followed by its mask token
 *   <|mask;x=0;y=0[;c=..];data=<H>,<W>,<enc><payload>|>
 * which we keep raw (decode with ./samMask.ts only when a caller wants masks).
 */
import type { SamMaskToken } from "./samMask.ts";

export type SamBox = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number | null;
  h: number | null;
  nx1: number | null;
  ny1: number | null;
  nx2: number | null;
  ny2: number | null;
  /** the record's mask token, raster over this box (only when SAM sent one) */
  mask?: SamMaskToken;
};

export function parseSamBoxes(text: string): SamBox[] {
  const out: SamBox[] = [];
  // a mask belongs to the box right before it; payloads never contain "|"
  let last: SamBox | null = null;
  for (const m of text.matchAll(/<\|(box|mask)([^|]*)\|>/g)) {
    if (m[1] === "mask") {
      const d = /;data=(\d+),(\d+),([~!][^|]*)$/.exec(m[2]);
      if (last && !last.mask && d) last.mask = { height: Number(d[1]), width: Number(d[2]), payload: d[3] };
      last = null;
      continue;
    }
    last = null;
    const f: Record<string, number> = {};
    for (const kv of m[2].matchAll(/([a-z]\d?)\s*=\s*(-?\d+(?:\.\d+)?)/g)) f[kv[1]] = Number(kv[2]);
    if (![f.x1, f.y1, f.x2, f.y2].every((v) => Number.isFinite(v))) continue;
    const w = Number.isFinite(f.w) && f.w > 0 ? f.w : null;
    const h = Number.isFinite(f.h) && f.h > 0 ? f.h : null;
    const box: SamBox = {
      x1: f.x1,
      y1: f.y1,
      x2: f.x2,
      y2: f.y2,
      w,
      h,
      nx1: w ? f.x1 / w : null,
      ny1: h ? f.y1 / h : null,
      nx2: w ? f.x2 / w : null,
      ny2: h ? f.y2 / h : null,
    };
    out.push(box);
    last = box;
  }
  return out;
}
