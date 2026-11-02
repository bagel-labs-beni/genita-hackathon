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
 * Auth (11/2 unification): server.ts resolves the accounts principal (session
 * JWT, or the dev token + X-Genita-User) before calling in; ?token= also works
 * so image views can load a plain URL. Owner = that account, never a header
 * or start.user.id. Images are served only to the owner of their card.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { ownerKey, type FindsStore } from "./store.ts";

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
export function isFindsRoute(pathname: string): boolean {
  return pathname === "/v1/finds" || pathname.startsWith("/v1/finds/");
}

/** `userId` = the authenticated account (server.ts principal()). */
export async function handleFindsHttp(req: IncomingMessage, res: ServerResponse, store: FindsStore, userId: string): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  await route(req, res, url, store, ownerKey(userId.slice(0, 128))).catch(() => send(res, 400, { error: "bad_request" }));
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL, store: FindsStore, owner: string) {
  const parts = url.pathname.split("/").filter(Boolean).slice(2); // after v1/finds
  const method = req.method ?? "GET";

  // only the owner of the card gets its pictures
  if (parts.length === 3 && parts[1] === "images" && method === "GET") {
    if (!(await store.get(owner, parts[0]))) return send(res, 404, { error: "not_found" });
    const img = await store.getImage(parts[0], parts[2]);
    if (!img) return send(res, 404, { error: "not_found" });
    res.writeHead(200, { "content-type": img.mime, "content-length": img.bytes.length, "cache-control": "private, max-age=86400" });
    return res.end(img.bytes);
  }
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
