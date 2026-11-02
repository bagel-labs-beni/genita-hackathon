import type { IncomingMessage, ServerResponse } from "node:http";
import { MemoryService } from "./service.ts";
import { imageMime, type UsPhotoInput, type CompanionFaceResolver, UsPhotoService } from "./photos.ts";

export type UserResolver = (req: IncomingMessage) => string | null | Promise<string | null>;
export type MemoryRoutes = { memory: MemoryService; photos?: UsPhotoService; resolveCompanionFace?: CompanionFaceResolver; resolveUser: UserResolver };
export function isMemoryRoute(path: string): boolean { return /^\/(?:v1\/(?:memories(?:\/[^/]+)?|memory-settings|us-photos)|me\/memories\/[^/]+)$/.test(path); }
export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0; const parts: Buffer[] = [];
  for await (const part of req) {
    size += part.length;
    if (size > 2_100_000) throw new Error("body_too_large");
    parts.push(part);
  }
  const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_body");
  return value as Record<string, unknown>;
}

/** Auth is checked by the server BEFORE this handler; identity comes only from
 * its resolver, never query/body/start.user or an X-User-ID header. */
export async function memoryRoute(req: IncomingMessage, res: ServerResponse, url: URL, routes: MemoryRoutes): Promise<void> {
  const userId = await routes.resolveUser(req);
  if (!userId) return json(res, 401, { error: "unauthorized" });
  try {
    if (url.pathname === "/v1/memories" && req.method === "GET") return json(res, 200, { memories: await routes.memory.list(userId) });
    if (/^\/(?:v1|me)\/memories(?:\/[^/]+)?$/.test(url.pathname) && req.method === "DELETE") {
      const id = url.pathname.split("/")[3] ?? url.searchParams.get("id") ?? undefined;
      if (id && !/^mem_[a-f0-9]{32}$/.test(id)) return json(res, 400, { error: "invalid_memory_id" });
      await routes.memory.forget(userId, id);
      res.writeHead(204, { "cache-control": "no-store" }); res.end(); return;
    }
    if (url.pathname === "/v1/memory-settings") {
      if (req.method === "GET") return json(res, 200, await routes.memory.settings(userId));
      if (req.method === "PATCH") {
        const update = await body(req);
        if (!Object.keys(update).length || Object.entries(update).some(([k, v]) => !["rememberSeen", "photosOfUs"].includes(k) || typeof v !== "boolean")) return json(res, 400, { error: "invalid_settings" });
        return json(res, 200, await routes.memory.settings(userId, update));
      }
    }
    if (url.pathname === "/v1/us-photos" && req.method === "POST" && routes.photos) {
      const b = await body(req);
      // Reject all other images/fields: the user's face/room is never forwarded.
      const fields = ["scene_id", "companion_id", "scene_description", "scene_ended", "card_closed"];
      if (Object.keys(b).some((k) => !fields.includes(k)) || typeof b.companion_id !== "string" || !/^[\w-]{1,100}$/.test(b.companion_id)) return json(res, 400, { error: "invalid_photo_input" });
      if (!routes.resolveCompanionFace) return json(res, 503, { error: "companion_storage_unavailable" });
      const face = await routes.resolveCompanionFace(userId, b.companion_id);
      if (!face) return json(res, 404, { error: "companion_not_found" });
      const input: UsPhotoInput = { sceneId: b.scene_id as string, companionFace: face, sceneDescription: b.scene_description as string, sceneEnded: b.scene_ended as boolean, cardClosed: b.card_closed as boolean };
      let result;
      try { result = await routes.photos.generate(userId, input); } catch (err) {
        if (err instanceof Error && err.message === "invalid_photo_input") return json(res, 400, { error: "invalid_photo_input" });
        return json(res, 502, { error: "photo_unavailable" });
      }
      return json(res, 200, result.status === "ready" ? { status: "ready", mime: imageMime(result.image), image_base64: result.image.toString("base64") } : result);
    }
    return json(res, 405, { error: "method_not_allowed" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    json(res, message === "body_too_large" ? 413 : err instanceof SyntaxError || message === "invalid_body" ? 400 : 503, { error: message === "body_too_large" ? message : err instanceof SyntaxError || message === "invalid_body" ? "invalid_body" : "memory_unavailable" });
  }
}
