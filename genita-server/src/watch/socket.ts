/**
 * /v1/watch?session=<sessionId> — the Mac's screen-share uplink for one call
 * (PROTOCOL.md "Watch together"). Text = JSON control + frames, binary =
 * the shared screen's sound (PCM s16le mono 24 kHz). Kept off the main call
 * socket so ~100 KB frames never queue in front of mic audio and the mic
 * stream's binary format stays unchanged.
 */
import type { WebSocket } from "ws";
import { PROTOCOL_VERSION, type WatchServerEvent } from "../protocol.ts";
import type { Session } from "../session/session.ts";
import type { WatchSink } from "./watch.ts";

export function attachWatchSocket(ws: WebSocket, session: Session, log: (event: string, data: Record<string, unknown>) => void): void {
  const sink: WatchSink = {
    send: (ev: WatchServerEvent) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(ev)),
    close: (code, reason) => ws.readyState === ws.OPEN && ws.close(code, reason),
  };
  const watch = session.attachWatch(sink);
  if (!watch) {
    sink.send({ type: "error", code: "not_started", message: "The call has not started" });
    return void ws.close(4404, "no call");
  }
  sink.send({ type: "ready", protocol: PROTOCOL_VERSION, sessionId: session.id });
  log("watch.open", { session: session.id });
  ws.on("message", (data, isBinary) => {
    try {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (isBinary) return watch.onAudio(buf);
      let msg: unknown;
      try {
        msg = JSON.parse(buf.toString("utf8"));
      } catch {
        return sink.send({ type: "error", code: "bad_message", message: "Message is not JSON" });
      }
      if (!msg || typeof msg !== "object") return sink.send({ type: "error", code: "bad_message", message: "Message must be an object" });
      watch.onMessage(msg as Record<string, unknown>);
    } catch {
      // A malformed client input must not escape this socket's callback and take down other calls.
      try {
        sink.send({ type: "error", code: "bad_message", message: "Invalid watch message" });
      } catch {
        try {
          ws.terminate();
        } catch {
          // The socket is already unusable; keep this failure scoped to it.
        }
      }
    }
  });
  ws.on("close", () => {
    watch.detach(sink);
    log("watch.close", { session: session.id });
  });
  ws.on("error", () => ws.terminate());
}
