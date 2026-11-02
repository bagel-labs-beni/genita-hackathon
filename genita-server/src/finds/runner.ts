/**
 * One per call. The session hands every non-interpret user turn here; if it
 * asks for a card (intent.ts) a pipeline runs beside the spoken answer.
 * Keeps the cards of this call, persists them to the owner's Finds, applies
 * "맞아?" answers, and gives the session one line of context about the card
 * on screen so "Ask about this" follow-ups make sense.
 */
import { randomUUID } from "node:crypto";
import type { FindCard, ServerEvent } from "../protocol.ts";
import { classifyTurn } from "./intent.ts";
import { confirmItem, runLink, runOutfit, runRecipe, type PipelineCtx, type PipelineResult } from "./pipeline.ts";
import { ownerKey, type FindsStore } from "./store.ts";
import type { FindsVendors } from "./vendors.ts";

export type FindsDeps = {
  vendors: FindsVendors;
  store: FindsStore;
  images: boolean;
  /** "/v1/finds" — image URLs are `${base}/${id}/images/${slot}` */
  imageBase: string;
};

export type TurnInput = {
  text: string;
  frames: string[];
  utteranceId: number;
  replyText: Promise<string | null>;
};

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
  private readonly cards = new Map<string, FindCard>();
  private readonly running = new Map<string, Running>();
  private focusId: string | null = null;
  private closed = false;

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
  }

  /** Starts a card pipeline if the turn asks for one. Returns the find id or null. */
  onTurn(t: TurnInput): string | null {
    if (this.closed) return null;
    const intent = classifyTurn(t.text, t.frames.length > 0);
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
      putImage: async (slot, bytes) => {
        await this.deps.store.putImage(findId, slot, bytes);
        return `${this.deps.imageBase}/${findId}/images/${slot}`;
      },
    };
    const run = intent.kind === "recipe" ? runRecipe : intent.kind === "outfit" ? runOutfit : runLink;
    const done = run(ctx).catch((err) => {
      if (!abort.signal.aborted) {
        this.hooks.emit({ type: "find.failed", findId, reason: "error", message: "Something went wrong while I was looking." });
        this.hooks.log("find.error", { findId, message: String(err).slice(0, 200) });
      }
      return { card: null, timings: {} } as PipelineResult;
    });
    this.running.set(findId, { abort, done });
    void done.then((r) => {
      this.running.delete(findId);
      this.hooks.log("find.done", { findId, kind: intent.kind, ok: !!r.card, ...r.timings });
      if (r.card) void this.persist(r.card);
    });
    return findId;
  }

  /** Waits for every running pipeline (tests, e2e script). */
  async settle(): Promise<PipelineResult[]> {
    return Promise.all([...this.running.values()].map((r) => r.done));
  }

  private onEvent(e: ServerEvent): void {
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
        void this.persist(card);
      }
    }
    if (!this.closed) this.hooks.emit(e);
  }

  private async persist(card: FindCard): Promise<void> {
    if (!this.owner) return;
    try {
      await this.deps.store.put(this.owner, card);
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
    if (c.options.length) parts.push(`options: ${c.options.map((o) => `${o.label}${o.picked ? " (your pick)" : ""}`).join(", ")}`);
    if (c.steps.length) parts.push(`${c.kind === "link" ? "takeaways" : "steps"}: ${c.steps.map((s, i) => `${i + 1}. ${s.text}`).join(" ")}`);
    if (c.why.length) parts.push(`why: ${c.why.join(" ")}`);
    if (c.page && !c.page.opened) parts.push("you could not open the page itself");
    if (c.sources[0]) parts.push(`source: ${c.sources[0].domain}`);
    return parts.join("; ").slice(0, 900);
  }

  close(): void {
    // a call ending keeps cards (they finish their pictures and stay in
    // Finds) and stops pipelines that have not made a card yet
    this.closed = true;
    for (const [id, r] of this.running) if (!this.cards.has(id)) r.abort.abort();
  }
}
