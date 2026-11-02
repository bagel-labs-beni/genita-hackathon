/**
 * App-side product telemetry. The server owns authentication and emits the
 * JSON log line; clients can supply only a small, flat allowlisted payload.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Only events the server cannot see itself. Server-owned events (auth.*, turn.answered, call.greeted, tts.*,
 * limit.reached, onboarding.ready, ...) are logged by the server and are NOT accepted from apps, so a client
 * cannot forge funnel steps or latency numbers.
 */
export const APP_EVENT_NAMES = new Set([
  "import.prompt_copied", "import.submitted", "import.cancelled", "import.skipped",
  "face.confirmed", "voice.previewed",
  "setup.depth_selected", "setup.answered", "setup.abandoned", "setup.summary_viewed", "setup.summary_cancelled",
  "camera.toggled", "screen.share_started", "screen.share_stopped", "screen.asked", "observe.boxes_shown",
  "find.opened", "product.links_opened",
  "handoff.preparing", "handoff.committed", "handoff.failed",
  "app.reopened",
]);

const MAX_EVENTS = 20;
const BODY_LIMIT = 32 * 1024;
const RATE_LIMIT = 120;
const WINDOW_MS = 60_000;
const RESERVED = new Set(["event", "source", "userId"]);
const ID = /^[A-Za-z0-9_-]{1,64}$/;

type PropRule =
  | { type: "enum"; values: readonly string[] }
  | { type: "int" }
  | { type: "bool" }
  | { type: "id" };

/** App telemetry must never carry arbitrary text (or a disguised identifier). */
const APP_PROP_SCHEMA: Record<string, Record<string, PropRule>> = {
  "import.prompt_copied": {},
  "import.submitted": { chars: { type: "int" } },
  "import.cancelled": {},
  "import.skipped": {},
  "face.confirmed": { companionId: { type: "id" } },
  "voice.previewed": { voiceId: { type: "id" } },
  "setup.depth_selected": { depth: { type: "enum", values: ["quick", "full"] } },
  "setup.answered": { step: { type: "int" } },
  "setup.abandoned": { step: { type: "int" } },
  "setup.summary_viewed": {},
  "setup.summary_cancelled": {},
  "camera.toggled": { on: { type: "bool" }, facing: { type: "enum", values: ["front", "back"] } },
  "screen.share_started": {},
  "screen.share_stopped": { seconds: { type: "int" } },
  "screen.asked": {},
  "observe.boxes_shown": { count: { type: "int" } },
  "find.opened": { findId: { type: "id" } },
  "product.links_opened": { findId: { type: "id" }, index: { type: "int" } },
  "handoff.preparing": { to: { type: "enum", values: ["iphone", "mac"] } },
  "handoff.committed": { to: { type: "enum", values: ["iphone", "mac"] }, ms: { type: "int" } },
  "handoff.failed": { reason: { type: "enum", values: ["timeout", "denied", "offline", "other"] } },
  "app.reopened": { gapHours: { type: "int" } },
};

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

function flatProps(event: string, value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const schema = APP_PROP_SCHEMA[event] ?? {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, rule] of Object.entries(schema)) {
    if (RESERVED.has(key)) continue;
    const item = (value as Record<string, unknown>)[key];
    if (rule.type === "bool" && typeof item === "boolean") out[key] = item;
    else if (rule.type === "id" && typeof item === "string" && ID.test(item)) out[key] = item;
    else if (rule.type === "enum" && typeof item === "string" && rule.values.includes(item)) out[key] = item;
    else if (rule.type === "int" && typeof item === "number" && Number.isInteger(item)) out[key] = Math.min(10_000_000, Math.max(0, item));
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
        log(item.name, { source: "app", userId, ...flatProps(item.name, item.props) });
      }
      if (unknown) log("events.unknown", { source: "app", userId, count: unknown });
      return send(res, 204);
    },
  };
}
