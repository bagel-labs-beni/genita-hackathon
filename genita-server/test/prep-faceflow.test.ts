import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACE_KEYS, faceManifest, type FaceFlow, type FaceState } from "../src/prep/face.ts";
import { FACEFLOW_SCRIPT, FLOW_KEYS, faceflowArgs, flowAssetName, flowAssets, makeFaceFlow } from "../src/prep/faceflow.ts";

const box = { face: [0.2, 0.25, 0.8, 0.62] as const, mouth: [0.42, 0.5, 0.58, 0.53] as const };
const state = (keys = ["MID", "AH"]): FaceState => ({
  size: [256, 456],
  ref: box,
  items: Object.fromEntries(keys.map((k) => [k, { status: "done", box, retried: false, ms: 1 }])),
  ms: { total: 0, edits: 0, sam: 0 },
});

test("faceflow asset names: store-safe ids for every file the script writes", () => {
  assert.equal(flowAssetName("AH2.nk.f16"), "flow_AH2_nk");
  assert.equal(flowAssetName("MBP.kn.f16"), "flow_MBP_kn");
  assert.equal(flowAssetName("OH.jpg"), "flow_OH_key");
  assert.equal(flowAssetName("neutral.jpg"), "flow_neutral");
  assert.equal(flowAssetName("mask.png"), "flow_mask");
  assert.equal(flowAssetName("flow.json"), null);
  assert.equal(flowAssetName("../x.jpg"), null);
  for (const k of FACE_KEYS) assert.match(flowAssetName(`${k}.nk.f16`) ?? "", /^[A-Za-z0-9_]{1,24}$/);
});

test("flow keys: visemes + mouth keys, never the expressions", () => {
  assert.ok(!FLOW_KEYS.includes("blink") && !FLOW_KEYS.includes("smile"));
  assert.ok(FLOW_KEYS.includes("AH2") && FLOW_KEYS.includes("MBP"));
});

test("faceflowArgs: boxes as fixed decimals, kind and paths", () => {
  const a = faceflowArgs({ dir: "/d", out: "/o", keys: ["MID"], ext: "png", state: state(), kind: "animal" });
  assert.deepEqual(a.slice(0, 2), ["--neutral", "/d/neutral.png"]);
  assert.equal(a[a.indexOf("--face") + 1], "0.20000,0.25000,0.80000,0.62000");
  assert.equal(a[a.indexOf("--kind") + 1], "animal");
});

const FLOW: FaceFlow = {
  version: 1, roi: [0.2, 0.47, 0.8, 0.7], size: [100, 60], flowSize: [25, 15], keys: ["AH"],
  files: { AH: { key: "flow_AH_key", nk: "flow_AH_nk", kn: "flow_AH_kn" } }, mask: "flow_mask", neutralRoi: "flow_neutral",
  lockY: 0.47, lockSource: "mouth-geometry", kind: "human", map: {},
};

test("manifest: flow block with URLs, existing fields unchanged; route allow-list = listed assets", () => {
  const m = faceManifest({ ...state(), flow: FLOW }, (k) => `/f/${k}`, (a) => `/f/${a}`);
  assert.equal(m.version, 1);
  assert.deepEqual(m.flow!.files.AH, { key: "/f/flow_AH_key", nk: "/f/flow_AH_nk", kn: "/f/flow_AH_kn" });
  assert.equal(m.flow!.mask, "/f/flow_mask");
  assert.equal(m.flow!.lockY, 0.47);
  assert.deepEqual(Object.keys(m.mouthKeys), ["MID", "AH"]);
  assert.deepEqual([...flowAssets(FLOW)].sort(), ["flow_AH_key", "flow_AH_kn", "flow_AH_nk", "flow_mask", "flow_neutral"]);
  assert.equal(flowAssets(null).size, 0);
});

test("makeFaceFlow: no Python / a failing script → null and a log line, nothing stored", async () => {
  const logs: string[] = [];
  const put: string[] = [];
  const base = { scene: pngOf(8, 8), state: state(), kind: "human" as const, image: async () => pngOf(8, 8), put: async (a: string) => void put.push(a), log: (e: string) => void logs.push(e) };
  assert.equal(await makeFaceFlow({ ...base, python: "/nonexistent/python3" }), null);
  const dir = mkdtempSync(join(tmpdir(), "ff-fail-"));
  try {
    const bad = join(dir, "bad.sh");
    writeFileSync(bad, "#!/bin/sh\necho boom >&2\nexit 3\n");
    chmodSync(bad, 0o755);
    assert.equal(await makeFaceFlow({ ...base, python: "/bin/sh", script: bad }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(logs, ["face.flow_skipped", "face.flow_skipped"]);
  assert.deepEqual(put, []);
});

/** A Python with OpenCV, if this machine has one (CI may not: the end-to-end test then skips). */
function pythonWithCv2(): string | null {
  for (const p of [process.env.GENITA_PYFLOW, "python3"].filter(Boolean) as string[]) {
    try {
      execFileSync(p, ["-c", "import cv2, numpy"], { stdio: "ignore" });
      return p;
    } catch {}
  }
  return null;
}

/** Minimal PNG writer (RGB, no filter) so the test needs no image library. */
function pngOf(w: number, h: number, px: (x: number, y: number) => [number, number, number] = () => [128, 128, 128]): Buffer {
  const { deflateSync } = require("node:zlib") as typeof import("node:zlib");
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

test("faceflow.py end to end: flows + keys written, nose lock holds (nothing above the subnasale line changes)", { skip: pythonWithCv2() ? false : "no python with OpenCV here" }, async () => {
  const W = 256, H = 456;
  // a face-ish texture with a mouth slit; the AH key opens the mouth (dark ellipse) and also scribbles on the
  // nose: the export must not carry that nose change
  const tex = (x: number, y: number): [number, number, number] => [150 + ((x * 7 + y * 3) % 40), 120 + ((x * 3 + y * 5) % 30), 110 + ((x + y) % 25)];
  const mouthY = 0.515 * H, mouthX = W / 2;
  const neutral = pngOf(W, H, (x, y) => (Math.abs(y - mouthY) < 1.5 && Math.abs(x - mouthX) < 18 ? [90, 40, 40] : tex(x, y)));
  const ah = pngOf(W, H, (x, y) => {
    if (((x - mouthX) / 18) ** 2 + ((y - mouthY) / 7) ** 2 < 1) return [40, 15, 15];
    if (y > 0.40 * H && y < 0.45 * H && Math.abs(x - mouthX) < 10) return [255, 0, 255]; // nose scribble
    return tex(x, y);
  });
  const imgs: Record<string, Buffer> = { MID: neutral, AH: ah };
  const stored = new Map<string, Buffer>();
  const flow = await makeFaceFlow({
    python: pythonWithCv2()!, scene: neutral, state: state(), kind: "human",
    image: async (k) => imgs[k] ?? null, put: async (a, b) => void stored.set(a, b),
  });
  assert.ok(flow, "flow block");
  assert.deepEqual(flow!.keys.sort(), ["AH", "MID"]);
  assert.equal(flow!.files.AH.nk, "flow_AH_nk");
  const [fw, fh] = flow!.flowSize;
  const nk = stored.get("flow_AH_nk")!;
  assert.equal(nk.length, fw * fh * 2 * 2, "float16 dx,dy per cell");
  // rows of the flow grid that lie above the lock line are exactly zero
  const roiY1 = flow!.roi[1] * H, roiH = (flow!.roi[3] - flow!.roi[1]) * H;
  let maxAbove = 0, maxBelow = 0;
  for (let j = 0; j < fh; j++) {
    const yTop = roiY1 + (j / fh) * roiH; // top edge of the cell row
    for (let i = 0; i < fw * 2; i++) {
      const v = Math.abs(f16(nk.readUInt16LE((j * fw * 2 + i) * 2)));
      if ((yTop + roiH / fh) / H < flow!.lockY) maxAbove = Math.max(maxAbove, v);
      else maxBelow = Math.max(maxBelow, v);
    }
  }
  assert.equal(maxAbove, 0, "no motion above the subnasale line");
  assert.ok(maxBelow > 0.5, `the mouth moves (${maxBelow})`);
  assert.ok(flow!.lockY < box.mouth[1] && flow!.lockY > box.mouth[1] - 0.05);
  assert.ok(stored.has("flow_mask") && stored.has("flow_neutral") && stored.has("flow_AH_key"));
});

function f16(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

test("faceflow.py ships inside genita-server (the release tarball is genita-server/ only)", () => {
  assert.match(FACEFLOW_SCRIPT, /genita-server\/prep-py\/faceflow\.py$/);
  assert.match(readFileSync(FACEFLOW_SCRIPT, "utf8"), /DISOpticalFlow_create/);
});

test("makeFaceFlow (codex P2): an abort before the script or during the uploads stores nothing more and rethrows", async () => {
  const ac = new AbortController();
  const put: string[] = [];
  ac.abort(new Error("cancelled"));
  await assert.rejects(
    makeFaceFlow({ python: "/bin/sh", script: "/dev/null", scene: pngOf(8, 8), state: state(), kind: "human", image: async () => pngOf(8, 8), put: async (a) => void put.push(a), signal: ac.signal }),
    /cancelled/,
  );
  assert.deepEqual(put, []);
});

test("faceflow.py lock line: SAM nose bottom when plausible, else upper lip − 6.5% of the face height (codex P2: thick lips)", { skip: pythonWithCv2() ? false : "no python with OpenCV here" }, () => {
  const py = pythonWithCv2()!;
  const run = (nose: string) =>
    JSON.parse(execFileSync(py, ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(FACEFLOW_SCRIPT.replace(/\/faceflow\.py$/, ""))}); import faceflow; print(__import__('json').dumps(faceflow.lock_line([0.2,0.25,0.8,0.62],[0.42,0.50,0.58,0.54],${nose})))`]).toString());
  const [y0, src0] = run("None");
  assert.equal(src0, "face-geometry");
  assert.ok(Math.abs(y0 - (0.5 - 0.065 * 0.37)) < 1e-9);
  assert.ok(y0 < 0.47 + 0.01 && y0 > 0.46, "above a nose base at 0.47–0.48 would be wrong for thick lips only if it came from the mouth height");
  assert.deepEqual(run("[0.45,0.40,0.55,0.484]"), [0.484, "sam"]);
  assert.equal(run("[0.45,0.30,0.55,0.35]")[1], "face-geometry", "a nose box far above the lip is ignored");
});
