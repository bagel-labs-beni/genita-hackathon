/**
 * App-side product telemetry. The server owns authentication and emits the
 * JSON log line; clients can supply only a small, flat allowlisted payload.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export const APP_EVENT_NAMES = new Set([
  "auth.signed_in", "auth.failed", "consent.accepted", "name.entered", "auth.logged_out", "account.deleted",
  "import.prompt_copied", "import.submitted", "import.applied", "import.failed", "import.backgrounded", "import.cancelled", "import.skipped",
  "prep.progress", "face.uploaded", "face.checked", "face.confirmed", "voice.previewed", "voice.selected", "companion.named", "expressions.started", "expressions.completed", "mouth.started", "mouth.completed", "mouth.failed", "onboarding.ready",
  "setup.depth_selected", "setup.answered", "setup.abandoned", "setup.summary_viewed", "setup.summary_cancelled",
  "call.greeted", "turn.answered", "tts.first_audio", "tts.fallback_device", "tool.called", "utterance.cancelled", "mode.changed", "limit.reached",
  "camera.toggled", "screen.share_started", "screen.share_stopped", "screen.memo_written", "screen.asked", "observe.boxes_shown",
  "find.created", "find.opened", "find.failed", "product.search_started", "product.links_opened",
  "handoff.preparing", "handoff.committed", "handoff.failed", "product.search_handed_off",
  "memory.extracted", "memory.recalled", "interpret.started", "interpret.detected", "interpret.relayed", "app.reopened",
]);

const MAX_EVENTS = 20;
const MAX_PROPS = 8;
const MAX_STRING = 80;
const BODY_LIMIT = 32 * 1024;
const RATE_LIMIT = 120;
const WINDOW_MS = 60_000;
const RESERVED = new Set(["event", "source", "userId"]);

type Rate = { startedAt: number; count: number };
export type EventsRoute = { handles(pathname: string): boolean; handle(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> };

const send = (res: ServerResponse, status: number, body?: unknown) => {
  if (body === undefined) return void res.writeHead(status).end();
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new Error("too_large");
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("bad_json"); }
}

function flatProps(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_PROPS)) {
    if (RESERVED.has(key)) continue;
    if (typeof item === "string" && item.length <= MAX_STRING) out[key] = item;
    else if (typeof item === "number" && Number.isFinite(item)) out[key] = item;
    else if (typeof item === "boolean") out[key] = item;
  }
  return out;
}

export function createEventsRoute(log: (event: string, data: Record<string, unknown>) => void, now = Date.now): EventsRoute {
  const rates = new Map<string, Rate>();
  return {
    handles: (pathname) => pathname === "/v1/events",
    async handle(req, res, userId) {
      if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      let body: unknown;
      try { body = await readJson(req); } catch { return send(res, 400, { error: "bad_json" }); }
      if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray((body as { events?: unknown }).events)) return send(res, 400, { error: "bad_events" });
      const events = (body as { events: unknown[] }).events;
      if (events.length > MAX_EVENTS) return send(res, 400, { error: "too_many_events" });
      if (events.some((event) => !event || typeof event !== "object" || Array.isArray(event) || typeof (event as { name?: unknown }).name !== "string")) return send(res, 400, { error: "bad_events" });

      const at = now();
      const previous = rates.get(userId);
      const rate = !previous || at - previous.startedAt >= WINDOW_MS ? { startedAt: at, count: 0 } : previous;
      if (rate.count + events.length > RATE_LIMIT) return send(res, 429, { error: "rate_limited" });
      rate.count += events.length;
      rates.set(userId, rate);

      let unknown = 0;
      for (const item of events as Array<{ name: string; props?: unknown }>) {
        if (!APP_EVENT_NAMES.has(item.name)) { unknown++; continue; }
        log(item.name, { source: "app", userId, ...flatProps(item.props) });
      }
      if (unknown) log("events.unknown", { source: "app", userId, count: unknown });
      return send(res, 204);
    },
  };
}
