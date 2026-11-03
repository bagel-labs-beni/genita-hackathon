import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { FileStore, type CompanionRecord } from "../src/prep/store.ts";
import { newPrepState } from "../src/prep/runner.ts";
import type { PrepDeps } from "../src/prep/pipeline.ts";
import type { FaceFlow, FaceState } from "../src/prep/face.ts";
import { encodeOneBit } from "../src/meta/samMask.ts";
import type { SamBox } from "../src/meta/sam.ts";
import { needsReflow, reflowFace } from "../src/prep/reflow.ts";

const require = createRequire(import.meta.url);
const W = 256, H = 456;
const box = { face: [0.2, 0.25, 0.8, 0.62] as [number, number, number, number], mouth: [0.42, 0.5, 0.58, 0.53] as [number, number, number, number] };

function pngOf(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const { deflateSync } = require("node:zlib") as typeof import("node:zlib");
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function pythonWithCv2(): string | null {
  for (const p of [process.env.GENITA_PYFLOW, "python3"].filter(Boolean) as string[]) {
    const r = spawnSync(p, ["-c", "import cv2, numpy"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

const oldFlow = { version: 1, roi: [0.1, 0.4, 0.9, 0.9], size: [10, 10], flowSize: [5, 5], keys: ["MID", "AH"], files: {}, mask: "flow_mask", neutralRoi: "flow_neutral", lockY: 0.48, lockSource: "x", kind: "human", map: {} } as unknown as FaceFlow;

function companion(flow: FaceFlow | null, status: "done" | "running" = "done"): CompanionRecord {
  const prep = newPrepState();
  const face: FaceState = { size: [W, H], ref: { face: box.face, mouth: box.mouth }, items: { MID: { status: "done", box: { face: box.face, mouth: box.mouth } }, AH: { status: "done", box: { face: box.face, mouth: box.mouth } } }, ms: { total: 0, edits: 0, sam: 0 }, flow } as unknown as FaceState;
  prep.steps.face = { status, attempts: 1, face };
  return { id: "c1", userId: "u1", imageId: "img1", type: "human", voiceId: "v", name: "Mira", createdAt: new Date().toISOString(), prep };
}

test("needsReflow: only ready faces whose flow predates the silhouette mask", () => {
  assert.equal(needsReflow(companion(oldFlow)), true);
  assert.equal(needsReflow(companion({ ...oldFlow, maskVersion: 2 })), false);
  assert.equal(needsReflow(companion(null)), false);
  assert.equal(needsReflow(companion(oldFlow, "running")), false);
});

test("reflowFace: rebuilds the flow with the SAM face silhouette and swaps it in; without a silhouette the old flow stays", { skip: pythonWithCv2() ? false : "no python with OpenCV here" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "prep-reflow-"));
  try {
    const tex = (x: number, y: number): [number, number, number] => [150 + ((x * 7 + y * 3) % 40), 120 + ((x * 3 + y * 5) % 30), 110 + ((x + y) % 25)];
    const mouthY = 0.515 * H, mouthX = W / 2;
    const neutral = pngOf(W, H, (x, y) => (Math.abs(y - mouthY) < 1.5 && Math.abs(x - mouthX) < 18 ? [90, 40, 40] : tex(x, y)));
    const ah = pngOf(W, H, (x, y) => (((x - mouthX) / 18) ** 2 + ((y - mouthY) / 7) ** 2 < 1 ? [40, 15, 15] : tex(x, y)));
    const store = new FileStore(dir);
    await store.putCompanion(companion(oldFlow));
    await store.putAsset("u1", "c1", "neutral", neutral);
    await store.putAsset("u1", "c1", "MID", neutral);
    await store.putAsset("u1", "c1", "AH", ah);
    // SAM "the person's face": a disc over the face box (one_bit mask in SAM's own pixel space = the still)
    const fx1 = Math.round(0.25 * W), fy1 = Math.round(0.2 * H), fx2 = Math.round(0.75 * W), fy2 = Math.round(0.58 * H);
    const mw = fx2 - fx1 + 1, mh = fy2 - fy1 + 1, bits = new Uint8Array(mw * mh);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) bits[y * mw + x] = ((x - mw / 2) / (mw / 2)) ** 2 + ((y - mh / 2) / (mh / 2)) ** 2 < 1 ? 1 : 0;
    const faceBox: SamBox = { x1: fx1, y1: fy1, x2: fx2, y2: fy2, w: W, h: H, nx1: fx1 / W, ny1: fy1 / H, nx2: fx2 / W, ny2: fy2 / H, mask: { width: mw, height: mh, payload: encodeOneBit(bits, mw, mh) } };
    let withMask = true;
    const prompts: string[] = [];
    const media = {
      imageEdit: async () => Buffer.alloc(0),
      samDetect: async (_k: string, _u: string, prompt: string, _s?: AbortSignal, o?: { masks?: boolean }) => {
        prompts.push(prompt);
        return o?.masks && withMask ? [faceBox] : [];
      },
    };
    const d = { metaKey: "k", store, voices: [], log: () => {}, media, python: pythonWithCv2() } as unknown as PrepDeps;
    const r = await reflowFace(d, (await store.getCompanion("u1"))!);
    assert.equal(r.status, "done", JSON.stringify(r));
    const flow = (await store.getCompanion("u1"))!.prep.steps.face!.face!.flow!;
    assert.equal(flow.maskVersion, 2);
    assert.equal(flow.silhouette, true);
    // codex P1: a new asset generation (the old manifest never points at half-written files; apps refetch new URLs)
    assert.equal(flow.mask, "flow_mask_g2");
    assert.ok(await store.getAsset("u1", "c1", "flow_mask_g2"), "new generation stored");
    assert.ok(Object.values(flow.files).every((f) => f.key.endsWith("_g2")));
    assert.ok(flow.roi[3] <= fy2 / H + 0.03, `ROI ends at the face outline (${flow.roi[3]})`);
    assert.ok(prompts.includes("the person's face"));
    assert.equal(needsReflow((await store.getCompanion("u1"))!), false, "a second run skips it");
    // SAM down: nothing swapped, the old flow stays
    await store.putCompanion(companion(oldFlow));
    withMask = false;
    const r2 = await reflowFace(d, (await store.getCompanion("u1"))!);
    assert.equal(r2.status, "failed");
    assert.deepEqual((await store.getCompanion("u1"))!.prep.steps.face!.face!.flow, oldFlow);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner.reflowMask: starts once in the background for an old-mask face, logs face.reflow, keeps the old flow on failure; off by env / up-to-date (ops pause shares the global pause switch)", async () => {
  const { PrepRunner } = await import("../src/prep/runner.ts");
  const dir = mkdtempSync(join(tmpdir(), "prep-reflow-run-"));
  try {
    const store = new FileStore(dir);
    await store.putCompanion(companion(oldFlow));
    await store.putAsset("u1", "c1", "neutral", pngOf(16, 16, () => [128, 128, 128]));
    const logs: Array<{ e: string; x: Record<string, unknown> }> = [];
    // python that cannot run faceflow.py: the job fails and must leave the old flow alone
    const d = { metaKey: "k", store, voices: [], log: (e: string, x: Record<string, unknown>) => void logs.push({ e, x }), media: { imageEdit: async () => Buffer.alloc(0), samDetect: async () => [] }, python: "/bin/false" } as unknown as PrepDeps;
    const runner = new PrepRunner(d);
    const c = (await store.getCompanion("u1"))!;
    assert.equal(runner.reflowMask("u1", c, { GENITA_FACE_REFLOW: "0" }), false, "env off");
    assert.equal(runner.reflowMask("u1", companion({ ...oldFlow, maskVersion: 2 }), {}), false, "already v2");
    assert.equal(runner.reflowMask("u1", c, {}), true, "started");
    assert.equal(runner.reflowMask("u1", c, {}), false, "one job per account at a time");
    for (let i = 0; i < 100 && !logs.some((l) => l.e === "face.reflow"); i++) await new Promise((r) => setTimeout(r, 20));
    const l = logs.find((x) => x.e === "face.reflow");
    assert.ok(l, "face.reflow logged");
    assert.equal(l!.x.status, "failed");
    assert.deepEqual((await store.getCompanion("u1"))!.prep.steps.face!.face!.flow, oldFlow, "old flow kept");
    assert.equal(runner.reflowMask("u1", c, {}), false, "not again within the retry window");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flowAssetAllowed (codex P2): the previous generation of a listed asset is still served after a re-flow swap", async () => {
  const { flowAssetAllowed } = await import("../src/prep/faceflow.ts");
  const g2 = { ...oldFlow, mask: "flow_mask_g2", neutralRoi: "flow_neutral_g2", files: { AH: { key: "flow_AH_key_g2", nk: "flow_AH_nk_g2" } } } as unknown as FaceFlow;
  assert.equal(flowAssetAllowed(g2, "flow_AH_nk_g2"), true);
  assert.equal(flowAssetAllowed(g2, "flow_AH_nk"), true, "old generation of a listed file");
  assert.equal(flowAssetAllowed(g2, "flow_mask"), true);
  assert.equal(flowAssetAllowed(g2, "flow_MID_nk"), false, "never listed");
  assert.equal(flowAssetAllowed(g2, "flow_AH_nk_g2_g2"), false);
  assert.equal(flowAssetAllowed(oldFlow, "flow_mask"), true);
});
