/**
 * Onboarding prep services: the vendor calls behind the /v1/import and
 * /v1/companion routes. Pure decisions live in the sibling modules; this file
 * only wires them to Spark, SAM, Muse Image, Meta voice.
 */
import { randomUUID } from "node:crypto";
import { PersonalizeError } from "../personalize/service.ts";
import { sparkJson, type SparkRequest } from "../meta/spark.ts";
import { museImageEdit, samDetect } from "../meta/media.ts";
import { getOps } from "../ops/limits.ts";
import { buildClassifyRequest, headPrompt, interpretCheck, pickHeadBox, sniffImage, type ClassifyRaw } from "./classify.ts";
import { EYES_PROMPT, MOUTH_PROMPT, facePointsFromSam, facePrompt, outlineFromSam } from "./faceGeometry.ts";
import { buildImportRequest, checkPaste, importFormat, redactSensitive, toStyleCard, type ImportRaw, type StyleCard } from "./importProfile.ts";
import { buildPersonaRequest, toPersona, validatePrefs, type PersonaRaw } from "./personaCard.ts";
import { SCENE_PROMPT, SCENE_SIZE, type CompanionKind } from "./prompts.ts";
import { isDeviceVoice, previewLine, renderPreview, voicesForKind, type VoiceOption } from "./voices.ts";
import type { MediaApi } from "./face.ts";
import type { CompanionRecord, ImageRecord, PrepStore } from "./store.ts";
import type { Personalize } from "../personalize/service.ts";

export type PrepLog = (event: string, data: Record<string, unknown>) => void;

export type PrepDeps = {
  metaKey: string;
  voice?: import("../config.ts").VoiceConfig | null;
  store: PrepStore;
  voices: VoiceOption[];
  log: PrepLog;
  /** tests: replaces the structured Spark call used by name suggest (F2-L26); unset = Muse Spark */
  spark?: <T>(req: Omit<SparkRequest, "text"> & { schemaName: string; schema: Record<string, unknown> }, signal?: AbortSignal) => Promise<T>;
  /** Muse Image + SAM; tests pass a fake */
  media?: MediaApi;
  /** Python with OpenCV for the face-flow step (prep/faceflow.ts); null/undefined = no flow data */
  python?: string | null;
  /** GENITA_PHOTO_POLISH (prep/polish.ts): the polish + confirm step before prep; unset/false = off */
  photoPolish?: boolean;
  /** lane 개인화: HISY story (in parallel with the import), corrections, call growth; unset = none */
  personalize?: Personalize;
  /** after DELETE /v1/profile (AU-92): the server forgets call memory and summaries too */
  onProfileForgotten?: (userId: string) => Promise<void>;
};

/** how long the import response waits for a story that's still being written after the parse (then it's saved when it lands) */
export const STORY_GRACE_MS = 1500;

export const META_MEDIA: MediaApi = { imageEdit: museImageEdit, samDetect };
export const mediaOf = (d: PrepDeps): MediaApi => d.media ?? META_MEDIA;

export class PrepError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** V03 face scan SAM calls: hard cap, and how long the check answer waits for them once Spark and the head box are in */
export const FACE_SCAN_TIMEOUT_MS = 15_000;
export const FACE_SCAN_GRACE_MS = 1_500;
/** the scan's 3–4 SAM calls start only if at least this many Meta calls are left today (Spark retry + head re-ask first) */
export const FACE_SCAN_MIN_CALLS_LEFT = 8;

/** `p`, or `fallback` if it hasn't settled `ms` from now (the timer is cleared as soon as `p` settles) */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

const dataUrl = (bytes: Buffer, mime: string) => `data:${mime};base64,${bytes.toString("base64")}`;
const since = (t0: number) => Math.round(performance.now() - t0);

// ---------- F2-L20: image check ----------

export async function checkImage(d: PrepDeps, userId: string, bytes: Buffer, rightsAck: boolean, createdAt = new Date().toISOString()): Promise<ImageRecord> {
  if (!bytes.length) throw new PrepError(400, "empty_image");
  if (bytes.length > MAX_IMAGE_BYTES) throw new PrepError(413, "image_too_large", "image must be under 8 MB; downscale on device (1280 px is plenty)");
  const mime = sniffImage(bytes);
  if (!mime) throw new PrepError(415, "unsupported_image", "JPEG, PNG or WebP");
  const url = dataUrl(bytes, mime);
  const t0 = performance.now();
  // SAM starts with a person prompt in parallel; if Spark says animal/character we re-ask with the right noun.
  const samPerson = samDetect(d.metaKey, url, headPrompt("human")).then(
    (b) => ({ boxes: b, ms: since(t0) }),
    () => null,
  );
  // The check itself goes first, so its Meta budget is reserved before the optional face-scan calls below.
  const sparkCheck = sparkJson<ClassifyRaw>(d.metaKey, buildClassifyRequest(url));
  // V03 face scan (11/4): face silhouette + eye and mouth boxes for the app's mesh, all SAM in parallel with the
  // Spark check. Optional: they start only with Meta budget to spare (the check's retry and a non-human head re-ask
  // come first), and a failure or a slow answer only means no mesh, never a slower check.
  const scan = getOps().metaCallsLeft() >= FACE_SCAN_MIN_CALLS_LEFT;
  const optional = AbortSignal.timeout(FACE_SCAN_TIMEOUT_MS);
  const samFaceOf = (kind: Parameters<typeof facePrompt>[0]) => !scan ? Promise.resolve(null)
    : samDetect(d.metaKey, url, facePrompt(kind), optional, { masks: true }).then((b) => outlineFromSam(b), () => null);
  const samBoxes = (prompt: string) => !scan ? Promise.resolve([])
    : samDetect(d.metaKey, url, prompt, optional).catch(() => [] as Awaited<ReturnType<typeof samDetect>>);
  const samFeatures = Promise.all([samBoxes(EYES_PROMPT), samBoxes(MOUTH_PROMPT)]);
  let samFace = samFaceOf("human");
  const raw = await sparkCheck;
  const checkMs = since(t0);
  const check = interpretCheck(raw);
  let head = await samPerson;
  if (check.passed && check.type && check.type !== "human") {
    const t1 = performance.now();
    const kind = check.type;
    // the head box first (it gates prep), then the face for this kind
    const samHead = samDetect(d.metaKey, url, headPrompt(kind)).then(
      (b) => ({ boxes: b, ms: checkMs + since(t1) }),
      () => null,
    );
    samFace = samFaceOf(kind);
    head = await samHead;
  }
  // one shared deadline: the answer waits at most FACE_SCAN_GRACE_MS for the scan once the check and head box are in
  const deadline = performance.now() + FACE_SCAN_GRACE_MS;
  const left = () => Math.max(0, deadline - performance.now());
  const [faceOutline, [eyes, mouth]] = await Promise.all([within(samFace, left(), null), within(samFeatures, left(), [[], []])]);
  const rec: ImageRecord = {
    id: randomUUID().replace(/-/g, ""),
    userId,
    mime,
    bytes: bytes.length,
    check,
    headBox: check.passed && head ? pickHeadBox(head.boxes) : null,
    heads: head?.boxes ?? [],
    // only on a passed check: a failed photo goes to V02-F, nothing to draw
    faceOutline: check.passed ? faceOutline : null,
    facePoints: check.passed ? facePointsFromSam(eyes, mouth, faceOutline) : null,
    rightsAck,
    // This is captured after the upload body is read, before any model check.
    createdAt,
    ms: { check: checkMs, sam: head?.ms ?? null },
  };
  await d.store.putImage(rec, bytes);
  d.log("face.checked", { passed: check.passed, reasons: check.reasons.map((r) => r.code), type: check.type, ms: since(t0), outline: rec.faceOutline?.length ?? 0, points: !!rec.facePoints });
  return rec;
}

// ---------- F3-L2: import ----------

export async function importStyle(d: PrepDeps, userId: string, pasted: unknown, genAtRequest?: number): Promise<StyleCard> {
  // "Forget all of this" while this reads (AU-92): its result is not saved
  const gen = genAtRequest ?? d.personalize?.generation(userId);
  const p = checkPaste(pasted);
  if (!p.ok) throw new PrepError(400, `import_${p.reason}`, "I couldn't read this one. Paste the whole reply, or try again.");
  const t0 = performance.now();
  // raw text is redacted before it leaves the server and never stored or logged
  const redacted = redactSensitive(p.text);
  // D47: the story is written from the same redacted text in parallel, so I03 has no extra wait
  const storyJob = d.personalize?.storyFromText(redacted) ?? null;
  const json = d.spark ?? (<T>(req: Parameters<NonNullable<PrepDeps["spark"]>>[0]) => sparkJson<T>(d.metaKey, req));
  const raw = await json<ImportRaw>(buildImportRequest(redacted));
  let card = toStyleCard(raw, "import");
  // A reply in the prompt's format whose every section says "Not enough information" (a new Claude/ChatGPT user
  // with no memory) is not unreadable: it is an empty profile. Keep it; the story says "Most of you, I'll learn as
  // we talk" and the first calls ask (QA 11/3 P1: never "couldn't read" for it). Only text we can't place is 422.
  if (card.itemCount === 0 && (importFormat(p.text) === "unknown" || (p.text.match(/not enough information/gi) ?? []).length < 3)) throw new PrepError(422, "import_empty", "I couldn't read this one. Paste the whole reply, or try again.");
  if (storyJob && d.personalize) {
    const grace = new Promise<"late">((r) => setTimeout(() => r("late"), STORY_GRACE_MS).unref?.());
    const s = await Promise.race([storyJob, grace]);
    if (s && s !== "late") card = d.personalize.withStory(card, s);
    // still writing: saved when it lands; GET /v1/profile/story waits for this same job (no second Spark call)
    else if (s === "late") d.personalize.trackLate(userId, storyJob, gen);
  }
  // under the personalize lock: a call starting at the same moment can't write the old card back
  if (d.personalize) {
    try { await d.personalize.replaceStyle(userId, card, gen); } catch (err) {
      if (err instanceof PersonalizeError) throw new PrepError(err.status, err.code, err.message);
      throw err;
    }
  }
  else await d.store.putStyle(userId, card);
  d.log("import.applied", { item_count: card.itemCount, latency_ms: since(t0), chars: p.chars, partial: card.partial, dropped: card.dropped });
  return card;
}

// ---------- F2-L21: call scene ----------

export type SceneResult = { bytes: Buffer; mime: string; source: "muse-image"; ms: number };

/** Muse Image edit, retried once on failure. */
export async function makeScene(d: PrepDeps, image: Buffer, mime: string, kind: CompanionKind, signal?: AbortSignal): Promise<SceneResult> {
  const t0 = performance.now();
  let out: Buffer;
  try {
    out = await mediaOf(d).imageEdit(d.metaKey, image, SCENE_PROMPT[kind], { size: SCENE_SIZE, mime, signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    d.log("scene.retry", { reason: "muse_image_failed" });
    out = await mediaOf(d).imageEdit(d.metaKey, image, SCENE_PROMPT[kind], { size: SCENE_SIZE, mime, signal });
  }
  return { bytes: out, mime: "image/png", source: "muse-image", ms: since(t0) };
}

// ---------- F2-L8: voices ----------

export const PREVIEW_VERSION = "meta-v3"; // v3 (11/3): the four V04 voices are new speakers 9, 19, 26 (+72)

/**
 * V04's list: the curated voices for this look, recommended default first (no model call).
 * `available` = the voice service answers /healthz (cached 15 s); when false the app greys the
 * list ("Voice preview is waking up") and lets the user continue with the default.
 */
export async function orderedVoices(d: PrepDeps, _userId: string, kind: CompanionKind | null): Promise<{ voices: VoiceOption[]; suggested: string | null; available: boolean; ms: number }> {
  const t0 = performance.now();
  const voices = voicesForKind(d.voices, kind);
  return { voices, suggested: voices[0]?.id ?? null, available: await voiceAvailable(d), ms: since(t0) };
}

let probe: { url: string; at: number; ok: boolean } | null = null;
export async function voiceAvailable(d: PrepDeps, now = Date.now()): Promise<boolean> {
  if (!d.voice) return false;
  if (probe && probe.url === d.voice.url && now - probe.at < 15_000) return probe.ok;
  let ok = false;
  try {
    ok = (await fetch(`${d.voice.url}/healthz`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch { /* down or cold */ }
  probe = { url: d.voice.url, at: now, ok };
  return ok;
}
export const resetVoiceProbe = () => { probe = null; };

export async function voicePreview(d: PrepDeps, voiceId: string): Promise<Buffer> {
  const v = d.voices.find((x) => x.id === voiceId);
  if (!v) throw new PrepError(404, "unknown_voice");
  // device voices are previewed by the app with its own synthesizer
  if (isDeviceVoice(v.id)) throw new PrepError(404, "device_preview", "preview this voice on the device");
  const cached = await d.store.getVoicePreview(v.id, PREVIEW_VERSION);
  if (cached) return cached;
  if (!d.voice) throw new PrepError(503, "voice_unavailable");
  const wav = await renderPreview(d.voice, v.id, previewLine(v));
  await d.store.putVoicePreview(v.id, PREVIEW_VERSION, wav);
  return wav;
}

// ---------- F2-L14: prefs → persona ----------

export async function savePrefs(d: PrepDeps, companion: CompanionRecord, depth: unknown, answers: unknown): Promise<CompanionRecord> {
  const v = validatePrefs(depth, answers);
  if (!v.ok) throw new PrepError(400, "bad_prefs", v.error);
  const t0 = performance.now();
  const style = await d.store.getStyle(companion.userId);
  const input = { name: companion.name, kind: companion.type, voiceId: companion.voiceId, depth: v.depth, answers: v.answers, style };
  let raw: PersonaRaw | null = null;
  try {
    raw = await sparkJson<PersonaRaw>(d.metaKey, buildPersonaRequest(input));
  } catch (err) {
    d.log("persona.spark_failed", { reason: String(err).slice(0, 200) }); // deterministic fallback below
  }
  const persona = toPersona(raw, input);
  const prefs = { depth: v.depth, answers: v.answers, updatedAt: new Date().toISOString() };
  // a rename (PATCH / by voice) may land while Spark writes the card: the stored name wins; a V04 voice pick
  // saved meanwhile also wins over the card's voice
  const next = (await d.store.patchCompanion(companion.userId, (x) => ({ ...x, prefs, persona: { ...persona, card: { ...persona.card, name: x.name, ...(x.voiceId === companion.voiceId ? {} : { voice: { id: x.voiceId } }) } } }))) ?? { ...companion, prefs, persona };
  d.log("setup.persona_written", { depth: v.depth, ms: since(t0), spark: !!raw });
  return next;
}
