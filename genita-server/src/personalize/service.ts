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
import { styleProfileText, type StyleCard, type DisplayRow } from "../prep/importProfile.ts";
import type { PrepStore } from "../prep/store.ts";
import { PICKS, STORY_IDS, TITLES, buildStoryRequest, openItems, toStory, unknownsCard, type Story, type StoryCard, type StoryId } from "./story.ts";
import { mergeUpdates, type AppliedUpdate, type ProfileUpdate } from "./merge.ts";
import { askLine, beginCall } from "./unknowns.ts";
import { buildCorrectionRequest, mightBeCorrection, toCorrectionUpdates } from "./corrections.ts";
import { buildCallExtractRequest, toCallUpdates, type CallTurn } from "./extract.ts";
import { tasteLines, type TasteLine } from "./reasons.ts";

export type JsonFn = <T>(req: Omit<SparkRequest, "text"> & { schemaName: string; schema: Record<string, unknown> }, signal?: AbortSignal) => Promise<T>;
export type PersonalizeStore = Pick<PrepStore, "getStyle" | "putStyle" | "getCompanion">;

export const ACK = "Got it. I'll remember that.";
export const CORRECTION_TEXT_MAX = 200;
const STORY_TIMEOUT_MS = 20_000;
const CALL_SIDE_MAX = 12;

export class PersonalizeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message = code) { super(message); this.status = status; this.code = code; }
}

export type CallStart = { profile?: string; ask?: string; askItem?: string; taste: TasteLine[] };
export type VoiceUpdate = { chip: string; applied: AppliedUpdate[]; profile: string; taste: TasteLine[] };

export class Personalize {
  private readonly store: PersonalizeStore;
  private readonly json: JsonFn;
  private readonly log: (event: string, data: Record<string, unknown>) => void;
  private readonly now: () => Date;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly storyJobs = new Map<string, Promise<void>>();

  constructor(o: { store: PersonalizeStore; json?: JsonFn; metaKey?: string; log?: (event: string, data: Record<string, unknown>) => void; now?: () => Date }) {
    this.store = o.store;
    this.json = o.json ?? (<T>(req: Parameters<JsonFn>[0], signal?: AbortSignal) => sparkJson<T>(o.metaKey ?? "", req, signal));
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

  private timed<T>(p: Promise<T>, ms = STORY_TIMEOUT_MS): Promise<T> {
    return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms).unref?.())]);
  }

  // ───────────── D47 story ─────────────

  /** Import: Spark story from the (already redacted) paste. Never throws; null on failure. */
  async storyFromText(text: string): Promise<{ raw: unknown; ms: number } | null> {
    const t0 = performance.now();
    try {
      const raw = await this.timed(this.json<unknown>(buildStoryRequest({ text })));
      return { raw, ms: Math.round(performance.now() - t0) };
    } catch (err) {
      this.log("story.failed", { from: "text", message: String(err).slice(0, 160) });
      return null;
    }
  }

  /** Attach a story written from the paste to the card the parse made (checked against that card). */
  withStory(card: StyleCard, r: { raw: unknown; ms: number }, from: Story["from"] = "text"): StyleCard {
    const cards = toStory(r.raw as { cards?: unknown }, card);
    return { ...card, story: { version: 1, cards, at: this.now().toISOString(), from, ms: r.ms } };
  }

  /** Save a story that landed after the import response went out (only if the card has none yet). */
  async attachLate(userId: string, r: { raw: unknown; ms: number }): Promise<void> {
    await this.update(userId, (card) => (card.story ? null : { card: this.withStory(card, r), out: true }));
  }

  private async summaryLines(userId: string): Promise<string[]> {
    const c = await this.store.getCompanion(userId).catch(() => null);
    const s = c?.persona?.summary;
    return s ? [`Why: ${s.why}`, `Energy: ${s.energy}`, `Initiative: ${s.initiative}`, `Never: ${s.never}`].filter((l) => !/:\s*$/.test(l)) : [];
  }

  /** Write (or rewrite the stale cards of) the story from the stored card. */
  private writeStory(userId: string): Promise<void> {
    const running = this.storyJobs.get(userId);
    if (running) return running;
    const job = (async () => {
      const card = await this.store.getStyle(userId);
      if (!card) return;
      const only = card.story ? (card.story.stale ?? []).filter((id) => id !== "unknowns") : [];
      if (card.story && !only.length) return;
      const t0 = performance.now();
      const raw = await this.timed(this.json<unknown>(buildStoryRequest({ card, summary: await this.summaryLines(userId) }, only.length ? (only as Exclude<StoryId, "unknowns">[]) : undefined)));
      const ms = Math.round(performance.now() - t0);
      await this.update(userId, (latest) => {
        const cards = toStory(raw as { cards?: unknown }, latest, latest.story?.cards, only.length ? only : undefined);
        this.log("story.written", { from: "card", cards: only.length || cards.length - 1, ms, later: cards.filter((c) => c.later).length });
        return { card: { ...latest, story: { version: 1, cards, at: this.now().toISOString(), from: "card", ms } }, out: true };
      });
    })()
      .catch((err) => this.log("story.failed", { from: "card", message: String(err).slice(0, 160) }))
      .finally(() => this.storyJobs.delete(userId));
    this.storyJobs.set(userId, job);
    return job;
  }

  /** GET /v1/profile/story?wait=s — `processing` if not written within the wait. The unknowns card is always current. */
  async story(userId: string, waitMs = 0): Promise<{ status: "ready" | "processing" | "none"; source?: StyleCard["source"]; cards: StoryCard[]; ms?: number }> {
    let card = await this.store.getStyle(userId);
    if (!card) return { status: "none", cards: [] };
    if (!card.story || card.story.stale?.some((id) => id !== "unknowns")) {
      const job = this.writeStory(userId);
      if (waitMs > 0) await Promise.race([job, new Promise((r) => setTimeout(r, waitMs).unref?.())]);
      card = (await this.store.getStyle(userId)) ?? card;
      if (!card.story) return this.storyJobs.has(userId) ? { status: "processing", source: card.source, cards: [] } : { status: "ready", source: card.source, cards: toStory(null, card) };
    }
    // unknowns is the server's own: recomputed from the latest card on every read
    const cards = toStory(null, card, card.story!.cards, ["unknowns"]);
    return { status: "ready", source: card.source, cards, ms: card.story!.ms };
  }

  // ───────────── "That's not me" ─────────────

  async correct(userId: string, body: Record<string, unknown>): Promise<{ card: StoryCard; ack: string; changed: boolean; profile: string; rows: DisplayRow[] }> {
    const cardId = body.cardId as StoryId;
    if (!STORY_IDS.includes(cardId)) throw new PersonalizeError(400, "bad_correction", "unknown card");
    const pick = body.pick === undefined || body.pick === null || body.pick === "" ? null : body.pick;
    if (pick !== null && (typeof pick !== "string" || !PICKS[cardId].includes(pick))) throw new PersonalizeError(400, "bad_correction", "unknown pick");
    const text = typeof body.text === "string" ? body.text.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim() : "";
    if (body.text !== undefined && body.text !== null && typeof body.text !== "string") throw new PersonalizeError(400, "bad_correction");
    if (text.length > CORRECTION_TEXT_MAX) throw new PersonalizeError(400, "bad_correction", `text is at most ${CORRECTION_TEXT_MAX} characters`);
    if (!pick && !text) throw new PersonalizeError(400, "bad_correction", "pick or text");
    const before = await this.store.getStyle(userId);
    if (!before) throw new PersonalizeError(404, "no_profile");
    const t0 = performance.now();

    let applied: AppliedUpdate[] = [];
    if (cardId === "unknowns" && pick === "Don't ask about these" && !text) {
      // no Spark: every open item is declined (the first calls won't ask, the card stops listing them)
      const latest = (await this.update(userId, (card) => {
        const at = this.now().toISOString();
        const asked = [...(card.growth?.asked ?? []), ...openItems(card).map((item) => ({ item, at, declined: true }))];
        const next = { ...card, toConfirm: [], growth: { calls: card.growth?.calls ?? 0, asked } };
        return { card: next, out: next };
      }))!;
      this.log("profile.corrected", { card: cardId, applied: 0, by: "declined" });
      return { card: unknownsCard(latest), ack: ACK, changed: true, profile: styleProfileText(latest), rows: latest.display };
    }

    const shown = before.story?.cards.find((c) => c.id === cardId);
    const line = [`About the "${TITLES[cardId]}" card${shown && !shown.later ? ` (it said: "${shown.observation}")` : ""}, the user says it's not right.`, pick ? `They picked: ${pick}.` : "", text ? `They wrote: ${text}` : ""].filter(Boolean).join(" ");
    const req = buildCorrectionRequest(before, line);
    req.instructions += "\nThis comes from the profile screen, where the user is correcting what a card says about them: treat it as their own explicit statement and turn it into updates. A pick that removes something (e.g. \"That's fine with me\" on a boundary, \"I don't need this\" on help) is an update with text \"\" and the removed lines in replaces.";
    const raw = await this.json<{ updates?: unknown }>(req).catch((err) => {
      this.log("profile.correct_failed", { card: cardId, message: String(err).slice(0, 160) });
      throw new PersonalizeError(502, "upstream_failed", "try again");
    });
    const updates = toCorrectionUpdates(raw, { allowRemove: true });
    if (updates.length) {
      applied = (await this.update(userId, (card) => {
        const m = mergeUpdates(card, updates, this.now().toISOString());
        if (!m.applied.length) return null;
        // the corrected card is rewritten now, the others it touched on the next read
        if (m.card.story) m.card.story.stale = [...new Set([...(m.card.story.stale ?? []), cardId])];
        return { card: m.card, out: m.applied };
      })) ?? [];
    }
    let latest = (await this.store.getStyle(userId))!;
    if (applied.length && cardId !== "unknowns") {
      try {
        const story = await this.timed(this.json<unknown>(buildStoryRequest({ card: latest }, [cardId as Exclude<StoryId, "unknowns">])));
        await this.update(userId, (c) => {
          const cards = toStory(story as { cards?: unknown }, c, c.story?.cards, [cardId]);
          // no story yet: the other cards are profile-line fallbacks until the next read rewrites them
          const stale = c.story ? (c.story.stale ?? []).filter((id) => id !== cardId) : STORY_IDS.filter((id) => id !== cardId && id !== "unknowns");
          return { card: { ...c, story: { version: 1, at: this.now().toISOString(), from: c.story?.from ?? "card", ...(c.story?.ms ? { ms: c.story.ms } : {}), cards, stale } }, out: true };
        });
      } catch (err) {
        this.log("story.failed", { from: "correction", message: String(err).slice(0, 160) });
      }
      latest = (await this.store.getStyle(userId))!;
    }
    const cards = toStory(null, latest, latest.story?.cards, latest.story ? ["unknowns"] : undefined);
    const card = cards.find((c) => c.id === cardId)!;
    this.log("profile.corrected", { card: cardId, applied: applied.length, ms: Math.round(performance.now() - t0) });
    return { card, ack: ACK, changed: applied.length > 0, profile: styleProfileText(latest), rows: latest.display };
  }

  // ───────────── calls ─────────────

  /** Call start: the server's latest profile (corrections included) and this call's one question. */
  async startCall(userId: string): Promise<CallStart | null> {
    return this.update(userId, (card) => {
      const r = beginCall(card, this.now().toISOString());
      if (r.ask) this.log("profile.ask_planned", { call: r.card.growth!.calls });
      return {
        card: r.card,
        out: { profile: styleProfileText(r.card, 2000, { toConfirm: false }) || undefined, ...(r.ask ? { ask: askLine(r.ask), askItem: r.ask } : {}), taste: tasteLines(r.card) },
      };
    });
  }

  /** One user line in a call. null = not a correction (most lines never reach Spark). */
  async voiceCorrection(userId: string, line: string, lastAssistant?: string, signal?: AbortSignal): Promise<VoiceUpdate | null> {
    if (!mightBeCorrection(line)) return null;
    const card = await this.store.getStyle(userId);
    if (!card) return null;
    const t0 = performance.now();
    const raw = await this.json<{ updates?: unknown }>(buildCorrectionRequest(card, line, lastAssistant), signal);
    const updates = toCorrectionUpdates(raw);
    if (!updates.length || signal?.aborted) { this.log("profile.voice_checked", { applied: 0, ms: Math.round(performance.now() - t0) }); return null; }
    const out = await this.update(userId, (latest) => {
      const m = mergeUpdates(latest, updates, this.now().toISOString());
      return m.applied.length ? { card: m.card, out: { m, card: m.card } } : null;
    });
    if (!out) return null;
    const chips = out.m.applied.map((a) => a.chip).filter((c): c is string => !!c);
    this.log("profile.voice_updated", { applied: out.m.applied.length, fields: out.m.applied.map((a) => a.field), ms: Math.round(performance.now() - t0) });
    return { chip: `Updated: ${chips.join(", ") || out.m.applied[0].text.replace(/\.$/, "")}`.slice(0, 60), applied: out.m.applied, profile: styleProfileText(out.card, 2000, { toConfirm: false }), taste: tasteLines(out.card) };
  }

  /** After a call: grow the profile. Returns how many updates were applied. */
  async endCall(userId: string, turns: CallTurn[], asked: string | null): Promise<number> {
    const userTurns = turns.filter((t) => t.role === "user" && t.text.trim());
    if (userTurns.length < 2) return 0;
    const card = await this.store.getStyle(userId);
    if (!card) return 0;
    const t0 = performance.now();
    const raw = await this.json<{ updates?: unknown; answered?: unknown }>(buildCallExtractRequest(card, turns, asked));
    const updates: ProfileUpdate[] = toCallUpdates(raw, asked);
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
