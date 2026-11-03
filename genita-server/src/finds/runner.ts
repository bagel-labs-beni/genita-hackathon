/**
 * One per call. The session hands every non-interpret user turn here; if it
 * asks for a card (intent.ts) a pipeline runs beside the spoken answer.
 * Keeps the cards of this call, persists them to the owner's Finds, applies
 * "맞아?" answers, and gives the session one line of context about the card
 * on screen so "Ask about this" follow-ups make sense.
 */
import { randomUUID } from "node:crypto";
import type { FindCard, FindKind, ServerEvent } from "../protocol.ts";
import { classifyTurn, isProductAsk } from "./intent.ts";
import { PRODUCT_COUNT, SEARCH_TITLE, guessLabel, runProduct, shortLabel } from "./product.ts";
import { confirmItem, runLink, runOutfit, runRecipe, type PipelineCtx, type PipelineResult } from "./pipeline.ts";
import { ownerKey, type FindsStore } from "./store.ts";
import type { FindsVendors } from "./vendors.ts";

export type FindsDeps = {
  vendors: FindsVendors;
  store: FindsStore;
  images: boolean;
  /** "/v1/finds" — image URLs are `${base}/${id}/images/${slot}` */
  imageBase: string;
  /** F7: the account's I04 "Likes & dislikes" lines (server-side style card); undefined = none */
  likes?: (userId: string) => Promise<string[] | undefined>;
  /** F7: where to shop ("US" default, GENITA_SHOP_REGION) */
  shopRegion?: string;
  /** F7: identical product searches raced (GENITA_PRODUCT_HEDGE, default 2; 1 = off) */
  productHedge?: number;
  /** demo S5: start the "goes with" search when an outfit card lands (GENITA_PRODUCT_PREFETCH=0 turns it off) */
  productPrefetch?: boolean;
};

/** What the session says instead of a full answer while a card is being made (PF-1 "On it…"). */
export const ACK: Partial<Record<FindKind, string>> = { product: "On it.", recipe: "Let me take a look." };

/** Demo S5: an outfit card's background search for what goes with it is reused this long. */
export const PREFETCH_WINDOW_MS = 5 * 60_000;
/** what an outfit answer can suggest buying next ("dark brown shoes or leather accessories") */
const GOES_WITH = /\b(shoes|sneakers|boots|loafers|heels|sandals|bag|bags|belt|belts|scarf|hat|jewelry|earrings|necklace|accessories|jacket|coat)\b/gi;

type Prefetch = {
  at: number;
  /** words the background search looked for (lowercased): a later ask must name one of them, or none */
  wants: Set<string>;
  question: string;
  label: string;
  events: ServerEvent[];
  images: Map<string, Buffer>;
  listeners: Set<(e: ServerEvent) => void>;
  done: Promise<PipelineResult & { label?: string }>;
  abort: AbortController;
};

/** A product ask with no thing named ("match my style", "send me the links") refines the last search (D25). */
const REFINE_WINDOW_MS = 15 * 60_000;

/** item words in an ask ("shoes", "lamp"): one the prefetch didn't look for means a fresh search */
const PRODUCT_WORD = /^(shoes?|sneakers?|boots?|loafers?|heels?|sandals?|bags?|belts?|scarf|scarves|hats?|jewelry|earrings?|necklaces?|accessories|accessory|jackets?|coats?|lamps?|chairs?|mugs?|headphones|earbuds|dress|dresses|shirts?|pants|jeans|sweaters?|hoodies?|tote|backpack|watch|sunglasses|gift|tops?|skirts?)$/;

export type TurnInput = {
  text: string;
  frames: string[];
  utteranceId: number;
  replyText: Promise<string | null>;
  /** last few lines of the conversation, oldest first (product refine on the Mac) */
  recent?: string[];
};

export type TurnStarted = { findId: string; kind: FindKind; ack?: string };

export type RunnerHooks = {
  emit: (e: ServerEvent) => void;
  /** have the companion say a line if it is idle (card landed) */
  announce: (text: string) => void;
  log: (event: string, data: Record<string, unknown>) => void;
  now: () => number;
};

type Running = { abort: AbortController; done: Promise<PipelineResult> };

export class FindsRunner {
  private readonly deps: FindsDeps;
  private readonly hooks: RunnerHooks;
  private owner: string | null = null;
  private memories: string[] = [];
  private profile: string | undefined;
  private userName: string | undefined;
  private timeZone: string | undefined;
  private likes: Promise<string[] | undefined> = Promise.resolve(undefined);
  private lastProduct: { label: string; question: string; at: number } | null = null;
  private readonly cards = new Map<string, FindCard>();
  private readonly running = new Map<string, Running>();
  private focusId: string | null = null;
  private closed = false;
  private prefetched: Prefetch | null = null;

  constructor(deps: FindsDeps, hooks: RunnerHooks) {
    this.deps = deps;
    this.hooks = hooks;
  }

  configure(o: { owner?: string; memories: string[]; profile?: string; userName?: string; timeZone?: string }): void {
    this.owner = o.owner ? ownerKey(o.owner.slice(0, 128)) : null;
    this.memories = o.memories;
    this.profile = o.profile;
    this.userName = o.userName;
    this.timeZone = o.timeZone && /^[A-Za-z_+\-/0-9]{1,40}$/.test(o.timeZone) ? o.timeZone : undefined;
    // the account's style card, read once per call (a failure just means no blue chip)
    this.likes = o.owner && this.deps.likes ? this.deps.likes(o.owner).catch(() => undefined) : Promise.resolve(undefined);
  }

  /** Starts a card pipeline if the turn asks for one. Returns the find (and what to say first) or null. */
  onTurn(t: TurnInput): TurnStarted | null {
    if (this.closed || (this.owner && this.deps.store.work.isDeleted(this.owner))) return null;
    const afterProduct =
      (!!this.lastProduct && this.hooks.now() - this.lastProduct.at < REFINE_WINDOW_MS) ||
      // a call continued on the other device: the search was asked on the first one (#199)
      (t.recent ?? []).some((l) => l.startsWith("User: ") && isProductAsk(l.slice(6)));
    const intent = classifyTurn(t.text, t.frames.length > 0, afterProduct);
    if (!intent) return null;
    const findId = randomUUID();
    const abort = new AbortController();
    const ctx: PipelineCtx = {
      findId,
      utteranceId: t.utteranceId,
      kind: intent.kind,
      question: t.text,
      frames: t.frames,
      url: intent.url,
      memories: this.memories,
      profile: this.profile,
      userName: this.userName,
      replyText: t.replyText,
      timeZone: this.timeZone,
      vendors: this.deps.vendors,
      emit: (e) => this.onEvent(e),
      signal: abort.signal,
      now: this.hooks.now,
      log: this.hooks.log,
      images: this.deps.images,
      speak: (text) => {
        const card = this.cards.get(findId);
        if (card) void this.persist(card);
        if (!this.closed) this.hooks.announce(text);
      },
      putImage: async (slot, bytes) => {
        if (this.purged || (this.owner && this.deps.store.work.isDeleted(this.owner))) throw new Error("account deleted");
        await this.deps.store.work.write(this.owner, () => this.deps.store.putImage(findId, slot, bytes));
        return `${this.deps.imageBase}/${findId}/images/${slot}`;
      },
    };
    let run: (c: PipelineCtx) => Promise<PipelineResult>;
    if (intent.kind === "product") {
      const now = this.hooks.now();
      const named = guessLabel(t.text, "") !== "";
      let prev = this.lastProduct && now - this.lastProduct.at < REFINE_WINDOW_MS && !named ? this.lastProduct : null;
      // #199: a call continued on the other device has no search of its own yet — the item comes from the
      // conversation's recent turns ("can we look for a jacket…" said on the iPhone)
      if (!prev && !named) {
        const said = [...(t.recent ?? [])].reverse().find((l) => /^User: /.test(l) && guessLabel(l, "") !== "");
        if (said) prev = { label: guessLabel(said, "Things"), question: said.replace(/^User: /, ""), at: now };
      }
      this.lastProduct = { label: prev?.label ?? guessLabel(t.text, "Things"), question: prev ? `${prev.question} — ${t.text}` : t.text, at: now };
      const likes = this.likes;
      const pre = prev ? null : this.takePrefetch(t.text, now);
      if (pre) this.lastProduct = { label: pre.label, question: `${pre.question} — ${t.text}`, at: now };
      run = pre ? (c) => this.replayPrefetch(pre, c, t) : async (c) => {
        const r = await runProduct({ ...c, likes: await likes, recent: t.recent ?? [], previous: prev?.question, region: this.deps.shopRegion, hedge: this.deps.productHedge });
        if (r.label && this.lastProduct) this.lastProduct.label = r.label;
        return r;
      };
    } else if (intent.kind === "outfit") {
      // the "goes with" search starts as soon as the spoken pick is out (~4 s), not after the card (~8 s):
      // Spark search takes 15–30 s, every second of head start shows on camera
      let prefetching = false;
      void t.replyText.then((said) => {
        if (said && !abort.signal.aborted) { prefetching = true; this.startPrefetch(null, said, t); }
      }).catch(() => {});
      run = async (c) => {
        const r = await runOutfit(c);
        if (r.card && !prefetching && !c.signal.aborted) this.startPrefetch(r.card, r.card.say ?? null, t);
        return r;
      };
    } else run = intent.kind === "recipe" ? runRecipe : runLink;
    const release = this.deps.store.work.track(this.owner, () => this.close({ purge: true }));
    const done = run(ctx).catch((err) => {
      if (!abort.signal.aborted) {
        this.onEvent({ type: "find.failed", findId, reason: "error", message: "Something went wrong. Ask me again in a moment." });
        this.hooks.log("find.error", { findId, message: String(err).slice(0, 200) });
      }
      return { card: null, timings: {} } as PipelineResult;
    }).then(async (r) => {
      if (r.card) await this.persist(r.card);
      this.hooks.log("find.done", { findId, kind: intent.kind, ok: !!r.card, ...r.timings });
      return r;
    }).finally(() => {
      this.running.delete(findId);
      release();
    });
    this.running.set(findId, { abort, done });
    if (ACK[intent.kind]) this.acked.add(findId);
    return { findId, kind: intent.kind, ...(ACK[intent.kind] ? { ack: ACK[intent.kind] } : {}) };
  }

  /** Waits for every running pipeline (tests, e2e script). */
  async settle(): Promise<PipelineResult[]> {
    return Promise.all([...this.running.values()].map((r) => r.done));
  }

  // ───────── demo S5: the search for what goes with a picked outfit, started before she asks ─────────

  private startPrefetch(card: FindCard | null, said: string | null, t: TurnInput): void {
    if (this.closed || this.deps.productPrefetch === false) return;
    const reply = (said ?? card?.say ?? "").slice(0, 300);
    const wants = new Set([...reply.matchAll(GOES_WITH)].map((m) => m[1].toLowerCase()));
    if (!wants.size) for (const w of ["shoes", "accessories", "bag"]) wants.add(w);
    const picked = card ? ` (${card.status || card.title})` : "";
    const question = `Find shoes or accessories that go with the outfit they just picked${picked}.${reply ? ` What you told them: "${reply}". If you named shoes or accessories there, find those.` : ""}`;
    this.prefetched?.abort.abort();
    const abort = new AbortController();
    const p: Prefetch = { at: this.hooks.now(), wants, question, label: guessLabel(reply, "Shoes"), events: [], images: new Map(), listeners: new Set(), abort, done: Promise.resolve({ card: null, timings: {} }) };
    const findId = `prefetch-${randomUUID()}`;
    const ctx: PipelineCtx = {
      findId, utteranceId: t.utteranceId, kind: "product", question, frames: t.frames.slice(-1), memories: this.memories, profile: this.profile, userName: this.userName,
      replyText: Promise.resolve(null), timeZone: this.timeZone, vendors: this.deps.vendors, signal: abort.signal, now: this.hooks.now, log: this.hooks.log, images: this.deps.images,
      emit: (e) => { p.events.push(e); for (const l of p.listeners) l(e); },
      putImage: async (slot, bytes) => { p.images.set(slot, bytes); return `prefetch:${slot}`; },
    };
    const likes = this.likes;
    // one more lane than a normal search: Spark search time varies 15–30 s and the first good lane wins
    const hedge = Math.min(3, (this.deps.productHedge ?? 2) + 1);
    p.done = (async () => runProduct({ ...ctx, likes: await likes, recent: t.recent ?? [], region: this.deps.shopRegion, hedge }))().catch(() => ({ card: null, timings: {} }));
    this.prefetched = p;
    this.hooks.log("product.prefetch", { wants: [...wants].slice(0, 6) });
  }

  /** The prefetch fits this ask: fresh, and the ask names nothing it didn't look for. */
  private takePrefetch(text: string, now: number): Prefetch | null {
    const p = this.prefetched;
    if (!p || now - p.at > PREFETCH_WINDOW_MS) return null;
    const named = [...text.matchAll(/\b([a-z]+)\b/gi)].map((m) => m[1].toLowerCase());
    const itemWords = named.filter((w) => PRODUCT_WORD.test(w));
    if (itemWords.length && !itemWords.some((w) => p.wants.has(w) || p.wants.has(`${w}s`) || p.wants.has(w.replace(/s$/, "")))) return null;
    this.prefetched = null;
    return p;
  }

  /** Puts the prefetched search on screen under this ask's own find id (events, card, pictures). */
  private async replayPrefetch(p: Prefetch, c: PipelineCtx, t: TurnInput): Promise<PipelineResult> {
    c.emit({ type: "find.started", findId: c.findId, utteranceId: c.utteranceId, kind: "product", title: SEARCH_TITLE, detail: `${shortLabel(p.label)} · searching shops` });
    let card: FindCard | null = null;
    const forward = async (e: ServerEvent) => {
      // a prefetch that found nothing is never shown: this ask searches itself (below)
      if (c.signal.aborted || e.type === "find.started" || e.type === "find.failed") return;
      if (e.type === "find.image") {
        const bytes = e.status === "ready" ? p.images.get(e.slot) : undefined;
        if (bytes) {
          try { c.emit({ ...e, findId: c.findId, url: await c.putImage(e.slot, bytes) }); } catch { c.emit({ ...e, findId: c.findId, status: "failed", url: undefined }); }
        } else c.emit({ ...e, findId: c.findId, status: "failed", url: undefined });
        return;
      }
      if (e.type === "find.created") { card = { ...e.card, id: c.findId }; c.emit({ ...e, findId: c.findId, card }); return; }
      c.emit({ ...e, findId: c.findId } as ServerEvent);
    };
    const queue: Promise<void>[] = [];
    for (const e of p.events) queue.push(forward(e));
    p.listeners.add((e) => queue.push(forward(e)));
    const r = await p.done;
    await Promise.all(queue);
    p.listeners.clear();
    if (r.card) return { card, timings: { ...r.timings, prefetched: 1 } };
    // the background search found nothing: search for this ask itself (the failure was never shown)
    const likes = this.likes;
    return runProduct({ ...c, likes: await likes, recent: t.recent ?? [], region: this.deps.shopRegion, hedge: this.deps.productHedge });
  }

  private onEvent(e: ServerEvent): void {
    if (this.purged || (this.owner && this.deps.store.work.isDeleted(this.owner))) return;
    // after the call ends, finished cards still get their pictures saved
    if (e.type === "find.created") {
      this.cards.set(e.findId, e.card);
      this.focusId = e.findId;
      void this.persist(e.card);
      if (e.card.say && !this.closed) this.hooks.announce(e.card.say);
    } else if (e.type === "find.image") {
      const card = this.cards.get(e.findId);
      if (card) {
        const img = { slot: e.slot, status: e.status, ...(e.url ? { url: e.url } : {}) } as const;
        if (e.slot === "hero") card.hero = img;
        const m = e.slot.match(/^step-(\d+)$/);
        if (m && card.steps[Number(m[1]) - 1]) card.steps[Number(m[1]) - 1].image = img;
        const p = e.slot.match(/^product-(\d+)$/);
        if (p && card.products?.[Number(p[1]) - 1]) card.products[Number(p[1]) - 1].image = img;
        void this.persist(card);
      }
    }
    if (e.type === "find.failed" && e.reason !== "stopped" && !this.closed && this.acked.has(e.findId)) this.hooks.announce(e.message);
    if (!this.closed) this.hooks.emit(e);
  }
  /** finds whose turn got only the short line (ACK): their failure is said out loud */
  private readonly acked = new Set<string>();

  private async persist(card: FindCard): Promise<void> {
    if (!this.owner || this.purged) return;
    const owner = this.owner;
    try {
      await this.deps.store.work.write(owner, () => this.deps.store.put(owner, card));
    } catch (err) {
      this.hooks.log("find.store_error", { findId: card.id, message: String(err).slice(0, 160) });
    }
  }

  confirm(findId: string, itemId: string, yes: boolean): void {
    const card = this.cards.get(findId);
    if (!card || !confirmItem(card, itemId, yes)) return;
    this.hooks.emit({ type: "find.items", findId, items: card.items, checking: this.running.has(findId), subtitle: card.subtitle, ...(card.status ? { status: card.status } : {}) });
    void this.persist(card);
  }

  stop(findId: string): void {
    const r = this.running.get(findId);
    if (!r) return;
    r.abort.abort();
    this.running.delete(findId);
    this.hooks.emit({ type: "find.failed", findId, reason: "stopped", message: "Stopped." });
  }

  focus(findId: string): void {
    if (this.cards.has(findId)) this.focusId = findId;
  }

  /** One line for the system prompt about the card on screen, or undefined. Data only. */
  onScreen(): string | undefined {
    const c = this.focusId ? this.cards.get(this.focusId) : undefined;
    if (!c) return undefined;
    const parts = [`${c.title}${c.subtitle ? ` (${c.subtitle})` : ""}`];
    if (c.kind === "recipe") {
      const by = (t: string) => c.items.filter((i) => i.tier === t).map((i) => i.name).join(", ");
      if (by("have")) parts.push(`they have: ${by("have")}`);
      if (by("maybe")) parts.push(`not sure: ${by("maybe")}`);
      if (by("buy")) parts.push(`not seen: ${by("buy")}`);
    }
    if (c.products?.length) {
      parts.push(`products: ${c.products.map((p, i) => `${i + 1}. ${p.name} (${p.store}, ${p.price ?? "price on the site"}; ${[p.taste, p.situation].filter(Boolean).join(", ")})`).join(" ")}`);
      if (c.evidence?.style) parts.push(`their style line: ${c.evidence.style}`);
      if (c.products.length < PRODUCT_COUNT) parts.push("only one product page opened");
    }
    if (c.options.length) parts.push(`options: ${c.options.map((o) => `${o.label}${o.picked ? " (your pick)" : ""}`).join(", ")}`);
    if (c.steps.length) parts.push(`${c.kind === "link" ? "takeaways" : "steps"}: ${c.steps.map((s, i) => `${i + 1}. ${s.text}`).join(" ")}`);
    if (c.why.length) parts.push(`why: ${c.why.join(" ")}`);
    if (c.page && !c.page.opened) parts.push("you could not open the page itself");
    if (c.sources[0]) parts.push(`source: ${c.sources[0].domain}`);
    return parts.join("; ").slice(0, 900);
  }

  close(opts: { purge?: boolean } = {}): void {
    // a call ending keeps cards (they finish their pictures and stay in
    // Finds) and stops pipelines that have not made a card yet.
    // purge (account deleted): stop everything and never write again.
    this.closed = true;
    if (opts.purge) this.purged = true;
    this.prefetched?.abort.abort();
    this.prefetched = null;
    for (const [id, r] of this.running) if (opts.purge || !this.cards.has(id)) r.abort.abort();
  }
  private purged = false;
}
