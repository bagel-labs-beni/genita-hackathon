/**
 * Face set top-up (11/3 night, expression layer): a companion whose face step is already `done` gets the face keys
 * its set is missing (today: surprised / concerned) without redoing the rest. It reuses the prep's own
 * `makeFaceSet` with the saved state as `prev`, so only the missing keys are edited (Muse Image, from the scene,
 * SAM drift-checked, one stricter retry) and every other key, the flow data and the person matte stay as they are.
 * Run in-process by `PrepRunner.topUpFace` when a face is loaded (GET /v1/companion/prep), so account deletion
 * stops and drains it; the next prep fetch serves the new keys (the app's face cache key follows the manifest, so
 * devices download the new stills once).
 */
import { faceKeysFor, makeFaceSet, type FaceItem, type FaceKey, type FaceState, type MediaApi } from "./face.ts";
import { SCENE_SIZE } from "./prompts.ts";
import type { CompanionRecord, PrepStore } from "./store.ts";

/** GENITA_FACE_TOPUP=0 / false / off stops the background top-up (new face sets still get every key). */
export function topUpOn(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.GENITA_FACE_TOPUP ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/** The face keys this companion's finished set is missing (or lost to an upstream edit failure). */
export function missingFaceKeys(c: CompanionRecord, env: Record<string, string | undefined> = process.env): FaceKey[] {
  const f = c.prep.steps.face;
  if (f?.status !== "done" || !f.face) return [];
  const items = f.face.items;
  return faceKeysFor(c.type, f.face.profile, env).filter((k) => !items[k] || (items[k]?.status === "rejected" && items[k]?.reason === "edit_failed"));
}

export type TopUpResult = { companionId: string; userId: string; status: "added" | "complete" | "skipped"; added: FaceKey[]; rejected: FaceKey[]; reason?: string; ms: number };

export async function topUpFaceKeys(o: {
  store: PrepStore;
  media: MediaApi;
  metaKey: string;
  companion: CompanionRecord;
  env?: Record<string, string | undefined>;
  log?: (event: string, data: Record<string, unknown>) => void;
  signal?: AbortSignal;
  /** After the write, wait this long and check the companion again (out-of-process callers: an account deletion
   *  removes the row a moment after its blob sweep). In-process (the runner) passes 0: forgetUser drains it. */
  settleMs?: number;
}): Promise<TopUpResult> {
  const t0 = performance.now();
  const c = o.companion;
  const done = (status: TopUpResult["status"], added: FaceKey[] = [], rejected: FaceKey[] = [], reason?: string): TopUpResult => ({
    companionId: c.id, userId: c.userId, status, added, rejected, ...(reason ? { reason } : {}), ms: Math.round(performance.now() - t0),
  });
  const step = c.prep.steps.face;
  const prev = step?.face;
  if (step?.status !== "done" || !prev) return done("skipped", [], [], `face step ${step?.status ?? "missing"}`);
  // a key that failed upstream (Muse / SAM outage) is retried on the next run (codex P2)
  const retryable = (k: FaceKey) => { const i = prev.items[k]; return i?.status === "rejected" && i.reason === "edit_failed"; };
  const missing = missingFaceKeys(c, o.env);
  if (!missing.length) return done("complete");
  const scene = await o.store.getAsset(c.userId, c.id, "neutral");
  if (!scene) return done("skipped", [], [], "no scene");

  const still = async () => (await o.store.getCompanion(c.userId))?.id === c.id;
  const written: FaceKey[] = [];
  const settled: Array<[FaceKey, FaceItem]> = [];
  const items = Object.fromEntries(Object.entries(prev.items).filter(([k]) => !retryable(k as FaceKey)));
  const out: FaceState = await makeFaceSet({
    metaKey: o.metaKey,
    media: o.media,
    scene,
    kind: c.type,
    size: SCENE_SIZE,
    prev: { ...prev, items },
    profile: prev.profile,
    onItem: async (key, item, bytes) => {
      // a companion deleted (or replaced) mid-run gets no image written back (codex P1); an abort (DELETE /me's
      // forgetUser) stops every later write, and forgetUser waits for this one before it erases the images
      o.signal?.throwIfAborted();
      if (bytes && (await still())) { await o.store.putAsset(c.userId, c.id, key, bytes); written.push(key); }
      settled.push([key, item]);
    },
    log: o.log,
    signal: o.signal,
  });
  // one write at the end: the saved face keeps its flow / person / profile, gains the new items (and the key plan).
  // A key another run already finished is never downgraded (codex P2: concurrent runs).
  const got = Object.fromEntries(settled);
  o.signal?.throwIfAborted();
  const saved = await o.store.patchCompanion(c.userId, (x) => {
    const f = x.prep.steps.face;
    if (!f?.face || x.id !== c.id) return x;
    const merged = { ...f.face.items };
    for (const [k, i] of Object.entries(got) as Array<[FaceKey, FaceItem]>) {
      if (merged[k]?.status === "done" && i.status !== "done") continue;
      if (i.status === "done" && !written.includes(k)) continue;
      merged[k] = i;
    }
    const face: FaceState = { ...f.face, items: merged, ...(out.keys ? { keys: [...new Set([...(f.face.keys ?? []), ...out.keys])] } : {}) };
    return { ...x, prep: { ...x.prep, steps: { ...x.prep.steps, face: { ...f, face } } } };
  });
  if (!saved || saved.id !== c.id) {
    // gone (or replaced) while we ran: drop what this run wrote
    if (written.length && !(await still())) await o.store.deleteAssets(c.userId, c.id).catch(() => undefined);
    return done("skipped", [], [], "companion gone");
  }
  if (written.length && (o.settleMs ?? 10_000) > 0) {
    await new Promise((r) => setTimeout(r, o.settleMs ?? 10_000));
    if (!(await still())) {
      await o.store.deleteAssets(c.userId, c.id).catch(() => undefined);
      return done("skipped", [], [], "companion gone");
    }
  }
  const added = settled.filter(([k, i]) => i.status === "done" && written.includes(k)).map(([k]) => k);
  const rejected = settled.filter(([, i]) => i.status === "rejected").map(([k]) => k);
  return done("added", added, rejected);
}
