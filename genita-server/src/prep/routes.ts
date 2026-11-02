/**
 * HTTP routes for onboarding prep (registered from server.ts via one hook).
 *
 *   GET  /v1/import/prompt                  F3-L2  prompt to copy (I01)
 *   POST /v1/import {text, background?}     F3-L2  paste → style card (I03 → I04); background:true → 202
 *   GET  /v1/import                         F3-L2  {status, style} (after "Continue in the background")
 *   POST /v1/companion/image                F2-L20 raw image body (or JSON {image: base64}); ?rights=1
 *   GET  /v1/companion/voices?imageId=      F2-L8  four voices, Spark order
 *   GET  /v1/companion/voices/:id/preview   F2-L8  mp3 (cached)
 *   POST /v1/companion {imageId, voiceId, name?}   F2-L3 subset: create (409 if one exists; a D41 demo one is replaced) + start prep
 *   GET  /v1/companion                      companion + prep + persona + demo
 *   GET  /v1/companion/prep                 F2-L9  {status, progress {done,total}, face (manifest), emotionVideos}
 *   GET  /v1/companion/face/:key            face set image (neutral = scene, blink/smile/warm, visemes), this user's companion only
 *   POST /v1/companion/prep/retry           F2-L9  after `failed`
 *   POST /v1/companion/prefs {depth, answers}      F2-L14 → persona card + SUM lines + session start fields
 *
 * The user comes from server.ts (session JWT → users.id, F1-L5). Without one
 * (shared-token dev mode, tests) it is `x-genita-user` (default "demo").
 * Auth and the AI-consent gate are checked by server.ts before handle().
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { IMPORT_PROMPT, styleProfileText, type StyleCard } from "./importProfile.ts";
import { MAX_IMAGE_BYTES, PrepError, checkImage, importStyle, orderedVoices, savePrefs, voicePreview, type PrepDeps } from "./pipeline.ts";
import { newPrepState, prepView, type PrepRunner } from "./runner.ts";
import { FACE_KEYS, type FaceKey } from "./face.ts";
import { sniffImage } from "./classify.ts";
import type { CompanionRecord } from "./store.ts";

const JSON_LIMIT = 256 * 1024;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new PrepError(413, "body_too_large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const b = await readBody(req, JSON_LIMIT);
  try {
    const v = JSON.parse(b.toString("utf8") || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new PrepError(400, "bad_json");
  }
}

export function userIdOf(req: IncomingMessage): string {
  const h = req.headers["x-genita-user"];
  const id = (Array.isArray(h) ? h[0] : h) ?? "demo";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new PrepError(400, "bad_user");
  return id;
}

const FACE_ASSETS = new Set<string>(["neutral", ...FACE_KEYS]);

/**
 * Session `lip`: Peter for humans only when GENITA_PETER is on; the mouth atlas
 * only on the Kling pipeline; otherwise "none" (the device animates the face set).
 */
function sessionLip(c: CompanionRecord, flags: { peter?: boolean; kling?: boolean }) {
  if (c.type === "human" && flags.peter) return { mode: "peter", fallback: "none", ...(c.prep.steps.lips.avatarId ? { avatarId: c.prep.steps.lips.avatarId } : {}) };
  if (c.type !== "human" && flags.kling) return "atlas";
  return "none";
}

export function companionView(c: CompanionRecord, style: StyleCard | null, flags: { peter?: boolean; kling?: boolean } = {}) {
  return {
    id: c.id,
    type: c.type,
    name: c.name,
    voiceId: c.voiceId,
    imageId: c.imageId,
    createdAt: c.createdAt,
    /** D41: the ready-made judge demo companion; POST /v1/companion replaces it */
    demo: c.demo === true,
    prep: prepView(c),
    prefs: c.prefs ?? null,
    persona: c.persona ?? null,
    /** ready-made fields for the realtime `start` message (PROTOCOL.md) */
    session: c.persona
      ? { persona: c.persona.card, user: { profile: style ? styleProfileText(style) : undefined }, voiceId: c.voiceId, lip: sessionLip(c, flags), peter: prepView(c).lips.peter }
      : null,
  };
}

type ImportJob = { status: "processing" | "failed"; error?: string };

export type PrepRoutes = { handles(req: IncomingMessage): boolean; handle(req: IncomingMessage, res: ServerResponse, userId?: string): Promise<void> };

export function createPrepRoutes(d: PrepDeps, runner: PrepRunner): PrepRoutes {
  const importJobs = new Map<string, ImportJob>();

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, userId?: string) {
    const m = req.method ?? "GET";
    const p = url.pathname.replace(/\/+$/, "");
    const user = userId ?? userIdOf(req);

    if (m === "GET" && p === "/v1/import/prompt") return send(res, 200, { prompt: IMPORT_PROMPT, chars: IMPORT_PROMPT.length });

    if (m === "POST" && p === "/v1/import") {
      const body = await readJson(req);
      const job = importStyle(d, user, body.text);
      if (body.background === true) {
        importJobs.set(user, { status: "processing" });
        job.then(
          () => importJobs.delete(user),
          (err) => importJobs.set(user, { status: "failed", error: err instanceof PrepError ? err.code : "import_failed" }),
        );
        d.log("import.backgrounded", {});
        return send(res, 202, { status: "processing" });
      }
      const style = await job.catch((err) => {
        d.log("import.failed", { reason: err instanceof PrepError ? err.code : String(err).slice(0, 120) });
        throw err;
      });
      return send(res, 200, { status: "ready", style, profile: styleProfileText(style) });
    }

    if (m === "GET" && p === "/v1/import") {
      const j = importJobs.get(user);
      if (j) return send(res, 200, j);
      const style = await d.store.getStyle(user);
      return send(res, 200, style ? { status: "ready", style, profile: styleProfileText(style) } : { status: "none" });
    }

    if (m === "POST" && p === "/v1/companion/image") {
      const ct = req.headers["content-type"] ?? "";
      let bytes: Buffer;
      let rights = url.searchParams.get("rights") === "1";
      if (ct.startsWith("application/json")) {
        const b = await readJson(req).catch(() => ({}) as Record<string, unknown>);
        bytes = Buffer.from(String(b.image ?? "").replace(/^data:[^,]*,/, ""), "base64");
        rights ||= b.rightsAck === true;
      } else bytes = await readBody(req, MAX_IMAGE_BYTES + 1);
      d.log("face.uploaded", { bytes: bytes.length });
      const rec = await checkImage(d, user, bytes, rights);
      return send(res, 200, {
        imageId: rec.id,
        passed: rec.check.passed,
        type: rec.check.type,
        checks: rec.check.checks,
        reasons: rec.check.reasons,
        headBox: rec.headBox,
        ms: rec.ms,
      });
    }

    if (m === "GET" && p === "/v1/companion/voices") {
      const imageId = url.searchParams.get("imageId");
      const img = imageId ? await d.store.getImage(imageId).catch(() => null) : null;
      const kind = img && img.rec.userId === user ? img.rec.check.type : null;
      const r = await orderedVoices(d, user, kind);
      return send(res, 200, {
        voices: r.voices.map((v) =>
          v.locale
            ? { id: v.id, name: v.name, blurb: v.blurb, locale: v.locale, gender: v.gender ?? "neutral", style: v.style ?? "", previewUrl: null }
            : { id: v.id, name: v.name, blurb: v.blurb, previewUrl: `/v1/companion/voices/${v.id}/preview` },
        ),
        suggested: r.suggested,
        ms: r.ms,
      });
    }

    const pv = p.match(/^\/v1\/companion\/voices\/([A-Za-z0-9_%:.-]{1,96})\/preview$/);
    if (m === "GET" && pv) {
      let id = "";
      try {
        id = decodeURIComponent(pv[1]);
      } catch {
        throw new PrepError(404, "unknown_voice");
      }
      const mp3 = await voicePreview(d, id);
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": mp3.length, "cache-control": "public, max-age=86400" });
      return void res.end(mp3);
    }

    if (m === "POST" && p === "/v1/companion") {
      const b = await readJson(req);
      const existing = await d.store.getCompanion(user);
      if (existing && !existing.demo) throw new PrepError(409, "companion_exists", "one companion per user; the face cannot be changed");
      const img = typeof b.imageId === "string" ? await d.store.getImage(b.imageId).catch(() => null) : null;
      if (!img || img.rec.userId !== user) throw new PrepError(404, "unknown_image");
      if (!img.rec.check.passed || !img.rec.check.type) throw new PrepError(422, "image_not_passed");
      const voice = d.voices.find((v) => v.id === b.voiceId);
      if (!voice) throw new PrepError(400, "unknown_voice");
      const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 40) : voice.name;
      const c: CompanionRecord = {
        id: randomUUID().replace(/-/g, ""),
        userId: user,
        imageId: img.rec.id,
        type: img.rec.check.type,
        voiceId: voice.id,
        name,
        createdAt: new Date().toISOString(),
        prep: newPrepState({ kling: d.kling }),
      };
      // B7 keeps one companion per user: a judge's own companion takes the demo one's place, atomically and only
      // if that demo is still there (a concurrent create wins once; the other gets 409). Bad requests never get here.
      if (existing?.demo) {
        if (!(await d.store.replaceDemoCompanion(existing.id, c))) throw new PrepError(409, "companion_exists", "one companion per user; the face cannot be changed");
        d.log("demo.replaced", { companion: existing.id });
      } else await d.store.putCompanion(c);
      d.log("voice.selected", { voice_id: voice.id });
      void runner.run(user);
      return send(res, 201, companionView(c, await d.store.getStyle(user), d));
    }

    if (m === "GET" && p === "/v1/companion") {
      const c = await d.store.getCompanion(user);
      if (!c) throw new PrepError(404, "no_companion");
      return send(res, 200, companionView(c, await d.store.getStyle(user), d));
    }

    if (m === "GET" && p === "/v1/companion/prep") {
      const c = await d.store.getCompanion(user);
      if (!c) throw new PrepError(404, "no_companion");
      return send(res, 200, prepView(c));
    }

    const fk = p.match(/^\/v1\/companion\/face\/([A-Za-z]{1,16})$/);
    if (m === "GET" && fk) {
      if (!FACE_ASSETS.has(fk[1])) throw new PrepError(404, "not_found");
      const c = await d.store.getCompanion(user);
      if (!c) throw new PrepError(404, "no_companion");
      // only images the manifest lists (a rejected key never is)
      if (fk[1] !== "neutral" && c.prep.steps.face?.face?.items[fk[1] as FaceKey]?.status !== "done") throw new PrepError(404, "no_image");
      const bytes = await d.store.getAsset(user, c.id, fk[1]);
      if (!bytes) throw new PrepError(404, "no_image");
      res.writeHead(200, { "content-type": sniffImage(bytes) ?? "application/octet-stream", "content-length": bytes.length, "cache-control": "private, max-age=86400" });
      return void res.end(bytes);
    }

    if (m === "POST" && p === "/v1/companion/prep/retry") {
      const c = await d.store.getCompanion(user);
      if (!c) throw new PrepError(404, "no_companion");
      if (c.prep.status === "ready") return send(res, 200, prepView(c));
      return send(res, 202, prepView(await runner.retry(user)));
    }

    if (m === "POST" && p === "/v1/companion/prefs") {
      const b = await readJson(req);
      const c = await d.store.getCompanion(user);
      if (!c) throw new PrepError(404, "no_companion");
      const next = await savePrefs(d, c, b.depth, b.answers);
      const v = companionView(next, await d.store.getStyle(user), d);
      return send(res, 200, { summary: next.persona!.summary, persona: next.persona!.card, rules: next.persona!.rules, session: v.session });
    }

    throw new PrepError(404, "not_found");
  }

  return {
    handles: (req) => {
      const p = new URL(req.url ?? "/", "http://localhost").pathname;
      return p === "/v1/import" || p.startsWith("/v1/import/") || p === "/v1/companion" || p.startsWith("/v1/companion/");
    },
    async handle(req, res, userId) {
      const url = new URL(req.url ?? "/", "http://localhost");
      try {
        await route(req, res, url, userId);
      } catch (err) {
        if (res.headersSent) return void res.end();
        if (err instanceof PrepError) return send(res, err.status, { error: err.code, message: err.message });
        d.log("prep.http_error", { path: url.pathname, message: String(err).slice(0, 300) });
        send(res, 502, { error: "upstream_failed", retryable: true });
      }
    },
  };
}
