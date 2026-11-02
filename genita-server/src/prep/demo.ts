/**
 * D41 judge demo companion. A Judge access account starts with one ready-made companion ("Jin")
 * so a judge can call right away instead of waiting for prep.
 *
 * The template is a normal companion, prepared once by `npm run demo:template`
 * (scripts/demo-template.ts) under a reserved account: users row provider "dev", sub
 * `demo:template`. Nothing outside reaches it: x-genita-user names can't contain ":" and
 * judge accounts are `judge:<label>`.
 *
 * seedDemoCompanion(userId) copies it to a user who has no companion: a new companion id,
 * `demo: true`, name Jin, the same prep state (ready), prefs and persona, a copy of the photo,
 * and a copy of every file under the template's `users/<tpl>/companions/<cid>/` (the face set,
 * whatever shape it has), written under the user's own `users/<id>/…` so DELETE /me removes the
 * copies and never the template's files. The companion row is written last, so a failed copy
 * leaves no half companion (only files under the user, which account deletion removes).
 *
 * Threat line: callers = the judge sign-in path (server-internal, after the code check) and
 * tests; no new endpoint. Bounded copy (DEMO_MAX_FILES, DEMO_MAX_BYTES). Exposes nothing new:
 * the judge sees only their own copy through the existing prep routes.
 */
import { randomUUID } from "node:crypto";
import type { BlobStore } from "../storage/blob.ts";
import { sniffImage } from "./classify.ts";
import type { CompanionRecord, PrepStore } from "./store.ts";

export const DEMO_TEMPLATE_SUB = "demo:template";
export const DEMO_NAME = "Jin";
export const DEMO_MAX_FILES = 64;
export const DEMO_MAX_BYTES = 64 * 1024 * 1024;

export type DemoSeedDeps = {
  store: PrepStore;
  blobs: BlobStore;
  /** users.id of the template account, or null when `npm run demo:template` has not run */
  templateUserId: () => Promise<string | null>;
  log: (event: string, data: Record<string, unknown>) => void;
};

export type DemoSeedResult = { seeded: boolean; reason?: string; companionId?: string; files?: number; bytes?: number; ms: number };

const companionDir = (userId: string, companionId: string) => `users/${userId}/companions/${companionId}/`;
const newId = () => randomUUID().replace(/-/g, "");

// one seed per user at a time (a judge signing in on iPhone and Mac at once)
const inflight = new Map<string, Promise<DemoSeedResult>>();

export function seedDemoCompanion(d: DemoSeedDeps, userId: string, limits: { maxFiles?: number; maxBytes?: number } = {}): Promise<DemoSeedResult> {
  const prev = inflight.get(userId) ?? Promise.resolve(null);
  const next = prev.catch(() => null).then(() => seed(d, userId, limits));
  inflight.set(userId, next);
  void next.finally(() => inflight.get(userId) === next && inflight.delete(userId)).catch(() => {});
  return next;
}

async function seed(d: DemoSeedDeps, userId: string, limits: { maxFiles?: number; maxBytes?: number }): Promise<DemoSeedResult> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const skip = (reason: string, extra: Record<string, unknown> = {}): DemoSeedResult => {
    d.log("demo.skipped", { reason, ...extra });
    return { seeded: false, reason, ms: ms() };
  };
  if (await d.store.getCompanion(userId)) return { seeded: false, reason: "has_companion", ms: ms() };

  const tplUser = await d.templateUserId();
  if (!tplUser || tplUser === userId) return skip("no_template");
  const tpl = await d.store.getCompanion(tplUser);
  if (!tpl) return skip("no_template");
  if (tpl.prep.status !== "ready") return skip("template_not_ready", { status: tpl.prep.status });
  const img = await d.store.getImage(tpl.imageId);
  if (!img) return skip("template_photo_missing");

  const cid = newId();
  const from = companionDir(tplUser, tpl.id);
  const to = companionDir(userId, cid);
  const keys = await d.blobs.list(from);
  const maxFiles = limits.maxFiles ?? DEMO_MAX_FILES;
  const maxBytes = limits.maxBytes ?? DEMO_MAX_BYTES;
  if (keys.length > maxFiles) return skip("template_too_big", { files: keys.length });

  let bytes = img.bytes.length;
  let imageId: string | null = null;
  try {
    for (const key of keys) {
      const b = await d.blobs.get(key);
      if (!b) throw new Error(`template file vanished: ${key.slice(from.length)}`); // never a ready companion with holes
      bytes += b.length;
      if (bytes > maxBytes) {
        await d.blobs.deletePrefix(to);
        return skip("template_too_big", { bytes });
      }
      await d.blobs.put(to + key.slice(from.length), b, sniffImage(b) ?? "application/octet-stream");
    }
    imageId = newId();
    await d.store.putImage({ ...img.rec, id: imageId, userId, createdAt: new Date().toISOString() }, img.bytes);
    const copy: CompanionRecord = {
      ...structuredClone(tpl),
      id: cid,
      userId,
      imageId,
      name: DEMO_NAME,
      demo: true,
      createdAt: new Date().toISOString(),
      prep: { ...structuredClone(tpl.prep), status: "ready" },
    };
    await d.store.putCompanion(copy);
  } catch (err) {
    await d.blobs.deletePrefix(to).catch(() => {});
    if (imageId) await d.store.deleteImage(userId, imageId).catch(() => {});
    d.log("demo.failed", { message: String(err).slice(0, 200) });
    return { seeded: false, reason: "copy_failed", ms: ms() };
  }
  const out = { seeded: true, companionId: cid, files: keys.length, bytes, ms: ms() };
  d.log("demo.seeded", { companion: cid, files: keys.length, bytes, ms: out.ms });
  return out;
}
