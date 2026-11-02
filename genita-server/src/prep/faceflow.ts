/**
 * Prep step after the face set: optical-flow morph data for the device ("B", 11/3).
 *
 * Runs prep-py/faceflow.py (classical OpenCV only: ECC registration on the eyes + nose bridge,
 * feathered lower-face composite, DIS optical flow both ways, float16). Everything above the
 * subnasale line stays the neutral still (nose lock). The script's files become companion assets
 * named `flow_*` and are served by GET /v1/companion/face/:key like the face images.
 *
 * Python is optional: when the interpreter or OpenCV is missing, or the script fails or times out,
 * the face set ships without `flow` and the device draws the viseme patches as before.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompanionKind } from "./prompts.ts";
import type { FaceFlow, FaceKey, FaceState } from "./face.ts";
import { MOUTH_KEYS, VISEMES } from "./face.ts";

export const FACEFLOW_SCRIPT = fileURLToPath(new URL("../../prep-py/faceflow.py", import.meta.url));
export const FACEFLOW_TIMEOUT_MS = 90_000;
/** Keys the runtime morphs between (expressions are not part of the mouth morph). */
export const FLOW_KEYS: readonly FaceKey[] = [...VISEMES, ...MOUTH_KEYS];

/** faceflow.py file name -> asset name (store ids are [A-Za-z0-9_-] only). */
export function flowAssetName(file: string): string | null {
  let m = file.match(/^([A-Za-z0-9]{1,8})\.(nk|kn)\.f16$/);
  if (m) return `flow_${m[1]}_${m[2]}`;
  m = file.match(/^([A-Za-z0-9]{1,8})\.jpg$/);
  if (m) return m[1] === "neutral" ? "flow_neutral" : `flow_${m[1]}_key`;
  if (file === "mask.png") return "flow_mask";
  return null;
}

/** Asset names a face state's flow block lists (what the route may serve). */
export function flowAssets(flow: FaceFlow | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!flow) return out;
  out.add(flow.mask).add(flow.neutralRoi);
  for (const f of Object.values(flow.files)) out.add(f.key).add(f.nk).add(f.kn);
  return out;
}

const fmt = (b: readonly number[]) => b.map((v) => v.toFixed(5)).join(",");

export function faceflowArgs(o: { dir: string; out: string; keys: string[]; ext: string; state: FaceState; kind: CompanionKind }): string[] {
  return [
    "--neutral", join(o.dir, `neutral.${o.ext}`),
    "--keys", o.keys.map((k) => `${k}=${join(o.dir, `${k}.${o.ext}`)}`).join(","),
    "--face", fmt(o.state.ref.face),
    "--mouth", fmt(o.state.ref.mouth),
    "--kind", o.kind,
    "--out", o.out,
  ];
}

const extOf = (b: Buffer) => (b.readUInt32BE(0) === 0x89504e47 ? "png" : b[0] === 0xff && b[1] === 0xd8 ? "jpg" : "webp");

export type FaceflowInput = {
  python: string;
  script?: string;
  scene: Buffer;
  state: FaceState;
  kind: CompanionKind;
  /** bytes of a kept key image (null = not available) */
  image: (key: FaceKey) => Promise<Buffer | null>;
  put: (asset: string, bytes: Buffer) => Promise<void>;
  timeoutMs?: number;
  signal?: AbortSignal;
  log?: (event: string, data: Record<string, unknown>) => void;
};

function run(cmd: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const kill = () => p.kill("SIGKILL");
    const t = setTimeout(() => { kill(); reject(new Error(`faceflow: timed out after ${timeoutMs} ms`)); }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", (code) => {
      clearTimeout(t);
      signal?.removeEventListener("abort", kill);
      if (code === 0) resolve(out);
      else reject(new Error(`faceflow: exit ${code}: ${err.trim().slice(-300)}`));
    });
  });
}

/** Builds and stores the flow assets; returns the `flow` block (asset names), or null when skipped/failed. */
export async function makeFaceFlow(o: FaceflowInput): Promise<FaceFlow | null> {
  const t0 = performance.now();
  const keys: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), "genita-faceflow-"));
  try {
    const ext = extOf(o.scene);
    await writeFile(join(dir, `neutral.${ext}`), o.scene);
    for (const k of FLOW_KEYS) {
      if (o.state.items[k]?.status !== "done") continue;
      const b = await o.image(k);
      if (!b) continue;
      await writeFile(join(dir, `${k}.${extOf(b)}`), b);
      keys.push(`${k}.${extOf(b)}`);
    }
    if (!keys.length) return null;
    const out = join(dir, "out");
    // keys may differ in format from the scene: pass full paths
    const args = faceflowArgs({ dir, out, keys: [], ext, state: o.state, kind: o.kind });
    args[3] = keys.map((f) => `${f.split(".")[0]}=${join(dir, f)}`).join(",");
    const stdout = await run(o.python, [o.script ?? FACEFLOW_SCRIPT, ...args], o.timeoutMs ?? FACEFLOW_TIMEOUT_MS, o.signal);
    const res = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as { ok?: boolean };
    if (!res.ok) throw new Error("faceflow: no ok line");
    const raw = JSON.parse(await readFile(join(out, "flow.json"), "utf8")) as FaceFlow;
    const rename = (file: string) => {
      const a = flowAssetName(file);
      if (!a) throw new Error(`faceflow: unexpected file ${file}`);
      return a;
    };
    const files: FaceFlow["files"] = {};
    for (const [k, f] of Object.entries(raw.files)) files[k] = { key: rename(f.key), nk: rename(f.nk), kn: rename(f.kn) };
    for (const file of await readdir(out)) {
      if (file === "flow.json") continue;
      const a = flowAssetName(file);
      if (a) await o.put(a, await readFile(join(out, file)));
    }
    const ms = Math.round(performance.now() - t0);
    const flow: FaceFlow = { ...raw, files, mask: rename(raw.mask), neutralRoi: rename(raw.neutralRoi), ms };
    o.log?.("face.flow_done", { ms, keys: raw.keys.length, lockY: raw.lockY });
    return flow;
  } catch (err) {
    if (o.signal?.aborted) throw err;
    o.log?.("face.flow_skipped", { error: String(err).slice(0, 300), ms: Math.round(performance.now() - t0) });
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
