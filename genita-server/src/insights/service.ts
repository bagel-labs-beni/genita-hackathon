/**
 * SUM insight report service: one per server (prep/index.ts), written in the background so SUM opens with it.
 *
 *   begin(user, text)   import: Spark starts on the redacted paste at once (parallel with the parse);
 *                       saved only after the import's card is (commit), never if the import failed (cancel)
 *   fromSkip(user, …)   N1–N3: from the picks, right after the skip card is saved
 *   fromAnswers(user, a) setup answers (the app sends them when P-last opens): rewritten with the picks + settings
 *   get(user, waitMs)   GET /v1/profile/insights — waits for a running write up to waitMs
 *   verdict(user, id, …) "That's right" (kept, high) / "Not me" (removed → still learning; told to the next write
 *                       and to the call profile as not true)
 *
 * Stored in the style card (user_styles.style_json.insights) under Personalize's lock. Import receipts are kept in
 * memory only (2 h, for the current-process response); the DB keeps their source labels but never pasted text.
 * GENITA_INSIGHTS=0: no Spark call, GET → none, the app keeps the old SUM.
 */
import { createHash } from "node:crypto";
import type { SparkRequest } from "../meta/spark.ts";
import { museJson } from "../meta/spark.ts";
import type { Personalize } from "../personalize/service.ts";
import { avoidKeys, mentionsAvoided } from "../personalize/forgotten.ts";
import { looksLikeInjection, redactSensitive, ruleLine, type StyleCard } from "../prep/importProfile.ts";
import type { PrepStore } from "../prep/store.ts";
import { LEARN_LABEL, OBS_MIN, OPERATIONAL, mixFrom, buildInsightRequest, editsBehind, editsFromSources, findingsBehind, linkSources, rulesBehind, picksFromAnswers, privateDetail, settingsFrom, similarClaim, scrubRemoved, toReport, withoutObservations, withoutRemoved, type InsightInputs } from "./report.ts";
import type { InsightEvidence, InsightReport, StoredInsights } from "./profile.ts";
export { insightProfileLines } from "./profile.ts";

type JsonFn = <T>(req: Omit<SparkRequest, "text"> & { schemaName: string; schema: Record<string, unknown> }, signal?: AbortSignal) => Promise<T>;

/** a paste quote as a short hash (the words themselves are never stored for a "not me") */
export const quoteKey = (q: string) => createHash("sha256").update(q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()).digest("hex").slice(0, 16);   // punctuation-blind, like the quote check (Codex #581 r13)
const QUOTE_STOP = new Set("i me my we you the a an to of and or but in on at for with is are was be it that this like really just so very".split(" "));
/**
 * A quote as the hashes of its content words ("I like to cook spicy food." → cook, spicy, food). Two quotes are the
 * same evidence when one's words are all in the other's (≥ 2 words, or both a single word): "spicy food" inside
 * "I enjoy spicy food", "short, direct replies" inside a longer line — never two lines sharing "I like to"
 * (Codex #581 r15/r16). Hashes only, never the pasted words.
 */
export function quoteWords(q: string): string[] {
  const w = q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter((x) => x && !QUOTE_STOP.has(x));
  return [...new Set(w.map((x) => quoteKey(x)))];
}
export function sameQuote(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const [small, big] = a.length <= b.length ? [a, new Set(b)] : [b, new Set(a)];
  if (small.length < 2 && big.size > 1) return false;
  return small.every((h) => big.has(h));
}

/** an observation built on a pick / item they already said "not me" to (any claim wording) */
export function standsOnDenied(o: { claim: string; use_in_call: string; evidence: Array<{ source: string; quote: string }> }, d: { picks?: string[]; items?: string[]; quotes?: string[][] }): boolean {
  // the same pick / item whatever source it's cited as ("Minimal" as an answer or as an import quote, Codex #581 r21)
  const n = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const picks = new Set([...(d.picks ?? []), ...(d.items ?? [])].map(n));
  if (o.evidence.some((e) => picks.has(n(e.quote)))) return true;
  if (o.evidence.some((e) => e.source !== "answer" && (d.quotes ?? []).some((q) => sameQuote(quoteWords(e.quote), q)))) return true;
  const items = (d.items ?? []).filter(Boolean);
  if (!items.length) return false;
  const re = new RegExp(`\\b(?:${items.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
  return [o.claim, o.use_in_call, ...o.evidence.map((e) => e.quote)].some((t) => re.test(t));
}

export class InsightsError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message = code) { super(message); this.status = status; this.code = code; }
}

export type InsightsStatus = "ready" | "pending" | "failed" | "none";
export const CORRECTION_MAX = 200;
const TEXT_TTL_MS = 2 * 60 * 60_000;
const TEXT_MAX_USERS = 2000;
const SPARK_TIMEOUT_MS = 30_000;
const FAIL_BACKOFF_MS = 60_000;
const DENIED_MAX = 20;

type Job = { promise: Promise<void>; startedAt: number };
type ImportQuote = Pick<InsightEvidence, "quote" | "highlight">;
type ImportQuotes = { quotes: Map<string, ImportQuote[]>; at: number };

/**
 * Receipt owners survive filtering and reordering. The evidence identity deliberately excludes copied text: source
 * and server-issued label are enough to distinguish an import receipt from the user's picks or chat.
 */
function importEvidenceKey(scope: string, e: InsightEvidence): string {
  return `${scope}:${e.source}:${e.source_label}`;
}

function importQuotesOf(report: InsightReport): Map<string, ImportQuote[]> {
  const quotes = new Map<string, ImportQuote[]>();
  const remember = (scope: string, e: InsightEvidence) => {
    if (e.source !== "import" || !e.quote) return;
    const key = importEvidenceKey(scope, e);
    const receipts = quotes.get(key) ?? [];
    receipts.push({ quote: e.quote, ...(e.highlight ? { highlight: e.highlight } : {}) });
    quotes.set(key, receipts);
  };
  report.observations.forEach((o) => o.evidence.forEach((e) => remember(`observation:${o.id}`, e)));
  report.strengths.forEach((x) => remember(`strength:${x.text}`, x.evidence));
  report.watchouts.forEach((x) => remember(`watchout:${x.text}:${x.fix}`, x.evidence));
  report.mix.forEach((x) => remember(`mix:${x.id}`, x.evidence));
  return quotes;
}

/** Restore only this process's import receipts; without them, omit the receipt rather than render an empty quote. */
function responseReport(report: InsightReport, saved?: ImportQuotes): InsightReport {
  const used = new Map<string, number>();
  const restore = (e: InsightEvidence, key: string): InsightEvidence | null => {
    if (e.source !== "import") return e;
    const quote = saved?.quotes.get(key)?.[used.get(key) ?? 0];
    used.set(key, (used.get(key) ?? 0) + 1);
    return quote ? { ...e, ...quote } : null;
  };
  return {
    ...report,
    observations: report.observations.map((o) => ({ ...o, evidence: o.evidence.flatMap((e) => {
      const next = restore(e, importEvidenceKey(`observation:${o.id}`, e));
      return next ? [next] : [];
    }) })),
    strengths: report.strengths.flatMap((x) => {
      const evidence = restore(x.evidence, importEvidenceKey(`strength:${x.text}`, x.evidence));
      return evidence ? [{ ...x, evidence }] : [];
    }),
    watchouts: report.watchouts.flatMap((x) => {
      const evidence = restore(x.evidence, importEvidenceKey(`watchout:${x.text}:${x.fix}`, x.evidence));
      return evidence ? [{ ...x, evidence }] : [];
    }),
    // A mix always has evidence in the app's Codable model. Do not send an empty import receipt: omit that row.
    mix: report.mix.flatMap((x) => {
      const evidence = restore(x.evidence, importEvidenceKey(`mix:${x.id}`, x.evidence));
      return evidence ? [{ ...x, evidence }] : [];
    }),
  };
}

/** what the app gets: no denied list, no internals */
export function publicReport(s: StoredInsights | undefined | null, importQuotes?: ImportQuotes): InsightReport | null {
  if (!s) return null;
  const { denied: _denied, ...r } = s;
  // the links are the server's bookkeeping (AU-91), not part of the report the app shows
  return responseReport({ ...r, observations: r.observations.map(({ sources: _s, basis: _b, ...o }) => o) }, importQuotes);
}

function cardFindings(card: StyleCard): string[] {
  return Object.values(card.sections ?? {}).flatMap((list) => (Array.isArray(list) ? list.map((f) => f.text) : [])).slice(0, 60);
}

/** the card's picks without what the user asked to forget (settings lane Codex: "Forget about seafood" kept the N3 pick) */
const cardPicks = (card: StyleCard) => withoutRemoved(card.picks ?? [], (p) => p.label, card.removed);

export class Insights {
  private readonly json: JsonFn;
  private readonly personalize: Personalize;
  private readonly store: Pick<PrepStore, "getStyle">;
  private readonly log: (event: string, data: Record<string, unknown>) => void;
  private readonly now: () => Date;
  readonly enabled: boolean;
  private readonly jobs = new Map<string, Job>();
  private readonly texts = new Map<string, { text: string; at: number }>();
  private readonly importQuotes = new Map<string, ImportQuotes>();
  /** Forget invalidates only volatile paste/receipts; running report writes may still save their stripped card. */
  private readonly importMemoryGeneration = new Map<string, number>();
  private readonly failedAt = new Map<string, number>();
  /** the newest write per user (a slower older one never lands over it) */
  private readonly seq = new Map<string, number>();
  private seqNext = 0;

  constructor(o: { personalize: Personalize; store: Pick<PrepStore, "getStyle">; json?: JsonFn; metaKey?: string; log?: (event: string, data: Record<string, unknown>) => void; now?: () => Date; enabled?: boolean }) {
    this.personalize = o.personalize;
    this.store = o.store;
    // one Muse Spark call per send, no hidden retry or fallback hop: every send (and our own retry) checks for a
    // forget first (Codex r9: sparkJson's inner retry re-sent the paste after a forget)
    this.json = o.json ?? (<T>(req: Parameters<JsonFn>[0], signal?: AbortSignal) => museJson<T>(o.metaKey ?? "", req, signal, { retry: false }));
    this.log = o.log ?? (() => {});
    this.now = o.now ?? (() => new Date());
    this.enabled = o.enabled ?? process.env.GENITA_INSIGHTS !== "0";
    // A targeted forget must not cancel an accepted-answers rewrite. It only makes
    // this process's paste and receipts ineligible to be read or re-registered.
    this.personalize.onForget((userId) => this.invalidateImportMemory(userId));
  }

  private nowMs(): number { return this.now().getTime(); }

  private clearImportMemory(userId: string) {
    this.texts.delete(userId);
    this.importQuotes.delete(userId);
  }

  private importGeneration(userId: string): number {
    return this.importMemoryGeneration.get(userId) ?? 0;
  }

  private invalidateImportMemory(userId: string) {
    this.clearImportMemory(userId);
    this.importMemoryGeneration.set(userId, this.importGeneration(userId) + 1);
  }

  private pruneImportMemory() {
    const now = this.nowMs();
    for (const [userId, value] of this.texts) if (now - value.at > TEXT_TTL_MS) this.clearImportMemory(userId);
    for (const [userId, value] of this.importQuotes) if (now - value.at > TEXT_TTL_MS) this.clearImportMemory(userId);
  }

  private rememberText(userId: string, text: string, generation: number) {
    if (this.importGeneration(userId) !== generation) return;
    this.pruneImportMemory();
    if (this.importGeneration(userId) !== generation) return;
    if (this.texts.size >= TEXT_MAX_USERS) this.clearImportMemory(this.texts.keys().next().value!);
    const now = this.nowMs();
    this.texts.set(userId, { text, at: now });
  }

  private rememberImportQuotes(userId: string, report: InsightReport, generation: number) {
    if (this.importGeneration(userId) !== generation) return;
    this.pruneImportMemory();
    if (this.importGeneration(userId) !== generation) return;
    // The original import starts the retention window. A rewrite completing
    // after expiry cannot make a new two-hour receipt window.
    const text = this.texts.get(userId);
    if (!text || this.nowMs() - text.at > TEXT_TTL_MS) { this.importQuotes.delete(userId); return; }
    const quotes = importQuotesOf(report);
    if (!quotes.size) { this.importQuotes.delete(userId); return; }
    this.importQuotes.set(userId, { quotes, at: text.at });
  }

  private reportFor(userId: string, card: StyleCard | null | undefined): InsightReport | null {
    this.pruneImportMemory();
    let saved = this.importQuotes.get(userId);
    const removed = card?.removed ?? [];
    const receiptAt = saved?.at;
    // A post-receipt forget makes the entire in-process import memory ineligible, just like textOf().
    if (receiptAt !== undefined && removed.some((r) => r.forget && Date.parse(r.at) >= receiptAt - 1000)) {
      this.clearImportMemory(userId);
      saved = undefined;
    } else if (saved) {
      const keys = avoidKeys(removed);
      if (keys.length) {
        const current = saved;
        const quotes = new Map([...current.quotes]
          .map(([key, receipts]) => [key, receipts.filter((receipt) => !mentionsAvoided(receipt.quote, keys))] as const)
          .filter(([, receipts]) => receipts.length));
        saved = quotes.size ? { ...saved, quotes } : undefined;
      }
    }
    return publicReport(card?.insights, saved);
  }

  /** the kept paste, unless the user has since asked to forget something (Codex r7: it would be sent again) */
  private textOf(userId: string, card?: StyleCard | null): string | undefined {
    this.pruneImportMemory();
    const t = this.texts.get(userId);
    if (!t) return undefined;
    if ((card?.removed ?? []).some((r) => r.forget && Date.parse(r.at) >= t.at - 1000)) { this.clearImportMemory(userId); return undefined; }
    return t.text;
  }

  /** One Spark write; a second when fewer than OBS_MIN survive the checks (the better one wins). */
  private async write(inputsForSend: () => Promise<InsightInputs>, from: InsightReport["from"], settings: InsightReport["settings"], stillOk: () => Promise<boolean> = async () => true): Promise<InsightReport> {
    const t0 = performance.now();
    // A full profile reset or newer write stops this job. Targeted forgets do not:
    // they replace the next send's inputs with a current, paste-free snapshot.
    const once = async () => {
      if (!(await stillOk())) throw new Error("insights_stale: forget or a newer write since this one started");
      return onceRaw();
    };
    let sent: InsightInputs | undefined;
    const onceRaw = async () => {
      const inputs = await inputsForSend();
      sent = inputs;
      return toReport(await this.json<unknown>(buildInsightRequest(inputs), AbortSignal.timeout(SPARK_TIMEOUT_MS)), inputs, { at: this.now().toISOString(), from, settings });
    };
    // a malformed JSON reply (seen 1 in 3 on 11/4) or a 5xx: once more
    let r = await once().catch(async (err) => {
      this.log("insights.retry", { from, message: String(err).slice(0, 120) });
      return once();
    });
    if (r.observations.length < OBS_MIN && !sent?.quick) {
      const again = await once().catch(() => null);
      if (again && again.observations.length > r.observations.length) r = again;
    }
    r.ms = Math.round(performance.now() - t0);
    this.log("insights.written", { from, observations: r.observations.length, learning: r.learning.length, ms: r.ms });
    return r;
  }

  /**
   * Start a write. `inputsOf` reads the latest card; `gate` (import) holds the save until the import's card is
   * stored and says which card (its importedAt). Saved only onto the card it was made from, only if no newer write
   * started for this user meanwhile (Codex P1/P2), and filtered again by the latest "not me" list; "right" carries over.
   */
  private reserve(userId: string): number {
    const mine = ++this.seqNext;
    this.seq.set(userId, mine);
    return mine;
  }

  private start(userId: string, from: InsightReport["from"], inputsOf: (card: StyleCard | null) => InsightInputs | null, opts: { gate?: Promise<string | null>; settings?: InsightReport["settings"]; seq?: number } = {}) {
    if (!this.enabled) return;
    const mine = opts.seq ?? this.reserve(userId);
    // A targeted forget does not advance `seq`: this write may finish, but it
    // can never restore memory belonging to the generation it started in.
    const importGeneration = this.importGeneration(userId);
    const promise = (async () => {
      // import: the card isn't there yet — the paste is the source
      const card = opts.gate ? null : await this.store.getStyle(userId);
      const inputs = inputsOf(card);
      if (!inputs) return;
      const stillOk = async () => {
        if (this.seq.get(userId) !== mine) return false;
        const latest = await this.store.getStyle(userId);
        // again after the read: a forget() / newer write may have landed while it ran (Codex r10); a card that is
        // gone ("Forget all of this") stops a non-import write too
        if (this.seq.get(userId) !== mine) return false;
        if (!latest && !opts.gate) return false;
        return true;
      };
      // Every send, including a Spark retry, checks the volatile-memory generation.
      // After a targeted forget the job may still write its accepted answers, but it
      // must rebuild from the latest card and can never resend the held paste.
      const inputsForSend = async (): Promise<InsightInputs> => {
        if (this.importGeneration(userId) === importGeneration) return inputs;
        const latest = await this.store.getStyle(userId);
        const rebuilt = inputsOf(latest);
        return { ...(rebuilt ?? inputs), text: undefined };
      };
      const report = await this.write(inputsForSend, from, opts.settings ?? card?.insights?.settings ?? null, stillOk);
      const basis = opts.gate ? await opts.gate : card?.importedAt ?? null;
      if (opts.gate && !basis) return;
      let saved: InsightReport | undefined;
      const next = await this.personalize.patchStyle(userId, (c) => {
        if (this.seq.get(userId) !== mine) return null; // a newer write started
        if ((c.importedAt ?? null) !== basis) return null; // the card was replaced (another import / skip)
        const old = opts.gate ? undefined : c.insights;
        const denied = old?.denied ?? [];
        const gone = report.observations.filter((o) => denied.some((d) => d.id === o.id || similarClaim(d.claim, o.claim) || standsOnDenied(o, d))).map((o) => o.id);
        const right = new Set((old?.observations ?? []).filter((o) => o.verdict === "right").map((o) => o.id));
        // and what the user asked to forget / corrected away since (card.removed)
        const kept = scrubRemoved(withoutObservations(report, gone), c.removed);
        // AU-91: each observation is linked to the profile lines it stands on, on the card it's saved onto (basis dropped)
        const observations = kept.observations.map(({ basis: _basis, ...o }) => {
          const linked = { ...o, sources: linkSources(c, { ...o, basis: _basis }) };
          return right.has(o.id) ? { ...linked, verdict: "right" as const, confidence: "high" as const } : linked;
        });
        saved = { ...kept, observations };
        return { ...c, insights: { ...saved, ...(denied.length ? { denied } : {}) } };
      });
      // A full `forget()` advances seq; a targeted forget advances import
      // generation. Check both paths before re-registering a receipt.
      if (next?.insights && saved && this.seq.get(userId) === mine) this.rememberImportQuotes(userId, saved, importGeneration);
      this.failedAt.delete(userId);
    })()
      .catch((err) => {
        this.failedAt.set(userId, Date.now());
        this.log("insights.failed", { from, message: String(err).slice(0, 160) });
      })
      .finally(async () => {
        if (this.jobs.get(userId)?.promise === promise) this.jobs.delete(userId);
        // the last write is done (saved, failed or stale): the report is no longer "refreshing"
        if (this.seq.get(userId) === mine) {
          // checked again under the lock: newer answers may have reserved and set it meanwhile (Codex P2)
          await this.personalize.patchStyle(userId, (c) => (c.insights?.refreshing && this.seq.get(userId) === mine ? { ...c, insights: { ...c.insights, refreshing: false } } : null)).catch(() => {});
        }
      });
    this.jobs.set(userId, { promise, startedAt: Date.now() });
  }

  /** Import: the report starts on the redacted paste now; commit(importedAt) after the card is saved, cancel() if the import failed. */
  begin(userId: string, redactedText: string): { commit(importedAt: string): void; cancel(): void } {
    const importGeneration = this.importGeneration(userId);
    let settle!: (at: string | null) => void;
    const gate = new Promise<string | null>((r) => (settle = r));
    this.start(userId, "import", () => ({ text: redactedText, findings: [], picks: [], source: "import" }), { gate });
    return {
      // the paste is kept (memory only) for the answers rewrite only once its card is the user's card
      commit: (at) => { if (this.enabled) this.rememberText(userId, redactedText, importGeneration); settle(at); },
      cancel: () => { this.clearImportMemory(userId); settle(null); },
    };
  }

  /** N1–N3: the skip card is saved; the report comes from the picks. */
  fromSkip(userId: string): void {
    this.clearImportMemory(userId);
    this.start(userId, "skip", (card) => (card ? { findings: cardFindings(card), picks: cardPicks(card), source: "skip", unknowns: card.toConfirm } : null));
  }

  /** Setup answers (server keys; partial is fine — the app sends them before the last pick). */
  async fromAnswers(userId: string, answers: unknown): Promise<void> {
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new InsightsError(400, "bad_answers", "answers must be an object");
    const a = answers as Record<string, unknown>;
    const settings = settingsFrom(a);
    const answerPicks = picksFromAnswers(a);
    // demo P0 #1 (11/4): the rewrite took 27–51 s while the app waited ~18 s, so SUM sat on the import-only report.
    // The answers' own parts (the four setup lines, "Your mix") go on the stored report now, marked refreshing (the
    // app shows "Adding your answers…" and keeps asking ~60 s); the traits follow from ONE minimal-effort Spark write.
    // The write's turn is reserved before the patch, so an older write ending meanwhile can't clear the new flag (Codex P2).
    const mine = this.enabled ? this.reserve(userId) : 0;
    if (this.enabled) {
      await this.personalize.patchStyle(userId, (c) => (c.insights && this.seq.get(userId) === mine ? { ...c, insights: { ...c.insights, settings, mix: mixFrom([...cardPicks(c), ...answerPicks]), refreshing: true } } : null));
    }
    this.start(userId, "answers", (card) => {
      if (!card) return null;
      return {
        text: card.source === "import" ? this.textOf(userId, card) : undefined,
        findings: cardFindings(card),
        picks: [...cardPicks(card), ...answerPicks],
        source: card.source,
        // AU-23: what the user took out of the profile (HISY "That's not me", "forget that …") is not true either
        // …minus anything that names what they asked to forget: a forget also leaves a plain "Dislikes seafood."
        // removal behind, which must not go back to Spark as not-true either (Codex r12)
        denied: withoutRemoved(
          [...(card.insights?.denied ?? []).map((d) => ({ claim: d.claim, correction: d.correction })), ...(card.removed ?? []).filter((r) => !r.forget).slice(-10).map((r) => ({ claim: r.text, correction: undefined as string | undefined }))],
          (d) => `${d.claim} ${d.correction ?? ""}`,
          (card.removed ?? []).filter((r) => r.forget),
        ),
        unknowns: card.toConfirm,
        quick: true,
      };
    }, { settings, seq: mine });
  }

  /** GET: the stored report, after waiting up to waitMs for one being written. No report and no write → one starts from the card. */
  async get(userId: string, waitMs: number): Promise<{ status: InsightsStatus; report: InsightReport | null }> {
    if (!this.enabled) return { status: "none", report: null };
    let job = this.jobs.get(userId);
    if (!job) {
      const card = await this.store.getStyle(userId);
      if (!card) return { status: "none", report: null };
      if (card.insights?.refreshing) {
        // nothing is writing it any more (a restart): the flag goes, so the app stops waiting (Codex P2)
        const fixed = await this.personalize.patchStyle(userId, (c) => (c.insights?.refreshing && !this.jobs.has(userId) ? { ...c, insights: { ...c.insights, refreshing: false } } : null));
        return { status: "ready", report: this.reportFor(userId, fixed ?? { ...card, insights: { ...card.insights, refreshing: false } }) };
      }
      if (card.insights) return { status: "ready", report: this.reportFor(userId, card) };
      const failed = this.failedAt.get(userId);
      if (failed && Date.now() - failed < FAIL_BACKOFF_MS) return { status: "failed", report: null };
      this.start(userId, "card", (c) => (c ? { text: c.source === "import" ? this.textOf(userId, c) : undefined, findings: cardFindings(c), picks: cardPicks(c), source: c.source, unknowns: c.toConfirm } : null));
      job = this.jobs.get(userId);
    }
    if (job && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([job.promise, new Promise<void>((r) => { timer = setTimeout(r, waitMs); })]);
      clearTimeout(timer);
    }
    const card = await this.store.getStyle(userId);
    const report = this.reportFor(userId, card);
    if (this.jobs.has(userId)) return { status: "pending", report };
    if (report) return { status: "ready", report };
    return { status: this.failedAt.has(userId) ? "failed" : "none", report: null };
  }

  /**
   * "Forget all of this" (AU-92 DELETE /v1/profile, SY-01): the stored report with its quoted lines goes with the
   * profile row; this drops what is only in this process — the paste kept for the answers rewrite, a failure
   * backoff — and makes any write still running land nowhere (a newer write number, and no card to land on).
   */
  forget(userId: string): void {
    this.invalidateImportMemory(userId);
    this.failedAt.delete(userId);
    this.seq.set(userId, ++this.seqNext);
  }

  /** "That's right" / "Not me" (+ what's right, ≤ 200 chars). */
  async verdict(userId: string, id: string, body: unknown): Promise<InsightReport> {
    const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    if (b.verdict !== "right" && b.verdict !== "not_me") throw new InsightsError(400, "bad_verdict", "verdict must be right or not_me");
    let correction: string | undefined;
    if (b.correction !== undefined && b.correction !== null) {
      if (typeof b.correction !== "string" || b.correction.length > CORRECTION_MAX) throw new InsightsError(400, "bad_correction", `correction: up to ${CORRECTION_MAX} characters`);
      const t = b.correction.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
      // kept only when it's safe to put in the call profile
      if (t && !looksLikeInjection(t) && redactSensitive(t) === t && !privateDetail(t)) correction = t;
    }
    let found = false;
    const next = await this.personalize.patchStyle(userId, (c) => {
      const ins = c.insights;
      const o = ins?.observations.find((x) => x.id === id);
      if (!ins || !o) return null;
      found = true;
      if (b.verdict === "right") {
        return { ...c, insights: { ...ins, observations: ins.observations.map((x) => (x.id === id ? { ...x, verdict: "right" as const, confidence: "high" as const } : x)) } };
      }
      const learning = ins.learning.some((l) => l.id === o.category) ? ins.learning : [...ins.learning, { id: o.category, label: LEARN_LABEL[o.category] }];

      // AU-91: the findings it was built from leave the call profile too (and its rows). Recorded as removed lines
      // (an older analysis can't bring them back) but not as "forget" tombstones: those block every later line that
      // shares a word ("short" films after "short replies", Codex #581 r2)
      // a list finding loses only the picked item ("Food: spicy, seafood." → "Food: seafood.", Codex #581 r3)
      // linked report: exactly its linked lines; an older report (no links): the text matching it had (AU-91)
      // a report saved with no links found (sources: []) falls back to the older matching too (Codex #581 recut P1)
      const edits = o.sources?.length ? editsFromSources(c, o) : editsBehind(c, o);
      const { drop, rewrite, picks, items, removedLines } = edits;
      // a linked edit applies only in its own section (the same words elsewhere are another setting, Codex #581 link r1)
      const sectionOf: Map<string, string> | null = "sectionOf" in edits ? (edits.sectionOf as Map<string, string>) : null;
      const gone = new Set([...drop, ...rewrite.keys()]);
      const at = this.now().toISOString();
      const fix = <T extends { text: string }>(key: string, list: T[]) => list.flatMap((f) => {
        // settings sections never change on a "not me", whatever path chose the line (Codex #581 link r3)
        if (OPERATIONAL.has(key)) return [f];
        if (sectionOf && sectionOf.has(f.text) && sectionOf.get(f.text) !== key) return [f];
        return drop.has(f.text) ? [] : rewrite.has(f.text) ? [{ ...f, text: rewrite.get(f.text)! }] : [f];
      });
      const sections = Object.fromEntries(Object.entries(c.sections).map(([k, v]) => [k, Array.isArray(v) ? fix(k, v as Array<{ text: string }>) : v])) as StyleCard["sections"];
      const display = (c.display ?? []).map((r) => ({ ...r, items: fix(r.key, r.items) }));
      // the picks it stood on leave card.picks: a rewritten report can't build a new line on them (Codex #581 r3)
      const pickN = new Set(picks.map((q) => q.trim().toLowerCase()));
      const cardPicks = c.picks ? { picks: c.picks.filter((x) => !pickN.has(x.label.trim().toLowerCase())) } : {};
      // each with its field: an older call analysis of that field can't add it back (merge.ts priorTombs, Codex #581 r5)
      const fieldOf = (from: string) => Object.entries(c.sections).find(([, v]) => Array.isArray(v) && (v as Array<{ text: string }>).some((f) => f.text === from))?.[0];
      const seen = new Set<string>();
      // the section the edit really happened in (a linked edit carries it; an older one is looked up); a settings section
      // never gets a removal record (Codex #581 link r4)
      const sectionFor = (r: { from: string; section?: string }) => r.section ?? fieldOf(r.from);
      const tomb = removedLines.filter((r) => !OPERATIONAL.has(sectionFor(r) ?? "") && !seen.has(r.text) && seen.add(r.text) && !(c.removed ?? []).some((x) => x.text === r.text))
        .map((r) => { const field = sectionFor(r); return { text: r.text, at, ...(field ? { field } : {}) }; });
      // an item taken out of a list ("spicy"): another observation that says it goes too, one on what's left stays
      const itemRe = items.length ? new RegExp(`\\b(?:${items.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i") : null;
      // another observation that stands on a removed finding goes with it (its "I'll keep replies short" would stay)
      const quotes = o.evidence.filter((e) => e.source !== "answer").map((e) => quoteWords(e.quote)).filter((w) => w.length).slice(0, 6);
      const alsoGone = gone.size || pickN.size || quotes.length ? ins.observations.filter((x) => {
        if (x.id === id) return false;
        const e = x.sources?.length ? editsFromSources(c, x) : editsBehind(c, x);
        // the same rule as the save path: anything standing on what they said "not me" to (Codex #581 r22)
        if (standsOnDenied(x, { picks, items, quotes })) return true;
        // the same paste quote (hash) as the one they said "not me" to, too (Codex #581 r13)
        if (x.evidence.some((v) => v.source !== "answer" && quotes.some((d) => sameQuote(quoteWords(v.quote), d)))) return true;
        return [...e.drop].some((t) => drop.has(t)) || e.picks.some((q) => pickN.has(q.trim().toLowerCase()))
          || (!!itemRe && [x.claim, x.use_in_call, ...x.evidence.map((v) => v.quote)].some((t) => itemRe.test(t)));
      }).map((x) => x.id) : [];
      // the paste quotes it stood on too: a reworded observation on the same quote can't come back (Codex #581 r12) —
      // kept as hashes, never the pasted words themselves (the privacy notice: no pasted text stored, AU-95)
      // the picks / items it stood on are kept with the "not me" record: a report already being written when they said
      // it can't bring them back with another claim (checked when it is saved, Codex #581 r5)
      const denied = [...(ins.denied ?? []), { id, claim: o.claim, category: o.category, ...(correction ? { correction } : {}), at: this.now().toISOString(), ...(picks.length ? { picks } : {}), ...(items.length ? { items } : {}), ...(quotes.length ? { quotes } : {}) }].slice(-DENIED_MAX);
      // the type / strengths / watch-outs / headline built on it go too (Codex P2)
      // the conditional rules saying the same go too ("When deciding, keep replies short and direct.")
      const ruleGone = new Set(rulesBehind(c.rules ?? [], o, [...gone]));
      const rules = (c.rules ?? []).filter((r) => !ruleGone.has(r));
      const ruleTexts = new Set([...ruleGone].map((r) => ruleLine(r)));
      const shown = ruleTexts.size ? display.map((r) => ({ ...r, items: r.items.filter((i) => !ruleTexts.has(i.text)) })) : display;
      // the other observations' links follow a rewritten list line ("Food: spicy, seafood." → "Food: seafood."), so a
      // later "not me" on Seafood still finds its line (Codex #581 link r1)
      const relink = (x: typeof ins.observations[number]) => (x.sources ? { ...x, sources: x.sources.map((l) => (rewrite.has(l.text) && (!sectionOf || sectionOf.get(l.text) === l.section) ? { ...l, text: rewrite.get(l.text)! } : l)) } : x);
      const kept = withoutObservations(ins, [id, ...alsoGone]);
      const relinked = { ...kept, observations: kept.observations.map(relink) };
      return { ...c, ...cardPicks, rules, sections, display: shown, removed: [...(c.removed ?? []), ...tomb].slice(-40), insights: { ...relinked, learning: learning.slice(0, 5), denied } };
    });
    if (!found || !next?.insights) throw new InsightsError(404, "not_found", "no such insight");
    this.log("insights.verdict", { verdict: b.verdict, corrected: !!correction });
    return this.reportFor(userId, next)!;
  }
}
