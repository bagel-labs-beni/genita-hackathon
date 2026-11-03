import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { facePointsFromSam, outlineFromSam, facePrompt, EYES_PROMPT, MOUTH_PROMPT } from "../src/prep/faceGeometry.ts";
import { checkImage, type PrepDeps } from "../src/prep/pipeline.ts";
import { FileStore } from "../src/prep/store.ts";
import { DEFAULT_VOICES } from "../src/prep/voices.ts";
import { encodeOneBit } from "../src/meta/samMask.ts";
import type { SamBox } from "../src/meta/sam.ts";
import { fakePng } from "./helpers/fakeMedia.ts";

/** a SAM box in a w × h image, no mask */
const box = (x1: number, y1: number, x2: number, y2: number, w = 1000, h = 1000): SamBox =>
  ({ x1, y1, x2, y2, w, h, nx1: x1 / w, ny1: y1 / h, nx2: x2 / w, ny2: y2 / h });

function disc(x1: number, y1: number, x2: number, y2: number, w: number, h: number): SamBox {
  const mw = x2 - x1 + 1, mh = y2 - y1 + 1;
  const bits = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) bits[y * mw + x] = ((x - mw / 2) / (mw / 2)) ** 2 + ((y - mh / 2) / (mh / 2)) ** 2 < 1 ? 1 : 0;
  return { ...box(x1, y1, x2, y2, w, h), mask: { width: mw, height: mh, payload: encodeOneBit(bits, mw, mh) } };
}

test("face outline: SAM's face mask is traced into 32 points on its edge, starting at the top, clockwise", () => {
  const out = outlineFromSam([disc(10, 10, 20, 20, 100, 200), disc(30, 50, 70, 130, 100, 200)])!;
  assert.equal(out.length, 32);
  for (const [x, y] of out) {
    assert.ok(x >= 0.28 && x <= 0.73, `x ${x} inside the big box`);
    assert.ok(y >= 0.23 && y <= 0.675, `y ${y} inside the big box`);
  }
  assert.ok(Math.abs(out[0][0] - 0.505) < 0.03 && out[0][1] < 0.27, "first point = top of the face");
  assert.ok(out[8][0] > 0.68, "a quarter turn later = the right edge");
});

test("face outline: no mask, an empty mask or a bad token = null", () => {
  assert.equal(outlineFromSam([]), null);
  assert.equal(outlineFromSam([box(0, 0, 10, 10, 100, 100)]), null);
  assert.equal(outlineFromSam([{ ...disc(0, 0, 9, 9, 100, 100), mask: { width: 10, height: 10, payload: "!garbage" } }]), null);
});

test("face points: two eye boxes and a mouth box → almond eyes, arched brows, nose, lips (live clay / dog shape)", () => {
  // live SAM 11/4, c2-clay: eyes [0.338,0.41,0.444,0.439] [0.571,0.407,0.677,0.436], mouth [0.423,0.549,0.598,0.565]
  const p = facePointsFromSam([box(571, 407, 677, 436), box(338, 410, 444, 439)], [box(423, 549, 598, 565)], null)!;
  assert.ok(p);
  assert.equal(p.leftEye.length, 6);
  assert.ok(p.leftEye.every(([x]) => x < 0.5) && p.rightEye.every(([x]) => x > 0.5), "left/right as seen in the image");
  assert.deepEqual(p.leftEye[0], [0.338, 0.4245]);
  assert.ok(p.leftBrow.every(([, y]) => y < 0.41), "brows sit above the eyes");
  assert.equal(p.lips.length, 10);
  assert.ok(p.lips.every(([x, y]) => x >= 0.423 && x <= 0.598 && y >= 0.549 && y <= 0.566), "lips stay on the mouth box");
  assert.equal(p.nose.length, 5);
  assert.ok(p.nose.every(([, y]) => y > 0.42 && y < 0.549), "nose between the eyes and the mouth");
});

test("face points: one wide box over both eyes (live human) is split in two", () => {
  // live SAM 11/4, p1-front: eyes [0.356,0.375,0.674,0.399], mouth [0.422,0.498,0.586,0.526]
  const p = facePointsFromSam([box(356, 375, 674, 399)], [box(422, 498, 586, 526)], null)!;
  assert.ok(p);
  assert.ok(Math.max(...p.leftEye.map(([x]) => x)) < 0.5 && Math.min(...p.rightEye.map(([x]) => x)) > 0.5);
});

test("face points: no eyes, no mouth, a mouth above the eyes or features outside the face = null", () => {
  const eyes = [box(338, 410, 444, 439), box(571, 407, 677, 436)];
  const mouth = [box(423, 549, 598, 565)];
  assert.equal(facePointsFromSam([], mouth, null), null);
  assert.equal(facePointsFromSam(eyes, [], null), null);
  assert.equal(facePointsFromSam(eyes, [box(423, 200, 598, 230)], null), null);
  assert.equal(facePointsFromSam([box(338, 410, 444, 439)], mouth, null), null, "one small eye box is not two eyes");
  const elsewhere: [number, number][] = [[0.8, 0.8], [0.95, 0.8], [0.95, 0.95], [0.8, 0.95]];
  assert.equal(facePointsFromSam(eyes, mouth, elsewhere), null, "features outside the traced face are ignored");
  assert.equal(facePrompt("animal"), "the animal's face");
});

test("checkImage: a passed photo carries faceOutline (SAM face mask) and facePoints (SAM eyes + mouth); a failed one carries none", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genita-face-geo-"));
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); });
  const prompts: string[] = [];
  let passed = true;
  const face = disc(300, 500, 700, 1300, 1000, 2000);
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    let text: string;
    if (body.model === "sam-3.1") {
      const prompt = body.input[0].content[0].text as string;
      prompts.push(prompt);
      text = prompt === "the person's face"
        ? `<|box;x1=300;y1=500;x2=700;y2=1300;w=1000;h=2000|><|mask;data=${face.mask!.height},${face.mask!.width},${face.mask!.payload}|>`
        : prompt === EYES_PROMPT
          ? "<|box;x1=380;y1=780;x2=470;y2=820;w=1000;h=2000|><|box;x1=530;y1=780;x2=620;y2=820;w=1000;h=2000|>"
          : prompt === MOUTH_PROMPT
            ? "<|box;x1=420;y1=1080;x2=580;y2=1130;w=1000;h=2000|>"
            : "<|box;x1=250;y1=300;x2=750;y2=1400;w=1000;h=2000|>";
    } else {
      text = JSON.stringify({ subject: "person", face_count: 1, front_facing: true, face_covered: false, sharp: passed, well_lit: true, text_on_image: false, public_figure: false, any_public_figure: false, species: "", character_style: "none" });
    }
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });
  }) as typeof fetch;
  const d: PrepDeps = { metaKey: "k", store: new FileStore(dir), voices: DEFAULT_VOICES, log: () => {} };
  const rec = await checkImage(d, "u1", fakePng(1000, 2000, "face-geo"), true);
  assert.equal(rec.check.passed, true);
  assert.deepEqual(prompts.sort(), ["the eyes", "the mouth", "the person's face", "the person's head"]);
  assert.equal(rec.faceOutline?.length, 32);
  assert.equal(rec.facePoints?.leftEye.length, 6);
  assert.ok(rec.facePoints!.lips.every(([, y]) => y > 0.53 && y < 0.57));
  passed = false;
  const failed = await checkImage(d, "u1", fakePng(1000, 2000, "face-geo-2"), true);
  assert.equal(failed.check.passed, false);
  assert.equal(failed.faceOutline, null);
  assert.equal(failed.facePoints, null);
});
