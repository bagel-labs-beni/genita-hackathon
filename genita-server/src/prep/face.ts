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
 * speech ("in the middle of saying …"), and a refused edit is retried once with
 * a softer "caught mid-word saying …" prompt instead of the stricter one.
 */
import type { SamBox } from "../meta/sam.ts";
import type { CompanionKind } from "./prompts.ts";
import { profileMouthKeys, profilePrompt, type FlowProfile } from "./profiles.ts";

export const FACE_EXPRESSIONS = ["blink", "smile", "warm"] as const;
export const VISEMES = ["MBP", "FV", "TH", "L", "WQ", "O", "EI", "A", "U", "CDG"] as const;
/**
 * Conversational mouth keys for the device's optical-flow morph (11/3, "B"): a jaw ladder
 * (MID slightly parted -> AH -> AH2) plus a relaxed EH and OH. The ten visemes above are caricatures
 * of single sounds (A is yawn-sized, O is a pucker); speech mostly lives between neutral and these.
 */
export const MOUTH_KEYS = ["MID", "AH", "AH2", "EH", "OH"] as const;
export type FaceExpression = (typeof FACE_EXPRESSIONS)[number];
export type Viseme = (typeof VISEMES)[number];
/** Non-human profile keys (prep-py/profiles.json): animal J2/J3, cat C2, 2D anime SM/WD/OO/EE. */
export const PROFILE_KEYS = ["J2", "J3", "C2", "SM", "WD", "OO", "EE"] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];
export type MouthKey = (typeof MOUTH_KEYS)[number] | ProfileKey;
export type FaceKey = FaceExpression | Viseme | MouthKey;
/** The human face set (and the default when no profile is known). */
export const FACE_KEYS: readonly FaceKey[] = [...FACE_EXPRESSIONS, ...VISEMES, ...MOUTH_KEYS];
/** Every key any profile can make (route allow-list). */
export const ALL_FACE_KEYS: readonly FaceKey[] = [...FACE_KEYS, ...PROFILE_KEYS];

/**
 * Per-category mouth keys and prompt lines for the flow morph. Every kind gets the five keys today;
 * the non-human lane (dog / cat / 3D clay / 2D anime) replaces these entries as its sets settle.
 * A key left out of a kind's list is never generated for it (the device resolves it via map.fallback).
 */
export const MOUTH_KEYS_BY_KIND: Record<CompanionKind, readonly MouthKey[]> = { human: MOUTH_KEYS, animal: MOUTH_KEYS, character: MOUTH_KEYS };
const ALL_MOUTH = new Set<string>([...MOUTH_KEYS, ...PROFILE_KEYS]);
export const MOUTH_PROMPT_BY_KIND: Partial<Record<CompanionKind, Partial<Record<MouthKey, string>>>> = {};

/** Keys a face set of this kind (and mouth profile, when known) is made of: expressions + visemes + mouth keys. */
export function faceKeysFor(kind: CompanionKind, profile?: FlowProfile): readonly FaceKey[] {
  const fromProfile = profile ? profileMouthKeys(profile) : null;
  const mouth = new Set<string>(fromProfile ?? MOUTH_KEYS_BY_KIND[kind] ?? MOUTH_KEYS);
  return ALL_FACE_KEYS.filter((k) => !ALL_MOUTH.has(k) || mouth.has(k));
}
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
  /** optical-flow morph data (prep/faceflow.ts), file values are asset names; absent = patches only */
  flow?: FaceFlow | null;
  /** mouth profile and the keys this set is made of (absent on sets from before 11/3 = FACE_KEYS) */
  profile?: FlowProfile;
  keys?: FaceKey[];
};

/** `flow` block written by prep-py/faceflow.py (see that file for the binary format). */
export type FaceFlow = {
  version: 1;
  roi: [number, number, number, number];
  size: [number, number];
  flowSize: [number, number];
  keys: string[];
  /** nk/kn absent when the profile does not morph (character2d snaps between drawings) */
  files: Record<string, { key: string; nk?: string; kn?: string; lip?: string }>;
  mask: string;
  neutralRoi: string;
  lockY: number;
  lockSource: string;
  kind: string;
  map: Record<string, unknown>;
  ms?: number;
};

export type MediaApi = {
  imageEdit(key: string, image: Buffer, prompt: string, opts: { size?: string; mime?: string; signal?: AbortSignal }): Promise<Buffer>;
  samDetect(key: string, imageDataUrl: string, prompt: string, signal?: AbortSignal): Promise<SamBox[]>;
};

// ---------- prompts ----------

/** Same nouns as classify.headPrompt. */
const NOUN: Record<CompanionKind, string> = { human: "person", animal: "animal", character: "character" };

export function samPrompt(kind: CompanionKind, part: "face" | "mouth" | "nose"): string {
  return `the ${NOUN[kind]}'s ${part}`;
}

/**
 * SAM 3.1 sometimes finds nothing for "the person's mouth" on closed lips while
 * "the person's lips" and plain "mouth" hit (11/2 e2e). Tried in order, only on a miss.
 */
export function MOUTH_PROMPTS(kind: CompanionKind): string[] {
  return [samPrompt(kind, "mouth"), kind === "animal" ? "the animal's muzzle" : `the ${NOUN[kind]}'s lips`, "mouth"];
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

/** Conversational mouth keys: [human wording, wording for a muzzle, beak or drawn mouth]. Tested 11/3 on T9 / dog / clay = the v7 demo set (critic 7/10 vs Peter). Dark-interior rewrites were tried and lost (bigger openings, fewer visible teeth); see sweep s25–s31. */
const MOUTH: Record<(typeof MOUTH_KEYS)[number], [string, string]> = {
  MID: [
    "the person is talking on a video call, caught mid-word with the lips relaxed and slightly parted, the upper front teeth just visible, the jaw lowered very slightly, as in the middle of saying 'uh'",
    "caught mid-sound with the mouth just slightly open, a thin gap between the lips, the jaw lowered very slightly",
  ],
  AH: [
    "the person is talking on a video call, caught mid-word saying 'ah' in a normal conversational way, the mouth comfortably open about one finger wide, the jaw naturally lowered, upper teeth visible, lips relaxed",
    "caught mid-sound with the mouth open a little, the jaw gently lowered, relaxed",
  ],
  AH2: [
    "the person is talking on a video call, caught mid-word on an open 'ah' sound, the mouth open about two fingers wide, the jaw clearly lowered, upper and lower teeth visible, lips relaxed, natural speech",
    "caught mid-sound with the mouth moderately open, the jaw lowered, relaxed, natural",
  ],
  EH: [
    "the person is talking on a video call, caught mid-word saying 'eh' as in 'bed', lips parted with the teeth a little apart, mouth corners relaxed and not stretched",
    "caught mid-sound saying 'eh', the mouth a little open, the corners relaxed",
  ],
  OH: [
    "the person is talking on a video call, caught mid-word saying 'oh' in a relaxed conversational way, lips softly rounded but not pushed forward, the mouth open in a soft oval, the jaw slightly lowered",
    "caught mid-sound saying 'oh', the mouth softly rounded and a little open",
  ],
};
const isMouthKey = (k: FaceKey): k is MouthKey => ALL_MOUTH.has(k);
const isProfileKey = (k: FaceKey): k is ProfileKey => (PROFILE_KEYS as readonly string[]).includes(k);
/** Profile context for prompts: which non-human set, and the classified species for `{species}`. */
export type PromptCtx = { profile?: FlowProfile; species?: string };
const HOLD = "Do not move, resize, rotate or re-crop: the head stays at exactly the same position and size in the frame.";

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
  if (isMouthKey(key)) return { part: kind === "human" ? "mouth and jaw" : `${mouth} and jaw`, keep: "hair, eyes, eyebrows, nose" };
  return { part: mouth, keep: "hair, eyes" };
}

export function faceEditPrompt(key: FaceKey, kind: CompanionKind, strict: boolean, ctx: PromptCtx = {}): string {
  // non-human profiles bring whole prompts (tested by the non-human lane); strict adds the hold-still line
  const own = ctx.profile ? profilePrompt(ctx.profile, key === "blink" ? "BLINK" : key, ctx.species) : null;
  if (own) return strict ? `${own} ${HOLD}` : own;
  if (isProfileKey(key)) throw new Error(`face set: no prompt for ${key} in profile ${ctx.profile ?? "-"}`);
  const s = NOUN[kind];
  const { part, keep } = region(key, kind);
  const line =
    (isMouthKey(key) ? MOUTH_PROMPT_BY_KIND[kind]?.[key] : undefined) ??
    (key in SHAPE ? SHAPE[key as Viseme] : isMouthKey(key) ? MOUTH[key as (typeof MOUTH_KEYS)[number]] : EXPRESSION[key as FaceExpression])[kind === "human" ? 0 : 1];
  const style = kind === "character" ? " Keep the original art style." : kind === "animal" ? " Keep it a real animal." : "";
  const base = `Edit only the ${s}'s ${part}: ${line}. Keep the ${s}'s identity, face, ${keep}, lighting, background, framing and camera exactly the same.${style}`;
  // the mouth keys always carry the hold-still line (that is how they were tested), and never smile
  if (isMouthKey(key)) return `${base} Neutral relaxed expression, not smiling. Do not move, resize, rotate or re-crop: the head stays at exactly the same position and size in the frame.${strict ? " Everything above the upper lip stays identical." : ""}`;
  if (!strict) return base;
  return `${base} Do not move, resize, rotate, re-crop or redraw anything else: the head stays at exactly the same position and size in the frame, and everything outside the ${key === "blink" ? "eyes" : key in SHAPE ? "mouth" : "mouth and eyes"} stays identical.`;
}

/** The sound each viseme is caught on, for the soft prompt. */
const SOUND: Record<Viseme | (typeof MOUTH_KEYS)[number], string> = {
  MBP: "'mm'", FV: "'f'", TH: "'th'", L: "'l'", WQ: "'w'", O: "'oh'", EI: "'ee'", A: "'ah'", U: "'oo'", CDG: "'s'",
  MID: "'uh', lips just parted", AH: "'ah', mouth a little open", AH2: "an open 'ah'", EH: "'eh'", OH: "a relaxed 'oh'",
};

/**
 * Retry prompt after a content-policy refusal (11/2: the same shape line can
 * pass on one scene and be refused on the next). It describes a moment of
 * speech instead of a mouth shape: "caught mid-word saying 'ah'".
 */
export function faceSoftPrompt(key: FaceKey, kind: CompanionKind, ctx: PromptCtx = {}): string {
  // profile keys (and a profile's blink): the lane's own prompt again, same species; its wording is already
  // the filter-safe "talking / calm" one (codex P2: never swap a blink retry for a mouth prompt)
  if (isProfileKey(key) || (ctx.profile && key === "blink" && profilePrompt(ctx.profile, "BLINK", ctx.species))) {
    return faceEditPrompt(key, kind, false, ctx);
  }
  const s = NOUN[kind];
  const { part, keep } = region(key, kind);
  const style = kind === "character" ? " Keep the original art style." : kind === "animal" ? " Keep it a real animal." : "";
  const moment = key in SOUND ? `the ${s} is talking on a video call, caught mid-word saying ${SOUND[key as Viseme]}` : `the ${s} on a video call with ${EXPRESSION[key as FaceExpression][kind === "human" ? 0 : 1]}`;
  return `Photo edit of the same video call frame: ${moment}. Change only the ${part}. Keep the ${s}'s identity, face, ${keep}, lighting, background, framing and camera exactly the same.${style}`;
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
  /** mouth profile (from the image check) and species for the profile prompts */
  profile?: FlowProfile;
  species?: string;
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
    const [primary, ...fallback] = MOUTH_PROMPTS(o.kind);
    let [faces, mouths] = await Promise.all([
      o.media.samDetect(o.metaKey, url, samPrompt(o.kind, "face"), o.signal),
      o.media.samDetect(o.metaKey, url, primary, o.signal),
    ]);
    for (const p of fallback) {
      if (mouths.length) break;
      mouths = await o.media.samDetect(o.metaKey, url, p, o.signal);
    }
    ms.sam += Math.round(performance.now() - t);
    return { size, ...pickBoxes(faces.map((b) => normBox(b, size)), mouths.map((b) => normBox(b, size))) };
  };

  let state: FaceState;
  // a saved set that kept nothing (all rejected) is redone from scratch, or a retry would skip every key
  const kept = !!o.prev && Object.values(o.prev.items).some((i) => i?.status === "done");
  if (o.prev?.ref) state = { ...o.prev, items: kept ? { ...o.prev.items } : {}, ms: { ...o.prev.ms } };
  else {
    const r = await sam(o.scene);
    if (!r.face || !r.mouth) throw new Error(`face set: face_not_found on the scene (${r.face ? "no mouth" : "no face"})`);
    state = { size: r.size, ref: { face: r.face, mouth: r.mouth }, items: {}, ms: { total: 0, edits: 0, sam: 0 } };
    // the plan is saved with the first state, so progress counts the right total from the start (codex P3)
    if (o.profile) {
      state.profile = o.profile;
      state.keys = [...faceKeysFor(o.kind, o.profile)];
    }
    await o.onRef?.(state);
  }
  const ref = state.ref;
  const aspect = state.size[0] / state.size[1];

  const attempt = async (key: FaceKey, prompt: string): Promise<{ bytes: Buffer; box: FaceBoxes } | FaceReject> => {
    const t = performance.now();
    let out: Buffer;
    try {
      out = await o.media.imageEdit(o.metaKey, o.scene, prompt, { size: o.size, mime: mimeOf(o.scene), signal: o.signal });
    } catch (err) {
      if (o.signal?.aborted) throw err;
      throw new EditError(/content_policy/.test(String(err)) ? "content_policy" : "edit_failed", err);
    } finally {
      ms.edits += Math.round(performance.now() - t);
    }
    let r: Awaited<ReturnType<typeof sam>>;
    try {
      r = await sam(out);
    } catch (err) {
      if (o.signal?.aborted) throw err;
      throw new EditError("edit_failed", err);
    }
    if (Math.abs(r.size[0] / r.size[1] - aspect) > 0.01) return "size_mismatch";
    const bad = driftCheck(ref, r, state.size);
    return bad ?? { bytes: out, box: { face: r.face!, mouth: r.mouth! } };
  };

  const upstream: Array<[FaceKey, FaceItem]> = [];
  const one = async (key: FaceKey) => {
    const t = performance.now();
    let last: FaceReject | null = null;
    for (const retry of [false, true]) {
      // first try: the shape prompt; retry: stricter after drift, speech framing after a content-policy refusal
      const ctx = { profile: o.profile, species: o.species };
      const prompt = !retry ? faceEditPrompt(key, o.kind, false, ctx) : last === "content_policy" ? faceSoftPrompt(key, o.kind, ctx) : faceEditPrompt(key, o.kind, true, ctx);
      try {
        const r = await attempt(key, prompt);
        if (typeof r !== "string") {
          const item: FaceItem = { status: "done", box: r.box, retried: retry, ms: Math.round(performance.now() - t) };
          await o.onItem?.(key, item, r.bytes);
          state.items[key] = item;
          return;
        }
        last = r;
      } catch (err) {
        if (!(err instanceof EditError)) throw err;
        last = err.reason;
      }
      o.log?.("face.edit_rejected", { key, reason: last, retry });
    }
    const item: FaceItem = { status: "rejected", reason: last ?? "edit_failed", retried: true };
    if (last === "edit_failed") return void upstream.push([key, item]); // saved only if the set is usable, else redone on the next attempt
    await o.onItem?.(key, item, null);
    state.items[key] = item;
  };

  const plan = faceKeysFor(o.kind, o.profile);
  if (o.profile) {
    state.profile = o.profile;
    state.keys = [...plan];
  }
  const todo = plan.filter((k) => !state.items[k]);
  let next = 0;
  let failure: { err: unknown } | null = null;
  const lanes = Math.min(o.concurrency ?? FACE_CONCURRENCY, todo.length);
  // every lane stops taking keys after a failure or an abort, and the call settles only when all have
  // stopped, so nothing is saved after it returns or throws (the runner may already be on its next attempt)
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (next < todo.length && !failure && !o.signal?.aborted) {
      try {
        await one(todo[next++]);
      } catch (err) {
        failure ??= { err };
      }
    }
  }));
  if (failure) throw (failure as { err: unknown }).err;
  if (o.signal?.aborted) throw o.signal.reason ?? new Error("face set: aborted");

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
  /** conversational mouth keys (MID AH AH2 EH OH), full-frame images like the visemes */
  mouthKeys: Partial<Record<MouthKey, string>>;
  /** optical-flow morph data for the device, file values are URLs; null = draw with the viseme patches */
  flow: FaceFlow | null;
  boxes: Record<string, FaceBoxes>;
  rejected: Array<{ key: FaceKey; reason: FaceReject; retried: boolean }>;
  ms: { total: number; edits: number; sam: number };
};

export function faceManifest(s: FaceState, urlFor: (key: "neutral" | FaceKey) => string, flowUrl: (asset: string) => string = (a) => a): FaceManifest {
  const images: FaceManifest["images"] = { neutral: urlFor("neutral") };
  const visemes: FaceManifest["visemes"] = {};
  const mouthKeys: FaceManifest["mouthKeys"] = {};
  const boxes: Record<string, FaceBoxes> = { neutral: s.ref };
  const rejected: FaceManifest["rejected"] = [];
  for (const k of s.keys ?? FACE_KEYS) {
    const it = s.items[k];
    if (!it) continue;
    if (it.status === "rejected") {
      rejected.push({ key: k, reason: it.reason, retried: it.retried });
      continue;
    }
    if ((VISEMES as readonly string[]).includes(k)) visemes[k as Viseme] = urlFor(k);
    else if (isMouthKey(k)) mouthKeys[k] = urlFor(k);
    else images[k as FaceExpression] = urlFor(k);
    boxes[k] = it.box;
  }
  const flow = s.flow
    ? {
        ...s.flow,
        files: Object.fromEntries(
          Object.entries(s.flow.files).map(([k, f]) => [k, { key: flowUrl(f.key), ...(f.nk ? { nk: flowUrl(f.nk) } : {}), ...(f.kn ? { kn: flowUrl(f.kn) } : {}), ...(f.lip ? { lip: flowUrl(f.lip) } : {}) }]),
        ),
        mask: flowUrl(s.flow.mask),
        neutralRoi: flowUrl(s.flow.neutralRoi),
      }
    : null;
  return { version: 1, size: s.size, faceBox: s.ref.face, mouthBox: s.ref.mouth, images, visemes, mouthKeys, flow, boxes, rejected, ms: s.ms };
}
