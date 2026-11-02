/**
 * HTTP + WebSocket entry.
 *   GET  /healthz          → {ok:true}
 *   WS   /v1/session       → one realtime conversation (PROTOCOL.md)
 *   *    /v1/finds…        → result cards (finds/http.ts, F10-L6)
 *   WS   /v1/watch?session= → the Mac's screen share for that call (src/watch, F5)
 *
 *   /auth/*, /me[/*]       → accounts (src/auth/routes.ts), when DATABASE_URL is set
 *
 * Threat line: callers are the Genita iOS/macOS apps. Auth is the user's
 * session JWT (F1-L5, `Authorization: Bearer` or `?token=`); the shared
 * GENITA_SESSION_TOKEN stays as a dev fallback (user = x-genita-user). With
 * neither accounts nor a shared token the server binds to loopback only.
 * Users who have not given AI-data consent get 403 on prep routes and a 4403
 * close on the WS, so nothing reaches a third-party model before consent.
 * Limits: maxSessions concurrent, 2 MB per message, maxSessionMs per
 * session, 120 s idle. Vendor keys never leave the server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "./config.ts";
import { Session, type ClientSink, type SessionDeps } from "./session/session.ts";
import { TranscribeStream } from "./meta/transcribe.ts";
import { sparkStream } from "./meta/spark.ts";
import { streamSpeech } from "./tts/elevenlabs.ts";
import { PeterClient } from "./lips/peter.ts";
import { createPrep } from "./prep/index.ts";
import { createAccounts, type AccountsService, type Principal } from "./auth/index.ts";
import { looksLikeJwt } from "./auth/jwt.ts";
import { createMemory } from "./memory/index.ts";
import { isMemoryRoute, memoryRoute } from "./memory/routes.ts";
import { findsFromEnv } from "./finds/setup.ts";
import { handleFindsHttp, isFindsRoute } from "./finds/http.ts";
import { ownerKey } from "./finds/store.ts";
import { attachWatchSocket } from "./watch/socket.ts";

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const IDLE_MS = 120_000;

export type LogFn = (event: string, data: Record<string, unknown>) => void;

export function defaultDeps(config: Config, log: LogFn): SessionDeps {
  return {
    config,
    ...createMemory(config.metaKey, log),
    openAsr: (languages, mode) => new TranscribeStream({ key: config.metaKey, languages, mode }),
    spark: (req, opts) => sparkStream(config.metaKey, req, opts),
    tts: (req) => streamSpeech({ ...req, apiKey: config.elevenKey }),
    // one Peter connection per call = one Modal container = one GPU
    openPeter:
      process.env.GENITA_PETER_URL && process.env.GENITA_PETER_TOKEN
        ? (o) => new PeterClient({ url: process.env.GENITA_PETER_URL!, token: process.env.GENITA_PETER_TOKEN!, avatarId: o?.avatarId })
        : undefined,
    finds: findsFromEnv(config.metaKey),
    log,
  };
}

const bearer = (req: IncomingMessage, url: URL) => req.headers.authorization?.replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";

function sameToken(got: string, expected: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export async function startServer(
  config: Config,
  log: LogFn = () => {},
  deps = defaultDeps(config, log),
  env: NodeJS.ProcessEnv = process.env,
  injected?: AccountsService | null, // tests
): Promise<Server> {
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(config.host);
  const accounts = injected !== undefined ? injected : await createAccounts(env, log, { loopback }); // null without DATABASE_URL
  if (!config.sessionToken && !accounts && !loopback) {
    throw new Error("GENITA_SESSION_TOKEN or DATABASE_URL (accounts) is required when HOST is not loopback");
  }
  const sessions = new Map<string, Session>();
  /** resets a call's idle timer; watch traffic keeps a muted call alive */
  const touches = new Map<string, () => void>();
  const sessionUsers = new Map<string, string>(); // ws session id → users.id
  const prep = createPrep(config, log, env, accounts?.prepStore); // onboarding prep routes (src/prep/routes.ts)
  const devUsers = new Map<string, string>(); // x-genita-user → users.id (dev fallback)
  // memories (and other feature data) live outside Postgres: erased before the account rows, and a
  // failure keeps the account so DELETE /me can be retried
  if (accounts) accounts.beforeUserDeleted = async (userId) => {
    // end the user's calls first so no running card or memory job writes after the erase
    for (const [id, u] of sessionUsers) if (u === userId) sessions.get(id)?.close(4401, "account_deleted");
    await deps.memory?.forget(userId);
    await deps.finds?.store.removeOwner(ownerKey(userId));
  };
  if (accounts) accounts.onUserDeleted = (userId) => {
    for (const [id, u] of sessionUsers) if (u === userId) sessions.get(id)?.close(4401, "account_deleted");
    for (const [name, u] of devUsers) if (u === userId) devUsers.delete(name);
  };

  /** session JWT → user; else the shared dev token (or loopback without one) → x-genita-user. null = reject. */
  async function principal(req: IncomingMessage, url: URL): Promise<Principal | null> {
    const token = bearer(req, url);
    if (accounts && looksLikeJwt(token)) return accounts.verifyToken(token).catch(() => null);
    const devOk = config.sessionToken ? sameToken(token, config.sessionToken) : loopback;
    if (!devOk) return null;
    const h = req.headers["x-genita-user"];
    const name = (Array.isArray(h) ? h[0] : h) ?? "demo";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return null;
    let userId = name;
    if (accounts) {
      userId = devUsers.get(name) ?? (await accounts.accounts.devUserId(name));
      devUsers.set(name, userId);
    }
    return { userId, sid: null, device: "dev", consented: true, kind: "dev" };
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (deps.memory && isMemoryRoute(url.pathname)) {
      // F7/F9 memory REST: same principal as everything else (JWT or dev token), consent first.
      // Before accounts: accounts claims every /me/* path, and DELETE /me/memories/:id is memory's.
      const who = await principal(req, url);
      if (!who) return json(res, 401, { error: "unauthorized" });
      if (!who.consented) return json(res, 403, { error: "consent_required" });
      return memoryRoute(req, res, url, { memory: deps.memory, photos: deps.photos, resolveCompanionFace: deps.resolveCompanionFace, resolveUser: () => who.userId }).catch(() => json(res, 503, { error: "memory_unavailable" }));
    }
    if (deps.finds && isFindsRoute(url.pathname)) {
      // F10-L6 Finds REST: same principal and consent gate; the owner is the account, never a header
      const who = await principal(req, url);
      if (!who) return json(res, 401, { error: "unauthorized" });
      if (!who.consented) return json(res, 403, { error: "consent_required" });
      return handleFindsHttp(req, res, deps.finds.store, who.userId);
    }
    if (accounts?.routes.handles(url.pathname)) return accounts.routes.handle(req, res, await principal(req, url));
    if (!accounts && (url.pathname === "/me" || url.pathname.startsWith("/me/") || url.pathname.startsWith("/auth/"))) return json(res, 503, { error: "accounts_disabled" });
    if (prep.routes.handles(req)) {
      const who = await principal(req, url);
      if (!who) return json(res, 401, { error: "unauthorized" });
      // F1-L8: nothing goes to a third-party AI before consent (the import prompt is static text)
      if (!who.consented && url.pathname !== "/v1/import/prompt") return json(res, 403, { error: "consent_required" });
      return prep.routes.handle(req, res, who.userId);
    }
    if (req.url === "/healthz") return json(res, 200, { ok: true, sessions: sessions.size });
    json(res, 404, { error: "not_found" });
  }

  const http = createServer((req, res) => {
    route(req, res).catch((err) => {
      log("http.error", { path: req.url?.split("?")[0], message: String(err).slice(0, 200) });
      if (!res.headersSent) json(res, 500, { error: "server_error" });
      else res.end();
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname === "/v1/watch") {
      // F5 + 11/2 auth: same principal as the call; only the user who owns the call can share into it.
      // Someone else's session id looks exactly like a missing one (404).
      const id = url.searchParams.get("session") ?? "";
      principal(req, url).then(
        (who) => {
          const session = sessions.get(id);
          if (who && who.consented && (!session || sessionUsers.get(id) !== who.userId)) return reject(404, "Not Found");
          wss.handleUpgrade(req, socket, head, (ws) => {
            ws.on("error", () => ws.terminate());
            if (!who) return ws.close(4401, "unauthorized");
            if (!who.consented) return ws.close(4403, "consent_required");
            ws.on("message", () => touches.get(id)?.());
            attachWatchSocket(ws, session!, log);
          });
        },
        () => reject(500, "Internal Server Error"),
      );
      return;
    }
    if (url.pathname !== "/v1/session") return reject(404, "Not Found");
    if (sessions.size >= config.maxSessions) return reject(503, "Busy");
    principal(req, url).then(
      (who) => {
        // re-check after the async auth: concurrent upgrades all passed the first check (attach is synchronous below)
        if (sessions.size >= config.maxSessions) return reject(503, "Busy");
        wss.handleUpgrade(req, socket, head, (ws) => {
          // a bad frame while closing must not become an unhandled 'error' (that kills the process)
          ws.on("error", () => ws.terminate());
          // F1-L5: close codes the app can act on (4401 → sign in again, 4403 → consent screen)
          if (!who) return ws.close(4401, "unauthorized");
          if (!who.consented) return ws.close(4403, "consent_required");
          attach(ws, who);
        });
      },
      () => reject(500, "Internal Server Error"),
    );
  });

  function attach(ws: WebSocket, who: Principal) {
    const id = randomUUID();
    const sink: ClientSink = {
      sendJson: (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)),
      sendBinary: (b) => ws.readyState === ws.OPEN && ws.send(b, { binary: true }),
      close: (code, reason) => ws.readyState === ws.OPEN && ws.close(code, reason),
    };
    const session = new Session(id, sink, { ...deps, userId: who.userId });
    sessions.set(id, session);
    sessionUsers.set(id, who.userId);
    log("session.open", { session: id, sessions: sessions.size, auth: who.kind });
    let idle = setTimeout(() => session.close(4000, "idle"), IDLE_MS);
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => session.close(4000, "idle"), IDLE_MS);
    };
    touches.set(id, touch);
    const life = setTimeout(() => session.close(4001, "max_duration"), config.maxSessionMs);
    ws.on("message", (data, isBinary) => {
      touch();
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (isBinary) session.onClientAudio(buf);
      else void session.onClientText(buf.toString("utf8")).catch((err) => log("session.error", { session: id, message: String(err).slice(0, 200) }));
    });
    ws.on("close", () => {
      clearTimeout(idle);
      clearTimeout(life);
      session.close();
      sessions.delete(id);
      sessionUsers.delete(id);
      touches.delete(id);
      log("session.close", { session: id, sessions: sessions.size });
    });
    ws.on("error", () => ws.terminate());
  }

  http.on("close", () => void accounts?.close().catch(() => {}));
  return new Promise((resolve) => http.listen(config.port, config.host, () => resolve(http)));
}
