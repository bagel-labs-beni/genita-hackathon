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

test("v41 interior masks: <key>.interior.png → flow_<key>_int, listed and served", () => {
  assert.equal(flowAssetName("AH.interior.png"), "flow_AH_int");
  const f = { ...FLOW, files: { AH: { ...FLOW.files.AH, interior: "flow_AH_int" } } };
  assert.ok(flowAssets(f).has("flow_AH_int"));
  assert.equal(faceManifest({ ...state(), flow: f }, (k) => `/f/${k}`, (a) => `/f/${a}`).flow!.files.AH.interior, "/f/flow_AH_int");
});

test("v16 lip masks: <key>.lip.png → flow_<key>_lip, listed and served", () => {
  assert.equal(flowAssetName("AH2.lip.png"), "flow_AH2_lip");
  const f = { ...FLOW, files: { AH: { ...FLOW.files.AH, lip: "flow_AH_lip" } } };
  assert.ok(flowAssets(f).has("flow_AH_lip"));
  assert.equal(faceManifest({ ...state(), flow: f }, (k) => `/f/${k}`, (a) => `/f/${a}`).flow!.files.AH.lip, "/f/flow_AH_lip");
});

test("2D blink assets (character2d): BLINK.jpg / BLINKMASK.png are store-safe and served only when listed", () => {
  assert.equal(flowAssetName("BLINK.jpg"), "flow_blink");
  assert.equal(flowAssetName("BLINKMASK.png"), "flow_blinkmask");
  const f = { ...FLOW, blink: { mode: "snap2d", image: "flow_blink", mask: "flow_blinkmask", frames: 3, rect: [0.3, 0.4, 0.7, 0.5] as [number, number, number, number] } };
  assert.ok(flowAssets(f).has("flow_blink") && flowAssets(f).has("flow_blinkmask"));
  assert.ok(!flowAssets(FLOW).has("flow_blink"));
  const m = faceManifest({ ...state(), flow: f }, (k) => `/f/${k}`, (a) => `/f/${a}`);
  assert.equal(m.flow!.blink!.image, "/f/flow_blink");
});

test("makeFaceFlow passes the animal species to faceflow.py (--species, non-human rules)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-species-"));
  try {
    const argsFile = join(dir, "args.txt");
    const sh = join(dir, "spy.sh");
    writeFileSync(sh, `#!/bin/sh\necho "$@" > ${argsFile}\nexit 3\n`);
    chmodSync(sh, 0o755);
    await makeFaceFlow({ python: "/bin/sh", script: sh, scene: pngOf(8, 8), state: state(), kind: "animal", profile: "animal", species: "parrot",
      image: async () => pngOf(8, 8), put: async () => {} });
    const argv = readFileSync(argsFile, "utf8");
    assert.match(argv, /--species parrot/);
    assert.match(argv, /--kind animal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const pyFaceflow = (expr: string) => {
  const py = pythonWithCv2()!;
  return JSON.parse(execFileSync(py, ["-c", `import sys, json; sys.path.insert(0, ${JSON.stringify(FACEFLOW_SCRIPT.replace(/\/faceflow\.py$/, ""))}); import faceflow as F; print(json.dumps(${expr}))`]).toString());
};

test("faceflow.py animal rules (non-human port): bird beak split, small muzzle by box or species, long-snout dog", { skip: pythonWithCv2() ? false : "no python with OpenCV here" }, () => {
  const face = "[0.2,0.25,0.8,0.62]";
  const wide = "[0.40,0.50,0.60,0.53]", tiny = "[0.47,0.50,0.53,0.53]";
  const rule = (kind: string, sp: string, mouth: string) => pyFaceflow(`(lambda r: r and r[0])(F.animal_rule('${kind}', F.profile_of('${kind}'), '${sp}', ${face}, ${mouth}))`);
  assert.equal(rule("animal", "parrot", wide), "bird");
  assert.equal(rule("animal", "dog", wide), "mildMuzzle", "a wide dog mouth gets the mild dog rule (f8)");
  assert.equal(rule("animal", "cow", wide), null, "a wide non-dog mouth gets no exaggeration");
  assert.equal(rule("animal", "dog", tiny), "smallMuzzle", "mouth box < 12 % of the face width");
  assert.equal(rule("animal", "hamster", wide), "smallMuzzle");
  assert.equal(rule("cat", "cat", wide), "smallMuzzle");
  assert.equal(rule("animal", "golden retriever", wide), "longSnoutDog");
  assert.equal(rule("character3d", "parrot", wide), null, "characters never take animal rules");
  const sm = pyFaceflow("F.profile_of('animal')['smallMuzzle']['prep']");
  assert.deepEqual([sm.squash, sm.widen, sm.shade], [1.6, 1.3, 0.5]);
});

test("faceflow.py end to end (non-human port): toy derives AH2 from AH; small-muzzle animal shades + widens the opening", { skip: pythonWithCv2() ? false : "no python with OpenCV here" }, () => {
  const py = pythonWithCv2()!;
  const W = 256, H = 456, mouthY = 0.515 * H, mouthX = W / 2;
  const tex = (x: number, y: number): [number, number, number] => [150 + ((x * 7 + y * 3) % 40), 120 + ((x * 3 + y * 5) % 30), 110 + ((x + y) % 25)];
  const neutral = pngOf(W, H, (x, y) => (Math.abs(y - mouthY) < 1.5 && Math.abs(x - mouthX) < 18 ? [90, 40, 40] : tex(x, y)));
  const open = pngOf(W, H, (x, y) => (((x - mouthX) / 14) ** 2 + ((y - mouthY - 3) / 6) ** 2 < 1 ? [150, 90, 170] : tex(x, y)));
  const dir = mkdtempSync(join(tmpdir(), "ff-nh-"));
  try {
    writeFileSync(join(dir, "n.png"), neutral); writeFileSync(join(dir, "ah.png"), open);
    const run = (kind: string, keys: string, species = "") => {
      const out = join(dir, `out-${kind}`);
      const args = [FACEFLOW_SCRIPT, "--neutral", join(dir, "n.png"), "--keys", keys, "--face", "0.2,0.25,0.8,0.62", "--mouth", "0.47,0.50,0.53,0.53", "--kind", kind, "--out", out];
      if (species) args.push("--species", species);
      const res = JSON.parse(execFileSync(py, args).toString().trim().split("\n").pop()!);
      return { res, flow: JSON.parse(readFileSync(join(out, "flow.json"), "utf8")) };
    };
    const toy = run("toy", `AH=${join(dir, "ah.png")}`);
    assert.deepEqual(toy.flow.keys.sort(), ["AH", "AH2"], "AH2 derived from the single felt key");
    assert.equal(toy.res.diag.AH2.derivedFrom, "AH");
    const bird = run("animal", `AH=${join(dir, "ah.png")}`, "parrot");
    assert.equal(bird.flow.lockSource, "bird-split", "codex P2: the beak split line is the lock line");
    assert.ok(Math.abs(bird.flow.lockY - (0.50 + 0.4 * 0.03)) < 1e-4, `upper half of the beak locked (${bird.flow.lockY})`);
    assert.deepEqual(toy.flow.map.jaw.steps.map((s: [string, number]) => s[0]), ["AH", "AH2"], "codex P2: the open drive reaches the derived AH2");
    assert.equal(toy.flow.map.cheek.cheekW, 1.0, "codex P2: toy cheek weight, not character3d's");
    const ham = run("animal", `AH=${join(dir, "ah.png")}`, "hamster");
    assert.ok(ham.flow.keys.includes("AH"));
    assert.equal(ham.flow.map.profile, "animal");
    assert.equal(ham.flow.map.fallback.EH, "AH", "animal shapes fall back to the jaw ladder");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("faceflow.py 2D (codex P2): white teeth on light skin survive pasteDrawnOnly (filled mouth kept, only outside skin dropped)", { skip: pythonWithCv2() ? false : "no python with OpenCV here" }, () => {
  const py = pythonWithCv2()!;
  const W = 256, H = 456, cy = 0.515 * H, cx = W / 2;
  const skin: [number, number, number] = [235, 240, 250];
  const neutral = pngOf(W, H, (x, y) => (Math.abs(y - cy) < 1.2 && Math.abs(x - cx) < 14 ? [60, 40, 40] : skin));
  const wd = pngOf(W, H, (x, y) => {
    const r = ((x - cx) / 28) ** 2 + ((y - cy - 4) / 18) ** 2;
    if (r < 0.8 && y < cy) return [250, 250, 250];           // white upper teeth, close to the skin colour
    if (r < 0.8) return [70, 30, 40];                         // cavity
    if (r < 1) return [40, 25, 25];                           // outline
    return skin;
  });
  const dir = mkdtempSync(join(tmpdir(), "ff-2d-"));
  try {
    writeFileSync(join(dir, "n.png"), neutral); writeFileSync(join(dir, "wd.png"), wd);
    const out = join(dir, "out");
    execFileSync(py, [FACEFLOW_SCRIPT, "--neutral", join(dir, "n.png"), "--keys", `WD=${join(dir, "wd.png")}`, "--face", "0.2,0.25,0.8,0.62",
      "--mouth", "0.44,0.505,0.56,0.525", "--kind", "character2d", "--out", out]);
    const flow = JSON.parse(readFileSync(join(out, "flow.json"), "utf8"));
    // white teeth are ~250 in every channel; the skin they would be wiped to has a 235 channel
    const white = Number(execFileSync(py, ["-c", `import cv2; im = cv2.imread(${JSON.stringify(join(out, "WD.jpg"))}); print(int((im.min(2) >= 244).sum()))`]).toString());
    assert.ok(flow.keys.includes("WD"));
    assert.ok(white > 120, `teeth stay white (${white} white px; ~88 when the teeth are wiped to skin)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("faceflow.py species add-ons (f7/f8): dog mild muzzle, rabbit chin fur + Y, horse lower-lip hinge; values reach the flow map", { skip: pythonWithCv2() ? false : "no python with OpenCV here" }, () => {
  const face = "[0.2,0.25,0.8,0.62]", wide = "[0.40,0.50,0.60,0.53]";
  const names = (sp: string) => pyFaceflow(`[r[0] for r in F.animal_rules('animal', F.profile_of('animal'), '${sp}', ${face}, ${wide})]`);
  assert.deepEqual(names("dog"), ["mildMuzzle"]);
  assert.deepEqual(names("rabbit"), ["smallMuzzle", "rabbitLike"]);
  assert.deepEqual(names("horse"), ["horseLike"]);
  assert.deepEqual(names("golden retriever"), ["longSnoutDog"]);
  assert.deepEqual(names("parrot"), ["bird"]);
  const ls = pyFaceflow("F.profile_of('animal')['smallMuzzle']['longSnoutDog']['prep']");
  assert.equal(ls.widen, undefined, "retriever: no horizontal widen (it smeared the lip corners)");
});

test("faceflow.py end to end: species runtime values land in flow.map (dog lip / unstressed, rabbit chinWarp); 2D dot mouth SM = small open WD", { skip: pythonWithCv2() ? false : "no python with OpenCV here" }, () => {
  const py = pythonWithCv2()!;
  const W = 256, H = 456, mouthY = 0.515 * H, mouthX = W / 2;
  const tex = (x: number, y: number): [number, number, number] => [150 + ((x * 7 + y * 3) % 40), 120 + ((x * 3 + y * 5) % 30), 110 + ((x + y) % 25)];
  const neutral = pngOf(W, H, (x, y) => (Math.abs(y - mouthY) < 1.5 && Math.abs(x - mouthX) < 18 ? [90, 40, 40] : tex(x, y)));
  const open = pngOf(W, H, (x, y) => (((x - mouthX) / 14) ** 2 + ((y - mouthY - 3) / 6) ** 2 < 1 ? [150, 90, 170] : tex(x, y)));
  const dir = mkdtempSync(join(tmpdir(), "ff-sp-"));
  try {
    writeFileSync(join(dir, "n.png"), neutral); writeFileSync(join(dir, "ah.png"), open);
    const run = (species: string, mouth = "0.40,0.50,0.60,0.53") => {
      const out = join(dir, `out-${species}`);
      execFileSync(py, [FACEFLOW_SCRIPT, "--neutral", join(dir, "n.png"), "--keys", `AH=${join(dir, "ah.png")}`, "--face", "0.2,0.25,0.8,0.62", "--mouth", mouth, "--kind", "animal", "--out", out, "--species", species]);
      return JSON.parse(readFileSync(join(out, "flow.json"), "utf8"));
    };
    const dog = run("dog");
    assert.deepEqual(dog.rules, ["mildMuzzle"]);
    assert.equal(dog.map.motionV2.lip, 1.84); assert.equal(dog.map.motionV2.unstressed, 0.35);
    assert.equal(typeof dog.map.motionV2.springHz, "number", "the kind's other motionV2 fields stay");
    const rab = run("rabbit");
    assert.equal(rab.map.chinWarp.px, 14); assert.equal(rab.map.lipPart.px, 6); assert.equal(rab.map.motionV2.lip, 1.2);
    const horse = run("horse");
    assert.equal(horse.map.chinWarp.from, "top");
    assert.equal(run("cow").rules, undefined, "no rule, no extra block");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(pyFaceflow("F.profile_of('character2d')['prep']['fitDotMouth']['replace']"), { SM: "WD" });
});

test("faceflow.py 2D dot mouth (codex P2): SM rejected upstream, WD kept → SM derived from WD, no crash", { skip: pythonWithCv2() ? false : "no python with OpenCV here" }, () => {
  const py = pythonWithCv2()!;
  const W = 256, H = 456, cy = 0.515 * H, cx = W / 2;
  const skin: [number, number, number] = [235, 225, 215];
  const neutral = pngOf(W, H, (x, y) => (Math.abs(y - cy) < 1 && Math.abs(x - cx) < 4 ? [60, 40, 40] : skin));
  const wd = pngOf(W, H, (x, y) => { const r = ((x - cx) / 12) ** 2 + ((y - cy - 3) / 9) ** 2; return r < 0.8 ? [80, 30, 40] : r < 1 ? [40, 25, 25] : skin; });
  const dir = mkdtempSync(join(tmpdir(), "ff-dot-"));
  try {
    writeFileSync(join(dir, "n.png"), neutral); writeFileSync(join(dir, "wd.png"), wd);
    const out = join(dir, "out");
    const res = JSON.parse(execFileSync(py, [FACEFLOW_SCRIPT, "--neutral", join(dir, "n.png"), "--keys", `WD=${join(dir, "wd.png")}`, "--face", "0.1,0.2,0.9,0.6",
      "--mouth", "0.49,0.512,0.51,0.518", "--kind", "character2d", "--out", out]).toString().trim().split("\n").pop()!);
    assert.ok(res.ok);
    assert.deepEqual(res.diag.SM.derivedFrom, "WD");
    assert.ok(JSON.parse(readFileSync(join(out, "flow.json"), "utf8")).keys.includes("SM"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
