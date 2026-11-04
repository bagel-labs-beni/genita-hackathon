import { homedir } from "node:os";
import { join } from "node:path";
/**
 * HTTP + WebSocket entry.
 *   GET  /healthz          → {ok:true, sessions, spark_open, spark_open_provider, spark_open_model}
 *   WS   /v1/session       → one realtime conversation (PROTOCOL.md)
 *   *    /v1/finds…        → result cards (finds/http.ts, F10-L6)
 *   WS   /v1/watch?session= → the Mac's screen share for that call (src/watch, F5)
 *   GET  /v1/app-config    → copy, flags, tuning, update nudges for the apps (src/appconfig, public: no user data)
 *
 *   /auth/*, /me[/*]       → accounts (src/auth/routes.ts), when DATABASE_URL is set
 *   WS   /v1/presence, /v1/handoff[/claim|/release] → F6-L7 conversation owner (src/handoff/routes.ts)
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
import { forgetProductCache } from "./finds/productCache.ts";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "./config.ts";
import { Session, greetOpenerOn, type ClientSink, type HistoryItem, type SessionDeps } from "./session/session.ts";
import { TranscribeStream } from "./meta/transcribe.ts";
import { sparkStream } from "./meta/spark.ts";
import { META_BASE, metaHeaders } from "./meta/http.ts";
import { setLlmLog, sparkOpenStatus, startSparkOpenProbe } from "./meta/sparkOpen.ts";
import { installKeepAlive, makePrewarm } from "./util/keepalive.ts";
import { createSeamless } from "./tts/seamless.ts";
import { fileClips } from "./tts/clips.ts";
import { DEFAULT_VOICES } from "./prep/voices.ts";
const CURATED_SPEAKERS = DEFAULT_VOICES.map((v) => Number(v.id)).filter((n) => Number.isInteger(n));
import { createVoiceSeats } from "./tts/capacity.ts";
import { createPrep } from "./prep/index.ts";
import { demoTemplateWanted, readDemoPointer, startDemoTemplate } from "./prep/demoTemplate.ts";
import { DEMO_TEMPLATE_SUB } from "./prep/demo.ts";
import { createCompanionReset, guardDemoSeed } from "./prep/reset.ts";
import { likesFromStyle } from "./finds/setup.ts";
import { renameCompanion } from "./prep/naming.ts";
import { createAccounts, type AccountsService, type Principal } from "./auth/index.ts";
import { looksLikeJwt } from "./auth/jwt.ts";
import { createMemory, PgMemoryRepository } from "./memory/index.ts";
import type { ThreadState } from "./memory/call.ts";
import { foldAge, NO_AGE, type AgeSay } from "./convo/minorBoundary.ts";
import { isMemoryRoute, memoryRoute } from "./memory/routes.ts";
import { findsFromEnv } from "./finds/setup.ts";
import { handleFindsHttp, isFindsRoute } from "./finds/http.ts";
import { configureOps, rejectGeneration } from "./ops/limits.ts";
import { ownerKey } from "./finds/store.ts";
import { attachWatchSocket } from "./watch/socket.ts";
import { createEventsRoute } from "./events/routes.ts";
import { HandoffHub } from "./handoff/hub.ts";
import { MemoryOwnershipStore, PgOwnershipStore } from "./handoff/store.ts";
import { forgetOpenerTopics } from "./convo/openerTopics.ts";
import { safetyTurn } from "./convo/forgetInCall.ts";
import { attachPresence, deviceFor, gatedCallDevice, gateCall, handleHandoffHttp, handoffHttpPaths } from "./handoff/routes.ts";
import { createAppConfigSource, handleAppConfig, isAppConfigRoute } from "./appconfig/appConfig.ts";

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const IDLE_MS = 120_000;

export type LogFn = (event: string, data: Record<string, unknown>) => void;

/**
 * Server TTS off: sessions run in device mode and never call this. If one did, it refuses
 * without reaching a vendor; "tts_off" is the session's text-only (no error) path.
 */
async function* serverTtsOff(): AsyncGenerator<never> {
  throw new Error("tts_off");
}

export function defaultDeps(config: Config, log: LogFn): SessionDeps {
  const voice = config.voice ? createSeamless(config.voice, { log, clips: fileClips(join(process.env.GENITA_DATA_DIR || join(homedir(), ".genita-data"), "voice-clips")) }) : null;
  return {
    config,
    ...createMemory(config.metaKey, log),
    openAsr: (languages, mode) => new TranscribeStream({ key: config.metaKey, languages, mode }),
    spark: (req, opts) => sparkStream(config.metaKey, req, opts),
    tts: voice ? (req) => voice.speak(req) : serverTtsOff,
    voicePrefetch: voice ? (speaker) => voice.prefetch(speaker) : undefined,
    // main.ts at boot: render (or load) the cold-GPU lines for the curated speakers, so the first call after a deploy has them
    voiceWarm: voice ? () => { for (const spk of new Set([...CURATED_SPEAKERS, ...Object.values(config.voice!.speakers)])) voice.prefetch(spk); } : undefined,
    greetOpener: greetOpenerOn(),
    // one socket per hedged Spark lane, one to the voice service (kept open by installKeepAlive)
    prewarm: makePrewarm({ metaUrl: META_BASE + "/models", metaHeaders: metaHeaders(config.metaKey, false), lanes: config.sparkHedge, voiceUrl: config.voice ? config.voice.url + "/healthz" : undefined }),
    // Construct once with the process's voice client; all sessions share these seats.
    voiceSeats: voice ? createVoiceSeats(config.voiceMaxCalls ?? 3) : undefined,
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
  if (config.httpKeepAliveMs) log("http.keepalive", { ms: config.httpKeepAliveMs, on: await installKeepAlive(config.httpKeepAliveMs) });
  const accounts = injected !== undefined ? injected : await createAccounts(env, log, { loopback }); // null without DATABASE_URL
  if (!config.sessionToken && !accounts && !loopback) {
    throw new Error("GENITA_SESSION_TOKEN or DATABASE_URL (accounts) is required when HOST is not loopback");
  }
  const ops = configureOps(config, { log, db: accounts?.db });
  // background structured calls → Muse Spark Open on Baseten (meta/sparkOpen.ts); one boot line for partner verification
  setLlmLog(log);
  // boot probe + every 10 min: is the model open to us yet? (llm.spark_open on each change; nothing without a key)
  // uses the env this server was started with (tests pass their own); stopped when the server closes
  const stopSparkOpenProbe = startSparkOpenProbe(env);
  // P0 11/3: without GENITA_MEMORY_FILE, memory lived in this process and every deploy erased it.
  // With accounts on, long-term memory goes to Postgres (migration 005), keyed by users.id.
  if (accounts && deps.memory?.ephemeral) deps.memory.useStore(new PgMemoryRepository(accounts.db));
  if (deps.memory) log("memory.store", { kind: deps.memory.ephemeral ? "process" : deps.memory.repository instanceof PgMemoryRepository ? "pg" : deps.memory.repository.constructor.name });
  const sessions = new Map<string, Session>();
  /** resets a call's idle timer; watch traffic keeps a muted call alive */
  const touches = new Map<string, () => void>();
  const sessionUsers = new Map<string, string>(); // ws session id → users.id
  const prep = createPrep(config, log, env, accounts?.prepStore); // onboarding prep routes (src/prep/routes.ts)
  // About you → "Forget all of this" (AU-92): after the profile row, call memory and summaries, the handed-off turns,
  // opener topics and the product cards made from the old taste go too; the companion stays
  prep.deps.onProfileForgotten = async (userId) => {
    // live calls stop using it at once (their next reply and search), not at the next call (Codex #583 P1)
    for (const [id, u] of sessionUsers) if (u === userId) sessions.get(id)?.profileForgotten();
    dropLastTurns(userId);
    forgetOpenerTopics(userId);
    forgetProductCache(ownerKey(userId), { block: false });
    await deps.memory?.forget(userId);
  };
  // the judge demo copy at sign-in is a companion create: it takes the same lock as POST /v1/companion (Codex #514 P2)
  if (accounts?.seedDemo) accounts.seedDemo = guardDemoSeed(accounts.seedDemo, prep.runner, log);
  // D41: the judge demo template ("Jin") is built by the server itself, in the background after the accounts
  // DB is migrated (007); idempotent, version-stamped, failures only logged (src/prep/demoTemplate.ts)
  const demoTemplate = accounts && demoTemplateWanted(env, accounts.db.kind)
    ? startDemoTemplate({
      templateUser: async (sub) => (await accounts.accounts.upsertUser({ provider: "dev", sub, displayName: "Demo template" })).user.id,
      prep, blobs: accounts.blobs, log,
    })
    : null;
  const events = createEventsRoute(log);
  // F7 product search: the reason chip comes from the account's own import (I04 Likes & dislikes)
  if (deps.finds && !deps.finds.likes) deps = { ...deps, finds: { ...deps.finds, likes: async (userId) => likesFromStyle(await prep.deps.store.getStyle(userId)) } };
  const devUsers = new Map<string, string>(); // x-genita-user → users.id (dev fallback)
  const appConfig = createAppConfigSource({ file: env.GENITA_APP_CONFIG_FILE || null, bargeInMs: config.bargeInMinMs, log });
  // memories (and other feature data) live outside Postgres: erased before the account rows, and a
  // failure keeps the account so DELETE /me can be retried
  // accounts being deleted: a late socket close must not cache their turns again (Codex P2 11/3 — the
  // cascade drops memory_state, so the Forget revision reads 0 again)
  const deletedUsers = new Set<string>();
  if (accounts) accounts.beforeUserDeleted = async (userId) => {
    deletedUsers.add(userId);
    dropLastTurns(userId);
    forgetOpenerTopics(userId); // #341 in-process copy (the DB copy goes with the memory_state cascade)
    try {
      // Includes Finds from ended calls: tombstone, cancel, and drain actual store writes
      // before purging. A late vendor completion must never recreate deleted data.
      const findsDeleted = deps.finds?.store.work.deleteOwner(ownerKey(userId));
      for (const [id, u] of sessionUsers) if (u === userId) sessions.get(id)?.close(4401, "account_deleted");
      await findsDeleted;
      await prep.runner.forgetUser(userId);
      // SUM insight report: the kept paste (memory only) goes, and a write still running lands nowhere
      prep.deps.insights?.forget(userId);
      await deps.memory?.forget(userId);
      await deps.finds?.store.removeOwner(ownerKey(userId));
      // S5 product cache: this account's cards and warm-ups (in memory, keyed by the account)
      forgetProductCache(ownerKey(userId));
    } catch (err) {
      deletedUsers.delete(userId); // the account stays (DELETE /me answers 502 and can be retried)
      throw err;
    }
  };
  // 11/4 "Make a new companion" (src/prep/reset.ts): the companion goes, the account stays. Same stop as DELETE /me
  // (prep / top-up / reflow drained by the runner); then live calls close 4410 and call memory is forgotten.
  const companionReset = createCompanionReset({
    store: prep.deps.store, runner: prep.runner, log, blobs: accounts?.blobs ?? null,
    isProtected: async (userId) => {
      if (!accounts) return false;
      const u = await accounts.accounts.getUser(userId);
      if (u?.provider === "dev" && u.providerSub.startsWith(DEMO_TEMPLATE_SUB)) return true;
      return (await readDemoPointer(accounts.blobs).catch(() => null))?.userId === userId;
    },
    afterErase: async (userId) => {
      // after the rows: an app re-reading /me on 4410 already sees no companion
      for (const [id, u] of sessionUsers) if (u === userId) sessions.get(id)?.close(4410, "companion_reset");
      dropLastTurns(userId);
      forgetOpenerTopics(userId);
      // after the close: its revision bump refuses a late extraction or turn cache from that call; the new companion
      // never met them (AU-90): when they last talked and the carried mood go too
      await deps.memory?.forget(userId, undefined, { relationship: true });
      // ...and it is call 1 with them again (first-call nod and question), what Genita knows about them stays (AU-90)
      // in the profile's per-user lock: a personalize save under way can't write the old count back (Codex AU-90)
      const personalize = deps.personalize ?? prep.deps.personalize;
      if (personalize && "resetGrowth" in personalize) await (personalize as { resetGrowth(u: string): Promise<void> }).resetGrowth(userId);
      else { const style = await prep.deps.store.getStyle(userId); if (style?.growth) await prep.deps.store.putStyle(userId, { ...style, growth: { calls: 0, asked: [] } }); }
    },
  });
  // F6-L7: who holds the sound. conversations.active_device/epoch with accounts, memory without.
  // proximity handoff moves a conversation only while the account has a live call socket
  const handoff = new HandoffHub(accounts ? new PgOwnershipStore(accounts.db) : new MemoryOwnershipStore(), log, {
    liveCall: (userId) => [...sessionUsers].some(([id, u]) => u === userId && sessions.get(id)?.hasStarted === true),
  });
  const presence = new Map<() => void, string>(); // closer → users.id
  if (accounts) accounts.onUserDeleted = (userId) => {
    for (const [id, u] of sessionUsers) if (u === userId) sessions.get(id)?.close(4401, "account_deleted");
    for (const [name, u] of devUsers) if (u === userId) devUsers.delete(name);
    for (const [close, u] of presence) if (u === userId) close();
    handoff.forget(userId);
    dropLastTurns(userId);
  };

  /** session JWT → user; else the shared dev token (or loopback without one) → x-genita-user. null = reject. */
  async function principal(req: IncomingMessage, url: URL): Promise<Principal | null> {
    const token = bearer(req, url);
    if (accounts && looksLikeJwt(token)) return accounts.verifyToken(token).catch(() => null);
    // keyless loopback access is for native apps: a browser page (any Origin header) never gets the dev identity,
    // on HTTP as on WebSocket (a text/plain POST from a page skips CORS preflight)
    const devOk = config.sessionToken ? sameToken(token, config.sessionToken) : loopback && req.headers.origin === undefined;
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
    if (isAppConfigRoute(url.pathname)) return handleAppConfig(req, res, appConfig); // public, before any auth
    if (rejectGeneration(req, res, ops)) return;
    if (events.handles(url.pathname)) {
      const who = await principal(req, url);
      if (!who) return json(res, 401, { error: "unauthorized" });
      if (!who.consented) return json(res, 403, { error: "consent_required" });
      return events.handle(req, res, who.userId);
    }
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
    if (companionReset.handles(url.pathname)) {
      const who = await principal(req, url);
      if (!who) return json(res, 401, { error: "unauthorized" });
      if (!who.consented) return json(res, 403, { error: "consent_required" });
      return companionReset.handle(req, res, who.userId);
    }
    if (prep.routes.handles(req)) {
      const who = await principal(req, url);
      if (!who) return json(res, 401, { error: "unauthorized" });
      // F1-L8: nothing goes to a third-party AI before consent (the import prompt is static text)
      if (!who.consented && url.pathname !== "/v1/import/prompt") return json(res, 403, { error: "consent_required" });
      return prep.routes.handle(req, res, who.userId);
    }
    if (handoffHttpPaths.has(url.pathname)) {
      const who = await principal(req, url);
      if (!who) return json(res, 401, { error: "unauthorized" });
      return handleHandoffHttp(handoff, req, res, url, who.userId, who.device);
    }
    // spark_open: available | not_listed | no_key | unknown | error, + provider/model (never the key)
    if (req.url === "/healthz") return json(res, 200, { ok: true, sessions: sessions.size, ...sparkOpenStatus() });
    json(res, 404, { error: "not_found" });
  }

  const http = createServer((req, res) => {
    // #232: the API is HTTPS-only behind CloudFront (it forwards origin headers); writeHead merges these
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("X-Content-Type-Options", "nosniff");
    route(req, res).catch((err) => {
      log("http.error", { path: req.url?.split("?")[0], message: String(err).slice(0, 200) });
      if (!res.headersSent) json(res, 500, { error: "server_error" });
      else res.end();
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

  http.on("upgrade", (req, socket, head) => {
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return reject(400, "Bad Request");
    }
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
            if (who.kind === "dev" && !config.sessionToken && req.headers.origin !== undefined) return ws.close(4401, "unauthorized");
            if (!who.consented) return ws.close(4403, "consent_required");
            ws.on("message", () => touches.get(id)?.());
            attachWatchSocket(ws, session!, log);
          });
        },
        () => reject(500, "Internal Server Error"),
      );
      return;
    }
    const isPresence = url.pathname === "/v1/presence";
    if (url.pathname !== "/v1/session" && !isPresence) return reject(404, "Not Found");
    if (!isPresence && ops.isPaused("ws.session")) return reject(503, "Paused");
    if (!isPresence && sessions.size >= config.maxSessions) return reject(503, "Busy");
    principal(req, url).then(
      (who) => {
        if (!isPresence && ops.isPaused("ws.session")) return reject(503, "Paused");
        // re-check after the async auth: concurrent upgrades all passed the first check (attach is synchronous below)
        if (!isPresence && sessions.size >= config.maxSessions) return reject(503, "Busy");
        wss.handleUpgrade(req, socket, head, (ws) => {
          // a bad frame while closing must not become an unhandled 'error' (that kills the process)
          ws.on("error", () => ws.terminate());
          // F1-L5: close codes the app can act on (4401 → sign in again, 4403 → consent screen)
          if (!who) return ws.close(4401, "unauthorized");
          // Browser pages can open localhost WebSockets too. Keyless dev access is for native apps.
          if (who.kind === "dev" && !config.sessionToken && req.headers.origin !== undefined) return ws.close(4401, "unauthorized");
          if (isPresence) {
            // presence carries no conversation content, so consent is not needed to know the owner
            const device = deviceFor(who.device, url);
            if (!device) return ws.close(4400, "device_required");
            const close = attachPresence(handoff, ws, who.userId, device, log);
            presence.set(close, who.userId);
            ws.on("close", () => presence.delete(close));
            return;
          }
          if (!who.consented) return ws.close(4403, "consent_required");
          attach(ws, who, gatedCallDevice(who.device, url), who.kind === "dev" && !accounts && !req.headers["x-genita-user"] ? null : who.userId, deviceFor(who.device, url));
        });
      },
      () => reject(500, "Internal Server Error"),
    );
  });

  // Handoff: this account's most advanced live or recently ended call (in memory,
  // one process — same as the audio gate). Never another account's.
  // A new user turn gets a process-wide sequence; assistant writes advance only that turn.
  // Thus a late assistant completion cannot promote an older turn over a newer device's turn.
  type Progress = { turn: number; update: number };
  let nextTurn = 0;
  const progress = new Map<string, Progress>();
  const zero: Progress = { turn: 0, update: 0 };
  const newer = (a: Progress, b: Progress) => a.turn > b.turn || (a.turn === b.turn && a.update > b.update);
  // device + hungUp (demo S5): the same device calling again after its user hung up is a return visit, not a move
  const lastTurns = new Map<string, { turns: HistoryItem[]; thread: ThreadState | null; revision: number | null; progress: Progress; at: number; device: string; hungUp: boolean; gen: number; forgetAsked?: boolean; crisisInCall?: boolean; ageSaid?: AgeSay; unsubscribe?: () => void }>();
  function dropLastTurns(userId: string) {
    lastTurns.get(userId)?.unsubscribe?.();
    lastTurns.delete(userId);
  }
  // Session memory: the thread of the call whose turns priorTurns handed over (read right after it, same tick)
  const handedThread = new Map<string, ThreadState | null>();
  const sessionDevices = new Map<string, string>(); // ws session id → the device the call is on
  // Join order: when a call took up the conversation (its memory start ran priorTurns), not when its socket opened.
  // At equal progress the later joiner is the one that inherited the conversation (Codex 11/3 r7/r8).
  let nextGen = 0;
  /** a same-device return visit's view of the call that just ended (taken once by the new call) */
  const lastCallFor = new Map<string, { turns: HistoryItem[]; threadId: string | null; covered: number }>();
  function lastCall(self: string): { turns: HistoryItem[]; threadId: string | null; covered: number } | null {
    const c = lastCallFor.get(self) ?? null;
    lastCallFor.delete(self);
    return c;
  }
  const sessionGens = new Map<string, number>();
  /** a seeded call that opens later than this after the last one dropped is a reconnect (it says RECONNECT_LINE) */
  const RECONNECT_GAP_MS = 10_000;
  function priorTurns(userId: string, self: string, revision: number, device: string): HistoryItem[] | null {
    // this call joins the conversation now (a slow first memory read can make it join after a later socket)
    sessionGens.set(self, ++nextGen);
    let cached = lastTurns.get(userId);
    if (cached && (cached.revision !== revision || Date.now() - cached.at >= 10 * 60_000)) {
      dropLastTurns(userId);
      cached = undefined;
    }
    let best: HistoryItem[] | null = cached?.turns.length ? cached.turns : null;
    let thread = cached?.thread ?? null;
    let bestProgress = cached?.progress ?? zero;
    // the winner was a call the user hung up on this same device (cached, or stopped with its socket still closing)
    let hungUpHere = !!(best && cached?.hungUp && cached.device === device);
    // where the winning turns came from and how long ago: a drop coming back gets the reconnect line
    let fromDevice = cached?.device ?? null;
    let gapMs = cached ? Date.now() - cached.at : 0;
    let hungUp = !!cached?.hungUp;
    let forgetAsked = !!cached?.forgetAsked;
    let crisisInCall = !!cached?.crisisInCall;
    // Codex #640: a minor's boundary rides the same handoff as the crisis flag
    let ageSaid: AgeSay = cached?.ageSaid ?? NO_AGE;
    // Codex #547 r4: a cached call with no turns left (all forgotten) still had its crisis
    let crisisAny = !!cached && !cached.turns.length && !!cached.crisisInCall;
    let bestGen = cached?.gen ?? 0;
    for (const [sid, u] of sessionUsers) {
      if (u !== userId || sid === self) continue;
      const session = sessions.get(sid);
      if (!session) continue;
      // Codex #547 r3: a crisis in the other device's call goes with the move even when its forgets left no turns
      if (session.crisisInCall) crisisAny = true;
      const t = session.historyForgetRevision === revision ? session.historySnapshot() : null;
      const p = progress.get(sid) ?? zero;
      const g = sessionGens.get(sid) ?? 0;
      // newer progress wins; at equal progress the later-opened call (the one that inherited it) wins
      if (t?.length && (!best || newer(p, bestProgress) || (!newer(bestProgress, p) && g > bestGen))) {
        // A call already stopped (socket still closing) still hands over to the OTHER device (Codex 11/3 r6); a hang-up
        // on this same device is a return visit, exactly like its cached copy will be.
        best = t; thread = session.threadInfo(); bestProgress = p; bestGen = g;
        hungUpHere = session.isClosed && session.endedByUser && sessionDevices.get(sid) === device;
        fromDevice = sessionDevices.get(sid) ?? null; gapMs = 0; hungUp = session.isClosed && session.endedByUser;
        forgetAsked = session.forgetAsked;
        crisisInCall = session.crisisInCall;
        ageSaid = session.ageSaid;
      }
    }
    // a crisis earlier in the conversation goes with it (next device or a quick call-back): no take nudge (Codex #502 P1 r3)
    if ((best && crisisInCall) || crisisAny) { const me = sessions.get(self); if (me) me.crisisInCall = true; }
    // the three age flags as they were (Codex #640 r3: a teen phrase stays a teen phrase, an adult age can still win)
    if (best && (ageSaid.minor || ageSaid.adult || ageSaid.teen)) { const me = sessions.get(self); if (me) me.ageSaid = foldAge(me.ageSaid, ageSaid); }
    // Hung up on this same device and called again: a return visit (greeting + the last call's notes). A call
    // on the OTHER device still continues it, whatever order its stop and the claim arrived in (Codex 11/3).
    if (best && hungUpHere) {
      log("history.not_seeded", { session: self, by: "hang_up" });
      // ...but its last lines go along right away as "the call that just ended" (P1 FILM 11/3): the summary and
      // memories of that call are written in the background and can take longer than a quick call-back
      // a call with a forget request anywhere in it (even before the kept lines) hands over nothing raw (Codex 11/3)
      // Codex #547 r6: after a forget, the call's crisis lines (kept by forgetInCall) still go to the quick call-back
      if (!forgetAsked || crisisInCall || best.some((h, i) => h.role === "user" && safetyTurn(h.text, best![i + 1]?.role === "assistant" ? best![i + 1].text : undefined))) lastCallFor.set(self, { turns: best, threadId: thread?.threadId ?? null, covered: thread?.covered ?? 0 });
      return null;
    }
    if (best) {
      // the conversation carries its forget request with it to the next device (Codex 11/3 #447 r3)
      if (forgetAsked) { const me = sessions.get(self); if (me) me.forgetAsked = true; }
      // same device (a dropped call: a hang-up there never seeds) or a drop on the other device longer than
      // RECONNECT_GAP_MS ago: "Sorry, we got cut off — where were we?". A move to the other device (live, within the
      // gap, or after hanging up there) goes on silently: that's the handoff.
      if (fromDevice === device || (!hungUp && gapMs > RECONNECT_GAP_MS)) {
        const me = sessions.get(self);
        if (me) me.reconnected = true;
        log("history.reconnect", { session: self, sameDevice: fromDevice === device, gapMs: Math.round(gapMs) });
      }
      progress.set(self, bestProgress); // inherit the snapshot's order; seeding is not a new turn
      handedThread.set(self, thread);
      return best;
    }
    return null;
  }
  /**
   * Personalize (P1 11/3, demo S4): this call continues the account's conversation from the OTHER device — a live
   * call there, or one that ended there < 10 min ago. Independent of memory (off or slow) and of `start.handoff`.
   */
  /** Codex #640 r13: the account's age flags from its live calls and the < 10 min cached one (no memory read) */
  function accountAge(userId: string, self: string): AgeSay {
    const cached = lastTurns.get(userId);
    let a: AgeSay = cached && Date.now() - cached.at < 10 * 60_000 && cached.ageSaid ? cached.ageSaid : NO_AGE;
    for (const [sid, u] of sessionUsers) {
      if (u !== userId || sid === self) continue;
      const s = sessions.get(sid);
      if (s) a = foldAge(a, s.ageSaid);
    }
    return a;
  }
  function continuesOtherDevice(userId: string, self: string, device: string): boolean {
    for (const [sid, u] of sessionUsers) {
      if (u === userId && sid !== self && sessionDevices.get(sid) !== device) return true;
    }
    const cached = lastTurns.get(userId);
    return !!cached && cached.turns.length > 0 && cached.device !== device && Date.now() - cached.at < 10 * 60_000;
  }
  function priorThread(self: string): ThreadState | null {
    const t = handedThread.get(self) ?? null;
    handedThread.delete(self);
    return t;
  }
  async function cacheTurns(userId: string, session: Session, device: string, gen = 0): Promise<void> {
    const turns = session.historySnapshot();
    const thread = session.threadInfo();
    const revision = session.historyForgetRevision;
    const p = progress.get(session.id) ?? zero;
    // Codex #547 r4: a call whose forgets left no turns still carries its crisis to the next socket
    if ((!turns.length && !session.crisisInCall) || deletedUsers.has(userId)) return;
    const save = () => {
      const cached = lastTurns.get(userId);
      const now = Date.now();
      // Compare when saving (inside the Forget lock), not before an asynchronous state read.
      // Only a still-valid newer snapshot can block this save.
      // An unchanged inherited snapshot still refreshes retention when its call ends.
      const valid = cached?.revision === revision && now - cached.at < 10 * 60_000;
      if (valid && newer(cached!.progress, p)) return;
      // Same progress = the same conversation point (an idle inherited copy, or the old device closing late):
      // refresh retention but keep who ended it and where (Codex 11/3 r6), so a late old-device close can't
      // turn the iPhone's hang-up into a continuation.
      const same = valid && !newer(p, cached!.progress);
      // ...unless this call opened after the one that wrote the cache: it inherited the conversation, and its
      // own hang-up is the latest word (Codex 11/3 r7)
      const keep = same && cached!.gen > gen;
      const tags = keep ? { device: cached!.device, hungUp: cached!.hungUp, gen: cached!.gen } : { device, hungUp: session.endedByUser, gen };
      dropLastTurns(userId);
      const unsubscribe = deps.memory?.subscribe(userId, () => dropLastTurns(userId));
      lastTurns.set(userId, { turns, thread, revision, progress: p, at: now, ...tags, forgetAsked: session.forgetAsked || (same && !!cached!.forgetAsked), crisisInCall: session.crisisInCall || (same && !!cached!.crisisInCall), ageSaid: same && cached!.ageSaid ? foldAge(session.ageSaid, cached!.ageSaid) : session.ageSaid, unsubscribe });
      log("history.cached", { session: session.id, turns: turns.length });
    };
    if (!deps.memory) return save();
    // Session.close unsubscribes before the socket closes. Keep the snapshot's ORIGINAL revision and
    // refuse a late pre-Forget close, including when newer safe turns are already cached.
    if (revision === null) return;
    await deps.memory.serial(userId, async () => {
      if (!deletedUsers.has(userId) && (await deps.memory!.state.getState(userId)).revision === revision) save();
    });
  }

  function attach(ws: WebSocket, who: Principal, device: ReturnType<typeof gatedCallDevice>, turnUserId: string | null, here: ReturnType<typeof deviceFor>) {
    const id = randomUUID();
    // the device this call is on (a gated call names it; else the principal's)
    const callDevice = device ?? who.device;
    const raw: ClientSink = {
      sendJson: (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)),
      sendBinary: (b) => ws.readyState === ws.OPEN && ws.send(b, { binary: true }),
      close: (code, reason) => ws.readyState === ws.OPEN && ws.close(code, reason),
    };
    // F6-L7: a call that names its device plays only while that device owns the conversation.
    // Calls without a device (older builds, smoke) are not gated.
    const ref: { session?: Session } = {};
    const gated = device ? gateCall(handoff, who.userId, device, raw, () => ref.session?.stopForHandoff()) : null;
    const sink = gated?.sink ?? raw;
    // F2-L26: a rename said in the call is saved to this user's own companion (no-op without one)
    const rename = deps.renameCompanion ?? ((userId: string, name: string) => renameCompanion(prep.deps.store, userId, name));
    // Same presence (11/3): this account's saved companion voice, on the iPhone and the Mac alike
    // one store read for both (AU-53: the stored name wins over the app's cached persona name)
    let companion: ReturnType<typeof prep.deps.store.getCompanion> | undefined;
    const storedCompanion = () => (companion ??= prep.deps.store.getCompanion(who.userId));
    const companionVoiceId = () => storedCompanion().then((c) => c?.voiceId ?? null);
    const companionName = () => storedCompanion().then((c) => c?.name ?? null);
    // Demo S4: an iPhone call may suggest moving to this account's open Mac app
    const macNearby = here === "iphone" ? () => handoff.isPresent(who.userId, "mac") : undefined;
    // lane 개인화: the stored profile, first-call asks, voice corrections and post-call growth for this account
    // D41: judge demo accounts get a per-code daily turn cap (auth/judge.ts), on top of the D46 ops caps
    const turnGate = who.judge && accounts ? accounts.judgeTurns.gate(who.judge) : undefined;
    const session = new Session(id, sink, { ...deps, ops, userId: who.userId, turnUserId, turnGate, renameCompanion: rename, companionVoiceId, companionName,
      priorTurns: (revision) => priorTurns(who.userId, id, revision, callDevice), priorThread: () => priorThread(id), lastCall: () => lastCall(id),
      personalize: deps.personalize ?? prep.deps.personalize, macNearby,
      continuesCall: () => continuesOtherDevice(who.userId, id, callDevice),
      accountAge: () => accountAge(who.userId, id),
      // the reconnect line waits for the start claim and a switch's lease (src/handoff/hub.ts mayPlay), at most 2 s
      untilPlayable: gated ? () => new Promise<boolean>((resolve) => {
        const t0 = Date.now();
        const tick = () => (gated.call.mayPlay() ? resolve(true) : Date.now() - t0 > 2000 ? resolve(false) : void setTimeout(tick, 50).unref?.());
        tick();
      }) : undefined,
      onHistoryChange: (role) => {
        const p = progress.get(id) ?? zero;
        progress.set(id, role === "user" ? { turn: ++nextTurn, update: 0 } : { turn: p.turn, update: p.update + 1 });
      },
    });
    ref.session = session;
    let announced = false;
    let callEnded: (() => void) | null = null;
    let socketClosed = false;
    sessions.set(id, session);
    sessionUsers.set(id, who.userId);
    sessionDevices.set(id, callDevice);
    const gen = ++nextGen;
    sessionGens.set(id, gen);
    log("session.open", { session: id, sessions: sessions.size, auth: who.kind, ...(who.judge ? { judge: who.judge } : {}) });
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
      if (isBinary) {
        // the mic belongs to the owner only
        if (!gated || gated.call.mayPlay()) session.onClientAudio(buf);
        return;
      }
      void session
        .onClientText(buf.toString("utf8"))
        .then(() => {
          // the other device's presence hears `peer.inCall` (Mac home: "Talking on your iPhone" only during a call)
          if (here && !socketClosed && !callEnded && session.hasStarted) callEnded = handoff.callStarted(who.userId, here);
          if (gated && !announced && session.hasStarted) {
            announced = true;
            return gated.call.started();
          }
        })
        .catch((err) => log("session.error", { session: id, message: String(err).slice(0, 200) }));
    });
    ws.on("close", () => {
      clearTimeout(idle);
      clearTimeout(life);
      session.close();
      gated?.call.close();
      socketClosed = true;
      callEnded?.();
      sessions.delete(id);
      sessionUsers.delete(id);
      sessionDevices.delete(id);
      const joined = sessionGens.get(id) ?? gen;
      sessionGens.delete(id);
      handedThread.delete(id);
      lastCallFor.delete(id);
      touches.delete(id);
      void cacheTurns(who.userId, session, callDevice, joined)
        .catch(() => log("history.unavailable", { session: id }))
        .finally(() => log("session.close", { session: id, sessions: sessions.size }));
      progress.delete(id); // cacheTurns captured its immutable progress before its first await
    });
    ws.on("error", () => ws.terminate());
  }

  http.on("close", () => {
    for (const userId of lastTurns.keys()) dropLastTurns(userId);
    void accounts?.close().catch(() => {});
  });
  http.once("close", stopSparkOpenProbe);
  if (demoTemplate) http.once("close", () => demoTemplate.stop());
  return new Promise((resolve) => http.listen(config.port, config.host, () => resolve(http)));
}
