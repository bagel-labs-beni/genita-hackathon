/**
 * V03 face scan (11/4, dyno demo video 1:02.6): the points the app turns into
 * the blue wireframe face mesh while the image check runs.
 *
 * All SAM 3.1, in parallel with the Spark check (no extra wait):
 *  - `faceOutline`: the face mask, traced into 32 points around its centroid.
 *  - `facePoints`: eyes / brows / nose / lips placed from SAM's "eyes" and
 *    "mouth" boxes (brows and nose follow from them).
 * Live probe 11/4 (human, clay, dog): SAM's boxes sat on the features; asking
 * Spark for the points in the check call put human eyes one eye-height high
 * and tripled the V03 wait (3.5 s → 9.6 s), so Spark is not used here.
 * Geometry only: no identity, nothing stored beyond the upload answer.
 */
import type { SamBox } from "../meta/sam.ts";
import { decodeSamMask } from "../meta/samMask.ts";
import type { CompanionKind } from "./prompts.ts";

/** [x, y] as fractions of the uploaded image (0 = left / top, 1 = right / bottom) */
export type FacePoint = [number, number];
export type FacePoints = {
  leftEye: FacePoint[];
  rightEye: FacePoint[];
  leftBrow: FacePoint[];
  rightBrow: FacePoint[];
  nose: FacePoint[];
  lips: FacePoint[];
};

export const EYES_PROMPT = "the eyes";
export const MOUTH_PROMPT = "the mouth";

export function facePrompt(kind: CompanionKind | null): string {
  if (kind === "animal") return "the animal's face";
  if (kind === "character") return "the character's face";
  return "the person's face";
}

const r4 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000;
type NBox = { x1: number; y1: number; x2: number; y2: number };

function norm(b: SamBox): NBox | null {
  if (b.nx1 == null || b.ny1 == null || b.nx2 == null || b.ny2 == null) return null;
  if (!(b.nx2 > b.nx1 && b.ny2 > b.ny1)) return null;
  return { x1: b.nx1, y1: b.ny1, x2: b.nx2, y2: b.ny2 };
}
const area = (b: NBox) => (b.x2 - b.x1) * (b.y2 - b.y1);
const cx = (b: NBox) => (b.x1 + b.x2) / 2;
const cy = (b: NBox) => (b.y1 + b.y2) / 2;

/**
 * Pure: the largest SAM match with a mask → `n` outline points (normalized),
 * one per angle around the mask centroid (the farthest mask pixel on that ray),
 * starting at the top, clockwise on screen. null when nothing usable came back.
 */
export function outlineFromSam(boxes: SamBox[], n = 32): FacePoint[] | null {
  let best: SamBox | null = null;
  for (const b of boxes) {
    if (!b.mask || !b.w || !b.h) continue;
    if (!best || (b.x2 - b.x1) * (b.y2 - b.y1) > (best.x2 - best.x1) * (best.y2 - best.y1)) best = b;
  }
  if (!best || !best.w || !best.h) return null;
  let m;
  try { m = decodeSamMask(best.mask!); } catch { return null; }
  const { width: mw, height: mh, bits } = m;
  let sx = 0, sy = 0, c = 0;
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (bits[y * mw + x]) { sx += x; sy += y; c++; }
  if (c < 16) return null;
  const ox = sx / c, oy = sy / c;
  // the raster is stretched over its box (live SAM 11/3: it can be smaller than the box)
  const bw = best.x2 - best.x1, bh = best.y2 - best.y1;
  const reach = Math.hypot(mw, mh);
  const radii: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    let last = -1;
    for (let t = 0; t < reach; t += 0.5) {
      const x = Math.round(ox + Math.cos(a) * t), y = Math.round(oy + Math.sin(a) * t);
      if (x < 0 || y < 0 || x >= mw || y >= mh) break;
      if (bits[y * mw + x]) last = t;
    }
    radii.push(last);
  }
  if (radii.filter((r) => r >= 0).length < 12) return null;
  // a median over 5 neighbours drops single-ray notches (hair over the forehead, live p1-front 11/4)
  const out: FacePoint[] = [];
  for (let i = 0; i < n; i++) {
    const near = [-2, -1, 0, 1, 2].map((k) => radii[(i + k + n) % n]).filter((r) => r >= 0).sort((p, q) => p - q);
    const t = near[near.length >> 1];
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    const lx = ox + Math.cos(a) * t, ly = oy + Math.sin(a) * t;
    out.push([r4((best.x1 + ((lx + 0.5) / mw) * bw) / best.w), r4((best.y1 + ((ly + 0.5) / mh) * bh) / best.h)]);
  }
  return out;
}

/** six points around an eye opening (almond), clockwise from the outer-left corner */
function eye(b: NBox): FacePoint[] {
  const w = b.x2 - b.x1, y = cy(b);
  return [[b.x1, y], [b.x1 + w * 0.3, b.y1], [b.x1 + w * 0.7, b.y1], [b.x2, y], [b.x1 + w * 0.7, b.y2], [b.x1 + w * 0.3, b.y2]].map(([x, yy]) => [r4(x), r4(yy)] as FacePoint);
}

/** four points along a brow arched above the eye */
function brow(b: NBox): FacePoint[] {
  const w = b.x2 - b.x1, h = Math.max(b.y2 - b.y1, w * 0.3);
  const base = b.y1 - h * 0.9;
  return [[b.x1 - w * 0.1, base + h * 0.25], [b.x1 + w * 0.3, base - h * 0.1], [b.x1 + w * 0.7, base - h * 0.1], [b.x2 + w * 0.1, base + h * 0.2]].map(([x, y]) => [r4(x), r4(y)] as FacePoint);
}

/** ten points around the outer lips, clockwise from the left corner, with a small cupid's bow */
function lips(b: NBox): FacePoint[] {
  const w = b.x2 - b.x1, h = b.y2 - b.y1, y = cy(b);
  return [
    [b.x1, y], [b.x1 + w * 0.2, b.y1 + h * 0.15], [b.x1 + w * 0.4, b.y1], [b.x1 + w * 0.5, b.y1 + h * 0.12], [b.x1 + w * 0.6, b.y1],
    [b.x1 + w * 0.8, b.y1 + h * 0.15], [b.x2, y], [b.x1 + w * 0.75, b.y2], [b.x1 + w * 0.5, b.y2 + h * 0.05], [b.x1 + w * 0.25, b.y2],
  ].map(([x, yy]) => [r4(x), r4(yy)] as FacePoint);
}

/**
 * Pure: SAM's "eyes" and "mouth" matches (+ the face outline as a frame) →
 * feature points, or null when there are no two eyes above a mouth inside the face.
 */
export function facePointsFromSam(eyeBoxes: SamBox[], mouthBoxes: SamBox[], outline: FacePoint[] | null): FacePoints | null {
  const frame = outline && outline.length
    ? { x1: Math.min(...outline.map((p) => p[0])), y1: Math.min(...outline.map((p) => p[1])), x2: Math.max(...outline.map((p) => p[0])), y2: Math.max(...outline.map((p) => p[1])) }
    : null;
  const inFrame = (b: NBox) => !frame || (cx(b) >= frame.x1 && cx(b) <= frame.x2 && cy(b) >= frame.y1 && cy(b) <= frame.y2);
  const eyes = eyeBoxes.map(norm).filter((b): b is NBox => !!b && inFrame(b)).sort((a, b) => area(b) - area(a));
  let pair: [NBox, NBox] | null = null;
  if (eyes.length >= 2) {
    const [a, b] = [eyes[0], eyes[1]].sort((p, q) => cx(p) - cx(q));
    if (cx(b) - cx(a) > (a.x2 - a.x1) * 0.8) pair = [a, b];
  }
  if (!pair && eyes.length >= 1) {
    // one box over both eyes (live SAM, front-facing human): split it
    const e = eyes[0], w = e.x2 - e.x1;
    // both eyes span ~40 % of the face (p1-front 0.32 of the image); one eye alone is ~15 %
    const wide = frame ? w > (frame.x2 - frame.x1) * 0.4 : w > 0.18;
    if (wide && w > (e.y2 - e.y1) * 2.2) pair = [{ ...e, x2: e.x1 + w * 0.38 }, { ...e, x1: e.x2 - w * 0.38 }];
  }
  if (!pair) return null;
  const eyeY = Math.max(cy(pair[0]), cy(pair[1]));
  const mouth = mouthBoxes.map(norm).filter((b): b is NBox => !!b && inFrame(b) && cy(b) > eyeY).sort((a, b) => area(b) - area(a))[0];
  if (!mouth) return null;
  const [l, r] = pair;
  const midX = (cx(l) + cx(r)) / 2, midY = (cy(l) + cy(r)) / 2;
  const span = mouth.y1 - midY;
  const nw = Math.max(mouth.x2 - mouth.x1, r.x1 - l.x2) * 0.35;
  const nose: FacePoint[] = [
    [midX, midY], [midX, midY + span * 0.72], [midX - nw, midY + span * 0.62], [midX + nw, midY + span * 0.62], [midX, midY + span * 0.8],
  ].map(([x, y]) => [r4(x), r4(y)] as FacePoint);
  return { leftEye: eye(l), rightEye: eye(r), leftBrow: brow(l), rightBrow: brow(r), nose, lips: lips(mouth) };
}
