/**
 * Photo polish (11/4): one Muse Image edit turns whatever photo the user brought into a clean,
 * front-facing reference before the face set is made, and the user confirms it in V02-T.
 *
 *   upload → image check (D26: a public figure is refused here and never edited)
 *          → POST /v1/companion/image/polish → Muse Image edit (one prompt for every subject:
 *            no human / animal / character branch) → the same Spark + SAM check on the result,
 *            which must pass and keep the subject type → V02-T "Use this image" / "Try again"
 *            (Chelsea 11/4: no "Use my original") → the confirmed picture is the call scene itself
 *
 * Fixable reasons (side view, poor light or blur, text over the image) are polished instead of
 * refused; the upload answer's `passed` stays strict, so an app build without the confirm step
 * behaves as before. Server flag GENITA_PHOTO_POLISH (default on; "0" = today's flow:
 * the upload answers polish:false and this route answers 404 polish_off).
 */
import { randomUUID } from "node:crypto";
import { sparkJson } from "../meta/spark.ts";
import { FAIL_REASONS, buildClassifyRequest, headPrompt, interpretCheck, pickHeadBox, type ClassifyRaw, type FailReason, type ImageCheck } from "./classify.ts";
import { PrepError, mediaOf, type PrepDeps } from "./pipeline.ts";
import type { ImageRecord } from "./store.ts";
import type { SamBox } from "../meta/sam.ts";

/**
 * One prompt; the model applies the right rule for a photo, a drawing or an animal itself, so no code
 * here looks at the type. Written for Genita's face set, not for a pretty picture: the call screen's 9:16 frame, the
 * face a little above the middle, eyes open, mouth closed (the mouth keys are edits of it), nothing over the face, hair
 * off the mouth and chin and a clear jawline against the background (the SAM mouth/jaw mask; ghosting otherwise),
 * soft even light, a simple blurred background. Muse Image keeps the asked shape at its own size (11/4: 9:16 → 1152×2048).
 */
export const POLISH_PROMPT = [
  "Redraw this image as a clean reference portrait for a face-animation video call, keeping the same subject.",
  "Subject: keep exactly the same individual, the same person, animal or character, with the same face shape, eyes, nose, mouth, skin, fur or coat, markings, hair, age, body proportions, colors and clothing.",
  "Do not change the species, do not beautify, smooth the skin or restyle anything.",
  "Style: a real photo stays a real photo; a drawing, cartoon, anime, 3D render, clay or toy figure keeps its own medium and art style exactly.",
  "If there are several people, animals or characters, keep only the largest, most prominent one.",
  "Composition: vertical portrait, the subject centered and facing the viewer straight on, head and shoulders, space above the head, the face a little above the middle of the frame, the head level.",
  "Face: both eyes open and looking at the viewer, a calm neutral expression (at most a slight smile) with the mouth closed and relaxed; no hands, food, cups, masks or other objects in front of the face; hair kept away from the mouth and chin.",
  "Mouth and jaw: the lips, chin and jawline fully visible with a clear outline, not hidden by hair, hands, a scarf or a high collar; a beard or mustache stays as it is but neatly clear of the lips; the chin clearly separated from the neck and the background.",
  "Light: soft, even front light on the face, no harsh shadows or dark areas, sharp focus.",
  "Background: simple and softly blurred, keeping only a gentle hint of the original place, with no text, captions, interface, frames, watermarks or other people or animals.",
].join(" ");

/** 9:16 like the call screen and the scene step's output. */
export const POLISH_SIZE = "1024x1820";
/** The first polish + two "Try again" per uploaded photo. */
export const POLISH_MAX_ATTEMPTS = 3;
const POLISH_TIMEOUT_MS = 60_000;

/**
 * What the edit can fix (11/4, Chelsea: users bring any photo). A group photo keeps its largest subject (the app can
 * crop to another head and upload that); a half-covered face is filled in and the user judges it in V02-T.
 * Only a public figure (D26) and a photo without any face are refused.
 */
const FIXABLE = new Set<FailReason>(["side_view", "too_blurry", "text_on_image", "multiple_faces", "face_covered"]);

export function canPolish(check: ImageCheck): boolean {
  if (!check.type || check.polishedFrom || !check.reasons.every((r) => FIXABLE.has(r.code))) return false;
  // D26 applies to the whole photo before it reaches the image model: a well-known person anywhere refuses the polish;
  // a group photo needs the answer to be a clear "no"
  if (check.raw.any_public_figure === true) return false;
  if (check.reasons.some((r) => r.code === "multiple_faces") && check.raw.any_public_figure !== false) return false;
  return true;
}

/** The result must stay the same kind of thing: a flat drawing stays flat, a dog stays a dog (a closer name is fine). */
function changedLook(orig: ClassifyRaw, now: ClassifyRaw): boolean {
  const flat = (s?: string) => (s === "2d" ? "2d" : s === "3d" || s === "toy" ? "3d" : "");
  if (flat(orig.character_style) && flat(now.character_style) && flat(orig.character_style) !== flat(now.character_style)) return true;
  const a = (orig.species ?? "").trim().toLowerCase();
  const b = (now.species ?? "").trim().toLowerCase();
  return !!a && !!b && !a.includes(b) && !b.includes(a);
}

/** The upload answer's `polish`: the app runs the confirm step only when this is true. */
export function uploadPolish(check: ImageCheck, flagOn: boolean): boolean {
  return flagOn && canPolish(check);
}

/** Every head SAM found on the upload, largest first (max 6): V02's "Pick someone else" for a group photo. */
export function headsView(boxes: SamBox[] | null | undefined): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const area = (b: SamBox) => (b.x2 - b.x1) * (b.y2 - b.y1);
  return [...(boxes ?? [])].sort((a, b) => area(b) - area(a)).slice(0, 6).map((b) => ({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }));
}

export type PolishOutcome = { rec: ImageRecord; source: ImageRecord; attempt: number; retriesLeft: number; ms: { polish: number; check: number } };

/** A refusal (content policy / safety) comes back the same for the same photo: another photo, not a retry. */
const isRefusal = (err: unknown) => /content_policy|safety|moderation|blocked/i.test(String(err));

export class PolishFailed extends PrepError {
  readonly retriesLeft: number;
  constructor(retriesLeft: number) {
    super(502, "polish_failed", "Couldn't polish this image. Try again.");
    this.retriesLeft = retriesLeft;
  }
}

const since = (t0: number) => Math.round(performance.now() - t0);

/** Polishes the user's own uploaded (unpolished) photo; `attempts` counts per source photo. */
export async function polishImage(
  d: PrepDeps,
  userId: string,
  imageId: unknown,
  attempts: Map<string, number>,
  /** QA comparisons only (prompt A/B); the route always uses the defaults */
  variant: { prompt: string; size: string } = { prompt: POLISH_PROMPT, size: POLISH_SIZE },
): Promise<PolishOutcome> {
  if (!d.photoPolish) throw new PrepError(404, "polish_off");
  const src = typeof imageId === "string" ? await d.store.getImage(imageId).catch(() => null) : null;
  if (!src || src.rec.userId !== userId) throw new PrepError(404, "unknown_image");
  const orig = src.rec;
  if (!canPolish(orig.check)) throw new PrepError(422, "not_polishable", "This image can't be polished. Choose another image.");
  const used = attempts.get(orig.id) ?? 0;
  if (used >= POLISH_MAX_ATTEMPTS) throw new PrepError(429, "polish_limit", "Use this one or your original, or choose another image.");
  const attempt = used + 1;
  attempts.set(orig.id, attempt);
  if (attempts.size > 10_000) attempts.delete(attempts.keys().next().value!);
  const retriesLeft = POLISH_MAX_ATTEMPTS - attempt;

  const t0 = performance.now();
  const edit = () => mediaOf(d).imageEdit(d.metaKey, src.bytes, variant.prompt, { size: variant.size, mime: orig.mime, signal: AbortSignal.timeout(POLISH_TIMEOUT_MS) });
  let bytes: Buffer;
  try {
    // an empty answer or a 5xx is usually a one-off: one automatic retry (not counted as the user's "Try again")
    bytes = await edit().catch((err) => {
      if (isRefusal(err)) throw err;
      d.log("photo.polish_retry", { attempt, reason: String(err).slice(0, 120) });
      return edit();
    });
  } catch (err) {
    d.log("photo.polish_failed", { attempt, ms: since(t0), refused: isRefusal(err), reason: String(err).slice(0, 200) });
    if (isRefusal(err)) throw new PrepError(422, "polish_refused", "This photo can't be used. Choose another photo.");
    throw new PolishFailed(retriesLeft);
  }
  const polishMs = since(t0);

  // the result gets the same check as an upload (public figure included); it must also keep the subject type and look.
  // A failure from here on (Spark, SAM, storage) is the same retryable polish_failed, with the tries left.
  let rec: ImageRecord;
  let checkMs: number;
  try {
    const t1 = performance.now();
    const url = `data:image/png;base64,${bytes.toString("base64")}`;
    const json = d.spark ?? (<T>(req: Parameters<NonNullable<PrepDeps["spark"]>>[0]) => sparkJson<T>(d.metaKey, req));
    const [raw, boxes] = await Promise.all([
      json<ClassifyRaw>(buildClassifyRequest(url)),
      mediaOf(d).samDetect(d.metaKey, url, headPrompt(orig.check.type)).catch(() => null),
    ]);
    checkMs = since(t1);
    // species and character style stay the upload's (the face profile is chosen from them) once they're known to match
    const merged: ClassifyRaw = { ...raw, species: orig.check.raw.species || raw.species, character_style: orig.check.raw.character_style ?? raw.character_style };
    let check: ImageCheck = interpretCheck(merged);
    if (check.type !== orig.check.type || changedLook(orig.check.raw, raw)) {
      check = { ...check, type: orig.check.type, passed: false, reasons: [{ code: "style_changed", label: FAIL_REASONS.style_changed }] };
    }
    check = { ...check, polishedFrom: orig.id };
    rec = {
      id: randomUUID().replace(/-/g, ""),
      userId,
      mime: "image/png",
      bytes: bytes.length,
      check,
      headBox: check.passed && boxes ? pickHeadBox(boxes) : null,
      rightsAck: orig.rightsAck,
      createdAt: new Date().toISOString(),
      ms: { check: checkMs, sam: null },
    };
    await d.store.putImage(rec, bytes);
  } catch (err) {
    d.log("photo.polish_failed", { attempt, ms: since(t0), stage: "recheck", reason: String(err).slice(0, 200) });
    throw new PolishFailed(retriesLeft);
  }
  const check = rec.check;
  d.log("photo.polished", { attempt, passed: check.passed, reasons: check.reasons.map((r) => r.code), type: orig.check.type, polish_ms: polishMs, check_ms: checkMs });
  return { rec, source: orig, attempt, retriesLeft, ms: { polish: polishMs, check: checkMs } };
}
