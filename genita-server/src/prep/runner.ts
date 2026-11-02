/**
 * F2-L9 (#24): prep job runner (the clip_jobs queue).
 *
 * Default (Meta only, GENITA_KLING off):
 *   scene (Muse Image) → face set (Muse Image expressions + visemes, SAM-checked; face.ts)
 *   No fal, Kling or Peter call; the clip and lips steps are `skipped`.
 *
 * GENITA_KLING=1 (the earlier pipeline):
 *   scene (Muse Image, gpt-image-2 fallback) → 3 silent clips in parallel (Kling 3.0, 10 s)
 *   → lips (human: Peter avatar cache on Modal when GENITA_PETER=1; animal/character: mouth atlas TODO)
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
import { makeScene, mediaOf, type PrepDeps } from "./pipeline.ts";
import { lipBakerFor, type LipBaker } from "./lips.ts";
import { FACE_KEYS, faceManifest, makeFaceSet, type FaceKey } from "./face.ts";
import { SCENE_SIZE } from "./prompts.ts";
import type { CompanionRecord, PrepState, Step } from "./store.ts";

export const KLING_MODEL = "fal-ai/kling-video/v3/pro/image-to-video";
export const MAX_PREP_ATTEMPTS = 3;
const STEP_RETRIES = 2;

export function newPrepState(opts: { kling?: boolean } = {}): PrepState {
  const now = new Date().toISOString();
  const s = (): Step => ({ status: "pending", attempts: 0 });
  const k = (): Step => (opts.kling ? s() : { status: "skipped", attempts: 0 });
  return {
    status: "running",
    attempts: 0,
    steps: { scene: s(), videos: { neutral: k(), happy: k(), warm: k() }, lips: k(), ...(opts.kling ? {} : { face: s() }) },
    startedAt: now,
    updatedAt: now,
  };
}

/** Public URL of a companion image (scene = `neutral`); GET /v1/companion/face/:key, same auth as every prep route. */
export const faceUrl = (key: "neutral" | FaceKey) => `/v1/companion/face/${key}`;

/**
 * Pure: {done,total} for the progress bar. `todo`/`skipped` steps are not
 * counted; the face step counts one per image (13), settled = kept or rejected.
 */
export function prepProgress(p: PrepState): { done: number; total: number } {
  const steps = [p.steps.scene, ...PREP_EMOTIONS.map((e) => p.steps.videos[e]), p.steps.lips].filter((s) => s.status !== "todo" && s.status !== "skipped");
  let done = steps.filter((s) => s.status === "done").length;
  let total = steps.length;
  const f = p.steps.face;
  if (f && f.status !== "skipped") {
    total += FACE_KEYS.length;
    done += f.status === "done" ? FACE_KEYS.length : Object.keys(f.face?.items ?? {}).length;
  }
  return { done, total };
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
    /** Meta-only face set manifest (team/metaface spec), once the face step is done */
    face: p.steps.face?.status === "done" && p.steps.face.face ? faceManifest(p.steps.face.face, faceUrl) : null,
    lips: {
      status: p.steps.lips.status,
      detail: p.steps.lips.error ?? null,
      url: p.steps.lips.url ?? null,
      ms: p.steps.lips.ms ?? null,
      /** Peter: send `avatar_id` in the worker HELLO; READY.bundle_id should equal bundleId */
      peter: p.steps.lips.bundleId ? { avatarId: p.steps.lips.avatarId ?? null, bundleId: p.steps.lips.bundleId, nBase: p.steps.lips.nBase ?? null } : null,
    },
    steps: {
      scene: { status: p.steps.scene.status, ms: p.steps.scene.ms ?? null },
      videos: Object.fromEntries(PREP_EMOTIONS.map((e) => [e, { status: p.steps.videos[e].status, ms: p.steps.videos[e].ms ?? null }])),
      face: p.steps.face
        ? { status: p.steps.face.status, settled: Object.keys(p.steps.face.face?.items ?? {}).length, total: FACE_KEYS.length, ms: p.steps.face.ms ?? null }
        : null,
    },
    startedAt: p.startedAt,
    readyAt: p.readyAt ?? null,
  };
}

export class PrepRunner {
  readonly events = new EventEmitter();
  private running = new Map<string, Promise<void>>();
  private aborts = new Map<string, AbortController>();
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
    const ac = new AbortController();
    this.aborts.set(userId, ac);
    const p = this.loop(userId, ac).finally(() => {
      this.running.delete(userId);
      this.aborts.delete(userId);
    });
    this.running.set(userId, p);
    return p;
  }

  /**
   * Stops a running prep (account deletion, shutdown). No new vendor call
   * starts and nothing more is saved; the record stays as it was (`running`),
   * so a later run resumes it if the companion still exists.
   */
  cancel(userId: string): boolean {
    const ac = this.aborts.get(userId);
    ac?.abort(new Error("prep cancelled"));
    return !!ac;
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
    const reset = (s: Step): Step => (s.status === "failed" ? { status: "pending", attempts: 0, ...(s.face ? { face: s.face } : {}) } : s);
    const next: CompanionRecord = {
      ...c,
      prep: {
        ...c.prep,
        status: "running",
        attempts: 0,
        steps: {
          scene: reset(steps.scene),
          videos: { neutral: reset(steps.videos.neutral), happy: reset(steps.videos.happy), warm: reset(steps.videos.warm) },
          lips: reset(steps.lips),
          ...(steps.face ? { face: reset(steps.face) } : {}),
        },
      },
    };
    await this.d.store.patchCompanion(userId, (x) => ({ ...x, prep: next.prep }));
    void this.run(userId);
    return next;
  }

  private emit(c: CompanionRecord) {
    this.events.emit("prep.progress", { userId: c.userId, companionId: c.id, ...prepProgress(c.prep) });
  }

  private async loop(userId: string, ac: AbortController): Promise<void> {
    for (;;) {
      if (ac.signal.aborted) return;
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
        await this.once(c, ac);
        return;
      } catch (err) {
        if (ac.signal.aborted) {
          this.d.log("prep.stopped", { companion: c.id, reason: String(ac.signal.reason).slice(0, 120) });
          return;
        }
        this.d.log("prep.attempt_failed", { companion: c.id, attempt: c.prep.attempts, reason: String(err).slice(0, 300) });
      }
    }
  }

  /**
   * Meta-only pass: scene (stored as asset `neutral`) → face set. Never calls
   * fal, Kling or a lip baker. Finished work is skipped, and the face step
   * resumes from its saved keys.
   */
  private async metaPass(
    cur: () => CompanionRecord,
    save: (mut: (c: CompanionRecord) => CompanionRecord) => Promise<void>,
    setStep: (path: "scene" | "face", patch: Partial<Step>) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const d = this.d;
    // a record started on the Kling pipeline: its clips and lips are not part of this one
    const st = cur().prep.steps;
    const skip = (x: Step): Step => (x.status === "done" ? x : { status: "skipped", attempts: x.attempts });
    if (!st.face || PREP_EMOTIONS.some((e) => st.videos[e].status !== "done" && st.videos[e].status !== "skipped") || (st.lips.status !== "done" && st.lips.status !== "skipped"))
      await save((x) => ({
        ...x,
        prep: {
          ...x.prep,
          steps: {
            ...x.prep.steps,
            videos: { neutral: skip(x.prep.steps.videos.neutral), happy: skip(x.prep.steps.videos.happy), warm: skip(x.prep.steps.videos.warm) },
            lips: skip(x.prep.steps.lips),
            face: x.prep.steps.face ?? { status: "pending", attempts: 0 },
          },
        },
      }));

    // 1. scene
    let c = cur();
    let scene = c.prep.steps.scene.status === "done" ? await d.store.getAsset(c.userId, c.id, "neutral") : null;
    if (!scene) {
      const img = await d.store.getImage(c.imageId);
      if (!img) throw new Error("source image missing");
      await setStep("scene", { status: "running", attempts: c.prep.steps.scene.attempts + 1 });
      try {
        const s = await makeScene(d, img.bytes, img.rec.mime, c.type, signal);
        signal.throwIfAborted();
        await d.store.putAsset(c.userId, c.id, "neutral", s.bytes);
        scene = s.bytes;
        await setStep("scene", { status: "done", url: faceUrl("neutral"), ms: s.ms, source: s.source, error: undefined });
        d.log("scene.done", { companion: c.id, source: s.source, ms: s.ms });
      } catch (err) {
        if (!signal.aborted) await setStep("scene", { status: "failed", error: String(err).slice(0, 300) });
        throw err;
      }
    }

    // 2. face set
    signal.throwIfAborted();
    c = cur();
    const fs = c.prep.steps.face!;
    if (fs.status === "done") return;
    await setStep("face", { status: "running", attempts: fs.attempts + 1, error: undefined });
    const companionId = c.id;
    const userId = c.userId;
    try {
      const out = await makeFaceSet({
        metaKey: d.metaKey,
        media: mediaOf(d),
        scene,
        kind: c.type,
        size: SCENE_SIZE,
        prev: fs.face ?? null,
        onRef: (s) => setStep("face", { face: { ...s, items: { ...s.items } } }),
        onItem: async (key, item, bytes) => {
          signal.throwIfAborted();
          if (bytes) await d.store.putAsset(userId, companionId, key, bytes);
          await save((x) => {
            const f = x.prep.steps.face!;
            return { ...x, prep: { ...x.prep, steps: { ...x.prep.steps, face: { ...f, face: { ...f.face!, items: { ...f.face!.items, [key]: item } } } } } };
          });
        },
        log: d.log,
        signal,
      });
      await setStep("face", { status: "done", face: out, ms: out.ms.total, error: undefined });
      const m = faceManifest(out, faceUrl);
      d.log("face.done", { companion: companionId, ms: out.ms, visemes: Object.keys(m.visemes).length, rejected: m.rejected.map((r) => `${r.key}:${r.reason}`) });
    } catch (err) {
      if (!signal.aborted) await setStep("face", { status: "failed", error: String(err).slice(0, 300) });
      throw err;
    }
  }

  /** One pass over the steps; finished steps are skipped, so a rerun only does what is left. */
  private async once(start: CompanionRecord, ac: AbortController): Promise<void> {
    const d = this.d;
    const t0 = performance.now();
    let c = start;
    // the companion row vanished under us (DELETE /me): stop, then drop the images this run wrote
    let gone = false;
    // serialize all store writes for this companion through one mutable record
    let chain = Promise.resolve();
    const save = (mut: (c: CompanionRecord) => CompanionRecord) => {
      c = mut(c);
      const prep = c.prep;
      chain = chain.then(() =>
        d.store.patchCompanion(c.userId, (x) => ({ ...x, prep })).then((r) => {
          if (r || gone) return;
          gone = true;
          ac.abort(new Error("companion deleted"));
        }),
      );
      this.emit(c);
      return chain;
    };
    const setStep = (path: "scene" | "lips" | "face" | PrepEmotion, patch: Partial<Step>) =>
      save((x) => {
        const steps = { ...x.prep.steps, videos: { ...x.prep.steps.videos } };
        if (path === "face") steps.face = { ...(steps.face ?? { status: "pending", attempts: 0 }), ...patch };
        else if (path === "scene" || path === "lips") steps[path] = { ...steps[path], ...patch };
        else steps.videos[path] = { ...steps.videos[path], ...patch };
        return { ...x, prep: { ...x.prep, steps } };
      });

    if (!d.kling) {
      try {
        await this.metaPass(() => c, save, setStep, ac.signal);
        await save((x) => ({ ...x, prep: { ...x.prep, status: "ready", readyAt: new Date().toISOString() } }));
        await chain;
      } finally {
        if (gone) {
          await d.store.deleteAssets(start.userId, start.id).catch(() => {});
          d.log("prep.companion_gone", { companion: start.id });
        }
      }
      if (gone) throw new Error("companion deleted");
      const face = c.prep.steps.face?.face ? faceManifest(c.prep.steps.face.face, faceUrl) : null;
      d.log("prep.completed", { companion: c.id, type: c.type, pipeline: "meta", total_ms: Math.round(performance.now() - t0), rejected: face?.rejected.length ?? null });
      this.events.emit("prep.ready", { userId: c.userId, companionId: c.id, emotion_videos: {}, face });
      return;
    }

    if (!d.falKey) throw new Error("FAL_KEY is not set");
    const falKey = d.falKey;

    // 1. scene
    // a scene made on the Meta-only pipeline has no fal URL for Kling: make it again
    if (c.prep.steps.scene.status !== "done" || !c.prep.steps.scene.url?.startsWith("http")) {
      const img = await d.store.getImage(c.imageId);
      if (!img) throw new Error("source image missing");
      await setStep("scene", { status: "running", attempts: c.prep.steps.scene.attempts + 1 });
      try {
        const s = await makeScene(d, img.bytes, img.rec.mime, c.type);
        if (!s.url) throw new Error("scene has no URL");
        await d.store.putAsset(c.userId, c.id, "neutral", s.bytes);
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

    // 3. lips: Peter avatar cache (human) / mouth atlas (TODO); a failure does not block the call
    if (c.prep.steps.lips.status !== "done" && c.prep.steps.lips.status !== "todo") {
      const baker = lipBakerFor(c.type, this.peter, this.atlas);
      const prev = c.prep.steps.lips;
      const resumeId = prev.status === "running" ? prev.callId : undefined;
      await setStep("lips", { status: "running", attempts: prev.attempts + (resumeId ? 0 : 1), source: baker.name });
      const t1 = performance.now();
      try {
        const r = await baker.bake(
          { companionId: c.id, kind: c.type, sceneUrl, videos: emotionVideos(c.prep), voiceId: c.voiceId },
          { resumeId, onSubmitted: (callId) => setStep("lips", { callId }) },
        );
        if (r.status === "todo") await setStep("lips", { status: "todo", error: r.reason, callId: undefined });
        else if (r.kind === "peter") {
          await setStep("lips", { status: "done", avatarId: r.avatarId, bundleId: r.bundleId, nBase: r.nBase, ms: r.ms, error: undefined, callId: undefined });
          d.log("peter_cache.done", { companion: c.id, bundle_id: r.bundleId, n_base: r.nBase, ms: r.ms, remote_s: r.remoteSeconds });
        } else await setStep("lips", { status: "done", url: r.atlasUrl, ms: r.ms, error: undefined, callId: undefined });
      } catch (err) {
        await setStep("lips", { status: "failed", error: String(err).slice(0, 300), ms: Math.round(performance.now() - t1), callId: undefined });
        d.log("peter_cache.failed", { companion: c.id, reason: String(err).slice(0, 200) });
      }
    }

    await save((x) => ({ ...x, prep: { ...x.prep, status: "ready", readyAt: new Date().toISOString() } }));
    await chain;
    const vids = emotionVideos(c.prep);
    d.log("clips.completed", { companion: c.id, type: c.type, total_ms: Math.round(performance.now() - t0) });
    this.events.emit("prep.ready", { userId: c.userId, companionId: c.id, emotion_videos: vids });
  }
}
