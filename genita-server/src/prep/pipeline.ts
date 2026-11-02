/**
 * Onboarding prep services: the vendor calls behind the /v1/import and
 * /v1/companion routes. Pure decisions live in the sibling modules; this file
 * only wires them to Spark, SAM, Muse Image, fal and ElevenLabs.
 */
import { randomUUID } from "node:crypto";
import { sparkJson, type SparkRequest } from "../meta/spark.ts";
import { museImageEdit, samDetect } from "../meta/media.ts";
import { falUpload, falSubmit, falWait } from "./fal.ts";
import { buildClassifyRequest, headPrompt, interpretCheck, pickHeadBox, sniffImage, type ClassifyRaw } from "./classify.ts";
import { buildImportRequest, checkPaste, redactSensitive, toStyleCard, type ImportRaw, type StyleCard } from "./importProfile.ts";
import { buildPersonaRequest, toPersona, validatePrefs, type PersonaRaw } from "./personaCard.ts";
import { SCENE_PROMPT, SCENE_SIZE, type CompanionKind } from "./prompts.ts";
import { applyOrder, buildOrderRequest, isDeviceVoice, previewLine, renderPreview, type VoiceOption } from "./voices.ts";
import type { MediaApi } from "./face.ts";
import type { CompanionRecord, ImageRecord, PrepStore } from "./store.ts";
import type { Personalize } from "../personalize/service.ts";

export type PrepLog = (event: string, data: Record<string, unknown>) => void;

export type PrepDeps = {
  metaKey: string;
  /** read only when `kling` is on */
  falKey: string | null;
  /** null when server TTS is off */
  elevenKey: string | null;
  ttsModel: string;
  store: PrepStore;
  voices: VoiceOption[];
  log: PrepLog;
  /** tests: replaces the structured Spark call used by name suggest (F2-L26); unset = Muse Spark */
  spark?: <T>(req: Omit<SparkRequest, "text"> & { schemaName: string; schema: Record<string, unknown> }, signal?: AbortSignal) => Promise<T>;
  /** GENITA_KLING=1: fal scene fallback + Kling clips + lips step. Off (default): scene → face set, Meta only */
  kling?: boolean;
  /** GENITA_PETER=1: Peter lip worker (session `lip` = peter for humans) */
  peter?: boolean;
  /** GENITA_SERVER_TTS=1: ElevenLabs voices + previews. Off: device voice descriptors */
  serverTts?: boolean;
  /** Muse Image + SAM; tests pass a fake */
  media?: MediaApi;
  /** lane 개인화: HISY story (in parallel with the import), corrections, call growth; unset = none */
  personalize?: Personalize;
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

const dataUrl = (bytes: Buffer, mime: string) => `data:${mime};base64,${bytes.toString("base64")}`;
const since = (t0: number) => Math.round(performance.now() - t0);

// ---------- F2-L20: image check ----------

export async function checkImage(d: PrepDeps, userId: string, bytes: Buffer, rightsAck: boolean): Promise<ImageRecord> {
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
  const raw = await sparkJson<ClassifyRaw>(d.metaKey, buildClassifyRequest(url));
  const checkMs = since(t0);
  const check = interpretCheck(raw);
  let head = await samPerson;
  if (check.passed && check.type && check.type !== "human") {
    const t1 = performance.now();
    head = await samDetect(d.metaKey, url, headPrompt(check.type)).then(
      (b) => ({ boxes: b, ms: checkMs + since(t1) }),
      () => null,
    );
  }
  const rec: ImageRecord = {
    id: randomUUID().replace(/-/g, ""),
    userId,
    mime,
    bytes: bytes.length,
    check,
    headBox: check.passed && head ? pickHeadBox(head.boxes) : null,
    rightsAck,
    createdAt: new Date().toISOString(),
    ms: { check: checkMs, sam: head?.ms ?? null },
  };
  await d.store.putImage(rec, bytes);
  d.log("face.checked", { passed: check.passed, reasons: check.reasons.map((r) => r.code), type: check.type, ms: since(t0) });
  return rec;
}

// ---------- F3-L2: import ----------

export async function importStyle(d: PrepDeps, userId: string, pasted: unknown): Promise<StyleCard> {
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
  if (card.itemCount === 0) throw new PrepError(422, "import_empty", "I couldn't read this one. Paste the whole reply, or try again.");
  if (storyJob && d.personalize) {
    const grace = new Promise<"late">((r) => setTimeout(() => r("late"), STORY_GRACE_MS).unref?.());
    const s = await Promise.race([storyJob, grace]);
    if (s && s !== "late") card = d.personalize.withStory(card, s);
    // still writing: saved when it lands; GET /v1/profile/story waits for this same job (no second Spark call)
    else if (s === "late") d.personalize.trackLate(userId, storyJob);
  }
  // under the personalize lock: a call starting at the same moment can't write the old card back
  if (d.personalize) await d.personalize.replaceStyle(userId, card);
  else await d.store.putStyle(userId, card);
  d.log("import.applied", { item_count: card.itemCount, latency_ms: since(t0), chars: p.chars, partial: card.partial, dropped: card.dropped });
  return card;
}

// ---------- F2-L21: call scene ----------

export type SceneResult = { bytes: Buffer; mime: string; source: "muse-image" | "gpt-image-2"; ms: number; url: string | null };

/**
 * Muse Image edit. With GENITA_KLING on, a failure falls back to one
 * gpt-image-2 edit via fal, and the result gets a fal CDN URL for Kling.
 * With it off, fal is never called and `url` is null.
 */
export async function makeScene(d: PrepDeps, image: Buffer, mime: string, kind: CompanionKind, signal?: AbortSignal): Promise<SceneResult> {
  const t0 = performance.now();
  const falKey = d.kling ? d.falKey : null;
  try {
    const out = await mediaOf(d).imageEdit(d.metaKey, image, SCENE_PROMPT[kind], { size: SCENE_SIZE, mime, signal });
    const url = falKey ? await falUpload(falKey, out, "image/png", "scene.png", signal) : null;
    return { bytes: out, mime: "image/png", source: "muse-image", ms: since(t0), url };
  } catch (err) {
    if (signal?.aborted || !falKey) throw err;
    d.log("scene.fallback", { reason: String(err).slice(0, 200) });
    const src = await falUpload(falKey, image, mime, "source", signal);
    const req = await falSubmit(falKey, "fal-ai/gpt-image-2/edit", { prompt: SCENE_PROMPT[kind], image_urls: [src], image_size: { width: 1024, height: 1820 }, quality: "high" }, signal);
    const r = await falWait<{ images: Array<{ url: string }> }>(falKey, req, { signal, pollMs: 3000, timeoutMs: 5 * 60_000 });
    const url = r.images?.[0]?.url;
    if (!url) throw new Error("gpt-image-2: no image");
    const res = await fetch(url, { signal });
    return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") ?? "image/png", source: "gpt-image-2", ms: since(t0), url };
  }
}

// ---------- F2-L8: voices ----------

export const PREVIEW_VERSION = "v1";

export async function orderedVoices(d: PrepDeps, userId: string, kind: CompanionKind | null): Promise<{ voices: VoiceOption[]; suggested: boolean; ms: number }> {
  const t0 = performance.now();
  const style = await d.store.getStyle(userId);
  try {
    const r = await sparkJson<{ order: string[] }>(d.metaKey, buildOrderRequest(d.voices, kind, style));
    return { voices: applyOrder(d.voices, r.order), suggested: true, ms: since(t0) };
  } catch (err) {
    d.log("voice.order_failed", { reason: String(err).slice(0, 200) });
    return { voices: d.voices, suggested: false, ms: since(t0) };
  }
}

export async function voicePreview(d: PrepDeps, voiceId: string): Promise<Buffer> {
  const v = d.voices.find((x) => x.id === voiceId);
  if (!v) throw new PrepError(404, "unknown_voice");
  // device voices are previewed by the app with its own synthesizer
  if (isDeviceVoice(v.id) || !d.serverTts || !d.elevenKey) throw new PrepError(404, "device_preview", "preview this voice on the device");
  const elevenKey = d.elevenKey;
  const cached = await d.store.getVoicePreview(v.id, PREVIEW_VERSION);
  if (cached) return cached;
  const mp3 = await renderPreview(elevenKey, v.id, previewLine(v), d.ttsModel).catch(() => renderPreview(elevenKey, v.id, previewLine(v), "eleven_multilingual_v2"));
  await d.store.putVoicePreview(v.id, PREVIEW_VERSION, mp3);
  return mp3;
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
  // a rename (PATCH / by voice) may land while Spark writes the card: the stored name wins
  const next = (await d.store.patchCompanion(companion.userId, (x) => ({ ...x, prefs, persona: { ...persona, card: { ...persona.card, name: x.name } } }))) ?? { ...companion, prefs, persona };
  d.log("setup.persona_written", { depth: v.depth, ms: since(t0), spark: !!raw });
  return next;
}
