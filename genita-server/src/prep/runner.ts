/**
 * F2-L9 (#24): prep job runner (the clip_jobs queue).
 *
 *   scene (Muse Image) → 3 silent clips in parallel (Kling 3.0, 10 s)
 *   → lips (Peter cache / mouth atlas; TODO interfaces in lips.ts)
 *
 * Every step's state is written to the store before and after it runs, and
 * each fal request id is saved the moment it is submitted. On boot,
 * resumeAll() picks up unfinished companions and polls the saved fal
 * requests instead of resubmitting (no double spend). A run that throws
 * counts one attempt; after MAX_PREP_ATTEMPTS the companion is `failed`
 * (S09-PF: the photo keeps breathing and the call goes on) until
 * POST /companion/prep/retry.
 *
 * Progress is emitted as `prep.progress {done,total}` and `prep.ready
 * {emotion_videos}` on the `events` emitter for the WS layer (F2-L3).
 */
import { EventEmitter } from "node:events";
import { falSubmit, falWait } from "./fal.ts";
import { klingSilentInput, PREP_EMOTIONS, type PrepEmotion } from "./prompts.ts";
import { makeScene, type PrepDeps } from "./pipeline.ts";
import { lipBakerFor, type LipBaker } from "./lips.ts";
import type { CompanionRecord, PrepState, Step } from "./store.ts";

export const KLING_MODEL = "fal-ai/kling-video/v3/pro/image-to-video";
export const MAX_PREP_ATTEMPTS = 3;
const STEP_RETRIES = 2;

export function newPrepState(): PrepState {
  const now = new Date().toISOString();
  const s = (): Step => ({ status: "pending", attempts: 0 });
  return {
    status: "running",
    attempts: 0,
    steps: { scene: s(), videos: { neutral: s(), happy: s(), warm: s() }, lips: s() },
    startedAt: now,
    updatedAt: now,
  };
}

/** Pure: {done,total} for the progress bar. A `todo` lips step is not counted. */
export function prepProgress(p: PrepState): { done: number; total: number } {
  const steps = [p.steps.scene, ...PREP_EMOTIONS.map((e) => p.steps.videos[e]), p.steps.lips].filter((s) => s.status !== "todo");
  return { done: steps.filter((s) => s.status === "done").length, total: steps.length };
}

export function emotionVideos(p: PrepState): Partial<Record<PrepEmotion, string>> {
  const out: Partial<Record<PrepEmotion, string>> = {};
  for (const e of PREP_EMOTIONS) if (p.steps.videos[e].url) out[e] = p.steps.videos[e].url;
  return out;
}

/** Public view for GET /companion/prep. */
export function prepView(c: CompanionRecord) {
  const p = c.prep;
  return {
    status: p.status,
    progress: prepProgress(p),
    attempts: p.attempts,
    maxAttempts: MAX_PREP_ATTEMPTS,
    sceneUrl: p.steps.scene.url ?? null,
    sceneSource: p.steps.scene.source ?? null,
    emotionVideos: emotionVideos(p),
    lips: { status: p.steps.lips.status, detail: p.steps.lips.error ?? null, url: p.steps.lips.url ?? null },
    steps: {
      scene: { status: p.steps.scene.status, ms: p.steps.scene.ms ?? null },
      videos: Object.fromEntries(PREP_EMOTIONS.map((e) => [e, { status: p.steps.videos[e].status, ms: p.steps.videos[e].ms ?? null }])),
    },
    startedAt: p.startedAt,
    readyAt: p.readyAt ?? null,
  };
}

export class PrepRunner {
  readonly events = new EventEmitter();
  private running = new Map<string, Promise<void>>();
  private d: PrepDeps;
  private peter: LipBaker;
  private atlas: LipBaker;
  constructor(d: PrepDeps, bakers: { peter: LipBaker; atlas: LipBaker }) {
    this.d = d;
    this.peter = bakers.peter;
    this.atlas = bakers.atlas;
  }

  isRunning(userId: string) {
    return this.running.has(userId);
  }

  /** Fire-and-forget; the promise is returned for scripts and tests. */
  run(userId: string): Promise<void> {
    const existing = this.running.get(userId);
    if (existing) return existing;
    const p = this.loop(userId).finally(() => this.running.delete(userId));
    this.running.set(userId, p);
    return p;
  }

  async resumeAll(): Promise<number> {
    const list = await this.d.store.listCompanions();
    let n = 0;
    for (const c of list) {
      if (c.prep.status === "running") {
        n++;
        void this.run(c.userId);
      }
    }
    if (n) this.d.log("prep.resumed", { companions: n });
    return n;
  }

  async retry(userId: string): Promise<CompanionRecord> {
    const c = await this.d.store.getCompanion(userId);
    if (!c) throw new Error("no companion");
    if (c.prep.status === "running" && this.isRunning(userId)) return c;
    const steps = c.prep.steps;
    const reset = (s: Step): Step => (s.status === "failed" ? { status: "pending", attempts: 0 } : s);
    const next: CompanionRecord = {
      ...c,
      prep: {
        ...c.prep,
        status: "running",
        attempts: 0,
        steps: { scene: reset(steps.scene), videos: { neutral: reset(steps.videos.neutral), happy: reset(steps.videos.happy), warm: reset(steps.videos.warm) }, lips: reset(steps.lips) },
      },
    };
    await this.d.store.patchCompanion(userId, (x) => ({ ...x, prep: next.prep }));
    void this.run(userId);
    return next;
  }

  private emit(c: CompanionRecord) {
    this.events.emit("prep.progress", { userId: c.userId, companionId: c.id, ...prepProgress(c.prep) });
  }

  private async loop(userId: string): Promise<void> {
    for (;;) {
      let c = await this.d.store.getCompanion(userId);
      if (!c || c.prep.status !== "running") return;
      if (c.prep.attempts >= MAX_PREP_ATTEMPTS) {
        c = { ...c, prep: { ...c.prep, status: "failed" } };
        const prep = c.prep;
        await this.d.store.patchCompanion(userId, (x) => ({ ...x, prep }));
        this.d.log("clips.failed", { companion: c.id, reason: "max_attempts" });
        this.events.emit("prep.failed", { userId, companionId: c.id });
        return;
      }
      c = { ...c, prep: { ...c.prep, attempts: c.prep.attempts + 1 } };
      const prep = c.prep;
      await this.d.store.patchCompanion(userId, (x) => ({ ...x, prep }));
      try {
        await this.once(c);
        return;
      } catch (err) {
        this.d.log("prep.attempt_failed", { companion: c.id, attempt: c.prep.attempts, reason: String(err).slice(0, 300) });
      }
    }
  }

  /** One pass over the steps; finished steps are skipped, so a rerun only does what is left. */
  private async once(start: CompanionRecord): Promise<void> {
    const d = this.d;
    if (!d.falKey) throw new Error("FAL_KEY is not set");
    const falKey = d.falKey;
    const t0 = performance.now();
    let c = start;
    // serialize all store writes for this companion through one mutable record
    let chain = Promise.resolve();
    const save = (mut: (c: CompanionRecord) => CompanionRecord) => {
      c = mut(c);
      const prep = c.prep;
      chain = chain.then(() => d.store.patchCompanion(c.userId, (x) => ({ ...x, prep })).then(() => {}));
      this.emit(c);
      return chain;
    };
    const setStep = (path: "scene" | "lips" | PrepEmotion, patch: Partial<Step>) =>
      save((x) => {
        const steps = { ...x.prep.steps, videos: { ...x.prep.steps.videos } };
        if (path === "scene" || path === "lips") steps[path] = { ...steps[path], ...patch };
        else steps.videos[path] = { ...steps.videos[path], ...patch };
        return { ...x, prep: { ...x.prep, steps } };
      });

    // 1. scene
    if (c.prep.steps.scene.status !== "done" || !c.prep.steps.scene.url) {
      const img = await d.store.getImage(c.imageId);
      if (!img) throw new Error("source image missing");
      await setStep("scene", { status: "running", attempts: c.prep.steps.scene.attempts + 1 });
      try {
        const s = await makeScene(d, img.bytes, img.rec.mime, c.type);
        if (!s.url) throw new Error("scene has no URL");
        await setStep("scene", { status: "done", url: s.url, ms: s.ms, source: s.source, error: undefined });
        d.log("scene.done", { companion: c.id, source: s.source, ms: s.ms });
      } catch (err) {
        await setStep("scene", { status: "failed", error: String(err).slice(0, 300) });
        throw err;
      }
    }
    const sceneUrl = c.prep.steps.scene.url!;

    // 2. three silent clips in parallel; resume a saved fal request when there is one
    d.log("clips.started", { companion: c.id, type: c.type, total: PREP_EMOTIONS.length });
    const clip = async (e: PrepEmotion) => {
      for (;;) {
        const st = c.prep.steps.videos[e];
        if (st.status === "done" && st.url) return;
        if (st.attempts > STEP_RETRIES && st.status === "failed") throw new Error(`clip ${e} failed: ${st.error}`);
        const t1 = performance.now();
        try {
          let req = st.status === "running" ? st.fal : undefined;
          if (!req) {
            req = await falSubmit(falKey, KLING_MODEL, klingSilentInput(sceneUrl, e, c.type));
            await setStep(e, { status: "running", fal: req, attempts: st.attempts + 1 });
          }
          const r = await falWait<{ video?: { url?: string } }>(falKey, req, { pollMs: 10_000, timeoutMs: 20 * 60_000 });
          const url = r.video?.url;
          if (!url) throw new Error("kling: no video url");
          await setStep(e, { status: "done", url, ms: (st.ms ?? 0) + Math.round(performance.now() - t1), error: undefined, fal: undefined });
        } catch (err) {
          await setStep(e, { status: "failed", fal: undefined, error: String(err).slice(0, 300), attempts: Math.max(c.prep.steps.videos[e].attempts, st.attempts + 1) });
        }
      }
    };
    const results = await Promise.allSettled(PREP_EMOTIONS.map(clip));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length) throw (failed[0] as PromiseRejectedResult).reason;

    // 3. lips (TODO bakers return `todo`; the call still works with the clip loop)
    if (c.prep.steps.lips.status !== "done" && c.prep.steps.lips.status !== "todo") {
      const baker = lipBakerFor(c.type, this.peter, this.atlas);
      await setStep("lips", { status: "running", attempts: c.prep.steps.lips.attempts + 1 });
      try {
        const r = await baker.bake({ companionId: c.id, kind: c.type, sceneUrl, videos: emotionVideos(c.prep), voiceId: c.voiceId });
        if (r.status === "todo") await setStep("lips", { status: "todo", error: r.reason, source: baker.name });
        else await setStep("lips", { status: "done", url: r.kind === "peter" ? (r.cacheUrl ?? r.avatarId) : r.atlasUrl, ms: r.ms, source: baker.name });
      } catch (err) {
        // lips failing must not block the call (photo/clip fallback); record and finish
        await setStep("lips", { status: "failed", error: String(err).slice(0, 300) });
      }
    }

    await save((x) => ({ ...x, prep: { ...x.prep, status: "ready", readyAt: new Date().toISOString() } }));
    await chain;
    const vids = emotionVideos(c.prep);
    d.log("clips.completed", { companion: c.id, type: c.type, total_ms: Math.round(performance.now() - t0) });
    this.events.emit("prep.ready", { userId: c.userId, companionId: c.id, emotion_videos: vids });
  }
}
