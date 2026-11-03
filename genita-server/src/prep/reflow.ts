/**
 * 11/4 one-off: re-run only the flow step of already-prepped faces whose blend mask predates the SAM face silhouette
 * (flow.maskVersion < 2) — Chelsea saw a see-through double jaw line under the chin on those. The face set keys
 * (Muse images) are kept; faceflow.py rebuilds flows + mask from the stored scene and keys into NEW asset names
 * (`_g2`), and the companion's flow block is swapped in one patch. Run in-process by the prep runner when a face is
 * loaded (runner.reflowMask), so DELETE /me cancels and waits for it like any prep job.
 */
import { makeFaceFlow } from "./faceflow.ts";
import { imageSize, normBox, samPrompt, type FaceKey } from "./face.ts";
import { makeFaceSilhouette } from "./person.ts";
import { mediaOf, type PrepDeps } from "./pipeline.ts";
import { flowProfileOf } from "./profiles.ts";
import type { CompanionRecord } from "./store.ts";

const sceneMime = (b: Buffer) => (b.readUInt32BE(0) === 0x89504e47 ? "image/png" : b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : "image/webp");

/** A ready face with a flow block made before the silhouette mask. */
export function needsReflow(c: CompanionRecord): boolean {
  const f = c.prep.steps.face;
  return f?.status === "done" && !!f.face?.flow && (f.face.flow.maskVersion ?? 1) < 2;
}

export type ReflowResult = { status: "done" | "skipped" | "failed"; reason?: string; silhouette?: boolean; ms?: number };

export async function reflowFace(d: PrepDeps, c: CompanionRecord, signal?: AbortSignal): Promise<ReflowResult> {
  const t0 = performance.now();
  if (!needsReflow(c)) return { status: "skipped", reason: "up to date" };
  if (!d.python) return { status: "skipped", reason: "no python (GENITA_PYFLOW)" };
  const face = c.prep.steps.face!.face!;
  const scene = await d.store.getAsset(c.userId, c.id, "neutral");
  if (!scene) return { status: "failed", reason: "scene missing" };
  const raw = (await d.store.getImage(c.imageId).catch(() => null))?.rec.check.raw;
  const profile = face.profile ?? flowProfileOf(c.type, raw);
  const url = `data:${sceneMime(scene)};base64,${scene.toString("base64")}`;
  const size = imageSize(scene);
  const media = mediaOf(d);
  const flow = await makeFaceFlow({
    python: d.python,
    profile,
    species: raw?.species || undefined,
    scene,
    state: face,
    kind: c.type,
    image: (k: FaceKey) => d.store.getAsset(c.userId, c.id, k),
    put: (asset, bytes) => d.store.putAsset(c.userId, c.id, asset, bytes),
    // codex P1: a new asset generation next to the old one — the live manifest never points at half-written files,
    // and apps that cache by asset URL fetch the new mask (the old files stay until the companion is deleted)
    assetSuffix: "_g2",
    nose: async () => {
      const boxes = await media.samDetect(d.metaKey, url, samPrompt(c.type, "nose"), signal);
      return size && boxes[0] ? normBox(boxes[0], size) : null;
    },
    eyes: async () => {
      const boxes = await media.samDetect(d.metaKey, url, samPrompt(c.type, "eyes"), signal);
      return size ? boxes.slice(0, 2).map((b) => normBox(b, size)) : [];
    },
    silhouette: async () => (size ? makeFaceSilhouette({ media, metaKey: d.metaKey, sceneDataUrl: url, size, kind: c.type, signal }) : null),
    log: (e, x) => d.log(e, { companion: c.id, reflow: true, ...x }),
    signal,
  });
  if (!flow) return { status: "failed", reason: "faceflow" };
  if ((flow.maskVersion ?? 1) < 2) return { status: "failed", reason: "SAM face silhouette unavailable (kept the old flow)" };
  // one patch: only this companion, only if it is still the same ready face (a re-prep in between wins)
  let swapped = false;
  await d.store.patchCompanion(c.userId, (x) => {
    const f = x.prep.steps.face;
    if (x.id !== c.id || f?.status !== "done" || !f.face) return x;
    swapped = true;
    return { ...x, prep: { ...x.prep, steps: { ...x.prep.steps, face: { ...f, face: { ...f.face, flow } } } } };
  });
  return swapped ? { status: "done", silhouette: !!flow.silhouette, ms: Math.round(performance.now() - t0) } : { status: "skipped", reason: "changed meanwhile" };
}
