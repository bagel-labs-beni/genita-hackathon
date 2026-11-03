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
 * Stored in the style card (user_styles.style_json.insights) under Personalize's lock. The pasted reply itself is
 * kept in memory only (2 h, so the answers rewrite can still quote it) and never stored or logged.
 * GENITA_INSIGHTS=0: no Spark call, GET → none, the app keeps the old SUM.
 */
import type { SparkRequest } from "../meta/spark.ts";
import { museJson } from "../meta/spark.ts";
import type { Personalize } from "../personalize/service.ts";
import { looksLikeInjection, redactSensitive, type StyleCard } from "../prep/importProfile.ts";
import type { PrepStore } from "../prep/store.ts";
import { LEARN_LABEL, OBS_MIN, buildInsightRequest, picksFromAnswers, privateDetail, settingsFrom, similarClaim, scrubRemoved, toReport, withoutObservations, withoutRemoved, type InsightInputs } from "./report.ts";
import type { InsightReport, StoredInsights } from "./profile.ts";
export { insightProfileLines } from "./profile.ts";

type JsonFn = <T>(req: Omit<SparkRequest, "text"> & { schemaName: string; schema: Record<string, unknown> }, signal?: AbortSignal) => Promise<T>;

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

/** what the app gets: no denied list, no internals */
export function publicReport(s: StoredInsights | undefined | null): InsightReport | null {
  if (!s) return null;
  const { denied: _denied, ...r } = s;
  return r;
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
  }

  private rememberText(userId: string, text: string) {
    const now = Date.now();
    for (const [k, v] of this.texts) if (now - v.at > TEXT_TTL_MS) this.texts.delete(k);
    if (this.texts.size >= TEXT_MAX_USERS) this.texts.delete(this.texts.keys().next().value!);
    this.texts.set(userId, { text, at: now });
  }

  /** the kept paste, unless the user has since asked to forget something (Codex r7: it would be sent again) */
  private textOf(userId: string, card?: StyleCard | null): string | undefined {
    const t = this.texts.get(userId);
    if (!t || Date.now() - t.at > TEXT_TTL_MS) return undefined;
    if ((card?.removed ?? []).some((r) => r.forget && Date.parse(r.at) >= t.at - 1000)) { this.texts.delete(userId); return undefined; }
    return t.text;
  }

  /** One Spark write; a second when fewer than OBS_MIN survive the checks (the better one wins). */
  private async write(inputs: InsightInputs, from: InsightReport["from"], settings: InsightReport["settings"], stillOk: () => Promise<boolean> = async () => true): Promise<InsightReport> {
    const t0 = performance.now();
    // every Spark call (and each retry) first checks the user hasn't since asked to forget something (Codex r8)
    const once = async () => {
      if (!(await stillOk())) throw new Error("insights_stale: forget or a newer write since this one started");
      return onceRaw();
    };
    const onceRaw = async () => toReport(await this.json<unknown>(buildInsightRequest(inputs), AbortSignal.timeout(SPARK_TIMEOUT_MS)), inputs, { at: this.now().toISOString(), from, settings });
    // a malformed JSON reply (seen 1 in 3 on 11/4) or a 5xx: once more
    let r = await once().catch(async (err) => {
      this.log("insights.retry", { from, message: String(err).slice(0, 120) });
      return once();
    });
    if (r.observations.length < OBS_MIN) {
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
  private start(userId: string, from: InsightReport["from"], inputsOf: (card: StyleCard | null) => InsightInputs | null, opts: { gate?: Promise<string | null>; settings?: InsightReport["settings"] } = {}) {
    if (!this.enabled) return;
    const mine = ++this.seqNext;
    this.seq.set(userId, mine);
    const promise = (async () => {
      // import: the card isn't there yet — the paste is the source
      const card = opts.gate ? null : await this.store.getStyle(userId);
      const inputs = inputsOf(card);
      if (!inputs) return;
      const startedAt = Date.now();
      const stillOk = async () => {
        if (this.seq.get(userId) !== mine) return false;
        const latest = await this.store.getStyle(userId);
        // again after the read: a forget() / newer write may have landed while it ran (Codex r10); a card that is
        // gone ("Forget all of this") stops a non-import write too
        if (this.seq.get(userId) !== mine) return false;
        if (!latest && !opts.gate) return false;
        return !(latest?.removed ?? []).some((r) => r.forget && Date.parse(r.at) >= startedAt - 1000);
      };
      const report = await this.write(inputs, from, opts.settings ?? card?.insights?.settings ?? null, stillOk);
      const basis = opts.gate ? await opts.gate : card?.importedAt ?? null;
      if (opts.gate && !basis) return;
      await this.personalize.patchStyle(userId, (c) => {
        if (this.seq.get(userId) !== mine) return null; // a newer write started
        if ((c.importedAt ?? null) !== basis) return null; // the card was replaced (another import / skip)
        const old = opts.gate ? undefined : c.insights;
        const denied = old?.denied ?? [];
        const gone = report.observations.filter((o) => denied.some((d) => d.id === o.id || similarClaim(d.claim, o.claim))).map((o) => o.id);
        const right = new Set((old?.observations ?? []).filter((o) => o.verdict === "right").map((o) => o.id));
        // and what the user asked to forget / corrected away since (card.removed)
        const kept = scrubRemoved(withoutObservations(report, gone), c.removed);
        const observations = kept.observations.map((o) => (right.has(o.id) ? { ...o, verdict: "right" as const, confidence: "high" as const } : o));
        return { ...c, insights: { ...kept, observations, ...(denied.length ? { denied } : {}) } };
      });
      this.failedAt.delete(userId);
    })()
      .catch((err) => {
        this.failedAt.set(userId, Date.now());
        this.log("insights.failed", { from, message: String(err).slice(0, 160) });
      })
      .finally(() => { if (this.jobs.get(userId)?.promise === promise) this.jobs.delete(userId); });
    this.jobs.set(userId, { promise, startedAt: Date.now() });
  }

  /** Import: the report starts on the redacted paste now; commit(importedAt) after the card is saved, cancel() if the import failed. */
  begin(userId: string, redactedText: string): { commit(importedAt: string): void; cancel(): void } {
    let settle!: (at: string | null) => void;
    const gate = new Promise<string | null>((r) => (settle = r));
    this.start(userId, "import", () => ({ text: redactedText, findings: [], picks: [], source: "import" }), { gate });
    return {
      // the paste is kept (memory only) for the answers rewrite only once its card is the user's card
      commit: (at) => { if (this.enabled) this.rememberText(userId, redactedText); settle(at); },
      cancel: () => settle(null),
    };
  }

  /** N1–N3: the skip card is saved; the report comes from the picks. */
  fromSkip(userId: string): void {
    this.texts.delete(userId);
    this.start(userId, "skip", (card) => (card ? { findings: cardFindings(card), picks: cardPicks(card), source: "skip", unknowns: card.toConfirm } : null));
  }

  /** Setup answers (server keys; partial is fine — the app sends them before the last pick). */
  async fromAnswers(userId: string, answers: unknown): Promise<void> {
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new InsightsError(400, "bad_answers", "answers must be an object");
    const a = answers as Record<string, unknown>;
    const settings = settingsFrom(a);
    const answerPicks = picksFromAnswers(a);
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
      };
    }, { settings });
  }

  /** GET: the stored report, after waiting up to waitMs for one being written. No report and no write → one starts from the card. */
  async get(userId: string, waitMs: number): Promise<{ status: InsightsStatus; report: InsightReport | null }> {
    if (!this.enabled) return { status: "none", report: null };
    let job = this.jobs.get(userId);
    if (!job) {
      const card = await this.store.getStyle(userId);
      if (!card) return { status: "none", report: null };
      if (card.insights) return { status: "ready", report: publicReport(card.insights) };
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
    const report = publicReport(card?.insights);
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
    this.texts.delete(userId);
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
      const denied = [...(ins.denied ?? []), { id, claim: o.claim, category: o.category, ...(correction ? { correction } : {}), at: this.now().toISOString() }].slice(-DENIED_MAX);
      // the type / strengths / watch-outs / headline built on it go too (Codex P2)
      return { ...c, insights: { ...withoutObservations(ins, [id]), learning: learning.slice(0, 5), denied } };
    });
    if (!found || !next?.insights) throw new InsightsError(404, "not_found", "no such insight");
    this.log("insights.verdict", { verdict: b.verdict, corrected: !!correction });
    return publicReport(next.insights)!;
  }
}
