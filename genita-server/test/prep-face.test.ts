import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FACE_EXPRESSIONS,
  FACE_KEYS,
  VISEMES,
  driftCheck,
  faceEditPrompt,
  faceManifest,
  imageSize,
  makeFaceSet,
  samPrompt,
  type FaceKey,
} from "../src/prep/face.ts";
import { FACE, MOUTH, box, fakeMedia, fakePng } from "./helpers/fakeMedia.ts";

const keyOf = (kind: "human" | "animal" | "character") => (prompt: string) => {
  for (const k of FACE_KEYS) for (const strict of [false, true]) if (faceEditPrompt(k, kind, strict) === prompt) return strict ? `${k}!` : k;
  throw new Error(`unknown prompt: ${prompt.slice(0, 60)}`);
};
const scene = () => fakePng(1000, 2000, "scene");
const urlFor = (k: string) => `/v1/companion/face/${k}`;

test("face keys: blink/smile/warm + the ten visemes, rest is the scene", () => {
  assert.deepEqual([...FACE_EXPRESSIONS], ["blink", "smile", "warm"]);
  assert.deepEqual([...VISEMES], ["MBP", "FV", "TH", "L", "WQ", "O", "EI", "A", "U", "CDG"]);
  assert.equal(FACE_KEYS.length, 13);
});

test("face prompts: one scaffold, a distinct shape line per key, kind-aware wording, stricter retry", () => {
  for (const kind of ["human", "animal", "character"] as const) {
    const all = FACE_KEYS.map((k) => faceEditPrompt(k, kind, false));
    assert.equal(new Set(all).size, all.length, "each key has its own prompt");
    for (const k of FACE_KEYS) {
      const p = faceEditPrompt(k, kind, false);
      assert.match(p, /^Edit only the /);
      assert.match(p, /lighting, background, framing and camera exactly the same/);
      const strict = faceEditPrompt(k, kind, true);
      assert.ok(strict.startsWith(p) && strict.length > p.length, "strict = base + extra rule");
      assert.match(strict, /same position and size/);
    }
    for (const v of VISEMES) assert.match(faceEditPrompt(v, kind, false), /mouth/);
    assert.match(faceEditPrompt("blink", kind, false), /eyes/);
  }
  assert.match(faceEditPrompt("A", "human", false), /person/);
  assert.match(faceEditPrompt("A", "animal", false), /muzzle or beak/);
  assert.match(faceEditPrompt("A", "character", false), /art style/);
  // 11/2 probe: "mouth wide open … jaw dropped … tongue" trips Muse Image's content filter; speech framing passes
  for (const kind of ["human", "animal", "character"] as const) assert.doesNotMatch(faceEditPrompt("A", kind, false), /jaw dropped|wide open as in/);
  assert.equal(samPrompt("human", "face"), "the person's face");
  assert.equal(samPrompt("animal", "mouth"), "the animal's mouth");
  assert.equal(samPrompt("character", "mouth"), "the character's mouth");
});

test("imageSize reads PNG, WebP (VP8/VP8L/VP8X) and JPEG headers", () => {
  assert.deepEqual(imageSize(fakePng(1152, 2048, "x")), [1152, 2048]);
  const vp8x = Buffer.alloc(30);
  vp8x.write("RIFF", 0);
  vp8x.write("WEBP", 8);
  vp8x.write("VP8X", 12);
  vp8x.writeUIntLE(1152 - 1, 24, 3);
  vp8x.writeUIntLE(2048 - 1, 27, 3);
  assert.deepEqual(imageSize(vp8x), [1152, 2048]);
  const vp8 = Buffer.alloc(30);
  vp8.write("RIFF", 0);
  vp8.write("WEBP", 8);
  vp8.write("VP8 ", 12);
  Buffer.from([0x9d, 0x01, 0x2a]).copy(vp8, 23);
  vp8.writeUInt16LE(1024, 26);
  vp8.writeUInt16LE(1820, 28);
  assert.deepEqual(imageSize(vp8), [1024, 1820]);
  const vp8l = Buffer.alloc(30);
  vp8l.write("RIFF", 0);
  vp8l.write("WEBP", 8);
  vp8l.write("VP8L", 12);
  vp8l[20] = 0x2f;
  vp8l.writeUInt32LE(((1820 - 1) << 14) | (1024 - 1), 21);
  assert.deepEqual(imageSize(vp8l), [1024, 1820]);
  // JPEG: SOI, APP0 (len 4), SOF0 h=1820 w=1024
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x07, 0x1c, 0x04, 0x00, 0x03]);
  assert.deepEqual(imageSize(jpg), [1024, 1820]);
  assert.equal(imageSize(Buffer.from("nope")), null);
});

test("driftCheck: centre moved > 3% of width, size changed > 6%, or no mouth → reject", () => {
  const ref = { face: [0.3, 0.2, 0.7, 0.45] as const, mouth: [0.42, 0.38, 0.58, 0.41] as const };
  const size: [number, number] = [1000, 2000];
  assert.equal(driftCheck(ref, { face: [0.3, 0.2, 0.7, 0.45], mouth: [0.42, 0.38, 0.58, 0.41] }, size), null);
  assert.equal(driftCheck(ref, { face: [0.325, 0.2, 0.725, 0.45], mouth: [0.42, 0.38, 0.58, 0.41] }, size), null, "2.5% sideways is fine");
  assert.equal(driftCheck(ref, { face: [0.335, 0.2, 0.735, 0.45], mouth: [0.42, 0.38, 0.58, 0.41] }, size), "face_moved");
  // vertical move counts in pixels against the width: 0.02 of 2000 px = 40 px = 4% of 1000 px
  assert.equal(driftCheck(ref, { face: [0.3, 0.22, 0.7, 0.47], mouth: [0.42, 0.4, 0.58, 0.43] }, size), "face_moved");
  // an open jaw makes the face box ~8% taller: sqrt-area grows ~4%, centre drops 1% of height (2% of width) → kept
  assert.equal(driftCheck(ref, { face: [0.3, 0.2, 0.7, 0.47], mouth: [0.42, 0.38, 0.58, 0.44] }, size), null);
  assert.equal(driftCheck(ref, { face: [0.28, 0.19, 0.72, 0.465], mouth: [0.42, 0.38, 0.58, 0.41] }, size), "face_resized");
  assert.equal(driftCheck(ref, { face: [0.3, 0.2, 0.7, 0.45], mouth: null }, size), "no_mouth");
  assert.equal(driftCheck(ref, { face: null, mouth: [0.42, 0.38, 0.58, 0.41] }, size), "no_face");
});

test("makeFaceSet: 13 edits from the scene, SAM face+mouth on scene and every edit, normalised boxes, manifest shape", async () => {
  const { media, calls } = fakeMedia({ keyOf: keyOf("human") });
  const saved: string[] = [];
  const st = await makeFaceSet({ metaKey: "k", media, scene: scene(), kind: "human", size: "1024x1820", onItem: async (k, item, bytes) => void saved.push(`${k}:${item.status}:${bytes ? bytes.length > 0 : "-"}`) });
  assert.equal(calls.edits.length, 13);
  assert.ok(calls.edits.every((e) => !e.key.endsWith("!")), "no retries when nothing drifts");
  assert.equal(calls.sam.length, 2 * 14);
  assert.ok(calls.sam.some((s) => s.tag === "scene" && s.prompt === "the person's face"));
  assert.ok(calls.sam.some((s) => s.tag === "scene" && s.prompt === "the person's mouth"));
  assert.equal(saved.length, 13);
  assert.ok(saved.every((s) => s.endsWith(":done:true")));

  const m = faceManifest(st, urlFor);
  assert.equal(m.version, 1);
  assert.deepEqual(m.size, [1000, 2000]);
  assert.deepEqual(m.faceBox, [0.3, 0.2, 0.7, 0.45]);
  assert.deepEqual(m.mouthBox, [0.42, 0.38, 0.58, 0.41]);
  assert.deepEqual(Object.keys(m.images), ["neutral", "blink", "smile", "warm"]);
  assert.equal(m.images.neutral, "/v1/companion/face/neutral");
  assert.deepEqual(Object.keys(m.visemes), [...VISEMES]);
  assert.equal(m.visemes.MBP, "/v1/companion/face/MBP");
  assert.deepEqual(Object.keys(m.boxes).sort(), ["neutral", ...FACE_KEYS].sort());
  for (const b of Object.values(m.boxes)) for (const v of [...b.face, ...b.mouth]) assert.ok(v >= 0 && v <= 1);
  assert.deepEqual(m.rejected, []);
  assert.deepEqual(Object.keys(m.ms), ["total", "edits", "sam"]);
});

test("makeFaceSet: drift → one stricter retry; still drifting / no mouth → rejected and absent", async () => {
  const moved = box(380, 400, 780, 900); // centre +80 px = 8% of width
  const big = box(260, 340, 740, 960); // 20% larger
  const { media, calls } = fakeMedia({
    keyOf: keyOf("animal"),
    sam: (tag, part) => {
      if (tag === "TH#1" && part === "face") return [moved]; // retried, then fine
      if (/^A!?#/.test(tag) && part === "face") return [moved]; // both tries move
      if (/^O!?#/.test(tag) && part === "face") return [big];
      if (/^U!?#/.test(tag) && part === "mouth") return [];
      return [part === "face" ? FACE : MOUTH];
    },
  });
  const st = await makeFaceSet({ metaKey: "k", media, scene: scene(), kind: "animal", size: "1024x1820" });
  const retried = calls.edits.filter((e) => e.key.endsWith("!")).map((e) => e.key).sort();
  assert.deepEqual(retried, ["A!", "O!", "TH!", "U!"]);
  assert.ok(calls.edits.filter((e) => e.key === "TH!").every((e) => /same position and size/.test(e.prompt)));
  assert.ok(calls.sam.every((s) => s.prompt.startsWith("the animal's")));
  const m = faceManifest(st, urlFor);
  assert.ok(m.visemes.TH, "TH passed on the retry");
  assert.equal(m.visemes.A, undefined);
  assert.equal(m.visemes.O, undefined);
  assert.equal(m.visemes.U, undefined);
  assert.equal(m.boxes.A, undefined);
  assert.deepEqual(
    m.rejected.sort((a, b) => a.key.localeCompare(b.key)),
    [
      { key: "A", reason: "face_moved", retried: true },
      { key: "O", reason: "face_resized", retried: true },
      { key: "U", reason: "no_mouth", retried: true },
    ],
  );
});

test("makeFaceSet: an edit error is retried once, then rejected; all edits failing throws (runner retries)", async () => {
  const policy = new Error('meta 400: {"error":{"code":"content_policy_violation"}}');
  const one = fakeMedia({ keyOf: keyOf("human"), fail: (t) => (t.startsWith("EI") ? policy : null) });
  const st = await makeFaceSet({ metaKey: "k", media: one.media, scene: scene(), kind: "human", size: "1024x1820" });
  assert.equal(one.calls.edits.filter((e) => e.key.startsWith("EI")).length, 2);
  assert.deepEqual(faceManifest(st, urlFor).rejected, [{ key: "EI", reason: "content_policy", retried: true }]);

  const all = fakeMedia({ keyOf: keyOf("human"), fail: () => new Error("meta 503: down") });
  const saved: string[] = [];
  await assert.rejects(
    () => makeFaceSet({ metaKey: "k", media: all.media, scene: scene(), kind: "human", size: "1024x1820", onItem: async (k) => void saved.push(k) }),
    /face set: every edit failed/,
  );
  assert.deepEqual(saved, [], "upstream failures are not saved as rejections, so a rerun redoes them");
});

test("makeFaceSet: no face or mouth on the scene → face_not_found", async () => {
  const { media } = fakeMedia({ keyOf: keyOf("character"), sam: (tag, part) => (tag === "scene" && part === "mouth" ? [] : [part === "face" ? FACE : MOUTH]) });
  await assert.rejects(() => makeFaceSet({ metaKey: "k", media, scene: scene(), kind: "character", size: "1024x1820" }), /face_not_found/);
});

test("makeFaceSet: picks the mouth inside the face when SAM returns several", async () => {
  const far = box(10, 1700, 400, 1900); // bigger, outside the face
  const { media } = fakeMedia({ keyOf: keyOf("human"), sam: (_t, part) => (part === "face" ? [FACE] : [far, MOUTH]) });
  const st = await makeFaceSet({ metaKey: "k", media, scene: scene(), kind: "human", size: "1024x1820" });
  assert.deepEqual(faceManifest(st, urlFor).mouthBox, [0.42, 0.38, 0.58, 0.41]);
});

test("makeFaceSet: rejects an edit whose aspect ratio differs from the scene", async () => {
  const { media } = fakeMedia({ keyOf: keyOf("human"), size: [1000, 1000] });
  await assert.rejects(() => makeFaceSet({ metaKey: "k", media, scene: scene(), kind: "human", size: "1024x1820" }), /every edit failed|size_mismatch/);
});

test("makeFaceSet: at most 6 edits in flight; resume skips settled keys", async () => {
  const a = fakeMedia({ keyOf: keyOf("human"), delayMs: 15 });
  const first = await makeFaceSet({ metaKey: "k", media: a.media, scene: scene(), kind: "human", size: "1024x1820" });
  assert.equal(a.calls.maxInFlight, 6);

  // keep 5 settled items (one of them a rejection), drop the rest: a rerun edits only the 8 missing
  const keep = new Set<FaceKey>(["blink", "smile", "MBP", "FV", "TH"]);
  const prev = { ...first, items: Object.fromEntries(Object.entries(first.items).filter(([k]) => keep.has(k as FaceKey))) };
  prev.items.TH = { status: "rejected", reason: "face_moved", retried: true };
  const b = fakeMedia({ keyOf: keyOf("human") });
  const st = await makeFaceSet({ metaKey: "k", media: b.media, scene: scene(), kind: "human", size: "1024x1820", prev });
  assert.equal(b.calls.edits.length, 8);
  assert.ok(!b.calls.edits.some((e) => keep.has(e.key as FaceKey)));
  assert.ok(!b.calls.sam.some((s) => s.tag === "scene"), "scene boxes come from the saved state");
  assert.equal(Object.keys(st.items).length, 13);
  assert.equal(st.items.TH?.status, "rejected");
});
