/**
 * F6-L7 · wiring of the conversation layer into the server (server.ts calls these).
 *
 *   WS   /v1/presence?device=iphone|mac   one per app while it runs (PROTOCOL.md "Handoff")
 *   GET  /v1/handoff                      → {owner, epoch, conversationId}
 *   POST /v1/handoff/claim   {device, epoch?, trigger?}
 *   POST /v1/handoff/release {device, epoch?}
 *   /v1/session?device=…                  the call socket: audio only while this device owns it
 *
 * Threat line: callers are the user's own Genita apps; auth is the same principal as /v1/session
 * (session JWT, or the dev token on loopback). A user can only read or move their own
 * conversation (keyed by users.id). Limits: 4 KB HTTP bodies, 8 KB presence messages, epoch fits
 * int4, presence sockets are pinged every 2 s and dropped after 6 s of silence. Nothing about the
 * conversation's content is exposed — only owner, epoch and the other device's online state.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebSocket } from "ws";
import type { ClientSink } from "../session/session.ts";
import { HandoffHub, type CallHandle, type Trigger } from "./hub.ts";
import { asDevice, validEpoch, type HandoffDevice } from "./rules.ts";

const TRIGGERS: Trigger[] = ["button", "touch", "continue", "start", "sync", "move", "proximity"];
const MAX_PRESENCE_BYTES = 8 * 1024;
const MAX_BODY_BYTES = 4 * 1024;
const HEARTBEAT_MS = 2000;
const DEAD_AFTER_MS = 6000;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** Which device a presence socket is: the JWT's device when it is iphone/mac, else `?device=`. */
export function deviceFor(principalDevice: string, url: URL): HandoffDevice | null {
  return asDevice(principalDevice) ?? asDevice(url.searchParams.get("device"));
}

/**
 * A call is gated only when it opts in with `?device=` (a build that also runs the presence client).
 * The JWT's device alone does not gate it: an older build with a signed-in token keeps its sound.
 */
export function gatedCallDevice(principalDevice: string, url: URL): HandoffDevice | null {
  const asked = asDevice(url.searchParams.get("device"));
  return asked ? (asDevice(principalDevice) ?? asked) : null;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export const handoffHttpPaths = new Set(["/v1/handoff", "/v1/handoff/claim", "/v1/handoff/release"]);

export async function handleHandoffHttp(hub: HandoffHub, req: IncomingMessage, res: ServerResponse, url: URL, userId: string, principalDevice: string) {
  if (url.pathname === "/v1/handoff") {
    if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
    const r = await hub.current(userId);
    return json(res, 200, { owner: r.owner, epoch: r.epoch, conversationId: r.conversationId });
  }
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  const body = await readBody(req);
  if (!body) return json(res, 400, { error: "bad_body" });
  const device = asDevice(body.device) ?? asDevice(principalDevice);
  const epoch = body.epoch === undefined || body.epoch === null ? null : validEpoch(body.epoch);
  if (!device || (body.epoch != null && epoch === null)) return json(res, 400, { error: "bad_claim" });
  const trigger = TRIGGERS.includes(body.trigger as Trigger) ? (body.trigger as Trigger) : "button";
  const out = url.pathname === "/v1/handoff/claim" ? await hub.claimHttp(userId, device, epoch, trigger) : await hub.releaseHttp(userId, device, epoch);
  return json(res, 200, { accepted: out.accepted, owner: out.state.owner, epoch: out.state.epoch, conversationId: out.state.conversationId });
}

/** One app's presence socket. Returns a closer for account deletion. */
export function attachPresence(hub: HandoffHub, ws: WebSocket, userId: string, device: HandoffDevice, log: (e: string, d: Record<string, unknown>) => void): () => void {
  const send = (m: Record<string, unknown>) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  const handle = hub.connect(userId, { device, send });
  let lastSeen = Date.now();
  const beat = setInterval(() => {
    if (Date.now() - lastSeen > DEAD_AFTER_MS) return ws.terminate();
    if (ws.readyState === ws.OPEN) ws.ping();
  }, HEARTBEAT_MS);
  ws.on("pong", () => (lastSeen = Date.now()));
  ws.on("message", (data, isBinary) => {
    lastSeen = Date.now();
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (isBinary || buf.length > MAX_PRESENCE_BYTES) return send({ type: "error", code: "bad_message" });
    let m: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(buf.toString("utf8"));
      if (!v || typeof v !== "object" || Array.isArray(v)) return send({ type: "error", code: "bad_message" });
      m = v as Record<string, unknown>;
    } catch {
      return send({ type: "error", code: "bad_message" });
    }
    const epoch = m.epoch === undefined || m.epoch === null ? null : validEpoch(m.epoch);
    if (m.epoch != null && epoch === null) return send({ type: "error", code: "bad_epoch" });
    const trigger = TRIGGERS.includes(m.trigger as Trigger) ? (m.trigger as Trigger) : "button";
    const fail = (err: unknown) => {
      log("handoff.error", { message: String(err).slice(0, 200) });
      send({ type: "error", code: "server_error" });
    };
    switch (m.type) {
      case "hello":
        if (typeof m.active === "boolean") handle.setActive(m.active);
        return void handle.hello({ owner: m.owner, epoch: m.epoch }).catch(fail);
      case "claim":
        return void handle.claim(epoch, trigger).catch(fail);
      case "release":
        return void handle.release(epoch).catch(fail);
      case "move.request": {
        const to = asDevice(m.to);
        if (!to) return send({ type: "error", code: "bad_message" });
        return handle.moveRequest(to);
      }
      case "presence":
        if (typeof m.active === "boolean") handle.setActive(m.active);
        return;
      case "proximity.arm":
        return void handle.proximityArm().catch(fail);
      case "proximity.disarm":
        return handle.proximityDisarm();
      case "proximity.seen":
        return void handle.proximitySeen(m.token, m.requestId).catch(fail);
      case "ping":
        return send({ type: "pong", t: m.t ?? null });
      default:
        return send({ type: "error", code: "unknown_type" });
    }
  });
  ws.on("close", () => {
    clearInterval(beat);
    handle.close();
  });
  ws.on("error", () => ws.terminate());
  return () => ws.close(4401, "account_deleted");
}

/**
 * The call socket's side of the gate. Audio frames (and their `audio` timing events) and device-voice
 * `say` lines (#157: the app speaks those itself) reach the device only while it owns the conversation; the mic is ignored while it doesn't. Everything
 * else (captions, state) still flows so the app stays in sync.
 */
export function gateCall(hub: HandoffHub, userId: string, device: HandoffDevice, sink: ClientSink, stop: () => void): { sink: ClientSink; call: CallHandle } {
  const call = hub.attachCall(userId, device, { stop, send: (m) => sink.sendJson(m as never) });
  return {
    call,
    sink: {
      sendJson: (m) => {
        if ((m.type === "audio" || m.type === "say") && !call.mayPlay()) return;
        sink.sendJson(m);
      },
      sendBinary: (b) => {
        if (call.mayPlay()) sink.sendBinary(b);
      },
      close: (code, reason) => sink.close(code, reason),
    },
  };
}
