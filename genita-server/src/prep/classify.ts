/**
 * F2-L20 (#22): image type + quality check + head box.
 *
 * Spark 1.3 with input_image and a json_schema answer. T1 (11/1) got 60/60
 * on type with a one-word prompt at effort "minimal"; the quality fields are
 * added here because V02-F needs a reason. SAM 3.1 runs in parallel for the
 * head box, so the wall time is max(Spark, SAM), not the sum.
 *
 * Screens: V02-T shows three rows (one face front-facing / sharp and well lit
 * / no text) and the type chip; V02-F turns the failing rows red with one of
 * the reasons below.
 */
import type { SparkRequest } from "../meta/spark.ts";
import type { SamBox } from "../meta/sam.ts";
import type { CompanionKind } from "./prompts.ts";

export const FAIL_REASONS = {
  no_face: "No face found",
  multiple_faces: "More than one face",
  face_covered: "Face is covered",
  side_view: "Side view",
  too_blurry: "Too blurry to make a face from",
  text_on_image: "Text on the image",
} as const;
export type FailReason = keyof typeof FAIL_REASONS;

export type ClassifyRaw = {
  subject: "person" | "animal" | "character" | "none";
  face_count: number;
  front_facing: boolean;
  face_covered: boolean;
  sharp: boolean;
  well_lit: boolean;
  text_on_image: boolean;
  /** 11/3, mouth profiles: the animal's species in one or two words ("dog", "cat"); "" otherwise */
  species?: string;
  /** 11/3, mouth profiles: drawn / flat ("2d") or rendered / clay / toy ("3d"); "none" for photos */
  character_style?: "2d" | "3d" | "none";
};

export const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string", enum: ["person", "animal", "character", "none"] },
    face_count: { type: "integer" },
    front_facing: { type: "boolean" },
    face_covered: { type: "boolean" },
    sharp: { type: "boolean" },
    well_lit: { type: "boolean" },
    text_on_image: { type: "boolean" },
    species: { type: "string" },
    character_style: { type: "string", enum: ["2d", "3d", "none"] },
  },
  required: ["subject", "face_count", "front_facing", "face_covered", "sharp", "well_lit", "text_on_image", "species", "character_style"],
  additionalProperties: false,
} as const;

const CLASSIFY_PROMPT = [
  "Check this image for making a video-call avatar. Judge only the main subject.",
  "subject: person (a real photo of a human), animal (a real animal), character (drawn, painted, 3D, clay, toy or otherwise stylized), or none (no face at all).",
  "face_count: how many clearly visible faces (people, animals or characters) are in the image.",
  "front_facing: true if the main face looks roughly toward the camera with both eyes visible; false for a profile or strong side view.",
  "face_covered: true if a mask, hand, object, hair or heavy shadow hides the eyes, nose or mouth.",
  "sharp: false if the face is noticeably blurry or out of focus. well_lit: false if the face is too dark to see its features.",
  "text_on_image: true if there is a caption, watermark, sticker text or large printed text over the image.",
  "species: for an animal, its species in one or two plain words (e.g. dog, cat, rabbit); otherwise an empty string.",
  "character_style: for a character, 2d = flat drawn / anime / cartoon / illustration with line art; 3d = 3D render, clay, toy or CGI; if unsure, 3d. For a person or an animal: none.",
].join("\n");

export function buildClassifyRequest(imageDataUrl: string): SparkRequest & { schemaName: string; schema: Record<string, unknown> } {
  return {
    input: [{ role: "user", content: [{ type: "input_text", text: CLASSIFY_PROMPT }, { type: "input_image", image_url: imageDataUrl }] }],
    effort: "minimal",
    schemaName: "image_check",
    schema: CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
  };
}

export type ImageCheck = {
  type: CompanionKind | null;
  passed: boolean;
  /** the three V02 rows */
  checks: { oneFaceFrontFacing: boolean; sharpAndLit: boolean; noText: boolean };
  reasons: Array<{ code: FailReason; label: string }>;
  raw: ClassifyRaw;
};

const KIND: Record<ClassifyRaw["subject"], CompanionKind | null> = { person: "human", animal: "animal", character: "character", none: null };

/** Pure: Spark's raw answer → pass/fail with V02-F reasons, most actionable first. */
export function interpretCheck(raw: ClassifyRaw): ImageCheck {
  const type = KIND[raw.subject] ?? null;
  const reasons: FailReason[] = [];
  if (!type || raw.face_count < 1) reasons.push("no_face");
  else {
    if (raw.face_count > 1) reasons.push("multiple_faces");
    if (raw.face_covered) reasons.push("face_covered");
    if (!raw.front_facing) reasons.push("side_view");
  }
  if (!raw.sharp || !raw.well_lit) reasons.push("too_blurry");
  if (raw.text_on_image) reasons.push("text_on_image");
  const has = (r: FailReason) => reasons.includes(r);
  return {
    type,
    passed: reasons.length === 0,
    checks: {
      oneFaceFrontFacing: !(has("no_face") || has("multiple_faces") || has("face_covered") || has("side_view")),
      sharpAndLit: !has("too_blurry"),
      noText: !has("text_on_image"),
    },
    reasons: reasons.map((code) => ({ code, label: FAIL_REASONS[code] })),
    raw,
  };
}

export function headPrompt(kind: CompanionKind | null): string {
  if (kind === "animal") return "the animal's head";
  if (kind === "character") return "the character's head";
  return "the person's head";
}

/** Largest box wins (the main subject); null if SAM found nothing. */
export function pickHeadBox(boxes: SamBox[]): SamBox | null {
  let best: SamBox | null = null;
  for (const b of boxes) {
    const area = (b.x2 - b.x1) * (b.y2 - b.y1);
    if (!best || area > (best.x2 - best.x1) * (best.y2 - best.y1)) best = b;
  }
  return best;
}

/** Sniffs JPEG / PNG / HEIC / WebP from magic bytes; null = unsupported. */
export function sniffImage(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length > 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
