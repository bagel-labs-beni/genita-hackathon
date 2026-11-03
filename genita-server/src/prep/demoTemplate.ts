/**
 * D41 judge demo template, made by the server itself at boot (the hosted DB is inside the VPC, so the
 * ops script `npm run demo:template` cannot reach it from a laptop).
 *
 * ensureDemoTemplate() runs in the background after the accounts DB is migrated (007_companion_demo)
 * and never blocks startup. Idempotent: a ready template whose stamp matches the current version is
 * kept (log demo.template.current). Otherwise the old template is dropped and rebuilt through the
 * normal prep routes (photo check → companion → prep → prefs) under the reserved account
 * provider "dev", sub "demo:template" (log demo.template.seeded). Any failure is logged
 * (demo.template.failed) and retried once after RETRY_MS; judges then onboard like new users.
 *
 * Version = DEMO_TEMPLATE_VERSION (bump when the face pipeline changes) + the sample photo's hash +
 * the default voice. Stored next to the template's files: users/<tpl>/demo-template.json.
 *
 * On by default only where it is wanted and paid for: a Postgres DB (the hosted server) with Judge
 * access codes configured. GENITA_DEMO_TEMPLATE=0 turns it off, =1 forces it on (tests, PGlite).
 *
 * Threat line: no endpoint; the loopback HTTP listener used to reuse the prep routes binds
 * 127.0.0.1 on a random port only for the length of the build and serves only the template account.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { BlobStore } from "../storage/blob.ts";
import type { Prep } from "./index.ts";
import { DEMO_NAME, DEMO_TEMPLATE_SUB } from "./demo.ts";

export const DEMO_TEMPLATE_VERSION = "2026-11-03.1";
export const DEMO_TEMPLATE_IMAGE = join(import.meta.dirname, "../../assets/demo/jin.jpg");
const RETRY_MS = 10 * 60_000;

type Log = (event: string, data: Record<string, unknown>) => void;
export type DemoTemplateDeps = {
  /** users.id of the reserved template account (created if missing) */
  templateUser: () => Promise<string>;
  prep: Prep;
  blobs: BlobStore;
  log: Log;
  image?: Buffer;
  /** builds a ready template companion for this user and returns its id (default: the prep routes) */
  build?: (tplUserId: string, image: Buffer) => Promise<string>;
};
export type DemoTemplateResult = { status: "current" | "seeded" | "failed"; companionId?: string; version: string; ms: number };

const stampKey = (tpl: string) => `users/${tpl}/demo-template.json`;

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
    const tpl = await d.templateUser();
    const store = d.prep.deps.store;
    const cur = await store.getCompanion(tpl);
    const stamp = await d.blobs.get(stampKey(tpl)).then((b) => (b ? (JSON.parse(b.toString("utf8")) as { version?: string }).version : null)).catch(() => null);
    if (cur && cur.prep.status === "ready" && stamp === version) {
      d.log("demo.template.current", { companionId: cur.id, version });
      return { status: "current", companionId: cur.id, version, ms: ms() };
    }
    if (cur) {
      await d.prep.runner.stop(tpl); // a resumed half-built template must not keep writing
      await store.deleteCompanion(tpl);
      d.log("demo.template.dropped", { companionId: cur.id, status: cur.prep.status, had: stamp ?? null, version });
    }
    const companionId = await (d.build ?? buildViaRoutes(d))(tpl, image);
    const done = await store.getCompanion(tpl);
    if (!done || done.id !== companionId || done.prep.status !== "ready") throw new Error(`template prep ended ${done?.prep.status ?? "missing"}`);
    await d.blobs.put(stampKey(tpl), Buffer.from(JSON.stringify({ version, companionId, at: new Date().toISOString() })), "application/json");
    const files = (await d.blobs.list(`users/${tpl}/companions/${companionId}/`)).length;
    d.log("demo.template.seeded", { companionId, version, files, ms: ms() });
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
    if (r.status !== "failed" || stopped) return;
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
