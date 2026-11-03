/**
 * Lane 개인화 service: one per server (src/prep/index.ts makes it, server.ts
 * hands it to every call). Everything is stored inside the user's style card
 * (user_styles.style_json / styles/<user>.json): story, growth, corrected
 * findings. Writes are serialized per user and always re-read the latest card.
 *
 *   storyFromText   import: Spark story from the redacted paste, in parallel with the parse
 *   story           GET /v1/profile/story — stored, or written from the card (skip users, stale cards)
 *   correct         PATCH /v1/profile — "That's not me" → merge → rewrite that card
 *   startCall       call start: latest profile text + ONE still-to-confirm item (calls 1–3)
 *   voiceCorrection a user line in a call → merge → "Updated: …" chip
 *   endCall         after a call: explicit statements / repeated patterns → merge
 */
import type { SparkRequest } from "../meta/spark.ts";
import { sparkJson } from "../meta/spark.ts";
import { backgroundJson } from "../meta/sparkOpen.ts";
import { looksLikeInjection, redactSensitive, styleProfileText, type DisplayRow, type Finding, type StyleCard } from "../prep/importProfile.ts";
import type { PrepStore } from "../prep/store.ts";
import { EYEBROWS, SOURCES, SPARK_STORY_IDS, STORY_IDS, buildStoryRequest, cardTexts, interimCard, optimisticCard, toStory, type SparkStoryId, type Story, type StoryCard, type StoryId, type UnknownItem } from "./story.ts";
import { PROFILE_FIELDS, mergeUpdates, type AppliedUpdate, type ProfileField, type ProfileUpdate } from "./merge.ts";
import { askLine, beginCall } from "./unknowns.ts";
import { FORGET, buildCorrectionRequest, mightBeCorrection, toAnswer, toCorrectionUpdates } from "./corrections.ts";
import { buildCallExtractRequest, toCallUpdates, type CallTurn } from "./extract.ts";
import { tasteLines, type TasteLine } from "./reasons.ts";
import { firstCallNod } from "./knows.ts";
import { avoidKeys, forgetTarget, isForgetRequest, type Removed } from "./forgotten.ts";
import { isSensitiveDetail } from "./sensitive.ts";

export type JsonFn = <T>(req: Omit<SparkRequest, "text"> & { schemaName: string; schema: Record<string, unknown> }, signal?: AbortSignal) => Promise<T>;
export type PersonalizeStore = Pick<PrepStore, "getStyle" | "putStyle" | "getCompanion">;

export const ACK = "Got it. I'll remember that.";
export const CORRECTION_TEXT_MAX = 200;
/** a failed correction call is tried once more after this (Spark 504s on 11/3) */
const CORRECTION_RETRY_MS = 1500;
/** 11/3 eval: story p50 ~5 s, one outlier > 20 s; past this the GET writes it from the stored card instead */
const STORY_TIMEOUT_MS = 12_000;
const STORY_BACKOFF_MS = 5 * 60_000;
const CALL_SIDE_MAX = 12;

const STOPW = new Set("the and you your with for that this from into like likes about very really".split(" "));
/** content words, 5-letter stems: "Lo-fi while working" ~ "Media: slow-burn dramas; lo-fi while working." */
const keyWords = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOPW.has(w)).map((w) => w.slice(0, 5));

type Edit = { drop: boolean; to?: string };
/**
 * What the marked lines take out of `card` (finding text → edit), decided on that card alone: the same words, or
 * nearly (Spark may word a card line a little differently), only in the card's own sections, about the same thing.
 * A picked chip ("Minimal") in a list finding ("Style: Minimal, Comfy.") takes out only that chip (Codex #538 r3).
 */
function markedEdits(card: StyleCard, items: string[], cardId?: StoryId): Map<string, Edit> {
  // a finding's own label ("Style: Minimal.", "Media: …") is not part of what the user marked (Codex #538 r2)
  const label = (t: string) => t.match(/^\s*[A-Za-z][A-Za-z ]{1,20}:\s+/)?.[0] ?? "";
  // a dislike: the finding "Dislikes seafood." and its chip "Not for you: seafood" (Codex #538 r4)
  const DISLIKE = /^\s*(dislikes|not for (you|them|me))\b:?\s*/i;
  const negative = (t: string) => DISLIKE.test(t);
  const bare = (t: string) => t.replace(DISLIKE, "").slice(DISLIKE.test(t) ? 0 : label(t).length);
  const list = (t: string) => bare(t).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  const words = (t: string) => new Set(list(t));
  /** what the line is about: its last content word ("… outfits." vs "… recipes."), 5-letter stem */
  const subject = (t: string) => list(t).at(-1)?.slice(0, 5) ?? "";
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const edits = new Map<string, Edit>();
  const marked = items.map((t) => ({ raw: bare(t), neg: negative(t), w: words(t), subj: subject(t) })).filter((m) => m.w.size);
  if (!marked.length) return edits;
  const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / Math.max(a.size, b.size); };
  const keys = new Set<string>(cardId && cardId !== "unknowns" ? SOURCES[cardId] : Object.keys(card.sections ?? {}));
  const candidates = Object.entries(card.sections ?? {}).flatMap(([k, v]) => (keys.has(k) && Array.isArray(v) ? v.map((f) => f.text) : []));
  /** a list finding's items as they stand after this save's earlier chips */
  const now = (t: string) => { const e = edits.get(t); return e?.drop ? "" : e?.to ?? t; };
  const items_ = (t: string) => bare(now(t)).replace(/\.\s*$/, "").split(/\s*,\s*/).filter(Boolean);
  for (const m of marked) {
    const pool = candidates.filter((t) => negative(t) === m.neg);   // a dislike chip only for a dislike, a like for a like
    // a chip inside a list finding ("Style: Minimal, Comfy."): only that chip goes; several chips of one save add up
    const chip = norm(m.raw);
    const listHit = pool.find((t) => {
      const parts = items_(t);
      return (parts.length > 1 || edits.has(t)) && parts.some((x) => norm(x) === chip);
    });
    if (listHit) {
      const parts = items_(listHit).filter((x) => norm(x) !== chip);
      const head = negative(listHit) ? (listHit.match(DISLIKE)?.[0] ?? "") : label(listHit);
      edits.set(listHit, parts.length ? { drop: false, to: `${head}${parts.join(", ")}.` } : { drop: true });
      continue;
    }
    // each marked line takes out at most ONE finding: the clear best match (≥ 60 % of the words, better than any other
    // line), about the same thing — "Ask before … outfits." never takes "… recipes." (Codex P1 #538, r2)
    const scored = pool.filter((t) => subject(t) === m.subj).map((t) => ({ t, s: overlap(words(t), m.w) })).sort((a, b) => b.s - a.s);
    if (scored[0] && scored[0].s >= 0.6 && (!scored[1] || scored[1].s < scored[0].s)) edits.set(scored[0].t, { drop: true });
  }
  return edits;
}

function applyEdits(card: StyleCard, edits: Map<string, Edit>): StyleCard {
  if (!edits.size) return card;
  const fix = <T extends { text: string }>(list: T[]) => list.flatMap((x) => {
    const e = edits.get(x.text);
    return !e ? [x] : e.drop ? [] : [{ ...x, text: e.to! }];
  });
  const sections = Object.fromEntries(Object.entries(card.sections ?? {}).map(([k, v]) => [k, Array.isArray(v) ? fix(v) : v])) as StyleCard["sections"];
  const display = (card.display ?? []).map((r) => ({ ...r, items: fix(r.items) }));
  return { ...card, sections, display };
}

/** The style card with the marked lines taken out where they are the profile's own findings (M02). */
export function withoutMarked(card: StyleCard, items: string[], cardId?: StoryId): StyleCard {
  return applyEdits(card, markedEdits(card, items, cardId));
}

/**
 * The card with every save still waiting on Spark's merge taken out the same way (the save's answer and the call
 * start agree; a second correction never brings back the first one's line — Codex #538 r2). Every save's targets are
 * chosen on the stored card, so two saves of the same line never move on to its neighbor (Codex #538 r3).
 * Unknowns answers are not removals.
 */
export function withPendingRemoved(card: StyleCard): StyleCard {
  // all saves of one card as one set of marked lines (the same line twice is once), chosen on the stored card
  const byCard = new Map<string, Set<string>>();
  for (const p of card.pendingCorrections ?? []) {
    if (p.cardId === "unknowns") continue;
    const set = byCard.get(p.cardId) ?? new Set<string>();
    for (const i of p.items) set.add(i);
    byCard.set(p.cardId, set);
  }
  const edits = new Map<string, Edit>();
  for (const [cardId, items] of byCard) for (const [t, e] of markedEdits(card, [...items], cardId as StoryId)) edits.set(t, e);
  return applyEdits(card, edits);
}
const STOP = new Set(["the", "and", "you", "your", "our", "with", "for", "that", "this", "are", "like", "likes", "into", "about"]);

export class PersonalizeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message = code) { super(message); this.status = status; this.code = code; }
}

export type CallStart = { profile?: string; ask?: string; askItem?: string; askTopic?: UnknownItem; taste: TasteLine[]; nod?: string; /** this call's number (growth.calls), for the engine's closeness line */ calls?: number;
  /** lines the user took out of the profile: the call keeps them out of memory, notes and handed-off turns */ removed?: Removed[] };
/** events: "Noted: …" (the planned question was answered) and/or "Updated: …" (a correction) */
export type VoiceUpdate = { events: Array<{ text: string; fields: string[] }>; applied: AppliedUpdate[]; answered: boolean; profile: string; taste: TasteLine[] };

export class Personalize {
  private readonly store: PersonalizeStore;
  private readonly json: JsonFn;
  /** after-call profile growth: Muse Spark Open on Baseten first, Muse Spark API fallback (meta/sparkOpen.ts) */
  private readonly bgJson: JsonFn;
  private readonly log: (event: string, data: Record<string, unknown>) => void;
  private readonly now: () => Date;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly storyJobs = new Map<string, Promise<void>>();
  /** a failed story write isn't retried for STORY_BACKOFF_MS (each try is a Spark call) */
  private readonly storyFailedAt = new Map<string, number>();
  /** C3 rewrites still running after PATCH /v1/profile answered */
  private readonly rewrites = new Set<Promise<void>>();
  /** per user: the saved corrections still being applied in the background, in order */
  private readonly corrections = new Map<string, Promise<void>>();
  /** newest save per user+card: an older correction's interim card / reword never covers a newer save (Codex P1) */
  private readonly lastSave = new Map<string, string>();
  /** user+asOf of saves with a job in this process (so a read doesn't replay one that is running) */
  private readonly queued = new Set<string>();
  private newerSave(userId: string, cardId: string, asOf: string): boolean {
    const last = this.lastSave.get(`${userId}\u0000${cardId}`);
    return !!last && last > asOf;
  }

  constructor(o: { store: PersonalizeStore; json?: JsonFn; backgroundJson?: JsonFn; metaKey?: string; log?: (event: string, data: Record<string, unknown>) => void; now?: () => Date }) {
    this.store = o.store;
    this.json = o.json ?? (<T>(req: Parameters<JsonFn>[0], signal?: AbortSignal) => sparkJson<T>(o.metaKey ?? "", req, signal));
    // injected `json` alone (tests) keeps serving both; production gets the Spark Open path
    this.bgJson = o.backgroundJson ?? (o.json ? o.json : (<T>(req: Parameters<JsonFn>[0], signal?: AbortSignal) => backgroundJson<T>(o.metaKey ?? "", req, { timeoutMs: 30_000, signal })));
    this.log = o.log ?? (() => {});
    this.now = o.now ?? (() => new Date());
  }

  private async serial<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const task = (this.locks.get(userId) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.locks.set(userId, task);
    try { return await task; } finally { if (this.locks.get(userId) === task) this.locks.delete(userId); }
  }

  /** Read-modify-write the latest card under the user's lock. fn returns null = no change. */
  private async update<T>(userId: string, fn: (card: StyleCard) => Promise<{ card: StyleCard; out: T } | null> | { card: StyleCard; out: T } | null): Promise<T | null> {
    return this.serial(userId, async () => {
      const card = await this.store.getStyle(userId);
      if (!card) return null;
      const r = await fn(card);
      if (!r) return null;
      await this.store.putStyle(userId, r.card);
      return r.out;
    });
  }

  /** A Spark call that is aborted (not just abandoned) after `ms`. */
  private timedJson<T>(req: Parameters<JsonFn>[0], ms = STORY_TIMEOUT_MS): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("timeout")), ms);
    timer.unref?.();
    return Promise.race([
      this.json<T>(req, ac.signal),
      new Promise<T>((_, rej) => ac.signal.addEventListener("abort", () => rej(new Error("timeout")), { once: true })),
    ]).finally(() => clearTimeout(timer));
  }

  /** Replace the user's style (import, N1–N3) under the same lock as every other write. */
  async replaceStyle(userId: string, card: StyleCard): Promise<void> {
    const at = this.now().toISOString();
    await this.serial(userId, () => this.store.putStyle(userId, { ...card, importedAt: at }));
  }

  // ───────────── D47 story ─────────────

  /** Import: Spark story from the (already redacted) paste. Never throws; null on failure. */
  async storyFromText(text: string): Promise<{ raw: unknown; ms: number } | null> {
    const t0 = performance.now();
    try {
      const raw = await this.timedJson<unknown>(buildStoryRequest({ text }));
      return { raw, ms: Math.round(performance.now() - t0) };
    } catch (err) {
      this.log("story.failed", { from: "text", message: String(err).slice(0, 160) });
      return null;
    }
  }

  /** Attach a story written from the paste to the card the parse made (checked against that card). */
  withStory(card: StyleCard, r: { raw: unknown; ms: number }, from: Story["from"] = "text"): StyleCard {
    const { cards, topics } = toStory(r.raw as { cards?: unknown }, card);
    return { ...card, story: { version: 2, cards, topics, at: this.now().toISOString(), from, ms: r.ms } };
  }

  /** The paste's story is still being written after the import answered: GET story waits for it instead of writing another. */
  trackLate(userId: string, job: Promise<{ raw: unknown; ms: number } | null>): void {
    const j = job
      .then((r) => (r ? this.attachLate(userId, r) : undefined))
      .catch(() => {})
      .finally(() => { if (this.storyJobs.get(userId) === j) this.storyJobs.delete(userId); });
    this.storyJobs.set(userId, j);
  }

  /** Save a story that landed after the import response went out (only if the card has none yet). */
  async attachLate(userId: string, r: { raw: unknown; ms: number }): Promise<void> {
    await this.update(userId, (card) => {
      if (card.story) return null;
      const next = this.withStory(card, r);
      // corrected before the paste's story landed: the story was written from the old text
      if (card.updatedAt && next.story) next.story.stale = [...SPARK_STORY_IDS];
      return { card: next, out: true };
    });
  }

  private async summaryLines(userId: string): Promise<string[]> {
    const c = await this.store.getCompanion(userId).catch(() => null);
    const s = c?.persona?.summary;
    return s ? [`Why: ${s.why}`, `Energy: ${s.energy}`, `Initiative: ${s.initiative}`, `Never: ${s.never}`].filter((l) => !/:\s*$/.test(l)) : [];
  }

  /** A story written before v2 (or none) is rewritten whole. */
  private static needsWrite(card: StyleCard): SparkStoryId[] | "all" | null {
    if (!card.story || card.story.version !== 2) return "all";
    const only = (card.story.stale ?? []).filter((id): id is SparkStoryId => id !== "unknowns");
    return only.length ? only : null;
  }

  /** Write (or rewrite the stale cards of) the story from the stored card. */
  private writeStory(userId: string): Promise<void> {
    const running = this.storyJobs.get(userId);
    if (running) return running;
    const job = (async () => {
      const card = await this.store.getStyle(userId);
      if (!card) return;
      const need = Personalize.needsWrite(card);
      if (!need) return;
      const only = need === "all" ? undefined : need;
      const t0 = performance.now();
      const basis = card.updatedAt;
      const raw = await this.timedJson<unknown>(buildStoryRequest({ card, summary: await this.summaryLines(userId) }, only));
      const ms = Math.round(performance.now() - t0);
      await this.update(userId, (latest) => {
        const prev = latest.story?.version === 2 ? latest.story : undefined;
        const { cards, topics } = toStory(raw as { cards?: unknown }, latest, prev?.cards, only);
        // the profile changed while Spark wrote: what was written may be old → stays stale, the next read rewrites it
        const moved = latest.updatedAt !== basis;
        const stale = moved ? [...new Set([...(prev?.stale ?? []), ...(only ?? SPARK_STORY_IDS)])] : (prev?.stale ?? []).filter((id) => !(only ?? SPARK_STORY_IDS).includes(id as SparkStoryId));
        this.log("story.written", { from: "card", cards: only?.length ?? cards.length - 1, ms, moved });
        return { card: { ...latest, story: { version: 2, cards, topics, at: this.now().toISOString(), from: prev?.from ?? "card", ms, ...(stale.length ? { stale } : {}) } }, out: true };
      });
    })()
      .catch((err) => {
        this.storyFailedAt.set(userId, Date.now());
        this.log("story.failed", { from: "card", message: String(err).slice(0, 160) });
      })
      .finally(() => this.storyJobs.delete(userId));
    this.storyJobs.set(userId, job);
    return job;
  }

  /** The cards to show now: the stored ones, with `unknowns` rebuilt from the latest card. */
  private static current(card: StyleCard, hidePending = true): StoryCard[] {
    const cards = Personalize.withoutRemoved(toStory(null, card, card.story?.version === 2 ? card.story.cards : undefined, card.story?.version === 2 ? ["unknowns"] : undefined).cards, card);
    if (!hidePending) return cards;
    // an answer saved but not merged yet: its topic is already gone from the list (Codex P2)
    const answering = new Set((card.pendingCorrections ?? []).filter((p) => p.cardId === "unknowns" && p.text).map((p) => p.items[0]).filter(Boolean));
    if (!answering.size) return cards;
    return cards.flatMap((c) => {
      if (c.id !== "unknowns") return [c];
      const unknowns = (c.unknowns ?? []).filter((u) => !answering.has(u.topic));
      return unknowns.length ? [{ ...c, unknowns }] : [];
    });
  }

  /**
   * A line removed since the story was written ("forget that…", "That's not me") disappears from the cards at once,
   * before the stale card is rewritten (QA K-test P2: it took 20+ s to leave the story).
   */
  private static withoutRemoved(cards: StoryCard[], card: StyleCard): StoryCard[] {
    const since = card.story?.at ?? "";
    const gone = (card.removed ?? []).filter((t) => t.at > since).map((t) => keyWords(t.text));
    if (!gone.length) return cards;
    // still said by what's there now — one line or several together ("Food: noodles." + "Food: tofu." keep "Noodles
    // and tofu", Codex P2 #432); a correction can rewrite a line without the removed part
    const kept = new Set(Object.values(card.sections ?? {}).flatMap((l) => (l as Array<{ text: string }>).flatMap((f) => keyWords(f.text))));
    const hit = (text: string) => {
      const w = keyWords(text);
      const covers = (g: string[]) => w.every((x) => g.includes(x));
      return w.length > 0 && gone.some(covers) && !w.every((x) => kept.has(x));
    };
    return cards.map((c) => ({
      ...c,
      items: c.items.filter((i) => !hit(i.text)),
      ...(c.tags ? { tags: c.tags.filter((t) => !hit(t.text)) } : {}),
      ...(c.help ? { help: c.help.filter((h) => !hit(h.label)) } : {}),
    }));
  }

  /** GET /v1/profile/story?wait=s — `processing` if not written within the wait. */
  async story(userId: string, waitMs = 0): Promise<{ status: "ready" | "processing" | "none"; source?: StyleCard["source"]; cards: StoryCard[]; ms?: number }> {
    let card = await this.store.getStyle(userId);
    if (!card) return { status: "none", cards: [] };
    this.replayPending(userId, card);
    const failed = this.storyFailedAt.get(userId);
    const backoff = failed !== undefined && Date.now() - failed < STORY_BACKOFF_MS && !this.storyJobs.has(userId);
    if (Personalize.needsWrite(card) && !backoff) {
      const job = this.writeStory(userId);
      if (waitMs > 0) await Promise.race([job, new Promise((r) => setTimeout(r, waitMs).unref?.())]);
      card = (await this.store.getStyle(userId)) ?? card;
      if (card.story?.version !== 2 && this.storyJobs.has(userId)) return { status: "processing", source: card.source, cards: [] };
    }
    return { status: "ready", source: card.source, cards: Personalize.current(card), ms: card.story?.ms };
  }

  // ───────────── "That's not me" (C1–C3) ─────────────

  async correct(userId: string, body: Record<string, unknown>): Promise<{ card: StoryCard | null; ack: string; changed: string[]; profile: string; rows: DisplayRow[] }> {
    const cardId = body.cardId as StoryId;
    if (!STORY_IDS.includes(cardId)) throw new PersonalizeError(400, "bad_correction", "unknown card");
    const rawItems = body.items === undefined || body.items === null ? [] : body.items;
    if (!Array.isArray(rawItems) || rawItems.length > 12 || rawItems.some((i) => typeof i !== "string" || i.length > 240)) throw new PersonalizeError(400, "bad_correction", "items: the card's own lines");
    if (body.text !== undefined && body.text !== null && typeof body.text !== "string") throw new PersonalizeError(400, "bad_correction");
    const text = typeof body.text === "string" ? body.text.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim() : "";
    if (text.length > CORRECTION_TEXT_MAX) throw new PersonalizeError(400, "bad_correction", `text is at most ${CORRECTION_TEXT_MAX} characters`);
    const items = rawItems as string[];
    // newer wins by when the user asked: a slow earlier correction can't undo a later one
    const asOf = this.now().toISOString();
    if (!items.length && !text) throw new PersonalizeError(400, "bad_correction", "items or text");
    const before = await this.store.getStyle(userId);
    if (!before) throw new PersonalizeError(404, "no_profile");
    const shown = Personalize.current(before).find((c) => c.id === cardId);
    if (!shown) throw new PersonalizeError(409, "card_not_shown", "that card isn't in the story");
    const texts = cardTexts(shown);
    if (items.some((i) => !texts.includes(i))) throw new PersonalizeError(400, "bad_correction", "items: the card's own lines");
    const t0 = performance.now();
    // "forget that …" on the sheet: like the voice path, only the profile's own words are kept; the request text
    // itself is never stored, shown or replayed (Codex r7) — the marked lines still go
    if (text && isForgetRequest(text)) {
      await this.rememberForget(userId, before, forgetTarget(text));
      if (!items.length) {
        const latest = (await this.store.getStyle(userId)) ?? before;
        this.log("profile.corrected", { card: cardId, ms: Math.round(performance.now() - t0), apply: "forget" });
        return { card: Personalize.current(latest).find((c) => c.id === cardId) ?? shown, ack: ACK, changed: [], profile: styleProfileText(latest), rows: latest.display };
      }
      return this.correct(userId, { cardId, items });
    }
    // a sensitive or identifying text (health, money, an email …) is never stored, shown or sent to Spark (Codex P1):
    // the card stays as it was, the user still gets the ack
    if (text && (isSensitiveDetail(text) || redactSensitive(text) !== text || looksLikeInjection(text))) {
      this.log("profile.corrected", { card: cardId, ms: Math.round(performance.now() - t0), apply: "dropped_sensitive" });
      return { card: shown, ack: ACK, changed: [], profile: styleProfileText(before), rows: before.display };
    }
    // S1 (≤ 1 s, Spark or not): the save answers now with the card as the user left it — the marked lines out, their
    // own words in — stored (stale) so a re-read or a second correction sees the same card. Spark turns it into
    // profile updates and rewords the card in the background (queued per user, newest wins by asOf).
    const card = optimisticCard(shown, items, text);
    // the save is kept (pendingCorrections) before the answer: a Spark outage or a restart replays it later
    await this.update(userId, (c) => {
      const pending = [...(c.pendingCorrections ?? []), { cardId, items, text, asOf }].slice(-20);
      if (c.story?.version !== 2) return { card: { ...c, pendingCorrections: pending }, out: true };
      const cards = card ? c.story.cards.map((x) => (x.id === cardId ? card : x)) : c.story.cards.filter((x) => x.id !== cardId);
      // not marked stale here: a story read before Spark merged would reword it from the old profile
      return { card: { ...c, pendingCorrections: pending, story: { ...c.story, cards } }, out: true };
    });
    this.lastSave.set(`${userId}\u0000${cardId}`, asOf);
    this.queued.add(`${userId}\u0000${asOf}`);
    this.queueCorrection(userId, () => this.applyCorrection(userId, cardId, items, text, asOf, shown, texts), `${userId}\u0000${asOf}`);
    const changed = card ? cardTexts(card).filter((t) => !texts.includes(t)) : [];
    this.log("profile.corrected", { card: cardId, ms: Math.round(performance.now() - t0), apply: "background" });
    // M02 / the call follow the save at once (QA build 6: "That's not me" on "Likes jokes in our chats." stayed in
    // Your preferences — the app keeps these rows, and the merge lands seconds later): the marked lines that are the
    // profile's own words are out of the rows and the profile text now; Spark's merge settles the rest
    const now = withPendingRemoved({ ...before, pendingCorrections: [...(before.pendingCorrections ?? []).filter((p) => p.asOf !== asOf), { cardId, items, text, asOf }] });
    return { card, ack: ACK, changed, profile: styleProfileText(now), rows: now.display };
  }

  /** Saves kept in pendingCorrections with no job here (a restart, or Spark down twice): apply them again. */
  private replayPending(userId: string, card: StyleCard): void {
    for (const p of card.pendingCorrections ?? []) {
      const key = `${userId}\u0000${p.asOf}`;
      if (this.queued.has(key)) continue;
      // the list with the pending answers still in it: a replayed answer must find its own topic (Codex)
      const shown = Personalize.current(card, false).find((c) => c.id === p.cardId);
      if (!shown) continue;
      this.queued.add(key);
      this.log("profile.correction_replay", { card: p.cardId });
      this.queueCorrection(userId, () => this.applyCorrection(userId, p.cardId as StoryId, p.items, p.text, p.asOf, shown, cardTexts(shown)), key);
    }
  }

  /** Corrections of one user run one at a time, in the order they were saved. */
  private queueCorrection(userId: string, fn: () => Promise<void>, key?: string): void {
    const prev = this.corrections.get(userId) ?? Promise.resolve();
    // when the job ends the save may still be pending (Spark down): a later read replays it
    const next = prev.then(fn, fn).catch(() => {}).finally(() => { if (key) this.queued.delete(key); });
    this.corrections.set(userId, next);
    this.rewrites.add(next);
    void next.finally(() => {
      this.rewrites.delete(next);
      if (this.corrections.get(userId) === next) this.corrections.delete(userId);
    });
  }

  /** C1 → C3 behind the save: Spark → profile updates (one retry) → merge → the card reworded. */
  private async applyCorrection(userId: string, cardId: StoryId, items: string[], text: string, asOf: string, shown: StoryCard, texts: string[]): Promise<void> {
    const t0 = performance.now();
    const before = await this.store.getStyle(userId);
    if (!before) return;
    // a hard timeout per try, so a hung call can't hold the user's queue (Codex P2)
    const once = async <T>(req: Parameters<JsonFn>[0]) => {
      // not unref: a pending save must keep the process (and a test) alive until its retry ran (CI 11/3)
      try { return await this.timedJson<T>(req); } catch { await new Promise((r) => setTimeout(r, CORRECTION_RETRY_MS)); return this.timedJson<T>(req); }
    };

    // C1: the marked lines + what's right → explicit updates (newer wins)
    let updates: ProfileUpdate[];
    if (cardId === "unknowns") {
      // "let me tell you now": an answer to one of the open topics
      // the topic they answered, never "the first one" (a replay after the list changed would answer the wrong one)
      const topic = (shown.unknowns ?? []).find((u) => u.topic === items[0]) ?? (items.length ? undefined : shown.unknowns?.[0]);
      if (!text || !topic) {
        await this.update(userId, (c) => ({ card: { ...c, pendingCorrections: (c.pendingCorrections ?? []).filter((x) => x.asOf !== asOf) }, out: true }));
        return;
      }
      const raw = await once<{ updates?: unknown; answered?: unknown }>(buildCorrectionRequest(before, text, undefined, topic)).catch((err) => {
        this.log("profile.correct_failed", { card: cardId, message: String(err).slice(0, 160) });
        return null;
      });
      if (!raw) return;
      const answer = toAnswer(raw, topic.item);
      updates = [...(answer ? [answer] : []), ...toCorrectionUpdates(raw)];
    } else {
      const line = [
        `On the "${EYEBROWS[cardId]}" card ("${shown.headline}") the user marked these as wrong: ${items.length ? items.map((i) => `"${i}"`).join("; ") : "(nothing specific)"}.`,
        text ? `They wrote what's right: ${text}` : "They didn't say what's right: remove the marked lines.",
      ].join(" ");
      const req = buildCorrectionRequest(before, line);
      req.instructions += "\nThis comes from the profile screen, where the user is correcting what a card says about them: treat it as their own explicit statement. Each marked line that is wrong goes into replaces (copy the matching current profile line). A marked line with nothing to put instead is an update with text \"\" and that line in replaces.";
      const raw = await once<{ updates?: unknown }>(req).catch((err) => {
        this.log("profile.correct_failed", { card: cardId, message: String(err).slice(0, 160) });
        return null;
      });
      if (!raw) return;
      updates = toCorrectionUpdates(raw, { allowRemove: true });
    }
    const settled = (c: StyleCard) => (c.pendingCorrections ?? []).filter((x) => x.asOf !== asOf);
    const applied = updates.length
      ? ((await this.update(userId, (card) => {
          const m = mergeUpdates(card, updates.map((u) => ({ ...u, asOf })), this.now().toISOString());
          if (!m.applied.length) return { card: { ...card, pendingCorrections: settled(card) }, out: [] as typeof m.applied };
          if (m.card.story) m.card.story.stale = [...new Set([...(m.card.story.stale ?? []), ...(cardId === "unknowns" ? [] : [cardId])])];
          return { card: { ...m.card, pendingCorrections: settled(card) }, out: m.applied };
        })) ?? [])
      : ((await this.update(userId, (card) => ({ card: { ...card, pendingCorrections: settled(card) }, out: [] }))) ?? []);
    const latest = await this.store.getStyle(userId);
    if (!latest) return;
    // C3: the answer doesn't wait for Spark to reword the card (S1 save took 9.6–14.8 s with both calls in a row):
    // it carries the card as shown with the marked lines out and the new facts in; the reworded card lands in the
    // store moments later (GET /v1/profile/story), other cards the change touched are rewritten on the next read
    if (applied.length && cardId !== "unknowns") {
      const card = interimCard(shown, items, before, latest);
      // the interim card is what the app now shows: store it (still stale) so a second correction on it validates
      // against the same lines and a re-read shows the same card until the reword lands (Codex)
      const stored = await this.update(userId, (c) => {
        if (c.updatedAt !== latest.updatedAt || c.story?.version !== 2 || this.newerSave(userId, cardId, asOf)) return null;
        const cards = card ? c.story.cards.map((x) => (x.id === cardId ? card : x)) : c.story.cards.filter((x) => x.id !== cardId);
        return { card: { ...c, story: { ...c.story, cards, stale: [...new Set([...(c.story.stale ?? []), cardId])] } }, out: true };
      });
      void stored;
      this.log("profile.correction_applied", { card: cardId, applied: applied.length, ms: Math.round(performance.now() - t0) });
      await this.rewriteCard(userId, cardId, latest.updatedAt, asOf); // story writes keep updatedAt; only merges move it
      return;
    }
    this.log("profile.correction_applied", { card: cardId, applied: applied.length, ms: Math.round(performance.now() - t0) });
  }

  /** C3 in the background: Spark rewords the corrected card; a newer change while it wrote keeps it stale. */
  private rewriteCard(userId: string, cardId: SparkStoryId, basis: string | undefined, asOf?: string): Promise<void> {
    const job = (async () => {
      const latest = await this.store.getStyle(userId);
      if (!latest) return;
      const raw = await this.timedJson<unknown>(buildStoryRequest({ card: latest }, [cardId]));
      await this.update(userId, (c) => {
        // the profile changed while Spark wrote (a newer correction): this reword is of an older profile — drop it;
        // the newer correction's own reword (or the next read) writes the card (Codex P1)
        if (c.updatedAt !== basis || (asOf && this.newerSave(userId, cardId, asOf))) return null;
        const prev = c.story?.version === 2 ? c.story : undefined;
        const { cards, topics } = toStory(raw as { cards?: unknown }, c, prev?.cards, prev ? [cardId] : undefined);
        const stale = (prev?.stale ?? []).filter((id) => id !== cardId);
        return { card: { ...c, story: { version: 2, cards, topics, at: this.now().toISOString(), from: prev?.from ?? "card", ...(prev?.ms ? { ms: prev.ms } : {}), stale } }, out: true };
      });
      this.log("story.written", { from: "correction", cards: 1 });
    })().catch((err) => this.log("story.failed", { from: "correction", message: String(err).slice(0, 160) }));
    this.rewrites.add(job);
    return job.finally(() => this.rewrites.delete(job));
  }
  /** tests / shutdown: wait for background card rewrites */
  async drainRewrites(): Promise<void> { while (this.rewrites.size) await Promise.all([...this.rewrites]); }

  // ───────────── calls ─────────────

  /**
   * Call start: the server's latest profile (corrections included) and this call's one question.
   * `plan: false` = a continuation (handoff to the other device): the same conversation, not a new call — the
   * profile only; no question, no first-call nod, and growth.calls is not counted (P1 11/3, demo S4).
   */
  async startCall(userId: string, opts: { plan?: boolean } = {}): Promise<CallStart | null> {
    const pendingCard = await this.store.getStyle(userId);
    if (pendingCard?.pendingCorrections?.length) this.replayPending(userId, pendingCard);
    if (opts.plan === false) {
      const stored = await this.store.getStyle(userId);
      const card = stored ? withPendingRemoved(stored) : null;
      return card ? { profile: styleProfileText(card, 2000, { toConfirm: false }), taste: tasteLines(card), removed: (card.removed ?? []).map((t) => ({ text: t.text, forget: !!t.forget })), ...(card.growth?.calls ? { calls: card.growth.calls } : {}) } : null;
    }
    return this.update(userId, (card) => {
      const r = beginCall(card, this.now().toISOString());
      if (r.ask) this.log("profile.ask_planned", { call: r.card.growth!.calls });
      // what the call is told: without the lines the user took out whose merge is still running
      const told = withPendingRemoved(r.card);
      return {
        card: r.card,
        out: { ...(firstCallNod(told) ? { nod: firstCallNod(told)! } : {}), profile: styleProfileText(told, 2000, { toConfirm: false }), removed: (r.card.removed ?? []).map((t) => ({ text: t.text, forget: !!t.forget })), ...(r.ask ? { ask: askLine(r.ask), askItem: r.ask.item, askTopic: r.ask } : {}), taste: tasteLines(told), ...(r.card.growth?.calls ? { calls: r.card.growth.calls } : {}) },
      };
    });
  }

  /**
   * The call turned out not to be a new conversation (watch together attached before the question was asked):
   * give back the call count and the planned topic so a later call can ask it.
   */
  async unplanCall(userId: string, item: string | null): Promise<void> {
    await this.update(userId, (card) => {
      const g = card.growth;
      if (!g || g.calls <= 0) return null;
      const asked = item ? g.asked.filter((a) => !(a.item === item && !a.answered)) : g.asked;
      return { card: { ...card, growth: { calls: g.calls - 1, asked } }, out: true };
    });
  }

  /**
   * A "forget that …" (voice or the profile sheet): what is kept is never the user's words, only the stored
   * profile's own words the request named — those passed every filter once, so no new detail ("asthma when
   * running") is stored or sent on (Codex r5–r7). Returns whether anything was kept.
   */
  private async rememberForget(userId: string, card: StyleCard, target: string): Promise<{ applied: AppliedUpdate[]; kept: string } | null> {
    const keys = avoidKeys([{ text: target, forget: true }]);
    const lines = Object.values(card.sections ?? {}).flatMap((l) => (l as Array<{ text: string }>).map((f) => f.text));
    const named = [...new Set(keys.flatMap((k) => k.keys).filter((stem) => lines.some((t) => keyWords(t).includes(stem))))];
    const words = [...new Set(lines.flatMap((t) => (t.match(/[\p{L}\p{N}-]{3,}/gu) ?? []).filter((w) => named.includes(w.toLowerCase().slice(0, 5)))))].map((w) => w.toLowerCase());
    const kept = words.join(" ").slice(0, 80);
    if (!kept) return null;
    const at = this.now().toISOString();
    let applied: AppliedUpdate[] = [];
    const targetKeys = keys.flatMap((k) => k.keys);
    await this.update(userId, (c) => {
      // the profile lines the request is about go now (more than half of the request's words are in the line), so
      // the sheet's "forget that …" really removes it without waiting for Spark (Codex r8); "asthma when running"
      // does not take "Likes running." with it
      const updates: ProfileUpdate[] = [];
      for (const [field, list] of Object.entries(c.sections ?? {})) {
        const hit = (list as Finding[]).filter((f) => {
          const w = keyWords(f.text);
          return targetKeys.filter((x) => w.includes(x)).length * 2 > targetKeys.length;
        }).map((f) => f.text);
        if (hit.length && (PROFILE_FIELDS as readonly string[]).includes(field)) updates.push({ field: field as ProfileField, text: "", replaces: hit, label: "explicit", asOf: at });
      }
      const m = updates.length ? mergeUpdates(c, updates, at) : null;
      applied = m?.applied ?? [];
      const merged = m ? m.card : c;
      return { card: { ...merged, removed: [...(merged.removed ?? []), { text: kept, at, forget: true as const }].slice(-40) }, out: true };
    });
    return { applied, kept };
  }

  /**
   * One user line in a call. `asked` = the companion just asked this call's question: the line is always
   * checked for an answer ("Noted: …"); otherwise only lines that look like a correction reach Spark ("Updated: …").
   */
  async voiceCorrection(userId: string, line: string, lastAssistant?: string, signal?: AbortSignal, asked?: UnknownItem | null): Promise<VoiceUpdate | null> {
    if (!asked && !mightBeCorrection(line)) return null;
    const card = await this.store.getStyle(userId);
    if (!card) return null;
    const t0 = performance.now();
    const asOf = this.now().toISOString();
    let forgot: { applied: AppliedUpdate[]; kept: string } | null = null;
    // "forget that …": its target is kept out of everything from now on, whatever Spark makes of the line
    // checked on the whole line too: stripping punctuation can hide an email ("alice@example com", Codex P1)
    if (isForgetRequest(line) && !isSensitiveDetail(line) && redactSensitive(line) === line && !looksLikeInjection(line)) {
      const target = forgetTarget(line);
      // a sensitive target (health, money, …) is never stored or sent on: the memory filters drop it anyway (Codex P1)
      // a target with a number in it (an address, a phone, an account) is never kept, whatever its shape
      forgot = await this.rememberForget(userId, card, target);
    }
    // removed already: the call's profile and taste follow now, even if Spark has nothing more to change (Codex r9)
    const forgotUpdate = async (): Promise<VoiceUpdate | null> => {
      if (!forgot?.applied.length) return null;
      const latest = (await this.store.getStyle(userId)) ?? card;
      return { events: [{ text: `Updated: forgot ${forgot.kept}`.slice(0, 60), fields: [...new Set(forgot.applied.map((a) => a.field))] }], applied: forgot.applied, answered: false, profile: styleProfileText(latest, 2000, { toConfirm: false }), taste: tasteLines(latest) };
    };
    const raw = await this.json<{ updates?: unknown; answered?: unknown }>(buildCorrectionRequest(card, line, lastAssistant, asked), signal);
    const answer = asked ? toAnswer(raw, asked.item) : null;
    // "forget that…" may remove a line by voice (removal-only updates are otherwise only from the profile screen)
    const updates = [...(answer ? [answer] : []), ...toCorrectionUpdates(raw, { allowRemove: FORGET.test(line) })].map((u) => ({ ...u, asOf }));
    if (!updates.length || signal?.aborted) { this.log("profile.voice_checked", { applied: 0, ms: Math.round(performance.now() - t0) }); return signal?.aborted ? null : forgotUpdate(); }
    const out = await this.update(userId, (latest) => {
      const m = mergeUpdates(latest, updates, this.now().toISOString());
      if (!m.applied.length) return null;
      if (answer && m.applied.some((a) => a.answers === answer.answers) && m.card.growth) m.card.growth = { ...m.card.growth, asked: m.card.growth.asked.map((a) => (a.item === asked!.item ? { ...a, answered: true } : a)) };
      return { card: m.card, out: { m, card: m.card } };
    });
    if (!out) return forgotUpdate();
    const events: Array<{ text: string; fields: string[] }> = [];
    const noted = out.m.applied.filter((a) => answer && a.answers === answer.answers);
    const rest = out.m.applied.filter((a) => !noted.includes(a));
    if (noted.length) events.push({ text: `Noted: ${noted[0].chip ?? noted[0].text.replace(/\.$/, "")}`.slice(0, 60), fields: [noted[0].field] });
    if (rest.length) events.push({ text: `Updated: ${rest.find((a) => a.chip)?.chip ?? rest[0].text.replace(/\.$/, "")}`.slice(0, 60), fields: [...new Set(rest.map((a) => a.field))] });
    this.log("profile.voice_updated", { applied: out.m.applied.length, answered: noted.length > 0, fields: out.m.applied.map((a) => a.field), ms: Math.round(performance.now() - t0) });
    return { events, applied: out.m.applied, answered: noted.length > 0, profile: styleProfileText(out.card, 2000, { toConfirm: false }), taste: tasteLines(out.card) };
  }

  /** Knows-Me S1: two long replies cut off in one call → an observed "short replies" line (never over an explicit one). */
  async noteShorter(userId: string): Promise<{ text: string; fields: string[]; profile: string } | null> {
    const at = this.now().toISOString();
    const out = await this.update(userId, (card) => {
      // they said they want long answers: two cut-offs don't override that
      if ((card.sections.response ?? []).some((f) => f.label === "explicit" && /\b(?:long|longer|detail\w*|thorough|in depth|in-depth|whole story|explain everything)\b/i.test(f.text))) return null;
      const m = mergeUpdates(card, [{ field: "response", text: "Short replies, one or two sentences.", replaces: [], label: "observed", asOf: at, chip: "shorter replies" }], at);
      return m.applied.length ? { card: m.card, out: m.card } : null;
    });
    if (!out) return null;
    this.log("profile.voice_updated", { applied: 1, by: "cuts" });
    return { text: "Updated: shorter replies", fields: ["response"], profile: styleProfileText(out, 2000, { toConfirm: false }) };
  }

  /** After a call: grow the profile. Returns how many updates were applied. */
  async endCall(userId: string, turns: CallTurn[], asked: string | null, startedAt?: string): Promise<number> {
    const userTurns = turns.filter((t) => t.role === "user" && t.text.trim());
    if (userTurns.length < 2) return 0;
    const card = await this.store.getStyle(userId);
    if (!card) return 0;
    const t0 = performance.now();
    const raw = await this.bgJson<{ updates?: unknown; answered?: unknown }>(buildCallExtractRequest(card, turns, asked));
    const asOf = startedAt ?? new Date(this.now().getTime() - 60 * 60_000).toISOString();
    const updates: ProfileUpdate[] = toCallUpdates(raw, asked).map((u) => ({ ...u, asOf }));
    const n = (await this.update(userId, (latest) => {
      const m = mergeUpdates(latest, updates, this.now().toISOString());
      const answered = m.applied.length && asked && updates.some((u) => u.answers === asked);
      if (!m.applied.length) return null;
      if (answered && m.card.growth) m.card.growth = { ...m.card.growth, asked: m.card.growth.asked.map((a) => (a.item === asked ? { ...a, answered: true } : a)) };
      return { card: m.card, out: m.applied.length };
    })) ?? 0;
    this.log("profile.call_grown", { applied: n, asked: !!asked, answered: updates.some((u) => !!u.answers), ms: Math.round(performance.now() - t0) });
    return n;
  }
}

export { CALL_SIDE_MAX };
