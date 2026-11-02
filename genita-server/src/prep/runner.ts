/**
 * Resumable Meta prep: scene (Muse Image) → face set (Muse Image + SAM).
 * Each settled image is persisted; failed passes retry up to MAX_PREP_ATTEMPTS.
 */
import { EventEmitter } from "node:events";
import { PREP_EMOTIONS } from "./prompts.ts";
import { makeScene, mediaOf, type PrepDeps } from "./pipeline.ts";
import { FACE_KEYS, faceManifest, imageSize, makeFaceSet, normBox, samPrompt, type FaceKey } from "./face.ts";
const sceneMime = (b: Buffer) => (b.readUInt32BE(0) === 0x89504e47 ? "image/png" : b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : "image/webp");
import { makeFaceFlow } from "./faceflow.ts";
import { flowProfileOf, type FlowProfile } from "./profiles.ts";
import { SCENE_SIZE } from "./prompts.ts";
import type { CompanionRecord, PrepState, Step } from "./store.ts";

export const MAX_PREP_ATTEMPTS = 3;

const skippedStep = (): Step => ({ status: "skipped", attempts: 0 });

/** A `ready` record from the old clip pipeline that never got the Meta face set. */
export function needsFaceSet(c: CompanionRecord): boolean {
  return c.prep.status === "ready" && c.prep.steps.face?.status !== "done";
}

export function newPrepState(): PrepState {
  const now = new Date().toISOString();
  const s = (): Step => ({ status: "pending", attempts: 0 });
  return {
    status: "running",
    attempts: 0,
    steps: { scene: s(), videos: { neutral: skippedStep(), happy: skippedStep(), warm: skippedStep() }, lips: skippedStep(), face: s() },
    startedAt: now,
    updatedAt: now,
  };
}

/** Public URL of a companion image (scene = `neutral`); GET /v1/companion/face/:key, same auth as every prep route. */
export const faceUrl = (key: "neutral" | FaceKey) => `/v1/companion/face/${key}`;
/** Face-flow assets (`flow_*`) are served by the same route. */
export const flowUrl = (asset: string) => `/v1/companion/face/${asset}`;

/**
 * Pure: scene + 13 face images for the progress bar; settled = kept or rejected.
 * Legacy video and lip steps never count.
 */
export function prepProgress(p: PrepState): { done: number; total: number } {
  let done = p.steps.scene.status === "done" ? 1 : 0;
  let total = 1;
  const f = p.steps.face;
  if (f?.status !== "skipped") {
    const n = f?.face?.keys?.length ?? FACE_KEYS.length;
    total += n;
    done += f?.status === "done" ? n : Object.keys(f?.face?.items ?? {}).length;
  }
  return { done, total };
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
    // Keep the legacy prep response shape neutral for existing clients.
    emotionVideos: {},
    /** Meta-only face set manifest (team/metaface spec), once the face step is done */
    face: p.steps.face?.status === "done" && p.steps.face.face ? faceManifest(p.steps.face.face, faceUrl, flowUrl) : null,
    lips: { status: "skipped", detail: null, url: null, ms: null },
    steps: {
      scene: { status: p.steps.scene.status, ms: p.steps.scene.ms ?? null },
      videos: Object.fromEntries(PREP_EMOTIONS.map((e) => [e, { status: "skipped", ms: null }])),
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
  constructor(d: PrepDeps) { this.d = d; }

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

  /**
   * Account deleted: stop the user's prep, wait until it has stopped writing,
   * then remove every face image the user still has. Safe to call after the
   * rows are gone (server.ts accounts.onUserDeleted), which also covers a run
   * that finished between DELETE /me's blob delete and its row delete.
   */
  async forgetUser(userId: string): Promise<void> {
    this.cancel(userId);
    await this.running.get(userId)?.catch(() => {});
    await this.d.store.deleteAssets(userId);
  }

  async resumeAll(): Promise<number> {
    const list = await this.d.store.listCompanions();
    let n = 0;
    let migrated = 0;
    for (const c of list) {
      if (c.prep.status === "running") {
        n++;
        void this.run(c.userId);
      } else if (needsFaceSet(c)) {
        // finished on the old clip pipeline: no face set yet, so make one (scene is reused)
        migrated++;
        void this.retry(c.userId).catch((err) => this.d.log("prep.migrate_failed", { companion: c.id, message: String(err).slice(0, 200) }));
      }
    }
    if (n) this.d.log("prep.resumed", { companions: n });
    if (migrated) this.d.log("prep.migrated", { companions: migrated });
    n += migrated;
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
          videos: { neutral: skippedStep(), happy: skippedStep(), warm: skippedStep() },
          lips: skippedStep(),
          face: steps.face ? reset(steps.face) : { status: "pending", attempts: 0 },
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
        this.d.log("prep.failed", { companion: c.id, reason: "max_attempts" });
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

  /** Scene and face generation resume from saved assets and settled face keys. */
  private async metaPass(
    cur: () => CompanionRecord,
    save: (mut: (c: CompanionRecord) => CompanionRecord) => Promise<void>,
    setStep: (path: "scene" | "face", patch: Partial<Step>) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const d = this.d;
    // Ignore legacy video/lip jobs and their extra persisted keys, including completed jobs.
    await save((x) => ({
      ...x,
      prep: {
        ...x.prep,
        steps: {
          scene: x.prep.steps.scene,
          videos: { neutral: skippedStep(), happy: skippedStep(), warm: skippedStep() },
          lips: skippedStep(),
          face: x.prep.steps.face ?? { status: "pending", attempts: 0 },
        },
      },
    }));

    // 1. scene
    let c = cur();
    let scene = c.prep.steps.scene.status === "done" ? await d.store.getAsset(c.userId, c.id, "neutral") : null;
    // a reused scene from the old pipeline may still point at an external CDN: serve our own copy
    if (scene && c.prep.steps.scene.url !== faceUrl("neutral")) await setStep("scene", { url: faceUrl("neutral") });
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
    // mouth profile from the image check (species / character style); a resumed set keeps its own
    const raw = fs.face?.profile ? null : (await d.store.getImage(c.imageId).catch(() => null))?.rec.check.raw;
    const profile: FlowProfile = fs.face?.profile ?? flowProfileOf(c.type, raw);
    const species = raw?.species || undefined;
    try {
      const out = await makeFaceSet({
        profile,
        species,
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
      // optical-flow morph data (optional: without Python/OpenCV the device draws the viseme patches)
      if (d.python) {
        out.flow = await makeFaceFlow({
          python: d.python,
          profile,
          scene,
          state: out,
          kind: c.type,
          image: (k) => d.store.getAsset(userId, companionId, k),
          put: (asset, bytes) => d.store.putAsset(userId, companionId, asset, bytes),
          // subnasale line for the nose lock (SAM misses human noses at times; the script then estimates it)
          nose: async () => {
            const size = imageSize(scene!);
            const boxes = await mediaOf(d).samDetect(d.metaKey, `data:${sceneMime(scene!)};base64,${scene!.toString("base64")}`, samPrompt(c.type, "nose"), signal);
            return size && boxes[0] ? normBox(boxes[0], size) : null;
          },
          log: (e, x) => d.log(e, { companion: companionId, ...x }),
          signal,
        });
        signal.throwIfAborted();
      }
      await setStep("face", { status: "done", face: out, ms: out.ms.total, error: undefined });
      const m = faceManifest(out, faceUrl, flowUrl);
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
    const setStep = (path: "scene" | "face", patch: Partial<Step>) =>
      save((x) => {
        const steps = { ...x.prep.steps };
        steps[path] = { ...(steps[path] ?? { status: "pending", attempts: 0 }), ...patch };
        return { ...x, prep: { ...x.prep, steps } };
      });

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
    const face = c.prep.steps.face?.face ? faceManifest(c.prep.steps.face.face, faceUrl, flowUrl) : null;
    d.log("prep.completed", { companion: c.id, type: c.type, pipeline: "meta", total_ms: Math.round(performance.now() - t0), rejected: face?.rejected.length ?? null });
    this.events.emit("prep.ready", { userId: c.userId, companionId: c.id, emotion_videos: {}, face });
  }
}
