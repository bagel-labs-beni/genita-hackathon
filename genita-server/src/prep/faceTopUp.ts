/**
 * Face set top-up (11/3 night, expression layer): a companion whose face step is already `done` gets the face keys
 * its set is missing (today: laugh / surprised / concerned) without redoing the rest. It reuses the prep's own
 * `makeFaceSet` with the saved state as `prev`, so only the missing keys are edited (Muse Image, from the scene,
 * SAM drift-checked, one stricter retry) and every other key, the flow data and the person matte stay as they are.
 * Called by `npm run face:topup` (ops script); the running server picks the new keys up on the next prep fetch
 * (the app's face cache key follows the manifest, so devices download the new stills once).
 */
import { faceKeysFor, makeFaceSet, type FaceItem, type FaceKey, type FaceState, type MediaApi } from "./face.ts";
import { SCENE_SIZE } from "./prompts.ts";
import type { CompanionRecord, PrepStore } from "./store.ts";

export type TopUpResult = { companionId: string; userId: string; status: "added" | "complete" | "skipped"; added: FaceKey[]; rejected: FaceKey[]; reason?: string; ms: number };

export async function topUpFaceKeys(o: {
  store: PrepStore;
  media: MediaApi;
  metaKey: string;
  companion: CompanionRecord;
  env?: Record<string, string | undefined>;
  log?: (event: string, data: Record<string, unknown>) => void;
  signal?: AbortSignal;
}): Promise<TopUpResult> {
  const t0 = performance.now();
  const c = o.companion;
  const done = (status: TopUpResult["status"], added: FaceKey[] = [], rejected: FaceKey[] = [], reason?: string): TopUpResult => ({
    companionId: c.id, userId: c.userId, status, added, rejected, ...(reason ? { reason } : {}), ms: Math.round(performance.now() - t0),
  });
  const step = c.prep.steps.face;
  const prev = step?.face;
  if (step?.status !== "done" || !prev) return done("skipped", [], [], `face step ${step?.status ?? "missing"}`);
  const plan = faceKeysFor(c.type, prev.profile, o.env);
  const missing = plan.filter((k) => !prev.items[k]);
  if (!missing.length) return done("complete");
  const scene = await o.store.getAsset(c.userId, c.id, "neutral");
  if (!scene) return done("skipped", [], [], "no scene");

  const settled: Array<[FaceKey, FaceItem]> = [];
  const out: FaceState = await makeFaceSet({
    metaKey: o.metaKey,
    media: o.media,
    scene,
    kind: c.type,
    size: SCENE_SIZE,
    prev,
    profile: prev.profile,
    onItem: async (key, item, bytes) => {
      if (bytes) await o.store.putAsset(c.userId, c.id, key, bytes);
      settled.push([key, item]);
    },
    log: o.log,
    signal: o.signal,
  });
  // one write at the end: the saved face keeps its flow / person / profile, gains the new items (and the key plan)
  const got = Object.fromEntries(settled);
  const saved = await o.store.patchCompanion(c.userId, (x) => {
    const f = x.prep.steps.face;
    if (!f?.face || x.id !== c.id) return x;
    const face: FaceState = { ...f.face, items: { ...f.face.items, ...got }, ...(out.keys ? { keys: out.keys } : {}) };
    return { ...x, prep: { ...x.prep, steps: { ...x.prep.steps, face: { ...f, face } } } };
  });
  if (!saved) return done("skipped", [], [], "companion gone");
  const added = settled.filter(([, i]) => i.status === "done").map(([k]) => k);
  const rejected = settled.filter(([, i]) => i.status === "rejected").map(([k]) => k);
  return done("added", added, rejected);
}
