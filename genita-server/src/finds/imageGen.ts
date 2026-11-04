/**
 * No empty pictures (Chelsea 11/4): the last steps of every card picture's fallback chain, after the page picture and
 * the web search found nothing.
 *
 *   1. the card's hero (only where the caller says it makes sense: a general / how-to web row)
 *   2. a generated picture (Muse Image, the same vendors.image the illustrations use) — only for ingredients, recipe
 *      steps, the dish hero, how-to steps and general / explainer cards. Never for products or real places (a made-up
 *      product shot or shopfront would mislead). Marked `source: "generated"` so the app can label it "Illustration".
 *   3. an explicit omit: find.image {status: "failed", omit: true}. Old apps read the plain "failed" they know; apps
 *      that know `omit` draw no picture box for that slot.
 *
 *   GENITA_FIND_IMAGE_GATE=0  → off: no hero reuse, no generation, no omit, no product swap (the 11/4 behavior)
 *   GENITA_FIND_IMAGE_GEN=0   → no generation (hero reuse and omit stay)
 *
 * Generation: ~8 s per picture, at most 4 at once across the server (a queued one waits ≤ 12 s), cached by prompt.
 */
import type { FindImage, ServerEvent } from "../protocol.ts";
import type { FindsVendors } from "./vendors.ts";

export function imageGateOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GENITA_FIND_IMAGE_GATE !== "0";
}
export function imageGenOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GENITA_FIND_IMAGE_GEN !== "0";
}

export const GEN_TIMEOUT_MS = 8000;
export const GEN_PARALLEL = 4;
/** a picture still waiting for a generation slot after this gives up (→ omit) */
const GEN_QUEUE_MS = 12_000;
const GEN_TTL_MS = 6 * 3600_000;
const GEN_CACHE_MAX = 200;

// ───────── prompts (short; the slot says what it is) ─────────

const clean = (s: string, n = 120) => s.replace(/["“”<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const TAIL = "No text, no logos, no people.";

export type GenKind = "ingredient" | "dish" | "step" | "howto-step" | "general";

/** "kimchi · 1 cup" → "Overhead photo of kimchi on a cutting board, natural light. No text, no logos, no people." */
export function genPrompt(kind: GenKind, subject: string, context = ""): string {
  const s = clean(kind === "ingredient" ? subject.split(" · ")[0] : subject);
  const c = clean(context, 60);
  switch (kind) {
    case "ingredient":
      return `Overhead photo of ${s.toLowerCase()} on a cutting board, natural light. ${TAIL}`;
    case "dish":
      return `Photo of a plated serving of ${s.toLowerCase()} on a table, natural light. ${TAIL}`;
    case "step":
      return `Overhead photo of a cooking step${c ? ` for ${c.toLowerCase()}` : ""}: ${s.replace(/[.!]+$/, "")}. Home kitchen, natural light, hands only. No text, no logos, no faces.`;
    case "howto-step":
      return `Clear photo of this step${c ? ` (${c})` : ""}: ${s.replace(/[.!]+$/, "")}. Natural light, hands only. No text, no logos, no faces.`;
    default:
      return `Simple editorial photo that shows: ${s}. Natural light. ${TAIL}`;
  }
}

// ───────── generation: cached by prompt, ≤ 4 at once, 8 s each ─────────

type Hit = { at: number; bytes: Buffer };
const cache = new Map<string, Hit>();
const inflight = new Map<string, Promise<Buffer | null>>();
let active = 0;
const waiting: Array<() => void> = [];

export function clearGenCache(): void {
  cache.clear();
  inflight.clear();
}
/** generations running right now (tests) */
export function genActive(): number {
  return active;
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

/** a generation slot, or false (stopped / waited too long) */
function acquire(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (active < GEN_PARALLEL) {
    active++;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(t);
      signal.removeEventListener("abort", stop);
      resolve(ok);
    };
    // a freed slot is handed straight to the next waiter (active stays counted)
    const go = () => done(true);
    const leave = () => { const i = waiting.indexOf(go); if (i >= 0) waiting.splice(i, 1); done(false); };
    const stop = () => leave();
    const t = setTimeout(leave, GEN_QUEUE_MS);
    waiting.push(go);
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** One generated picture for `prompt`, or null (off, stopped, failed, over 8 s). Never throws. */
export async function generatePicture(v: FindsVendors, prompt: string, signal: AbortSignal): Promise<Buffer | null> {
  const key = prompt.trim();
  if (!key || signal.aborted) return null;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < GEN_TTL_MS) return hit.bytes;
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      if (!(await acquire(signal))) return null;
      try {
        const s = AbortSignal.any([signal, AbortSignal.timeout(GEN_TIMEOUT_MS)]);
        const bytes = await new Promise<Buffer | null>((resolve) => {
          const stop = () => resolve(null);
          s.addEventListener("abort", stop, { once: true });
          v.image(key, s).then((b) => { s.removeEventListener("abort", stop); resolve(b?.length ? b : null); }, () => resolve(null));
        });
        if (bytes) {
          cache.delete(key);
          cache.set(key, { at: Date.now(), bytes });
          for (const k of cache.keys()) { if (cache.size <= GEN_CACHE_MAX) break; cache.delete(k); }
        }
        return bytes;
      } finally {
        release();
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const bytes = await p;
  return signal.aborted ? null : bytes;
}

// ───────── the end of a slot's chain ─────────

export type SlotCtx = {
  findId: string;
  vendors: FindsVendors;
  signal: AbortSignal;
  emit: (e: ServerEvent) => void;
  putImage: (slot: string, bytes: Buffer) => Promise<string>;
  log: (event: string, data: Record<string, unknown>) => void;
  /** GENITA_FIND_IMAGES (the illustration switch); false = no generation */
  images?: boolean;
};

export type Picture = { bytes: Buffer; generated?: boolean };

export type SlotEnd = {
  slot: string;
  /** the card's hero as a stand-in (only where it makes sense); null = none */
  hero?: () => Promise<Picture | null>;
  /** the generation prompt; absent = never generate (products, real places) */
  gen?: string;
  /** the picture that was sent (a hero made here is reused by the rows) */
  keep?: (pic: Picture) => void;
};

/** Stores and sends a ready picture; the FindImage sent, or null when it could not be stored. */
export async function sendPicture(ctx: SlotCtx, slot: string, pic: Picture): Promise<FindImage | null> {
  try {
    const url = await ctx.putImage(slot, pic.bytes);
    if (ctx.signal.aborted) return null;
    const img: FindImage = { slot, status: "ready", url, ...(pic.generated ? { source: "generated" as const } : {}) };
    ctx.emit({ type: "find.image", findId: ctx.findId, slot, status: "ready", url, ...(pic.generated ? { source: "generated" as const } : {}) });
    return img;
  } catch (err) {
    ctx.log("find.image_store_failed", { findId: ctx.findId, slot, message: String(err).slice(0, 120) });
    return null;
  }
}

/** "there will be no picture here": the app removes the box (old apps: plain failed) */
export function omitSlot(ctx: SlotCtx, slot: string): FindImage {
  ctx.emit({ type: "find.image", findId: ctx.findId, slot, status: "failed", omit: true });
  ctx.log("find.image_omit", { findId: ctx.findId, slot });
  return { slot, status: "failed", omit: true };
}

/**
 * A slot the page and the web search found nothing for: the hero (when given) → a generated picture (when allowed)
 * → omit. Returns what was sent, or null when the gate is off or the card was stopped (nothing sent).
 */
export async function endSlot(ctx: SlotCtx, end: SlotEnd): Promise<FindImage | null> {
  if (!imageGateOn() || ctx.signal.aborted) return null;
  const hero = end.hero ? await end.hero() : null;
  if (ctx.signal.aborted) return null;
  if (hero) {
    const img = await sendPicture(ctx, end.slot, hero);
    if (img) {
      end.keep?.(hero);
      ctx.log("find.image_hero_standin", { findId: ctx.findId, slot: end.slot });
      return img;
    }
  }
  if (end.gen && imageGenOn() && ctx.images !== false) {
    const t0 = Date.now();
    const bytes = await generatePicture(ctx.vendors, end.gen, ctx.signal);
    if (ctx.signal.aborted) return null;
    if (bytes) {
      const img = await sendPicture(ctx, end.slot, { bytes, generated: true });
      if (img) {
        end.keep?.({ bytes, generated: true });
        ctx.log("find.image_generated", { findId: ctx.findId, slot: end.slot, ms: Date.now() - t0 });
        return img;
      }
    } else ctx.log("find.image_gen_none", { findId: ctx.findId, slot: end.slot });
  }
  if (ctx.signal.aborted) return null;
  return omitSlot(ctx, end.slot);
}
