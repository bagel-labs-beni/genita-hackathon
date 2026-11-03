/**
 * D41 judge demo template, made by the server itself at boot (the hosted DB is inside the VPC, so the
 * ops script `npm run demo:template` cannot reach it from a laptop).
 *
 * startDemoTemplate() runs in the background after the accounts DB is migrated and never blocks startup.
 * Each template version gets its own reserved account (provider "dev", sub `demo:template:<v>`), so a
 * new template is built next to the old one; templates are never deleted by this module. Only a
 * ready build moves the pointer `demo/template-current.json` ({userId, companionId, version}); judge
 * sign-in copies whatever the pointer names (else the legacy `demo:template` account, prep/demo.ts).
 *   - pointer already on a ready template of this version → kept (demo.template.current)
 *   - this version ready but not pointed at (another process built it) → pointer moved (demo.template.seeded)
 *   - this version being built by another process (running, < STALE_MS old) → left alone (demo.template.busy)
 *   - missing → built via the prep routes (demo.template.seeded)
 *   - failed / stale → never deleted; this process builds in a fresh account of its own for this version
 *     (demo.template.recover), so two processes recovering at once cannot remove each other's work
 *   - ops pause (GENITA_PAUSED / pause file) → nothing generated (demo.template.failed reason paused)
 * Any failure is only logged (demo.template.failed) and retried once after RETRY_MS.
 *
 * Version = DEMO_TEMPLATE_VERSION (bump when the face pipeline changes) + the sample photo's hash +
 * the default voice.
 *
 * On by default only where it is wanted and paid for: a Postgres DB (the hosted server) with Judge
 * access codes configured. GENITA_DEMO_TEMPLATE=0 turns it off, =1 forces it on (tests, PGlite).
 *
 * Threat line: no endpoint; the loopback HTTP listener used to reuse the prep routes binds
 * 127.0.0.1 on a random port only for the length of the build and serves only the template account.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { BlobStore } from "../storage/blob.ts";
import type { Prep } from "./index.ts";
import { DEMO_NAME, DEMO_TEMPLATE_SUB } from "./demo.ts";
import { getOps } from "../ops/limits.ts";

export const DEMO_TEMPLATE_VERSION = "2026-11-03.2";   // .2: + surprised / concerned expression keys
export const DEMO_TEMPLATE_IMAGE = join(import.meta.dirname, "../../assets/demo/jin.jpg");
const RETRY_MS = 10 * 60_000;
/** a build in another process older than this is treated as crashed */
const STALE_MS = 30 * 60_000;
export const DEMO_POINTER_KEY = "demo/template-current.json";
export type DemoPointer = { userId: string; companionId: string; version: string };

type Log = (event: string, data: Record<string, unknown>) => void;
export type DemoTemplateDeps = {
  /** users.id of the reserved template account for this version (created if missing) */
  templateUser: (sub: string) => Promise<string>;
  prep: Prep;
  blobs: BlobStore;
  log: Log;
  image?: Buffer;
  /** builds a ready template companion for this user and returns its id (default: the prep routes) */
  build?: (tplUserId: string, image: Buffer) => Promise<string>;
};
export type DemoTemplateResult = { status: "current" | "seeded" | "busy" | "failed"; companionId?: string; version: string; ms: number };

/** The reserved account for one template version. */
export const templateSub = (version: string) => `${DEMO_TEMPLATE_SUB}:${createHash("sha256").update(version).digest("hex").slice(0, 12)}`;

/** The template judges copy now (null = none yet; prep/demo.ts then falls back to the legacy account). */
export async function readDemoPointer(blobs: BlobStore): Promise<DemoPointer | null> {
  const b = await blobs.get(DEMO_POINTER_KEY).catch(() => null);
  if (!b) return null;
  try {
    const p = JSON.parse(b.toString("utf8")) as DemoPointer;
    return typeof p.userId === "string" && typeof p.companionId === "string" ? p : null;
  } catch {
    return null;
  }
}

export function demoTemplateVersion(image: Buffer, voiceId: string | undefined): string {
  return `${DEMO_TEMPLATE_VERSION}:${createHash("sha256").update(image).digest("hex").slice(0, 12)}:${voiceId ?? "none"}`;
}

/** On for the hosted server (Postgres + Judge access codes); GENITA_DEMO_TEMPLATE=0/1 overrides. */
export function demoTemplateWanted(env: NodeJS.ProcessEnv, dbKind: string): boolean {
  if (env.GENITA_DEMO_TEMPLATE === "0") return false;
  if (env.GENITA_DEMO_TEMPLATE === "1") return true;
  return dbKind === "pg" && !!env.GENITA_JUDGE_CODES?.trim();
}

let running: Promise<DemoTemplateResult> | null = null;

/** One build at a time in this process; never throws. */
export function ensureDemoTemplate(d: DemoTemplateDeps): Promise<DemoTemplateResult> {
  running ??= run(d).finally(() => { running = null; });
  return running;
}

async function run(d: DemoTemplateDeps): Promise<DemoTemplateResult> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  let version = "unknown";
  try {
    const image = d.image ?? readFileSync(DEMO_TEMPLATE_IMAGE);
    version = demoTemplateVersion(image, d.prep.deps.voices[0]?.id);
    const store = d.prep.deps.store;
    const pointer = await readDemoPointer(d.blobs);
    if (pointer?.version === version) {
      const c = await store.getCompanion(pointer.userId);
      if (c?.id === pointer.companionId && c.prep.status === "ready") {
        d.log("demo.template.current", { companionId: c.id, version });
        return { status: "current", companionId: c.id, version, ms: ms() };
      }
    }
    let tpl = await d.templateUser(templateSub(version));
    let cur = await store.getCompanion(tpl);
    if (cur?.prep.status === "running" && d.prep.runner.isRunning(tpl)) {
      await d.prep.runner.run(tpl); // this process resumed it at boot: let it finish
      cur = await store.getCompanion(tpl);
    }
    if (cur && cur.prep.status !== "ready") {
      const age = Date.now() - Date.parse(cur.createdAt);
      if (cur.prep.status === "running" && !d.prep.runner.isRunning(tpl) && age < STALE_MS) {
        d.log("demo.template.busy", { companionId: cur.id, version, ageMs: age });
        return { status: "busy", companionId: cur.id, version, ms: ms() };
      }
      // failed, or a crashed/stale build: never deleted (another process may be recovering it right now);
      // this process builds in a fresh account of its own for this version instead
      const retrySub = `${templateSub(version)}:r${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
      d.log("demo.template.recover", { companionId: cur.id, status: cur.prep.status, version });
      tpl = await d.templateUser(retrySub);
      cur = null;
    }
    let companionId = cur?.id;
    if (!companionId) {
      if (getOps().isPaused("demo.template")) throw new Error("paused");
      companionId = await (d.build ?? buildViaRoutes(d))(tpl, image);
      const done = await store.getCompanion(tpl);
      if (!done || done.id !== companionId || done.prep.status !== "ready") throw new Error(`template prep ended ${done?.prep.status ?? "missing"}`);
    }
    const files = (await d.blobs.list(`users/${tpl}/companions/${companionId}/`)).length;
    if (!files) throw new Error("template has no face files");
    const next: DemoPointer = { userId: tpl, companionId, version };
    await d.blobs.put(DEMO_POINTER_KEY, Buffer.from(JSON.stringify({ ...next, at: new Date().toISOString() })), "application/json");
    d.log("demo.template.seeded", { companionId, version, files, previous: pointer?.version ?? null, ms: ms() });
    return { status: "seeded", companionId, version, ms: ms() };
  } catch (err) {
    d.log("demo.template.failed", { version, message: String(err).slice(0, 300), ms: ms() });
    return { status: "failed", version, ms: ms() };
  }
}

/** Boot hook: background, never blocks or throws; one retry after RETRY_MS when the build failed. */
export function startDemoTemplate(d: DemoTemplateDeps, retryMs = RETRY_MS): { stop(): void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  void ensureDemoTemplate(d).then((r) => {
    if ((r.status !== "failed" && r.status !== "busy") || stopped) return;
    timer = setTimeout(() => void ensureDemoTemplate(d), retryMs);
    timer.unref?.();
  });
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}

/** The same steps as `npm run demo:template`, through the server's own prep routes on loopback. */
function buildViaRoutes(d: DemoTemplateDeps) {
  return async (tpl: string, image: Buffer): Promise<string> => {
    const http = createServer((req, res) => void d.prep.routes.handle(req, res, tpl));
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown, raw?: Buffer) => {
      const r = await fetch(base + path, { method, headers: { "content-type": raw ? "image/jpeg" : "application/json" }, body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body) });
      const json = (await r.json()) as Record<string, any>;
      if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(json).slice(0, 200)}`);
      return json;
    };
    try {
      const check = await call("POST", "/v1/companion/image?rights=1", undefined, image);
      if (!check.passed) throw new Error(`sample photo did not pass the check: ${JSON.stringify(check.reasons)}`);
      const voiceId = d.prep.deps.voices[0]?.id;
      const made = await call("POST", "/v1/companion", { imageId: check.imageId, voiceId, name: DEMO_NAME });
      await d.prep.runner.run(tpl);
      await call("POST", "/v1/companion/prefs", { depth: "quick", answers: { help: "Be there", relationship: "Close companion", presence: ["Warm", "Witty"] } });
      return String(made.id);
    } finally {
      http.close();
    }
  };
}

export { DEMO_TEMPLATE_SUB };
