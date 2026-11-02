/**
 * HTTP + WebSocket entry.
 *   GET  /healthz          → {ok:true}
 *   WS   /v1/session       → one realtime conversation (PROTOCOL.md)
 *
 * Threat line: callers are the Genita iOS/macOS apps. Auth is a shared
 * bearer token (GENITA_SESSION_TOKEN) until the login ticket lands; with no
 * token configured the server refuses to bind anywhere but loopback.
 * Limits: maxSessions concurrent, 2 MB per message, maxSessionMs per
 * session, 120 s idle. Nothing is stored; vendor keys never leave the server.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "./config.ts";
import { Session, type ClientSink, type SessionDeps } from "./session/session.ts";
import { TranscribeStream } from "./meta/transcribe.ts";
import { sparkStream } from "./meta/spark.ts";
import { streamSpeech } from "./tts/elevenlabs.ts";
import { PeterClient } from "./lips/peter.ts";
import { createPrep } from "./prep/index.ts";

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const IDLE_MS = 120_000;

export type LogFn = (event: string, data: Record<string, unknown>) => void;

export function defaultDeps(config: Config, log: LogFn): SessionDeps {
  return {
    config,
    openAsr: (languages) => new TranscribeStream({ key: config.metaKey, languages }),
    spark: (req, opts) => sparkStream(config.metaKey, req, opts),
    tts: (req) => streamSpeech({ ...req, apiKey: config.elevenKey }),
    // one Peter connection per call = one Modal container = one GPU
    openPeter:
      process.env.GENITA_PETER_URL && process.env.GENITA_PETER_TOKEN
        ? (o) => new PeterClient({ url: process.env.GENITA_PETER_URL!, token: process.env.GENITA_PETER_TOKEN!, avatarId: o?.avatarId })
        : undefined,
    log,
  };
}

function tokenOk(req: IncomingMessage, url: URL, expected: string | null): boolean {
  if (!expected) return true;
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const got = header || url.searchParams.get("token") || "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startServer(config: Config, log: LogFn = () => {}, deps = defaultDeps(config, log)): Promise<Server> {
  if (!config.sessionToken && !["127.0.0.1", "::1", "localhost"].includes(config.host)) {
    throw new Error("GENITA_SESSION_TOKEN is required when HOST is not loopback");
  }
  const sessions = new Map<string, Session>();
  const prep = createPrep(config, log); // onboarding prep routes (src/prep/routes.ts)
  const http = createServer((req, res) => {
    if (prep.routes.handles(req)) {
      if (!tokenOk(req, new URL(req.url ?? "/", "http://localhost"), config.sessionToken)) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      return void prep.routes.handle(req, res);
    }
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== "/v1/session") return reject(404, "Not Found");
    if (!tokenOk(req, url, config.sessionToken)) return reject(401, "Unauthorized");
    if (sessions.size >= config.maxSessions) return reject(503, "Busy");
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws));
  });

  function attach(ws: WebSocket) {
    const id = randomUUID();
    const sink: ClientSink = {
      sendJson: (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)),
      sendBinary: (b) => ws.readyState === ws.OPEN && ws.send(b, { binary: true }),
      close: (code, reason) => ws.readyState === ws.OPEN && ws.close(code, reason),
    };
    const session = new Session(id, sink, deps);
    sessions.set(id, session);
    log("session.open", { session: id, sessions: sessions.size });
    let idle = setTimeout(() => session.close(4000, "idle"), IDLE_MS);
    const life = setTimeout(() => session.close(4001, "max_duration"), config.maxSessionMs);
    ws.on("message", (data, isBinary) => {
      clearTimeout(idle);
      idle = setTimeout(() => session.close(4000, "idle"), IDLE_MS);
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (isBinary) session.onClientAudio(buf);
      else void session.onClientText(buf.toString("utf8")).catch((err) => log("session.error", { session: id, message: String(err).slice(0, 200) }));
    });
    ws.on("close", () => {
      clearTimeout(idle);
      clearTimeout(life);
      session.close();
      sessions.delete(id);
      log("session.close", { session: id, sessions: sessions.size });
    });
    ws.on("error", () => ws.terminate());
  }

  return new Promise((resolve) => http.listen(config.port, config.host, () => resolve(http)));
}
