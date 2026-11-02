/**
 * F10-L6 · Finds REST (the Finds tab and "reopen from Finds"):
 *   GET    /v1/finds                       → {finds: FindCard[]}  saved first, then newest
 *   GET    /v1/finds/:id                   → {find}
 *   DELETE /v1/finds/:id                   → soft delete (Undo window)
 *   POST   /v1/finds/:id/restore           → undo the delete
 *   POST   /v1/finds/:id/save  {saved}     → pin to the top
 *   GET    /v1/finds/:id/images/:slot      → illustration bytes
 *   DELETE /v1/finds                       → account deletion: everything for this owner
 *
 * Auth: the same bearer token as the WebSocket (?token= also works so image
 * views can load a plain URL). Owner: `X-Genita-User` header (or ?user=),
 * the same id the app sends in start.user.id; replaced by the login JWT in
 * F1-L5. Without an owner the list is empty.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { ownerKey, type FindsStore } from "./store.ts";

function authorized(req: IncomingMessage, url: URL, expected: string | null): boolean {
  if (!expected) return true;
  const got = (req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "") || url.searchParams.get("token") || "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, max = 4096): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > max) throw new Error("body too large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return v && typeof v === "object" ? v : {};
}

/** Returns true when the request was a /v1/finds route (handled, even if with an error). */
export function handleFindsHttp(req: IncomingMessage, res: ServerResponse, store: FindsStore, token: string | null): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/v1/finds" && !url.pathname.startsWith("/v1/finds/")) return false;
  void route(req, res, url, store, token).catch(() => send(res, 400, { error: "bad_request" }));
  return true;
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL, store: FindsStore, token: string | null) {
  if (!authorized(req, url, token)) return send(res, 401, { error: "unauthorized" });
  const rawOwner = (req.headers["x-genita-user"] as string | undefined) ?? url.searchParams.get("user") ?? "";
  const owner = rawOwner ? ownerKey(rawOwner.slice(0, 128)) : null;
  const parts = url.pathname.split("/").filter(Boolean).slice(2); // after v1/finds
  const method = req.method ?? "GET";

  // images are addressed by the unguessable find id; token still required
  if (parts.length === 3 && parts[1] === "images" && method === "GET") {
    const img = await store.getImage(parts[0], parts[2]);
    if (!img) return send(res, 404, { error: "not_found" });
    res.writeHead(200, { "content-type": img.mime, "content-length": img.bytes.length, "cache-control": "private, max-age=86400" });
    return res.end(img.bytes);
  }
  if (!owner) return parts.length === 0 && method === "GET" ? send(res, 200, { finds: [] }) : send(res, 400, { error: "missing_user" });

  if (parts.length === 0) {
    if (method === "GET") return send(res, 200, { finds: await store.list(owner) });
    if (method === "DELETE") return send(res, 200, { deleted: await store.removeOwner(owner) });
  }
  if (parts.length === 1) {
    if (method === "GET") {
      const f = await store.get(owner, parts[0]);
      return f ? send(res, 200, { find: f }) : send(res, 404, { error: "not_found" });
    }
    if (method === "DELETE") return (await store.remove(owner, parts[0])) ? send(res, 200, { ok: true, undo: `/v1/finds/${parts[0]}/restore` }) : send(res, 404, { error: "not_found" });
  }
  if (parts.length === 2 && method === "POST") {
    if (parts[1] === "restore") return (await store.restore(owner, parts[0])) ? send(res, 200, { ok: true }) : send(res, 404, { error: "not_found" });
    if (parts[1] === "save") {
      const body = await readJson(req);
      return (await store.setSaved(owner, parts[0], body.saved !== false)) ? send(res, 200, { ok: true }) : send(res, 404, { error: "not_found" });
    }
  }
  return send(res, 405, { error: "method_not_allowed" });
}
