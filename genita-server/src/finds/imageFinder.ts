/**
 * Visual everything (Chelsea 11/4 21:09): a photo for any card row, found on the web. The server has no image
 * search (vendors.image only generates), so: one Spark web search for the query → the pages it returned → the first
 * one whose og:image loads (fetchPage's SSRF-safe reader, ≤ 2 MB, JPEG/PNG/WebP only). The bytes are re-hosted by the
 * caller's putImage like product photos. Cached per query (in-flight shared), time-boxed, globally rate-limited.
 *
 * Only `ready` pictures go on the wire (sendFoundImages): a row whose picture was not found gets no slot at all.
 *
 *   GENITA_FIND_WEB_IMAGES=0        → off (cards keep their text; product / og:image paths unchanged)
 *   GENITA_FIND_WEB_IMAGE_SEARCHES  → web searches in flight across the server (default 6)
 */
import type { FindImage, ServerEvent } from "../protocol.ts";
import { domainOf } from "./parse.ts";
import { userMessage, type FindsVendors, type OutputItem } from "./vendors.ts";
import { isBlockedSite } from "./webAnswer.ts";

/** one query's whole budget, waiting for a search slot included */
export const WEB_IMAGE_BUDGET_MS = 15_000;
/** one page read (HTML, then the image) */
const PAGE_MS = 2500;
/** pages tried per query, in parallel */
const PAGES_PER_QUERY = 6;
const HIT_TTL_MS = 6 * 3600_000;
const MISS_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 400;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

export function webImagesOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GENITA_FIND_WEB_IMAGES !== "0";
}

const norm = (q: string) => q.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);

/** "cooked rice · 2 cups" → "cooked rice ingredient" (the chip's amount is not part of what it looks like) */
export function ingredientQuery(label: string): string {
  return `${label.split(" · ")[0].trim().toLowerCase()} ingredient`;
}

const FILLER = new Set(["a", "an", "the", "and", "or", "in", "on", "of", "for", "to", "at", "by", "with", "into", "onto", "from", "until", "about", "your", "it", "them", "then", "over", "minutes", "minute", "seconds", "hours", "min", "is", "are", "some", "each", "all"]);
/** "<dish> <step verb/object>": "Fry the kimchi in oil for 3 minutes." → "kimchi fried rice fry kimchi oil" */
export function stepQuery(dish: string, step: string): string {
  const words = step.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter((w) => w && !FILLER.has(w) && !/^\d+$/.test(w));
  return `${dish.toLowerCase().trim()} ${words.slice(0, 4).join(" ")}`.trim();
}

/** a site-wide picture, not one of the thing: logos, icons, sprites, share defaults */
export function isJunkImageUrl(u: string): boolean {
  return /(?:logo|favicon|sprite|placeholder|apple-touch|default[-_]?(?:og|share|image)|blank|spacer|avatar)/i.test(u.split("?")[0]);
}

type Entry = { at: number; bytes: Buffer | null };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Buffer | null>>();
let cacheBytes = 0;

export function clearWebImageCache(): void {
  cache.clear();
  inflight.clear();
  cacheBytes = 0;
}

function remember(key: string, bytes: Buffer | null): void {
  const old = cache.get(key);
  if (old?.bytes) cacheBytes -= old.bytes.length;
  cache.delete(key);
  cache.set(key, { at: Date.now(), bytes });
  if (bytes) cacheBytes += bytes.length;
  // oldest first (Map keeps insertion order)
  for (const [k, e] of cache) {
    if (cache.size <= CACHE_MAX_ENTRIES && cacheBytes <= CACHE_MAX_BYTES) break;
    cache.delete(k);
    if (e.bytes) cacheBytes -= e.bytes.length;
  }
}

function cached(key: string): Entry | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > (e.bytes ? HIT_TTL_MS : MISS_TTL_MS)) {
    cache.delete(key);
    if (e.bytes) cacheBytes -= e.bytes.length;
    return null;
  }
  return e;
}

// ───────── a server-wide cap on web searches in flight (a recipe asks ~20 at once) ─────────
let active = 0;
const waiting: Array<() => void> = [];
const maxSearches = () => Math.max(1, Number(process.env.GENITA_FIND_WEB_IMAGE_SEARCHES) || 6);
async function slot(signal: AbortSignal): Promise<() => void> {
  if (active < maxSearches()) active++;
  else {
    // a freed slot is handed straight to the next waiter (active stays counted), so a newcomer can't jump the queue
    await new Promise<void>((resolve, reject) => {
      const go = () => { signal.removeEventListener("abort", stop); resolve(); };
      const stop = () => { const i = waiting.indexOf(go); if (i >= 0) waiting.splice(i, 1); reject(new Error("aborted")); };
      waiting.push(go);
      signal.addEventListener("abort", stop, { once: true });
    });
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
}

function searchedPages(output: OutputItem[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const o of output) {
    if (o.type !== "web_search_call" || o.status === "failed") continue;
    const a = o.action as { url?: string; sources?: Array<{ url?: string }> } | undefined;
    for (const u of [a?.url, ...(a?.sources ?? []).map((s) => s.url)]) {
      if (!u || !/^https?:\/\//i.test(u)) continue;
      const d = domainOf(u);
      if (!d || isBlockedSite(d) || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

const timeboxed = <T>(run: (s: AbortSignal) => Promise<T>, ms: number, outer: AbortSignal): Promise<T | null> => {
  const signal = AbortSignal.any([outer, AbortSignal.timeout(ms)]);
  return new Promise<T | null>((resolve) => {
    const stop = () => resolve(null);
    signal.addEventListener("abort", stop, { once: true });
    run(signal).then((v) => { signal.removeEventListener("abort", stop); resolve(v); }, () => resolve(null));
  });
};

/** A page's own picture: og:image (not a logo) that loads as an image. */
export async function pagePicture(v: FindsVendors, url: string, signal: AbortSignal, ms = PAGE_MS): Promise<Buffer | null> {
  if (!v.pageFacts || !v.productImage) return null;
  const facts = await timeboxed((s) => v.pageFacts!(url, s), ms, signal);
  // og:image, else the first content picture in the page body (fetchPage.firstContentImage)
  const pic = facts?.image && !isJunkImageUrl(facts.image) ? facts.image : facts?.inPageImage;
  if (!pic) return null;
  const bytes = await timeboxed((s) => v.productImage!(pic, s), ms, signal);
  return bytes?.length ? bytes : null;
}

/** first non-null of the pages, in any order; null when none */
function firstPicture(v: FindsVendors, pages: string[], signal: AbortSignal): Promise<Buffer | null> {
  if (!pages.length) return Promise.resolve(null);
  const stop = new AbortController();
  const s = AbortSignal.any([signal, stop.signal]);
  return new Promise((resolve) => {
    let left = pages.length;
    for (const p of pages) {
      pagePicture(v, p, s).then((b) => {
        left--;
        if (b) { stop.abort(); resolve(b); } else if (!left) resolve(null);
      }, () => { left--; if (!left) resolve(null); });
    }
  });
}

async function search(v: FindsVendors, query: string, signal: AbortSignal): Promise<Buffer | null> {
  const release = await slot(signal);
  let pages: string[];
  try {
    const res = await v.spark(
      {
        input: userMessage(`Do one web search for: "${query.replace(/"/g, "'")}". Do not open pages. Reply with only the word OK.`),
        tools: [{ type: "web_search" }],
        effort: "minimal",
        // the model writes a line before it calls the tool: under ~300 tokens it stops before searching (e2e 11/4)
        maxOutputTokens: 500,
      },
      signal,
    );
    pages = searchedPages(res.output).slice(0, PAGES_PER_QUERY);
  } finally {
    release();
  }
  return firstPicture(v, pages, signal);
}

/** One shared, cached run per key (in-flight shared; a hit for 6 h, a miss for 10 min; an abort is not cached). */
function memo(key: string, produce: (signal: AbortSignal) => Promise<Buffer | null>): Promise<Buffer | null> {
  const hit = cached(key);
  if (hit) return Promise.resolve(hit.bytes);
  let p = inflight.get(key);
  if (!p) {
    // the shared run has its own budget, so one caller's abort doesn't fail the others
    const own = AbortSignal.timeout(WEB_IMAGE_BUDGET_MS);
    p = produce(own)
      .then((b) => { if (b || !own.aborted) remember(key, b); return b; }, () => null)
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** Wikipedia's lead picture for a title (fast, no AI): the common-ingredient / dish path. */
async function wikiPicture(v: FindsVendors, title: string, signal: AbortSignal): Promise<Buffer | null> {
  if (!v.wikiImage || !v.productImage) return null;
  const url = await timeboxed((s) => v.wikiImage!(title, s), PAGE_MS, signal);
  if (!url) return null;
  const bytes = await timeboxed((s) => v.productImage!(url, s), PAGE_MS, signal);
  return bytes?.length ? bytes : null;
}

function firstOf(ps: Promise<Buffer | null>[]): Promise<Buffer | null> {
  if (!ps.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    let left = ps.length;
    for (const p of ps) p.then((b) => { left--; if (b) resolve(b); else if (!left) resolve(null); }, () => { left--; if (!left) resolve(null); });
  });
}

export type FindOpts = {
  budgetMs?: number;
  /** Wikipedia titles tried first, in order (an ingredient or a dish) */
  wiki?: string[];
  /** more searches when `query` finds nothing, run together ("<x> food", "<x>") */
  variants?: string[];
};

/**
 * One photo for `query`, or null (nothing found, over budget, off, aborted). Never throws. Wikipedia titles first,
 * then the web search for `query`, then its variants together. Each step is cached on its own.
 */
export async function findWebImage(v: FindsVendors, query: string, signal: AbortSignal, opts: FindOpts = {}): Promise<Buffer | null> {
  if (!webImagesOn() || !v.productImage) return null;
  const key = norm(query);
  if (!key) return null;
  if (signal.aborted) return null;
  const searchFor = (q: string) => (v.pageFacts ? memo(norm(q), (s) => search(v, norm(q), s)) : Promise.resolve(null));
  // `s` = the caller's signal + this call's budget: nothing new (a paid search) starts once it is over (Codex P2);
  // a lookup already shared with other callers keeps running for them
  const run = async (s: AbortSignal): Promise<Buffer | null> => {
    for (const t of opts.wiki ?? []) {
      if (s.aborted) return null;
      if (!norm(t)) continue;
      const b = await memo(`wiki:${norm(t)}`, (sig) => wikiPicture(v, t, sig));
      if (b) return b;
    }
    if (s.aborted) return null;
    const b = await searchFor(query);
    if (b || s.aborted) return b;
    return firstOf((opts.variants ?? []).filter((q) => norm(q) && norm(q) !== key).map(searchFor));
  };
  return timeboxed(run, opts.budgetMs ?? WEB_IMAGE_BUDGET_MS, signal);
}

/** An ingredient's lookups: Wikipedia ("anchovy stock", then "stock", then "anchovy"), then "<x> ingredient", "<x> food", "<x>". */
export function ingredientLookups(label: string): { query: string; wiki: string[]; variants: string[] } {
  const base = label.split(" · ")[0].trim().toLowerCase();
  const words = base.split(/\s+/).filter(Boolean);
  const wiki = [...new Set([base, ...(words.length > 1 ? [words.slice(1).join(" "), words[0]] : [])])];
  return { query: `${base} ingredient`, wiki, variants: [`${base} food`, base] };
}

export type ImageJob = { slot: string; query: string; /** the page's own picture first (e.g. the top recipe page) */ page?: string } & Omit<FindOpts, "budgetMs">;

/**
 * Finds each job's photo in parallel and sends find.image {status:"ready"} for the ones found (none for the rest).
 * Returns the slots sent → their FindImage, so the pipeline can fall back (illustration) or keep them on the card.
 */
export async function sendFoundImages(
  ctx: { findId: string; vendors: FindsVendors; signal: AbortSignal; emit: (e: ServerEvent) => void; putImage: (slot: string, bytes: Buffer) => Promise<string>; log: (event: string, data: Record<string, unknown>) => void },
  jobs: ImageJob[],
  onReady?: (slot: string, img: FindImage) => void,
): Promise<Map<string, FindImage>> {
  const sent = new Map<string, FindImage>();
  await Promise.all(
    jobs.map(async (j) => {
      const bytes = (j.page ? await pagePicture(ctx.vendors, j.page, ctx.signal) : null) ?? (await findWebImage(ctx.vendors, j.query, ctx.signal, { wiki: j.wiki, variants: j.variants }));
      if (!bytes || ctx.signal.aborted) {
        if (!ctx.signal.aborted) ctx.log("find.web_image_none", { findId: ctx.findId, slot: j.slot });
        return;
      }
      try {
        const url = await ctx.putImage(j.slot, bytes);
        if (ctx.signal.aborted) return;
        const img: FindImage = { slot: j.slot, status: "ready", url };
        sent.set(j.slot, img);
        onReady?.(j.slot, img);
        ctx.emit({ type: "find.image", findId: ctx.findId, slot: j.slot, status: "ready", url });
      } catch (err) {
        ctx.log("find.web_image_store_failed", { findId: ctx.findId, slot: j.slot, message: String(err).slice(0, 120) });
      }
    }),
  );
  return sent;
}
