/**
 * Muse Image (generations / edits), SAM 3.1 boxes and /v1/files uploads.
 * Request helpers for Genita image generation, segmentation and file uploads.
 */
import { metaForm, metaJson } from "./http.ts";
import { parseSamBoxes, type SamBox } from "./sam.ts";
import { outputText } from "./spark.ts";

export const MUSE_IMAGE_MODEL = "muse-image-1.0";
export const SAM_MODEL = "sam-3.1";

type ImageResponse = { data: Array<{ b64_json?: string }> };

function firstImage(d: ImageResponse): Buffer {
  const b64 = d.data?.[0]?.b64_json;
  if (!b64) throw new Error("muse image: empty response");
  return Buffer.from(b64, "base64");
}

export async function museImageGenerate(key: string, prompt: string, size = "1024x1820", signal?: AbortSignal): Promise<Buffer> {
  return firstImage(
    await metaJson<ImageResponse>(key, "/images/generations", { model: MUSE_IMAGE_MODEL, prompt, size, response_format: "b64_json", n: 1 }, signal),
  );
}

/** image: PNG bytes (the 11/1 runs converted inputs to PNG first). */
export async function museImageEdit(
  key: string,
  image: Buffer,
  prompt: string,
  opts: { size?: string; mime?: string; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const form = new FormData();
  form.set("model", MUSE_IMAGE_MODEL);
  form.set("prompt", prompt);
  form.set("size", opts.size ?? "1024x1820");
  form.set("response_format", "b64_json");
  form.set("image", new Blob([new Uint8Array(image)], { type: opts.mime ?? "image/png" }), "image.png");
  return firstImage(await metaForm<ImageResponse>(key, "/images/edits", form, opts.signal));
}

/**
 * Boxes for `prompt` (e.g. "the dog's mouth") in a data-URL image. Each box
 * carries its raw mask token. `masks: true` asks for one_bit masks, many times
 * smaller on the wire than the lossless default (decode with meta/samMask.ts),
 * and for a confidence score on every match (SamBox.score).
 */
export async function samDetect(
  key: string,
  imageDataUrl: string,
  prompt: string,
  signal?: AbortSignal,
  opts: { masks?: boolean } = {},
): Promise<SamBox[]> {
  const d = await metaJson<{ id: string; output?: [] }>(
    key,
    "/responses",
    {
      model: SAM_MODEL,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }, { type: "input_image", image_url: imageDataUrl }] }],
      // metadata values are strings on this API ("true", not true)
      ...(opts.masks ? { metadata: { mask_encoding: "one_bit", include_confidence: "true" } } : {}),
    },
    signal,
  );
  return parseSamBoxes(outputText(d));
}

/** Upload for input_file (video clips etc.). Returns the file id. */
export async function uploadFile(key: string, bytes: Buffer, filename: string, mime: string, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.set("purpose", "user_data");
  form.set("file", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
  return (await metaForm<{ id: string }>(key, "/files", form, signal)).id;
}

export function jpegDataUrl(bytes: Buffer): string {
  return "data:image/jpeg;base64," + bytes.toString("base64");
}
