/**
 * One per call. The session hands every non-interpret user turn here; if it
 * asks for a card (intent.ts) a pipeline runs beside the spoken answer.
 * Keeps the cards of this call, persists them to the owner's Finds, applies
 * "맞아?" answers, and gives the session one line of context about the card
 * on screen so "Ask about this" follow-ups make sense.
 */
import { webAnswerCard, type WebSearch } from "./webAnswer.ts";
import { applySourceImage, assessLine, generalLayout, rowPictures, runGeneral } from "./general.ts";
import { JUDGE_TIMEOUT_MS, judgeEnabled, judgeWithin, sparkJudge, type Judge, type JudgeResult } from "./judge.ts";
import type { Intent } from "./intent.ts";
import { findUrl } from "./parse.ts";
import { reasonChips, tasteLines, type TasteLine } from "../personalize/reasons.ts";
import { randomUUID } from "node:crypto";
import type { FindCard, FindImage, FindKind, FindProduct, ServerEvent } from "../protocol.ts";
import { classifyTurn, isBareAccept, isGoesWithFollowUp, isLinksAsk, isProductAsk, refersToScreen } from "./intent.ts";
import { PRODUCT_COUNT, SEARCH_TITLE, decidePick, guessLabel, runProduct, shortLabel, tasteLines as productTaste } from "./product.ts";
import { runNamedRecipe } from "./namedRecipe.ts";
import { walkPlan, type WalkPlan, type WalkState } from "./walkthrough.ts";
import { choiceForSearch, isColorWord } from "./choice.ts";
import { confirmItem, FRIDGE_UNCLEAR, IDENTIFY_UNSURE, runIdentify, runLink, runOutfit, runRecipe, type PipelineCtx, type PipelineResult } from "./pipeline.ts";
import { cacheGet, cacheKey, cachePut, cardFitsColors, cardIsKind, categoryOf, claimWarm, colorAsks, colorPhrases, colorsOf, plainAsk, releaseWarm, type CachedProducts } from "./productCache.ts";
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
  /** F7: identical product searches raced (GENITA_PRODUCT_HEDGE, default 3; 1 = off) */
  productHedge?: number;
  /** demo S5: start the "goes with" search when an outfit card lands (GENITA_PRODUCT_PREFETCH=0 turns it off) */
  productPrefetch?: boolean;
  /** S5 product cache + background warm-up (GENITA_PRODUCT_CACHE=0 turns it off) */
  productCache?: boolean;
  /** the find judge (judge.ts); default: one Spark call. Tests stub it. */
  judge?: Judge;
  /** the judge's deadline (default JUDGE_TIMEOUT_MS) */
  judgeTimeoutMs?: number;
  /** demo S5: a product search with nothing on screen by then gets one "still hunting" line (default 30 s) */
  stillSearchingMs?: number;
};

/** What the session says instead of a full answer while a card is being made (PF-1 "On it…"). */
// recipe: a reaction to what's shown, not a lookup announcement ("Let me take a look." read as narration, 11/3)
// AU-59: said before anything is looked at, so it never sounds like it saw something ("nice haul" on a dark shelf,
// then "I can't make out the shelves"); a reaction, not narration
// answer (general.ts) has none: the turn answers in one sentence itself (Chelsea 11/4 "섞어"), the card says its line
export const ACK: Partial<Record<FindKind, string>> = { product: "On it.", recipe: "Ooh, let me see." };

/** Demo S5: an outfit card's background search for what goes with it is reused this long. */
export const PREFETCH_WINDOW_MS = 5 * 60_000;
/** demo S5: send the outfit frames with the prefetch search (GENITA_PREFETCH_FRAMES=1) or only what was said (default) */
export function prefetchHedge(productHedge = 2, env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.GENITA_PREFETCH_HEDGE);
  // default 5 (11/3 S4→S5, text-only: S5 card 11.1 / 4.9 / 8.0 s with 5 lanes vs 1.3 / 13.5 / 10.6 s with 3)
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : Math.max(5, productHedge);
}
/** the companion's line names the pick by color ("Black, for sure…"): the search can go by what was said (Codex P2: "the first one" can't) */
export function namesPick(said: string): boolean {
  const words = [...said.toLowerCase().matchAll(/[a-z]+/g)].map((m) => m[0]);
  // a color of what it recommends ("dark brown shoes", "black leather belt") is not the pick (Codex P2)
  const goesWith = /^(shoes?|boots?|loafers?|sneakers?|heels?|flats|sandals?|bags?|belts?|watch|scarf|hat|accessories|leather|suede|jewelry|socks)$/;
  return words.some((w, i) => COLOR.test(w) && !words.slice(i + 1, i + 4).some((n) => goesWith.test(n)));
}
/** the account's colors with their modifier ("dark brown"), at most 3, for the cache warm-up */
export function warmColors(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/\b((?:dark|light|deep|pale) )?(black|white|grey|gray|navy|blue|red|green|pink|purple|yellow|orange|beige|camel|tan|brown|cream|ivory|olive|burgundy)\b/g)) {
    const c = `${m[1] ?? ""}${m[2]}`;
    if (!out.includes(c)) out.push(c);
    if (out.length >= 3) break;
  }
  return out;
}
export function prefetchFrames(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GENITA_PREFETCH_FRAMES === "1";
}
/** what an outfit answer can suggest buying next ("dark brown shoes or leather accessories") */
const GOES_WITH = /\b(shoes|sneakers|boots|loafers|heels|sandals|bag|bags|belt|belts|scarf|hat|jewelry|earrings|necklace|accessories|jacket|coat)\b/gi;

type Prefetch = {
  at: number;
  /** words the background search looked for (lowercased): a later ask must name one of them, or none */
  wants: Set<string>;
  question: string;
  /** what the search had in view (question + taste lines), lowercased: an ask's colors must be in it */
  inView: string;
  label: string;
  events: ServerEvent[];
  images: Map<string, Buffer>;
  listeners: Set<(e: ServerEvent) => void>;
  done: Promise<PipelineResult & { label?: string }>;
  /** the background search has ended (with or without a card) */
  settled: boolean;
  abort: AbortController;
};

/** A product ask with no thing named ("match my style", "send me the links") refines the last search (D25). */
const REFINE_WINDOW_MS = 15 * 60_000;

/** item words in an ask ("shoes", "lamp"): one the prefetch didn't look for means a fresh search */
const PRODUCT_WORD = /^(shoes?|sneakers?|boots?|loafers?|heels?|sandals?|bags?|belts?|scarf|scarves|hats?|jewelry|earrings?|necklaces?|accessories|accessory|jackets?|coats?|lamps?|chairs?|mugs?|headphones|earbuds|dress|dresses|shirts?|pants|jeans|sweaters?|hoodies?|tote|backpack|watch|sunglasses|gift|tops?|skirts?)$/;

/** intent.ts's shopping nouns too ("blazer", "parka", "cardigan"…) */
const ITEM_NOUN = /^(blazers?|parkas?|vests?|overshirts?|t-?shirts?|tees?|cardigans?|trousers|shorts|totes?|caps?|scarves|mugs?|chairs?|lamps?|outfits?)$/;
/**
 * Capitalized words mid-sentence ("some Nike shoes"), lowercased. Not one: a sentence start, "I…", or a name being
 * spoken to ("Hey Rio, …", "Okay Rio, find…": right after a greeting word).
 */
export function brandsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/([A-Z][a-zA-Z&'-]+)/g)) {
    const at = m.index ?? 0;
    const before = text.slice(0, at).trimEnd();
    const word = m[1];
    if (!before || /[.!?]$/.test(before) || /^I('|$)/.test(word)) continue;
    // a name being spoken to: after a greeting word only (a comma alone is not enough: "from Nike, preferably…")
    if (/\b(hey|hi|hello|okay|ok|so|thanks|yo|and|well)$/i.test(before)) continue;
    out.push(word.toLowerCase());
  }
  return out;
}

const EXCLUDE = /\b(no|not|without|non|except|other than|instead of|aren't|isn't|don't|nothing)\b/;
const MATERIAL = /^(leather|suede|canvas|wool|cotton|linen|denim|silk|cashmere|nylon|vegan|patent|rubber|knit|velvet|satin|mesh)$/;
const COLOR = /^(black|white|grey|gray|navy|blue|red|green|pink|purple|yellow|orange|beige|camel|tan|brown|cream|ivory|olive|burgundy|neon|silver|gold)$/;

/** "Still hunting for the right pair, one sec." (shoes) / "…the right jacket…" */
export function stillHunting(label: string): string {
  const l = label.toLowerCase();
  const thing = /shoe|sneaker|boot|loafer|sandal|heel/.test(l) ? "pair" : l === "things" ? "one" : l.replace(/s$/, "");
  return `Still hunting for the right ${thing}, one sec.`;
}

export type TurnInput = {
  text: string;
  frames: string[];
  utteranceId: number;
  replyText: Promise<string | null>;
  /** last few lines of the conversation, oldest first (product refine on the Mac) */
  recent?: string[];
  /** D59: the app judged these frames too dark or too blurry to see anything */
  unclear?: boolean;
  /** Chelsea 11/4 D: the Mac's shared screen right now (watch together), when a share is on */
  screen?: string;
  /** the turn's own signal (barge-in, cancel): a judged card for a cancelled turn never starts */
  signal?: AbortSignal;
};

/** A find.image on the stored card: hero · step-N (1-based) · product-N (1-based) · source-N (0-based) · ingredient-<item id>. */
export function applyFindImage(card: FindCard, img: FindImage, replace?: FindProduct): void {
  if (img.slot === "hero") card.hero = img;
  const m = img.slot.match(/^step-(\d+)$/);
  if (m && card.steps[Number(m[1]) - 1]) card.steps[Number(m[1]) - 1].image = img;
  const p = img.slot.match(/^product-(\d+)$/);
  if (p && card.products?.[Number(p[1]) - 1]) {
    const i = Number(p[1]) - 1;
    // no empty pictures: the next verified product (with its picture) takes the slot's place
    if (replace) {
      card.products[i] = replace;
      if (card.sources[i]) card.sources[i] = { title: replace.name, url: replace.url, domain: replace.domain };
    } else card.products[i].image = img;
  }
  if (img.slot.startsWith("ingredient-")) {
    const item = card.items.find((i) => i.id === img.slot.slice("ingredient-".length));
    if (item) item.image = img;
  }
  applySourceImage(card, img);
}

/** reaction: S5 — the spoken line made from the same pick the search shops (null = say the plain ack) */
export type TurnStarted = { findId: string; kind: FindKind | "identify"; named?: true; ack?: string; reaction?: Promise<string | null> };

/** "What's this?": a reaction while it looks (the name comes after the checks, like the fridge) */
export const IDENTIFY_ACK = "Ooh, let me look.";
/** the line says it's about the share ("on my screen", "this video") */
const SCREEN_WORDS = /\b(?:on (?:my|the) screen|(?:this|the|in the) (?:video|clip|show|movie|scene)|on the share|screen share)\b/i;
/** the line says it's about them / the camera, not the share */
// "shoes that would go with this" (demo S5) is about what she has on, even with a share open (QA 11/4)
const CAMERA_WORDS = /\b(?:camera|on me|i'?m wearing|i am wearing|i have on|my outfit|this outfit|i'?m holding|in my hand|my hand|go(?:es)? with (?:this|it)|match(?:es)? this)\b|입고|들고/i;
/** Codex r1 P2: recipe / outfit made from a shared-screen frame — its boxes are not for the camera preview (null = dropped). */
export function screenEvent(e: ServerEvent): ServerEvent | null {
  if (e.type === "observe.boxes") return null;
  if (e.type === "find.created" && e.card.camera) return { ...e, card: screenCard(e.card) };
  return e;
}
/** the same card as the app got: what is saved to Finds must not bring the camera picture back (Codex r2) */
export function screenCard(c: FindCard): FindCard {
  if (!c.camera) return c;
  const { camera: _camera, ...card } = c;
  return { ...card, eyebrow: "From your screen", how: card.how.map((h) => h.replace(/\byour camera\b/gi, "your shared screen")) };
}
/** the companion's last line offered to find something ("Want me to find a pair?") */
const OFFER = /\b(?:want me to|should i|shall i|i can|i could|let me|how about i)\b[^.?!]{0,60}\b(?:find|look|pull|search|grab|show|hunt)\b/i;

export type RunnerHooks = {
  emit: (e: ServerEvent) => void;
  /** have the companion say a line if it is idle (card landed) */
  announce: (text: string) => void;
  log: (event: string, data: Record<string, unknown>) => void;
  now: () => number;
};

type Running = { abort: AbortController; done: Promise<PipelineResult> };

/** demo S5: how far back "what did you find for me earlier" looks */
const RECENT_FINDS_MS = 72 * 3_600_000;
// Codex #675 r1: an ask about earlier finds, never "what do you find relaxing" / "what did you find funny about that movie"
const FOUND_ASK = /\b(?:what|which)\s+(?:shoes|boots|sneakers|products|items|picks|jackets?|coats?|dress(?:es)?|tops?|recipes?)\b[^.?!]{0,30}\b(?:did you\s+(?:find|pick|pull|show|recommend|suggest)|you\s+(?:found|picked|pulled|showed|recommended|suggested))\b|\b(?:what|which)\b[^.?!]{0,40}\b(?:did you|you)\s+(?:find|found|pick|picked|pull|pulled|recommend|recommended)\s+(?:for me\b|earlier|last time|before|yesterday)|\b(?:the|those|that) (?:shoes|boots|picks|ones|finds|products|options|stuff|things) you (?:found|picked|showed|pulled|recommended)\b|\b(?:what you|you) found (?:for me|earlier|last time|before)\b/i;
export class FindsRunner {
  private readonly deps: FindsDeps;
  private readonly hooks: RunnerHooks;
  private owner: string | null = null;
  private memories: string[] = [];
  private profile: string | undefined;
  /** lane 개인화: the user's taste lines with labels (reason chips); empty = read them from the profile text */
  private taste: TasteLine[] = [];
  private userName: string | undefined;
  private timeZone: string | undefined;
  private likes: Promise<string[] | undefined> = Promise.resolve(undefined);
  private lastProduct: { label: string; question: string; at: number } | null = null;
  /** demo scene 5: the outfit verdict just said in this call (what a "yes" to its offer means) */
  private lastOutfit: { said: string; at: number; question?: string } | null = null;
  private readonly cards = new Map<string, FindCard>();
  private readonly running = new Map<string, Running>();
  private focusId: string | null = null;
  /** P0 11/4: guided cooking of a recipe card ("Walk me through it"), or null */
  private walk: WalkState | null = null;
  private closed = false;
  private prefetched: Prefetch | null = null;
  /** cache warm-up / refresh searches of this call (stopped when it ends) */
  private readonly backgroundStops = new Set<() => void>();

  constructor(deps: FindsDeps, hooks: RunnerHooks) {
    this.deps = deps;
    this.hooks = hooks;
  }

  configure(o: { owner?: string; memories: string[]; profile?: string; userName?: string; timeZone?: string; taste?: TasteLine[] }): void {
    this.owner = o.owner ? ownerKey(o.owner.slice(0, 128)) : null;
    this.memories = o.memories;
    this.profile = o.profile;
    this.taste = o.taste ?? [];
    this.userName = o.userName;
    this.timeZone = o.timeZone && /^[A-Za-z_+\-/0-9]{1,40}$/.test(o.timeZone) ? o.timeZone : undefined;
    // the account's style card, read once per call (a failure just means no blue chip)
    this.likes = o.owner && this.deps.likes ? this.deps.likes(o.owner).catch(() => undefined) : Promise.resolve(undefined);
    // demo S5 return visit (0/5, once "I didn't pull any shoes"): this account's recent Finds, read once per call, so
    // "what did you find for me earlier?" is answered from them (foundBefore)
    this.recent = [];
    const owner = this.owner;
    if (owner) void this.deps.store.list(owner).then((cards) => {
      if (this.owner !== owner || this.purged) return;
      const since = Date.now() - RECENT_FINDS_MS;
      this.recent = cards.filter((c) => Date.parse(c.createdAt) >= since).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3);
    }).catch(() => {});
    // S5: shoes in each color this account likes, searched in the background before anyone asks (11/4)
    if (this.deps.productCache === true) void this.warmProducts();
  }

  /**
   * What a cached card is kept under: this account and its taste text. Never shared between accounts: a search's
   * taste chips and evidence can quote the account's own memories (Codex #522 r3 P1).
   */
  private tasteText(): string {
    return `account:${this.owner ?? "none"}|${(this.profile ?? "").trim()}`;
  }

  private async warmProducts(): Promise<void> {
    if (!(this.profile ?? "").trim() || this.closed) return;
    const taste = this.tasteText();
    // all colors at once: background searches yield to calls, and the ask comes ~20 s after the call starts
    await Promise.all(warmColors(taste).map(async (phrase) => {
      const key = cacheKey("shoes", colorPhrases(phrase), taste);
      if (cacheGet(key, Date.now()) || !claimWarm(key, Date.now())) return;
      const card = await this.searchInBackground(`Find ${phrase} shoes that match their style.`, `warm-${randomUUID()}`).catch(() => null);
      if (card && this.tasteText() === taste && cardIsKind(card.card, "shoes") && cardFitsColors(card.card, colorsOf(phrase))) cachePut(key, card);
      else releaseWarm(key);
    }));
  }

  /** A product search nobody waits for (cache warm-up / refresh): no events out, pictures kept in memory. */
  private async searchInBackground(question: string, findId: string): Promise<CachedProducts | null> {
    const images = new Map<string, Buffer>();
    const abort = new AbortController();
    const stop = () => abort.abort();
    this.backgroundStops.add(stop);
    try {
      const ctx: PipelineCtx = {
        findId, utteranceId: -1, kind: "product", question, frames: [], memories: this.memories, profile: this.profile, userName: this.userName,
        replyText: Promise.resolve(null), timeZone: this.timeZone, vendors: this.deps.vendors, signal: abort.signal, now: this.hooks.now, log: this.hooks.log, images: this.deps.images,
        emit: () => {},
        putImage: async (slot, bytes) => { images.set(slot, bytes); return `cache:${slot}`; },
      };
      const r = await runProduct({ ...ctx, likes: await this.likes, recent: [], region: this.deps.shopRegion, hedge: 1, background: true });
      this.hooks.log("product.cache_search", { ok: !!r.card, ms: r.timings.cardMs ?? null });
      return r.card ? { at: Date.now(), card: r.card, images } : null;
    } finally {
      this.backgroundStops.delete(stop);
    }
  }

  /** A product search of this call is still open for refines ("another one in black"). `recent` as in TurnInput. */
  /** a find is still being made (its card is not out yet): the call's backchannel cue stays quiet meanwhile */
  busy(): boolean {
    return this.running.size > 0;
  }

  afterProduct(recent: string[] = []): boolean {
    return (
      (!!this.lastProduct && this.hooks.now() - this.lastProduct.at < REFINE_WINDOW_MS) ||
      // a call continued on the other device: the search was asked on the first one (#199)
      recent.some((l) => l.startsWith("User: ") && isProductAsk(l.slice(6)))
    );
  }

  /** A correction in the call changed the profile: later cards use it. */
  setProfile(profile: string, taste: TasteLine[]): void {
    this.profile = profile;
    this.taste = taste;
  }

  /** Starts a card pipeline if the turn asks for one. Returns the find (and what to say first) or null. */
  onTurn(input: TurnInput): TurnStarted | null {
    if (this.closed || (this.owner && this.deps.store.work.isDeleted(this.owner))) return null;
    // P0 11/4: "Walk me through it" / "next" while cooking is the conversation's (walkthrough.ts), never a new search
    const walk = this.walkTurn(input.text);
    if (walk) {
      this.walk = walk.state;
      this.hooks.log("finds.walkthrough", { step: walk.state?.step ?? -1, quiet: walk.quiet });
      if (walk.quiet) {
        this.judgeAbort?.abort();
        this.judgeAbort = null;
        return null;
      }
    }
    let t = input;
    /** P0 11/4: a camera find that can't see clearly closes quietly — the spoken reply already answered */
    const afterProduct = this.afterProduct(t.recent);
    // demo S4→S5: a bare "send me the links" while the outfit's shoes are being searched already takes that search
    // (only a links ask: "does this jacket match my style?" stays an outfit question, Codex P2)
    const prefetchLive = !!this.prefetched && this.hooks.now() - this.prefetched.at < PREFETCH_WINDOW_MS;
    // demo scene 5: right after the outfit verdict, "yes" to its offer / "find me some" / "what shoes go with it" is the
    // search for what it suggested (with the camera and her taste), not another outfit pick
    // only the very next turn: anything said in between ends it ("Want me to find a restaurant?" → "yes", Codex r1 P2)
    const outfit = this.lastOutfit && this.hooks.now() - this.lastOutfit.at < PREFETCH_WINDOW_MS ? this.lastOutfit : null;
    this.lastOutfit = null;
    const lastLine = [...(t.recent ?? [])].reverse().find((l) => l.startsWith("You: ")) ?? "";
    const base = classifyTurn(t.text, t.frames.length > 0 || !!t.screen, afterProduct);
    // a new ask of its own ("find me some chicken recipes", "a pair of headphones") keeps its own card (Codex r1 P2)
    const followUp = !!outfit && (!base || base.kind === "outfit") && isGoesWithFollowUp(t.text) && (!isBareAccept(t.text) || OFFER.test(lastLine));
    // demo 11/4: an "A or B" verdict decides what is searched; no clear pick out loud = no sheet
    const choice = followUp ? choiceForSearch(outfit!.question ?? "", outfit!.said) : null;
    if (choice === false) { this.hooks.log("finds.choice_unclear", {}); return null; }
    if (followUp) {
      this.lastOutfit = null;
      t = { ...t, text: `Find what you offered to find for the look they just picked (shoes or accessories that go with it). What you told them: "${outfit!.said.slice(0, 300)}". They answered: "${t.text.slice(0, 100)}".${choice ? ` You picked ${choice} out loud: find ${choice} ones only, never the other option.` : ""}` };
    }
    // Chelsea 11/4 D: while the Mac shares its screen, a question takes the shared frame (fresher than the camera,
    // ≤1 s old), unless it's about them or what they hold; "on my screen" / "this video" always mean the share
    const intent0 = followUp ? { kind: "product" as const } : base ?? (prefetchLive && isLinksAsk(t.text) ? { kind: "product" as const } : null);
    // Chelsea 11/4: nothing in the words alone — the judge looks at the line, the context and the picture (judge.ts)
    this.judgeAbort?.abort();
    this.judgeAbort = null;
    if (!intent0) {
      this.startJudge(input);
      return null;
    }
    return this.start(intent0, t, followUp, false, choice || null);
  }

  /** The keyword intent or the judge's pick, started the same way. `judged`: the turn already answered out loud. */
  private start(intent: NonNullable<Intent>, t: TurnInput, followUp: boolean, judged: boolean, choice: string | null = null): TurnStarted | null {
    const silentFail = (e: ServerEvent): ServerEvent => (e.type === "find.failed" && e.reason !== "stopped" ? { ...e, reason: "stopped", message: "" } : e);
    // the share when there is no camera picture, or when the line points at it; otherwise the camera (Codex r1 P2)
    const useScreen = !!t.screen && !followUp && (
      !t.frames.length || SCREEN_WORDS.test(t.text) || (intent.kind === "product" && refersToScreen(t.text) && !CAMERA_WORDS.test(t.text))
    );
    if (useScreen) t = { ...t, frames: [t.screen!], unclear: false };
    const findId = randomUUID();
    if (intent.kind === "identify") return this.startIdentify(findId, t, useScreen);
    // P0 11/4: a dark / blurry fridge is answered by the conversation itself (no find, no canned line)
    if (intent.kind === "recipe" && t.unclear && !intent.named) return null;
    const abort = new AbortController();
    const ctx: PipelineCtx = {
      findId,
      utteranceId: t.utteranceId,
      kind: intent.kind,
      question: t.text,
      frames: t.frames,
      screen: useScreen,
      url: intent.url,
      memories: this.memories,
      profile: this.profile,
      userName: this.userName,
      replyText: t.replyText,
      timeZone: this.timeZone,
      vendors: this.deps.vendors,
      // a shared-screen frame: no boxes for the camera preview, and the card never claims (or shows) a camera picture
      emit: (e) => { const s = useScreen ? screenEvent(e) : e; this.onEvent(s && (intent.kind === "recipe" || intent.kind === "outfit") ? silentFail(s) : s); },
      signal: abort.signal,
      now: this.hooks.now,
      log: this.hooks.log,
      images: this.deps.images,
      speak: (text) => {
        const card = this.cards.get(findId);
        if (card) void this.persist(card);
        // P0 11/4: never a canned "can't see it" line after the reply
        if (!text.trim() || /^I can['’]t make out/i.test(text)) return;
        if (!this.closed) this.hooks.announce(text);
      },
      putImage: async (slot, bytes) => {
        if (this.purged || (this.owner && this.deps.store.work.isDeleted(this.owner))) throw new Error("account deleted");
        await this.deps.store.work.write(this.owner, () => this.deps.store.putImage(findId, slot, bytes));
        return `${this.deps.imageBase}/${findId}/images/${slot}`;
      },
    };
    let run: (c: PipelineCtx) => Promise<PipelineResult>;
    let pickP: ReturnType<typeof decidePick> | null = null;
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
      // demo S5 (lead 11/4 P0): an ask with the camera on gets a fresh look at what's in view — never a saved card
      // or a text-only prefetch (3/3 replayed "from earlier" without looking)
      const camera = t.frames.length > 0;
      const cached = prev || camera || followUp || this.deps.productCache !== true ? null : this.cacheFor(t.text);
      // scene 5: a "yes" to the verdict's offer may take the search started with that verdict (same moment, same frames)
      // S5 (QA 11/4): a follow-up searches fresh from the one pick it says out loud (the prefetch never won anyway: 0/3)
      const pre = prev || cached || camera || followUp ? null : this.takePrefetch(t.text, now);
      if (pre) this.lastProduct = { label: pre.label, question: `${pre.question} — ${t.text}`, at: now };
      // S5: one decision — the item + colour said out loud is the item searched (started now, beside the sheet)
      // (camera asks and the verdict's follow-up: the S5 paths, where she sees the outfit and hears the pick)
      if (!cached && !pre && (camera || followUp)) {
        const decided = decidePick(this.deps.vendors, { question: prev ? `${prev.question} — ${t.text}` : t.text, recent: t.recent ?? [], taste: productTaste(undefined, this.profile, this.memories), frames: t.frames, signal: abort.signal });
        // the spoken "A or B" verdict wins over the pick model (it once said white and searched black)
        pickP = choice ? decided.then((p) => p ? (isColorWord(choice) ? { ...p, color: choice, say: p.color === choice ? p.say : "" } : { ...p, item: choice, say: p.item === choice ? p.say : "" }) : p) : decided;
        pickP.catch(() => {});
      }
      const pick = pickP;
      run = cached ? (c) => this.replayCache(cached, c, t) : pre ? (c) => this.replayPrefetch(pre, c, t) : async (c) => {
        // S5 latency: find.started goes out before the likes are awaited (the sheet shows in this tick)
        const r = await runProduct({ ...c, ...(pick ? { pick } : {}), likesLater: likes, recent: t.recent ?? [], previous: prev?.question, region: this.deps.shopRegion, hedge: this.deps.productHedge });
        if (r.label && this.lastProduct) this.lastProduct.label = r.label;
        return r;
      };
    } else if (intent.kind === "outfit") {
      // the "goes with" search starts as soon as the spoken pick is out (~4 s), not after the card (~8 s):
      // Spark search takes 15–30 s, every second of head start shows on camera
      let prefetching = false;
      // made from the taste of this moment: after a "Forget all of this" it never starts a search (Codex #583 r10)
      const turnAt = new Date().toISOString();
      const forgotSince = () => this.tasteForgottenAt !== null && turnAt <= this.tasteForgottenAt;
      const turn = t;
      void t.replyText.then((said) => {
        if (said && !forgotSince()) this.lastOutfit = { said, at: this.hooks.now(), question: turn.text };
        if (said && !abort.signal.aborted && !forgotSince()) { prefetching = true; this.startPrefetch(null, said, turn); }
      }).catch(() => {});
      run = async (c) => {
        const r = await runOutfit(c);
        if (r.card && !prefetching && !c.signal.aborted && !forgotSince()) this.startPrefetch(r.card, r.card.say ?? null, turn);
        return r;
      };
    } else if (intent.kind === "recipe" && intent.named) {
      // P0 11/4: a dish by name — the web recipe card, never the camera's ingredient check
      const recent = t.recent ?? [];
      run = (c) => runNamedRecipe({ ...c, frames: [], recent });
    } else run = intent.kind === "recipe" ? runRecipe : intent.kind === "answer" ? runGeneral : runLink;
    const release = this.deps.store.work.track(this.owner, () => this.close({ purge: true }));
    const tasteAtStart = this.tasteText(); // a profile change while it searched: not cached (Codex #522 r5 P1)
    const done = run(ctx).catch((err) => {
      if (!abort.signal.aborted) {
        this.onEvent({ type: "find.failed", findId, reason: "error", message: "Something went wrong. Ask me again in a moment." });
        this.hooks.log("find.error", { findId, message: String(err).slice(0, 200) });
      }
      return { card: null, timings: {} } as PipelineResult;
    }).then(async (r) => {
      if (r.card && useScreen) r = { ...r, card: screenCard(r.card) };
      if (r.card) await this.persist(r.card);
      // a real search's card answers the same ask next time at once (same taste only)
      if (r.card && intent.kind === "product" && !r.timings.cached && this.deps.productCache === true) {
        const cat = categoryOf(t.text);
        const colors = colorAsks(t.text);
        if (cat && colors.length && tasteAtStart === this.tasteText() && plainAsk(t.text) && cardIsKind(r.card, cat) && cardFitsColors(r.card, colors)) cachePut(cacheKey(cat, colorPhrases(t.text), tasteAtStart), { at: Date.now(), card: r.card, sourceFindId: findId });
      }
      this.hooks.log("find.done", { findId, kind: intent.kind, ok: !!r.card, ...r.timings });
      return r;
    }).finally(() => {
      this.running.delete(findId);
      release();
    });
    this.running.set(findId, { abort, done });
    if (intent.kind === "product") {
      // never a long dead stretch: one natural line if the card isn't in by ~30 s
      const label = this.lastProduct?.label ?? "Things";
      const timer = setTimeout(() => {
        if (abort.signal.aborted || this.closed || this.landed.has(findId)) return;
        this.hooks.announce(stillHunting(label));
      }, this.deps.stillSearchingMs ?? 12_000); // S5 latency (lead 11/4): the visible wait is ~12 s, then one line
      void done.finally(() => clearTimeout(timer));
    }
    if (ACK[intent.kind]) this.acked.add(findId);
    // an outfit pick is answered out loud by the turn itself: its card only shows it (demo S4, one verdict)
    else if (intent.kind === "outfit") this.answered.set(findId, t.replyText);
    return { findId, kind: intent.kind, ...(intent.named ? { named: true as const } : {}), ...(ACK[intent.kind] ? { ack: ACK[intent.kind] } : {}), ...(pickP ? { reaction: pickP.then((p) => p?.say || null, () => null) } : {}) };
  }

  /**
   * "What's this?" (CEO demo 11/4): outline the thing on the camera frame and name it once checked — no card, no
   * sheet. On a shared screen (the Mac draws no boxes over it) the answer lands in the sheet instead.
   */
  private startIdentify(findId: string, t: TurnInput, screen: boolean): TurnStarted | null {
    // P0 11/4: the turn's own reply names it from the frame; this only draws the outline (or the screen card)
    if (t.unclear && !screen) return null;
    const abort = new AbortController();
    const ctx: PipelineCtx = {
      findId, utteranceId: t.utteranceId, kind: "answer", question: t.text, frames: t.frames, screen, memories: this.memories, profile: this.profile, userName: this.userName,
      replyText: t.replyText, timeZone: this.timeZone, vendors: this.deps.vendors, emit: (e) => this.onEvent(e), signal: abort.signal, now: this.hooks.now,
      log: this.hooks.log, images: false, putImage: async () => { throw new Error("no pictures"); },
      speak: () => {
        const card = this.cards.get(findId);
        if (card) void this.persist(card);
      },
    };
    const done = runIdentify(ctx).catch((err) => {
      if (!abort.signal.aborted) this.hooks.log("find.error", { findId, kind: "identify", message: String(err).slice(0, 200) });
      return { card: null, timings: {} } as PipelineResult;
    }).then((r) => {
      this.hooks.log("find.done", { findId, kind: "identify", ok: true, screen, ...r.timings });
      return r;
    }).finally(() => this.running.delete(findId));
    this.running.set(findId, { abort, done });
    return { findId, kind: "identify" };
  }

  /**
   * Chelsea 11/3: a spoken answer that searched the web lands in the sheet with its sources,
   * after the answer was said (no line of its own). Returns the find id, or null.
   */
  webAnswer(o: { utteranceId: number; question: string; said: string; searches: WebSearch[] }): string | null {
    if (this.closed || this.purged || (this.owner && this.deps.store.work.isDeleted(this.owner))) return null;
    // one sheet card per turn: whichever of the judge and the reply's own search came first (Codex judge r1 P2)
    if (this.judged.has(o.utteranceId)) return null;
    const findId = randomUUID();
    const card = webAnswerCard({ id: findId, question: o.question, said: o.said, searches: o.searches });
    if (!card) return null;
    this.judged.add(o.utteranceId);
    this.onEvent({ type: "find.started", findId, utteranceId: o.utteranceId, kind: "answer", title: "Looked it up", detail: card.subtitle });
    // never taste chips on a looked-up fact
    card.reasons = [];
    this.onEvent({ type: "find.created", findId, card });
    this.hooks.log("find.done", { findId, kind: "answer", ok: true, sources: card.sources.length });
    // visual everything: every row gets its page's picture (else a web photo), the first is the hero
    const abort = new AbortController();
    const release = this.deps.store.work.track(this.owner, () => abort.abort());
    void rowPictures(
      {
        findId, vendors: this.deps.vendors, signal: abort.signal, emit: (e) => this.onEvent(e), log: this.hooks.log, images: this.deps.images,
        putImage: async (slot, bytes) => {
          if (this.purged || (this.owner && this.deps.store.work.isDeleted(this.owner))) throw new Error("account deleted");
          await this.deps.store.work.write(this.owner, () => this.deps.store.putImage(findId, slot, bytes));
          return `${this.deps.imageBase}/${findId}/images/${slot}`;
        },
      },
      card.sources.map((s) => ({ title: s.title, url: s.url })),
      // a spoken answer about places ("ramen near me") never gets a made-up picture
      { layout: generalLayout(o.question) === "place" ? "place" : card.layout, topic: card.title },
    ).catch(() => {}).finally(release);
    return findId;
  }

  /** the judge of the latest turn (a newer turn stops it) */
  private judgeAbort: AbortController | null = null;
  /** turns a judged card answered: the reply's own web search adds no second sheet card */
  private readonly judged = new Set<number>();

  /**
   * Chelsea 11/4: an "open" line (assessLine) with nothing in its words goes to the find judge beside the spoken reply.
   * A pick other than none starts the same pipeline as a keyword intent, with find.started at once.
   */
  private startJudge(t: TurnInput): void {
    if (!judgeEnabled() || t.unclear) return;
    if (assessLine(t.text) !== "open") return;
    const abort = new AbortController();
    this.judgeAbort = abort;
    // a barged-in / cancelled turn (its reply resolves null) starts nothing (Codex judge r1 P2)
    void t.replyText.then((said) => { if (said === null) abort.abort(); }).catch(() => {});
    // cut off while it played (the reply text was already final): the turn's own signal (Codex judge r2 P2)
    if (t.signal?.aborted) return;
    t.signal?.addEventListener("abort", () => abort.abort(), { once: true });
    // the picture is chosen from what they said ("on my screen" → the share), and kept for the card (Codex judge r1 P2)
    const useScreen = !!t.screen && (!t.frames.length || SCREEN_WORDS.test(t.text));
    const frame = useScreen ? t.screen : t.frames.at(-1);
    const seen: TurnInput = useScreen ? { ...t, frames: [], screen: t.screen } : { ...t, screen: undefined };
    const judge = this.deps.judge ?? sparkJudge(this.deps.vendors);
    const t0 = this.hooks.now();
    void judgeWithin(judge, { text: t.text, recent: (t.recent ?? []).slice(-4), ...(frame ? { frame, screen: useScreen } : {}) }, this.deps.judgeTimeoutMs ?? JUDGE_TIMEOUT_MS, abort.signal).then((r) => {
      const ms = Math.round(this.hooks.now() - t0);
      if (this.judgeAbort === abort) this.judgeAbort = null;
      if (abort.signal.aborted || this.closed) {
        this.hooks.log("finds.judge", { utteranceId: t.utteranceId, kind: r.kind, started: null, reason: "cancelled", ms });
        return;
      }
      const intent = judgedIntent(r, seen);
      // the reply's own web search already put a card up for this turn
      const taken = this.judged.has(t.utteranceId);
      this.hooks.log("finds.judge", { utteranceId: t.utteranceId, kind: r.kind, started: taken ? null : intent?.kind ?? null, reason: r.reason, ms });
      if (!intent || taken) return;
      if (this.owner && this.deps.store.work.isDeleted(this.owner)) return;
      this.judged.add(t.utteranceId);
      const question = (intent.kind === "answer" || intent.kind === "product") && r.query ? r.query : t.text;
      // a judged turn already answered out loud: its fixed line (ack) is dropped, so a failure isn't said either
      const started = this.start(intent, { ...seen, text: question }, false, true);
      if (started) this.acked.delete(started.findId);
    });
  }

  /** Waits for every running pipeline (tests, e2e script). */
  async settle(): Promise<PipelineResult[]> {
    return Promise.all([...this.running.values()].map((r) => r.done));
  }

  // ───────── demo S5: the search for what goes with a picked outfit, started before she asks ─────────

  private startPrefetch(card: FindCard | null, said: string | null, t: TurnInput): void {
    if (this.closed || this.deps.productPrefetch === false) return;
    const reply = (said ?? card?.say ?? "").slice(0, 300);
    // demo 11/4: an "A or B" ask searches only the option said out loud; no clear pick = no search
    const choice = choiceForSearch(t.text, reply);
    if (choice === false) return;
    const wants = new Set([...reply.matchAll(GOES_WITH)].map((m) => m[1].toLowerCase()));
    if (!wants.size) for (const w of ["shoes", "accessories", "bag"]) wants.add(w);
    const picked = card ? ` (${card.status || card.title})` : "";
    const question = `Find shoes or accessories that go with the outfit they just picked${picked}.${reply ? ` What you told them: "${reply}". If you named shoes or accessories there, find those.` : ""}${choice ? ` You picked ${choice} out loud: find ${choice} ones only, never the other option.` : ""}`;
    this.prefetched?.abort.abort();
    const abort = new AbortController();
    const p: Prefetch = { at: this.hooks.now(), wants, question, inView: question.toLowerCase(), label: guessLabel(reply, "Shoes"), events: [], images: new Map(), listeners: new Set(), abort, settled: false, done: Promise.resolve({ card: null, timings: {} }) };
    const findId = `prefetch-${randomUUID()}`;
    const ctx: PipelineCtx = {
      // the search follows what was said ("dark brown shoes…"); the frames cost a vision pass on every lane
      findId, utteranceId: t.utteranceId, kind: "product", question, frames: prefetchFrames() || !namesPick(reply) ? t.frames : [], memories: this.memories, profile: this.profile, userName: this.userName,
      replyText: Promise.resolve(null), timeZone: this.timeZone, vendors: this.deps.vendors, signal: abort.signal, now: this.hooks.now, log: this.hooks.log, images: this.deps.images,
      emit: (e) => { p.events.push(e); for (const l of p.listeners) l(e); },
      putImage: async (slot, bytes) => { p.images.set(slot, bytes); return `prefetch:${slot}`; },
    };
    const likes = this.likes;
    // one more lane than a normal search: Spark search time varies 15–30 s and the first good lane wins
    // GENITA_PREFETCH_HEDGE: lanes for this background search (11/3: text-only lanes took 11.7–24 s; the first good one wins)
    const hedge = prefetchHedge(this.deps.productHedge);
    p.done = (async () => {
      const l = await likes;
      return runProduct({ ...ctx, likes: l, recent: t.recent ?? [], region: this.deps.shopRegion, hedge, allFrames: true });
    })().catch(() => ({ card: null, timings: {} }));
    void p.done.then(() => { p.settled = true; });
    void likes.then((l) => { p.inView = [question, ...(l ?? []), this.profile ?? ""].join(" ").toLowerCase(); });
    this.prefetched = p;
    this.hooks.log("product.prefetch", { wants: [...wants].slice(0, 6) });
  }

  /** A cached card for this ask: same category, its colors proven, nothing narrower asked (price, brand, material…). */
  private cacheFor(text: string): CachedProducts | null {
    const cat = categoryOf(text);
    if (!cat || !plainAsk(text)) return null;
    const lower = text.toLowerCase();
    const named = [...lower.matchAll(/\b([a-z]+)\b/g)].map((m) => m[1]);
    if (EXCLUDE.test(lower) || named.some((w) => MATERIAL.test(w)) || /\$\s?\d|\bunder \d|\bcheap|\bsize\b|\b\d{1,2}(\.5)?\b|\b(wide|narrow|petite|plus)\b/.test(lower) || brandsIn(text).length) return null;
    const colors = colorAsks(text);
    // no color word we know ("teal" once was none): never served from the cache (Codex #522 r3)
    if (!colors.length) return null;
    const hit = cacheGet(cacheKey(cat, colorPhrases(text), this.tasteText()), Date.now());
    return hit && cardIsKind(hit.card, cat) && cardFitsColors(hit.card, colors) ? hit : null;
  }

  /**
   * S5 at once: the cached card under this ask's own id (pictures copied over), then a fresh search behind it that
   * only refreshes the cache — the card on screen never changes under the user.
   */
  private async replayCache(entry: CachedProducts, c: PipelineCtx, t: TurnInput): Promise<PipelineResult> {
    const t0 = c.now();
    const label = guessLabel(t.text, "Things");
    c.emit({ type: "find.started", findId: c.findId, utteranceId: c.utteranceId, kind: "product", title: SEARCH_TITLE, detail: `${shortLabel(label)} · from earlier` });
    const products = [];
    for (const p of entry.card.products ?? []) {
      // another call's situation (what someone said there) never travels with the card
      const q = { ...p, situation: "" };
      // the picture's bytes, wherever the card's own status stopped (a background search sends no image events, so
      // its card still says "pending" — Codex #522 r3): there → ready here; not there → failed (nothing will follow)
      if (p.image?.omit) q.image = p.image;
      else if (p.image) {
        const bytes = entry.images?.get(p.image.slot) ?? (entry.sourceFindId ? (await this.deps.store.getImage(entry.sourceFindId, p.image.slot).catch(() => null))?.bytes : undefined);
        if (bytes) {
          try { q.image = { slot: p.image.slot, status: "ready", url: await c.putImage(p.image.slot, bytes) }; } catch { q.image = { slot: p.image.slot, status: "failed" }; }
        } else q.image = { slot: p.image.slot, status: "failed" };
      }
      products.push(q);
    }
    // only the public product facts and the shared taste line travel; the words of the call they were found in
    // (title, subtitle, say, reason chips) are rebuilt for this one (Codex P1 #522)
    const n = products.length;
    const card: FindCard = {
      ...entry.card, id: c.findId, createdAt: new Date().toISOString(), products, saved: false,
      // "2 shoes picks" (demo S5): the count reads as words, the thing is in the subtitle
      title: n === 1 ? "One pick for you" : "Two picks for you",
      subtitle: `${shortLabel(label)}, matched to your style.`,
      reasons: undefined, say: undefined, pill: undefined, status: `${n} link${n === 1 ? "" : "s"}`,
      ...(entry.card.evidence ? { evidence: { ...entry.card.evidence, situation: "" } } : {}),
    };
    delete card.reasons; delete card.say; delete card.pill;
    if (c.signal.aborted) return { card: null, timings: {} };
    c.emit({ type: "find.created", findId: c.findId, card });
    const cardMs = Math.round(c.now() - t0);
    // refresh behind it (yields to calls), for the next ask
    const kind = categoryOf(t.text) ?? "shoes";
    const taste = this.tasteText();
    const key = cacheKey(kind, colorPhrases(t.text), taste);
    void this.searchInBackground(t.text, `refresh-${randomUUID()}`).then((fresh) => { if (fresh && this.tasteText() === taste && cardIsKind(fresh.card, kind) && cardFitsColors(fresh.card, colorAsks(t.text))) cachePut(key, fresh); }).catch(() => {});
    return { card, timings: { cardMs, cached: 1 } };
  }

  /** The prefetch fits this ask: fresh, and the ask names nothing it didn't look for. */
  private takePrefetch(text: string, now: number): Prefetch | null {
    const p = this.prefetched;
    if (!p || now - p.at > PREFETCH_WINDOW_MS) return null;
    const lower = text.toLowerCase();
    const named = [...lower.matchAll(/\b([a-z]+)\b/g)].map((m) => m[1]);
    // whole words only ("on" is not in "undertones", "tan" is not in "standing")
    const seen = new Set(p.inView.match(/[a-z]+/g) ?? []);
    const inView = (w: string) => seen.has(w);
    // every item the ask names must be one the prefetch looked for ("shoes and a lamp" → fresh search)
    const itemWords = named.filter((w) => PRODUCT_WORD.test(w) || ITEM_NOUN.test(w));
    const wanted = (w: string) => p.wants.has(w) || p.wants.has(`${w}s`) || p.wants.has(w.replace(/s$/, ""));
    if (itemWords.some((w) => !wanted(w))) return null;
    // a color or a price it never had in view (said, or the account's own taste) → fresh search
    // a color must be one the search was steered by (what was said): taste alone didn't keep it from picking black
    // for "dark brown" (prod 11/3 13:00)
    const asked = new Set(p.question.toLowerCase().match(/[a-z]+/g) ?? []);
    if (named.some((w) => COLOR.test(w) && !asked.has(w))) return null;
    if (/\$\s?\d|\bunder \d|\bcheap/.test(lower)) return null;
    // anything narrower than "what goes with it" is its own search (Codex P2 #366): an exclusion, a material,
    // a size, or a brand (a capitalized word mid-sentence) the prefetch never had in view
    if (EXCLUDE.test(lower)) return null;
    if (named.some((w) => MATERIAL.test(w) && !inView(w))) return null;
    if (/\bsize\b|\b\d{1,2}(\.5)?\b|\b(wide|narrow|petite|plus)\b/.test(lower)) return null;
    if (brandsIn(text).some((w) => !inView(w))) return null;
    this.prefetched = null;
    return p;
  }

  /**
   * Puts the prefetched search on screen under this ask's own find id (events, card, pictures). If the prefetch is
   * still running, a fresh search for this ask starts at once beside it; the first one with a card is shown and
   * the other is stopped (never "wait for the prefetch, then search").
   */
  private async replayPrefetch(p: Prefetch, c: PipelineCtx, t: TurnInput): Promise<PipelineResult> {
    // the label of what this ask names ("shoes"), not what the prefetch guessed from the outfit ("Sweater", demo S5)
    c.emit({ type: "find.started", findId: c.findId, utteranceId: c.utteranceId, kind: "product", title: SEARCH_TITLE, detail: `${shortLabel(guessLabel(t.text, p.label))} · searching shops` });
    type Src = { events: ServerEvent[]; listeners: Set<(e: ServerEvent) => void>; rekey: boolean; images?: Map<string, Buffer> };
    let winner: Src | null = null;
    let card: FindCard | null = null;
    const queue: Promise<void>[] = [];
    const forward = async (src: Src, e: ServerEvent) => {
      // only the winner reaches the app; a search that found nothing is never shown on its own
      if (c.signal.aborted || winner !== src || e.type === "find.started" || e.type === "find.failed") return;
      if (src.rekey && e.type === "find.image" && e.replace) {
        // a swapped-in product: its picture moves under this ask's id too (none → the slot is just omitted)
        const { replace, ...rest } = e;
        const bytes = replace.image?.status === "ready" ? src.images?.get(e.slot) : undefined;
        let url: string | null = null;
        if (bytes) url = await c.putImage(e.slot, bytes).catch(() => null);
        c.emit(url ? { ...rest, findId: c.findId, replace: { ...replace, image: { slot: e.slot, status: "ready", url } } } : { ...rest, findId: c.findId });
        return;
      }
      if (src.rekey && e.type === "find.image") {
        const bytes = e.status === "ready" ? src.images?.get(e.slot) : undefined;
        if (bytes) {
          try { c.emit({ ...e, findId: c.findId, url: await c.putImage(e.slot, bytes) }); } catch { c.emit({ ...e, findId: c.findId, status: "failed", url: undefined }); }
        } else c.emit({ ...e, findId: c.findId, status: "failed", url: undefined });
        return;
      }
      if (e.type === "find.created") { card = { ...e.card, id: c.findId }; c.emit({ ...e, findId: c.findId, card }); return; }
      c.emit({ ...e, findId: c.findId } as ServerEvent);
    };
    let won: () => void = () => {};
    const someoneWon = new Promise<void>((resolve) => (won = resolve));
    const crown = (src: Src) => {
      if (winner) return;
      winner = src;
      won();
      for (const e of src.events) queue.push(forward(src, e));
      src.listeners.add((e) => queue.push(forward(src, e)));
    };
    const pre: Src = { events: p.events, listeners: p.listeners, rekey: true, images: p.images };
    // stopping this ask stops both searches
    const stopPre = () => p.abort.abort();
    c.signal.addEventListener("abort", stopPre, { once: true });
    const preDone = p.done.then((r) => { if (r.card) crown(pre); return r; });
    let fresh: { src: Src; abort: AbortController; done: Promise<PipelineResult> } | null = null;
    if (!p.settled) {
      const abort = new AbortController();
      const stopFresh = () => abort.abort();
      c.signal.addEventListener("abort", stopFresh, { once: true });
      const src: Src = { events: [], listeners: new Set(), rekey: false };
      const likes = this.likes;
      const done = (async () => runProduct({
        ...c, signal: abort.signal,
        emit: (e) => { src.events.push(e); for (const l of src.listeners) l(e); },
        likes: await likes, recent: t.recent ?? [], region: this.deps.shopRegion, hedge: this.deps.productHedge,
      }))().catch(() => ({ card: null, timings: {} }) as PipelineResult).then((r) => { if (r.card) crown(src); return r; });
      fresh = { src, abort, done };
    }
    // first card wins; if one search ends empty, the other still may
    await Promise.race([someoneWon, Promise.all([preDone, fresh?.done])]);
    if (winner === pre) fresh?.abort.abort();
    else if (winner) p.abort.abort();
    const r = winner === pre ? await preDone : winner && fresh ? await fresh.done : await preDone;
    await Promise.all(queue);
    p.listeners.clear();
    c.signal.removeEventListener("abort", stopPre);
    if (card) return { card, timings: { ...r.timings, prefetched: winner === pre ? 1 : 0 } };
    if (c.signal.aborted) return { card: null, timings: r.timings };
    if (!fresh) {
      // the prefetch had already ended empty before the ask: search for this ask itself, under the same "searching" state
      const likes = this.likes;
      return runProduct({ ...c, emit: (e) => { if (e.type !== "find.started") c.emit(e); }, likes: await likes, recent: t.recent ?? [], region: this.deps.shopRegion, hedge: this.deps.productHedge });
    }
    // both ended empty: say so once
    await fresh.done;
    const failed = fresh.src.events.find((e) => e.type === "find.failed");
    if (failed) c.emit({ ...failed, findId: c.findId } as ServerEvent);
    return { card: null, timings: r.timings };
  }

  private onEvent(e: ServerEvent | null): void {
    if (!e) return;
    if (this.purged || (this.owner && this.deps.store.work.isDeleted(this.owner))) return;
    // after the call ends, finished cards still get their pictures saved
    if (e.type === "find.created" || e.type === "find.failed") this.landed.add(e.findId);
    if (e.type === "find.failed") this.answered.delete(e.findId);
    if (e.type === "find.created") {
      // lane 개인화 E: 1–2 reason chips from the user's own taste lines (never model-written)
      if (!e.card.reasons) {
        const reasons = reasonChips(this.taste.length ? this.taste : tasteLines(this.profile), e.card);
        if (reasons.length) e.card.reasons = reasons;
      }
      // CW-02: an outfit card carries a taste reason — the model's (grounded), else the account's imported top taste
      // line (P1-7: never a line said in this call, which is the grey chip; no import → no taste line)
      const top = e.card.kind === "outfit" && !e.card.subtitle ? e.card.reasons?.find((r) => r.from === "profile") : undefined;
      if (top) {
        e.card.subtitle = top.text;
        e.card.evidence = { style: top.text, situation: e.card.evidence?.situation ?? "" };
      }
      this.cards.set(e.findId, e.card);
      this.focusId = e.findId;
      void this.persist(e.card);
      if (e.card.say && !this.closed) this.announceCard(e.findId, e.card.say);
    } else if (e.type === "find.image") {
      const card = this.cards.get(e.findId);
      if (card) {
        applyFindImage(card, { slot: e.slot, status: e.status, ...(e.url ? { url: e.url } : {}), ...(e.source ? { source: e.source } : {}), ...(e.omit ? { omit: e.omit } : {}) }, e.replace);
        void this.persist(card);
      }
    }
    if (e.type === "find.failed" && e.reason !== "stopped" && !this.closed && this.acked.has(e.findId)) this.hooks.announce(e.message);
    if (!this.closed) this.hooks.emit(e);
  }
  /**
   * A card's own line. Demo S4 build 9 (4/6 runs): the spoken answer already gave the outfit verdict ("Black one
   * wins, Summer…") and the card, landing 11–14 s later, said it again ("Black one wins, no contest cutie."). A card
   * whose turn answered out loud stays silent — waiting for that answer when it is still under way — and its line is
   * said only when the answer said nothing (the reply failed or was cut before a word).
   */
  private announceCard(findId: string, say: string): void {
    const answer = this.answered.get(findId);
    if (!answer) return this.hooks.announce(say);
    this.answered.delete(findId);
    void answer.then((said) => {
      if (said?.trim()) this.hooks.log("find.say_skipped", { findId, reason: "answered" });
      else if (!this.closed) this.hooks.announce(say);
    }, () => {});
  }
  /** finds whose turn's own spoken reply is the answer (outfit): the reply text, once said */
  private readonly answered = new Map<string, Promise<string | null>>();
  /** finds that already have a card or a failure on screen */
  private readonly landed = new Set<string>();
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

  /**
   * The card the user is asking about ("Ask about this", "Talk about this on a call"). A card from an earlier call
   * is read back from this account's Finds (FD-01 F2 → call, AU-70); another account's id is never loaded.
   */
  async focus(findId: string): Promise<void> {
    // the newest pick wins: a slower read of an earlier pick never takes it back (Codex r2)
    const gen = ++this.focusGen;
    if (this.cards.has(findId)) {
      this.focusId = findId;
      return;
    }
    if (!this.owner || this.purged || !/^[A-Za-z0-9-]{8,64}$/.test(findId)) return;
    const owner = this.owner;
    const card = await this.deps.store.get(owner, findId).catch(() => null);
    if (!card || this.purged || this.owner !== owner) return;
    if (!this.cards.has(findId)) this.cards.set(findId, card);
    if (gen === this.focusGen) this.focusId = findId;
  }
  private focusGen = 0;

  /** "Forget all of this" (AU-92): cards made before it keep their products, but their taste chips and style line
   * (made from the old profile) never go to the prompt again */
  private tasteForgottenAt: string | null = null;
  /** searches already running then: their cards were made from the old taste too */
  private tasteForgottenIds = new Set<string>();
  forgetTaste(): void {
    this.tasteForgottenAt = new Date().toISOString();
    // a judge still thinking was asked with the old conversation: it starts nothing (Codex judge r1 P1)
    this.judgeAbort?.abort();
    this.judgeAbort = null;
    this.lastOutfit = null; // its verdict may quote the forgotten taste (Codex r1 P1)
    for (const id of this.running.keys()) this.tasteForgottenIds.add(id);
    // a prefetch searched with the old taste: stopped and never reused (Codex #583 r9)
    this.prefetched?.abort.abort();
    this.prefetched = null;
    // searches already running were asked with the old taste: their card would say it ("Both leather, your style.")
    for (const r of this.running.values()) r.abort.abort();
    // and the background ones (cache warm-up / refresh) asked with it too, running or waiting for a slot (Codex #583 r15)
    for (const stop of [...this.backgroundStops]) stop();
    // the last product search's question / label (a "find a couple more" refine) was made from it too (Codex #583 r16)
    this.lastProduct = null;
  }

  private recent: FindCard[] = [];
  /** demo S5: the line about what was found before this call, only when the user asks about it ("what shoes did you
   * find for me earlier?"). Cards made in this call are left out (they are on screen / in the turns). Data only. */
  foundBefore(userText: string): string | undefined {
    if (!FOUND_ASK.test(userText)) return undefined;
    const old = this.recent.filter((c) => !this.cards.has(c.id));
    if (!old.length) return undefined;
    return old.map((c, i) => {
      const what = c.products?.length ? c.products.map((p) => `${p.name} (${p.store}${p.price ? `, ${p.price}` : ""}${p.taste ? `; ${p.taste}` : ""})`).join(", ") : c.subtitle;
      const why = c.why.length ? ` why: ${c.why.join(" ")}` : c.evidence?.style ? ` why: ${c.evidence.style}` : "";
      return `${i + 1}. ${c.title}${what ? `: ${what}` : ""}.${why}`;
    }).join(" ").slice(0, 700);
  }

  /** Pure: what this turn means for guided cooking of the card on screen (the prompt line; onTurn keeps the step). */
  walkTurn(text: string): WalkPlan {
    const card = this.focusId ? this.cards.get(this.focusId) : undefined;
    return walkPlan(text, this.walk, card, this.focusId);
  }

  /** One line for the system prompt about the card on screen, or undefined. Data only. */
  onScreen(): string | undefined {
    const c = this.focusId ? this.cards.get(this.focusId) : undefined;
    if (!c) return undefined;
    const old = this.tasteForgottenAt !== null && ((c.createdAt ?? "") <= this.tasteForgottenAt || this.tasteForgottenIds.has(c.id));
    // an outfit card's subtitle is written from their taste ("You prefer minimal clothes."): not after a forget (Codex #583 r8)
    // a card made before the forget: its title and subtitle were written from the old taste ("Minimal, just like you"):
    // only its kind goes to the prompt (Codex #583 r17)
    const parts = [old ? (c.kind === "product" ? "Product picks" : c.kind === "outfit" ? "Outfit pick" : c.title) : `${c.title}${c.subtitle ? ` (${c.subtitle})` : ""}`];
    if (c.kind === "recipe") {
      const by = (t: string) => c.items.filter((i) => i.tier === t).map((i) => i.name).join(", ");
      if (by("have")) parts.push(`they have: ${by("have")}`);
      if (by("maybe")) parts.push(`not sure: ${by("maybe")}`);
      if (by("buy")) parts.push(`not seen: ${by("buy")}`);
    }
    if (c.products?.length) {
      parts.push(`products: ${c.products.map((p, i) => `${i + 1}. ${p.name} (${p.store}, ${p.price ?? "price on the site"}; ${(old ? [] : [p.taste, p.situation]).filter(Boolean).join(", ")})`).join(" ")}`);
      if (c.evidence?.style && !old) parts.push(`their style line: ${c.evidence.style}`);
      if (c.products.length < PRODUCT_COUNT) parts.push("only one product page opened");
    }
    if (c.options.length) parts.push(`options: ${c.options.map((o) => `${o.label}${o.picked ? " (your pick)" : ""}`).join(", ")}`);
    // the occasion the outfit is for: the call can say why it fits it (CW-02). The line is the model's, written with
    // the taste of then ("Your favorite muted colors for this weekend."): never after a forget, like "why" (Codex #625)
    if (c.kind === "outfit" && c.evidence?.situation && !old) parts.push(`occasion: ${c.evidence.situation}`);
    if (c.steps.length) parts.push(`${c.kind === "link" ? "takeaways" : "steps"}: ${c.steps.map((s, i) => `${i + 1}. ${s.text}`).join(" ")}`);
    // an old card's "why" lines were written with the old taste too ("Clean camel, totally you.")
    if (c.why.length && !old) parts.push(`why: ${c.why.join(" ")}`);
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
    this.judgeAbort?.abort(); // a judge still thinking starts nothing after the call
    this.prefetched?.abort.abort();
    this.prefetched = null;
    for (const stop of this.backgroundStops) stop();
    for (const [id, r] of this.running) if (opts.purge || !this.cards.has(id)) r.abort.abort();
  }
  private purged = false;
}

const RECIPE_ASK = /\bwhat (?:can|could|should) (?:i|we) (?:make|cook)\b|\bwhat'?s in (?:here|there|my fridge)\b|\bin (?:my|the) fridge\b|\bwith (?:these|this|what i have|what's here)\b|뭐\s*해\s*먹|냉장고/i;
const OUTFIT_CHOICE = /\b(?:which|better|or|should i wear|pick|choose|decide|go with)\b|어느|뭐가\s*나아|골라/i;

/** The judge's pick as a runner intent, or null: camera kinds need a picture, a link needs a URL, general needs web search on. */
export function judgedIntent(r: JudgeResult, t: { text: string; frames: string[]; screen?: string }, env: NodeJS.ProcessEnv = process.env): NonNullable<Intent> | null {
  const picture = t.frames.length > 0 || !!t.screen;
  switch (r.kind) {
    case "general": return env.GENITA_WEB_SEARCH === "0" ? null : { kind: "answer" };
    case "product": return { kind: "product" };
    case "identify": return picture ? { kind: "identify" } : null;
    // Chelsea 11/4 (finds lane): describe / observe lines ("what am I wearing?", "recommend a dinner menu") stay a spoken
    // answer — an outfit card needs a choice, a recipe card a cooking-from-these ask, same as the keyword path
    case "recipe": return picture && RECIPE_ASK.test(t.text) ? { kind: "recipe" } : null;
    case "outfit": return picture && OUTFIT_CHOICE.test(t.text) ? { kind: "outfit" } : null;
    case "link": { const url = findUrl(t.text); return url ? { kind: "link", url } : null; }
    default: return null;
  }
}
