/**
 * Prep step `face` (Meta-only face set, team/metaface spec "Face set").
 *
 * From the call scene, Muse Image edits make three expressions (blink, smile,
 * warm) and ten viseme images (MBP FV TH L WQ O EI A U CDG); `rest` and
 * `neutral` are the scene itself. Every edit starts from the scene, never from
 * another edit, so drift does not stack.
 *
 * SAM 3.1 boxes the face and the mouth on the scene and on every edit. An edit
 * is rejected when the face box centre moved more than 3% of the image width,
 * its linear size (square root of the area) changed more than 6%, or SAM finds
 * no mouth. A rejected edit gets one retry with a stricter prompt; after that
 * it is listed in `rejected` and left out (the device falls back to the
 * nearest shape). Pixel work (crop, registration, colour match) is on the
 * device.
 *
 * Muse Image has no mask input (11/2 probe: `mask` → 400 unsupported_parameter),
 * so the prompt alone keeps the edit local. It also refused "mouth wide open …
 * jaw dropped … tongue" as a content-policy hit, so the viseme lines describe
 * speech ("in the middle of saying …").
 */
import type { SamBox } from "../meta/sam.ts";
import type { CompanionKind } from "./prompts.ts";

export const FACE_EXPRESSIONS = ["blink", "smile", "warm"] as const;
export const VISEMES = ["MBP", "FV", "TH", "L", "WQ", "O", "EI", "A", "U", "CDG"] as const;
export type FaceExpression = (typeof FACE_EXPRESSIONS)[number];
export type Viseme = (typeof VISEMES)[number];
export type FaceKey = FaceExpression | Viseme;
export const FACE_KEYS: readonly FaceKey[] = [...FACE_EXPRESSIONS, ...VISEMES];
export const FACE_CONCURRENCY = 6;

/** Normalised box [x1, y1, x2, y2], 0–1 of the image's own size. */
export type NBox = readonly [number, number, number, number];
export type FaceBoxes = { face: NBox; mouth: NBox };

export type FaceItem =
  | { status: "done"; box: FaceBoxes; retried: boolean; ms: number }
  | { status: "rejected"; reason: FaceReject; retried: boolean };

export type FaceReject = "face_moved" | "face_resized" | "no_face" | "no_mouth" | "size_mismatch" | "content_policy" | "edit_failed";

/** Saved in the prep step, so a restart redoes only the keys not in `items`. */
export type FaceState = {
  size: [number, number];
  ref: FaceBoxes;
  items: Partial<Record<FaceKey, FaceItem>>;
  ms: { total: number; edits: number; sam: number };
};

export type MediaApi = {
  imageEdit(key: string, image: Buffer, prompt: string, opts: { size?: string; mime?: string; signal?: AbortSignal }): Promise<Buffer>;
  samDetect(key: string, imageDataUrl: string, prompt: string, signal?: AbortSignal): Promise<SamBox[]>;
};

// ---------- prompts ----------

/** Same nouns as classify.headPrompt. */
const NOUN: Record<CompanionKind, string> = { human: "person", animal: "animal", character: "character" };

export function samPrompt(kind: CompanionKind, part: "face" | "mouth"): string {
  return `the ${NOUN[kind]}'s ${part}`;
}

/** Mouth shape per viseme: [human lips wording, wording for a muzzle, beak or drawn mouth]. */
const SHAPE: Record<Viseme, [string, string]> = {
  MBP: ["lips closed and pressed lightly together, as in the middle of saying 'm' in 'mom'", "mouth fully closed, lips together, as if humming 'mm'"],
  FV: ["upper front teeth resting lightly on the lower lip, as in the middle of saying 'f' in 'five'", "mouth barely open, a thin gap with the upper teeth just touching the lower lip, as if saying 'f'"],
  TH: ["lips slightly parted with the tip of the tongue just visible between the front teeth, as in the middle of saying 'th' in 'think'", "mouth slightly open with the tongue tip just showing at the front, as if saying 'th'"],
  L: ["mouth a little open with the tongue tip raised behind the upper front teeth, as in the middle of saying 'l' in 'hello'", "mouth a little open with the tongue tip raised at the front, as if saying 'l'"],
  WQ: ["lips rounded and pushed forward into a small tight circle, as in the middle of saying 'w' in 'we'", "mouth pursed small and rounded, as if saying 'w'"],
  O: ["lips rounded into an open oval, as in the middle of saying 'oh'", "mouth open in a rounded oval, as if saying 'oh'"],
  EI: ["lips spread wide with the teeth slightly apart, as in the middle of saying 'ee' in 'see'", "mouth slightly open and stretched wide sideways, as if saying 'ee'"],
  A: ["mouth open wide, as in the middle of saying 'ah' in 'father'", "mouth open wide, as if mid-word saying 'ah'"],
  U: ["lips softly rounded and a little open, as in the middle of saying 'oo' in 'food'", "mouth a little open and softly rounded, as if saying 'oo'"],
  CDG: ["teeth nearly together and lips slightly parted and relaxed, as in the middle of saying 's' or 'k'", "mouth barely open with the teeth nearly together, as if saying 's'"],
};

const EXPRESSION: Record<FaceExpression, [string, string]> = {
  blink: ["both eyes fully closed in a natural relaxed blink", "both eyes fully closed in a natural relaxed blink"],
  smile: ["a happy, natural smile with smiling eyes, as if just amused", "a happy, content look with relaxed, smiling eyes"],
  warm: ["a soft, tender look: a faint gentle closed-lip smile and warm eyes", "a soft, tender look with gentle, warm eyes"],
};

/** What the edit may change, and what else it must keep. */
function region(key: FaceKey, kind: CompanionKind): { part: string; keep: string } {
  const mouth = kind === "animal" ? "mouth (its muzzle or beak)" : kind === "character" ? "mouth, drawn in the character's own art style" : "mouth";
  if (key === "blink") return { part: "eyes", keep: "hair, mouth" };
  if (key === "smile" || key === "warm") return { part: "facial expression (mouth and eyes)", keep: "hair" };
  return { part: mouth, keep: "hair, eyes" };
}

export function faceEditPrompt(key: FaceKey, kind: CompanionKind, strict: boolean): string {
  const s = NOUN[kind];
  const { part, keep } = region(key, kind);
  const line = (key in SHAPE ? SHAPE[key as Viseme] : EXPRESSION[key as FaceExpression])[kind === "human" ? 0 : 1];
  const style = kind === "character" ? " Keep the original art style." : kind === "animal" ? " Keep it a real animal." : "";
  const base = `Edit only the ${s}'s ${part}: ${line}. Keep the ${s}'s identity, face, ${keep}, lighting, background, framing and camera exactly the same.${style}`;
  if (!strict) return base;
  return `${base} Do not move, resize, rotate, re-crop or redraw anything else: the head stays at exactly the same position and size in the frame, and everything outside the ${key === "blink" ? "eyes" : key in SHAPE ? "mouth" : "mouth and eyes"} stays identical.`;
}

// ---------- pure helpers ----------

/** [width, height] from PNG / WebP / JPEG headers; null if unknown. */
export function imageSize(b: Buffer): [number, number] | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const fourcc = b.toString("latin1", 12, 16);
    if (fourcc === "VP8X") return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
    if (fourcc === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    if (fourcc === "VP8L") {
      const v = b.readUInt32LE(21);
      return [(v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1];
    }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + len;
    }
  }
  return null;
}

const r4 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000;

export function normBox(b: SamBox, size: [number, number]): NBox {
  const w = b.w ?? size[0];
  const h = b.h ?? size[1];
  return [r4(b.x1 / w), r4(b.y1 / h), r4(b.x2 / w), r4(b.y2 / h)];
}

const area = (b: NBox) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const centre = (b: NBox) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

/** Largest face; the largest mouth whose centre is inside that face (else the largest mouth). */
export function pickBoxes(faces: NBox[], mouths: NBox[]): { face: NBox | null; mouth: NBox | null } {
  const big = (xs: NBox[]) => xs.reduce<NBox | null>((a, x) => (!a || area(x) > area(a) ? x : a), null);
  const face = big(faces);
  const inside = face ? mouths.filter((m) => {
    const [cx, cy] = centre(m);
    return cx >= face[0] && cx <= face[2] && cy >= face[1] && cy <= face[3];
  }) : [];
  return { face, mouth: big(inside.length ? inside : mouths) };
}

export const MAX_CENTRE_SHIFT = 0.03;
export const MAX_SIZE_CHANGE = 0.06;

/** null = keep. Distances in scene pixels, measured against the scene width. */
export function driftCheck(ref: { face: NBox; mouth: NBox }, got: { face: NBox | null; mouth: NBox | null }, size: [number, number]): FaceReject | null {
  if (!got.face) return "no_face";
  if (!got.mouth) return "no_mouth";
  const [ax, ay] = centre(ref.face);
  const [bx, by] = centre(got.face);
  const shift = Math.hypot((bx - ax) * size[0], (by - ay) * size[1]) / size[0];
  if (shift > MAX_CENTRE_SHIFT + 1e-9) return "face_moved";
  const scale = Math.sqrt(area(got.face) / Math.max(area(ref.face), 1e-9));
  if (Math.abs(scale - 1) > MAX_SIZE_CHANGE + 1e-9) return "face_resized";
  return null;
}

// ---------- the step ----------

export type FaceSetInput = {
  metaKey: string;
  media: MediaApi;
  /** the call scene (neutral / rest) */
  scene: Buffer;
  kind: CompanionKind;
  /** Muse Image `size`, the same one the scene was made with */
  size: string;
  /** saved state of an interrupted run */
  prev?: FaceState | null;
  /** persist one settled key (bytes for a kept edit) before it counts */
  onItem?: (key: FaceKey, item: FaceItem, bytes: Buffer | null) => Promise<void>;
  /** the scene's own boxes, once known (saved so a resume skips them) */
  onRef?: (state: FaceState) => Promise<void>;
  concurrency?: number;
  signal?: AbortSignal;
  log?: (event: string, data: Record<string, unknown>) => void;
};

const mimeOf = (b: Buffer) => (b.readUInt32BE(0) === 0x89504e47 ? "image/png" : b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : "image/webp");
const dataUrl = (b: Buffer) => `data:${mimeOf(b)};base64,${b.toString("base64")}`;

class EditError extends Error {
  readonly reason: FaceReject;
  constructor(reason: FaceReject, cause: unknown) {
    super(`${reason}: ${String(cause).slice(0, 200)}`);
    this.reason = reason;
  }
}

export async function makeFaceSet(o: FaceSetInput): Promise<FaceState> {
  const t0 = performance.now();
  const ms = { edits: 0, sam: 0 };
  const sam = async (img: Buffer) => {
    const t = performance.now();
    const url = dataUrl(img);
    const size = imageSize(img);
    if (!size) throw new Error("face set: unreadable image");
    const [faces, mouths] = await Promise.all([
      o.media.samDetect(o.metaKey, url, samPrompt(o.kind, "face"), o.signal),
      o.media.samDetect(o.metaKey, url, samPrompt(o.kind, "mouth"), o.signal),
    ]);
    ms.sam += Math.round(performance.now() - t);
    return { size, ...pickBoxes(faces.map((b) => normBox(b, size)), mouths.map((b) => normBox(b, size))) };
  };

  let state: FaceState;
  if (o.prev?.ref) state = { ...o.prev, items: { ...o.prev.items }, ms: { ...o.prev.ms } };
  else {
    const r = await sam(o.scene);
    if (!r.face || !r.mouth) throw new Error(`face set: face_not_found on the scene (${r.face ? "no mouth" : "no face"})`);
    state = { size: r.size, ref: { face: r.face, mouth: r.mouth }, items: {}, ms: { total: 0, edits: 0, sam: 0 } };
    await o.onRef?.(state);
  }
  const ref = state.ref;
  const aspect = state.size[0] / state.size[1];

  const attempt = async (key: FaceKey, strict: boolean): Promise<{ bytes: Buffer; box: FaceBoxes } | FaceReject> => {
    const t = performance.now();
    let out: Buffer;
    try {
      out = await o.media.imageEdit(o.metaKey, o.scene, faceEditPrompt(key, o.kind, strict), { size: o.size, mime: mimeOf(o.scene), signal: o.signal });
    } catch (err) {
      if (o.signal?.aborted) throw err;
      throw new EditError(/content_policy/.test(String(err)) ? "content_policy" : "edit_failed", err);
    } finally {
      ms.edits += Math.round(performance.now() - t);
    }
    const r = await sam(out);
    if (Math.abs(r.size[0] / r.size[1] - aspect) > 0.01) return "size_mismatch";
    const bad = driftCheck(ref, r, state.size);
    return bad ?? { bytes: out, box: { face: r.face!, mouth: r.mouth! } };
  };

  const upstream: Array<[FaceKey, FaceItem]> = [];
  const one = async (key: FaceKey) => {
    const t = performance.now();
    let last: FaceReject = "edit_failed";
    for (const strict of [false, true]) {
      try {
        const r = await attempt(key, strict);
        if (typeof r !== "string") {
          const item: FaceItem = { status: "done", box: r.box, retried: strict, ms: Math.round(performance.now() - t) };
          await o.onItem?.(key, item, r.bytes);
          state.items[key] = item;
          return;
        }
        last = r;
      } catch (err) {
        if (!(err instanceof EditError)) throw err;
        last = err.reason;
      }
      o.log?.("face.edit_rejected", { key, reason: last, strict });
    }
    const item: FaceItem = { status: "rejected", reason: last, retried: true };
    if (last === "edit_failed") return void upstream.push([key, item]); // saved only if the set is usable, else redone on the next attempt
    await o.onItem?.(key, item, null);
    state.items[key] = item;
  };

  const todo = FACE_KEYS.filter((k) => !state.items[k]);
  let next = 0;
  const lanes = Math.min(o.concurrency ?? FACE_CONCURRENCY, todo.length);
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (next < todo.length) await one(todo[next++]);
  }));

  const total = Math.round(performance.now() - t0);
  state.ms = { total: state.ms.total + total, edits: state.ms.edits + ms.edits, sam: state.ms.sam + ms.sam };
  if (!Object.values(state.items).some((i) => i?.status === "done")) throw new Error(`face set: every edit failed (${[...upstream.map(([k]) => k), ...Object.keys(state.items)].join(",")})`);
  for (const [k, item] of upstream) {
    await o.onItem?.(k, item, null);
    state.items[k] = item;
  }
  return state;
}

// ---------- manifest (GET /v1/companion/prep → face) ----------

export type FaceManifest = {
  version: 1;
  size: [number, number];
  faceBox: NBox;
  mouthBox: NBox;
  images: Partial<Record<"neutral" | FaceExpression, string>>;
  visemes: Partial<Record<Viseme, string>>;
  boxes: Record<string, FaceBoxes>;
  rejected: Array<{ key: FaceKey; reason: FaceReject; retried: boolean }>;
  ms: { total: number; edits: number; sam: number };
};

export function faceManifest(s: FaceState, urlFor: (key: "neutral" | FaceKey) => string): FaceManifest {
  const images: FaceManifest["images"] = { neutral: urlFor("neutral") };
  const visemes: FaceManifest["visemes"] = {};
  const boxes: Record<string, FaceBoxes> = { neutral: s.ref };
  const rejected: FaceManifest["rejected"] = [];
  for (const k of FACE_KEYS) {
    const it = s.items[k];
    if (!it) continue;
    if (it.status === "rejected") {
      rejected.push({ key: k, reason: it.reason, retried: it.retried });
      continue;
    }
    if ((VISEMES as readonly string[]).includes(k)) visemes[k as Viseme] = urlFor(k);
    else images[k as FaceExpression] = urlFor(k);
    boxes[k] = it.box;
  }
  return { version: 1, size: s.size, faceBox: s.ref.face, mouthBox: s.ref.mouth, images, visemes, boxes, rejected, ms: s.ms };
}
