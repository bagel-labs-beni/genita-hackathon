/**
 * HTTP routes for onboarding prep (registered from server.ts via one hook).
 *
 *   GET  /v1/import/prompt                  F3-L2  prompt to copy (I01)
 *   POST /v1/import {text, background?}     F3-L2  paste → style card (I03 → I04); background:true → 202
 *   POST /v1/import/skip {interests, replies, avoid}  N1–N3 → style card, no Spark call
 *   GET  /v1/import                         F3-L2  {status, style} (after "Continue in the background")
 *   POST /v1/companion/image                F2-L20 raw image body (or JSON {image: base64}); ?rights=1
 *   GET  /v1/companion/voices?imageId=      F2-L8  4–6 curated voices for the look, recommended first; available = voice service up
 *   GET  /v1/companion/voices/:id/preview   F2-L8  WAV (cached); device voices → 404 device_preview
 *   PUT  /v1/companion/voice {voiceId}      V04: the picked voice is saved on the companion (404 no companion, 400 unknown_voice)
 *   POST /v1/companion {imageId, voiceId, name?}   F2-L3 subset: create (409 if one exists) + start prep
 *   POST /v1/companion/name/suggest {imageId}      F2-L26 NM01 pre-fill: Spark → {name, ms, suggested} (10/min/user)
 *   PATCH /v1/companion {name}              F2-L26 rename (1–20 chars, else 400 bad_name)
 *   GET  /v1/companion                      companion + prep + persona
 *   GET  /v1/companion/prep                 F2-L9  {status, progress {done,total}, face (manifest), emotionVideos}
 *   GET  /v1/companion/face/:key            face set image (neutral = scene, blink/smile/warm, visemes, mouth keys) or
 *                                           face-flow asset (flow_*: ROI keys, float16 flows, mask), this user's companion only
 *   POST /v1/companion/prep/retry           F2-L9  after `failed`
 *   POST /v1/companion/prefs {depth, answers}      F2-L14 → persona card + SUM lines + session start fields
 *   GET  /v1/profile/story?wait=s           D47 HISY story cards (wait ≤ 10 s for one being written)
 *   PATCH /v1/profile {cardId, pick?, text?}  D47 "That's not me" → updated card + ack (10/min/user)
 *
 * The user comes from server.ts (session JWT → users.id, F1-L5). Without one
 * (shared-token dev mode, tests) it is `x-genita-user` (default "demo").
 * Auth and the AI-consent gate are checked by server.ts before handle().
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { IMPORT_PROMPT, skipStyleCard, styleProfileText, type StyleCard } from "./importProfile.ts";
import { MAX_IMAGE_BYTES, PrepError, checkImage, importStyle, orderedVoices, savePrefs, voicePreview, type PrepDeps } from "./pipeline.ts";
import { needsFaceSet, newPrepState, prepView, type PrepRunner } from "./runner.ts";
import { ALL_FACE_KEYS, type FaceKey } from "./face.ts";
import { flowAssets } from "./faceflow.ts";
import { sniffImage } from "./classify.ts";
import type { CompanionRecord } from "./store.ts";
import { cleanName, renameCompanion, suggestName } from "./naming.ts";
import { PersonalizeError } from "../personalize/service.ts";
import { getOps } from "../ops/limits.ts";

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

const FACE_ASSETS = new Set<string>(["neutral", "person", ...ALL_FACE_KEYS]);

/** All companion kinds animate the Meta face set on the device. */
function sessionLip(_c: CompanionRecord): "none" {
  return "none";
}

export function companionView(c: CompanionRecord, style: StyleCard | null) {
  return {
    id: c.id,
    type: c.type,
    name: c.name,
    voiceId: c.voiceId,
    imageId: c.imageId,
    createdAt: c.createdAt,
    prep: prepView(c),
    prefs: c.prefs ?? null,
    persona: c.persona ?? null,
    /** ready-made fields for the realtime `start` message (PROTOCOL.md) */
    session: c.persona
      ? { persona: c.persona.card, user: { profile: style ? styleProfileText(style) : undefined }, voiceId: c.voiceId, lip: sessionLip(c) }
      : null,
  };
}

type ImportJob = { status: "processing" | "failed"; error?: string };

export type PrepRoutes = { handles(req: IncomingMessage): boolean; handle(req: IncomingMessage, res: ServerResponse, userId?: string): Promise<void> };

/** suggest is a Spark call: at most 10 per user per rolling minute */
const SUGGEST_PER_MIN = 10;
/** a profile correction is up to two Spark calls: same budget */
const CORRECT_PER_MIN = 10;
const STORY_WAIT_MAX_S = 10;
/** a story read can start a Spark write: 20 reads per user per minute (the app polls at most 3 times) */
const STORY_PER_MIN = 20;
const PROFILE_JSON_LIMIT = 2048;

export function createPrepRoutes(d: PrepDeps, runner: PrepRunner): PrepRoutes {
  const importJobs = new Map<string, ImportJob>();
  const limiter = (perMin: number) => {
    const hitsBy = new Map<string, number[]>();
    return (user: string) => {
      const now = Date.now();
      const hits = (hitsBy.get(user) ?? []).filter((t) => now - t < 60_000);
      const ok = hits.length < perMin;
      if (ok) hits.push(now);
      hitsBy.set(user, hits);
      if (hitsBy.size > 10_000) for (const [k, v] of hitsBy) if (!v.some((t) => now - t < 60_000)) hitsBy.delete(k);
      return ok;
    };
  };
  const allowSuggest = limiter(SUGGEST_PER_MIN);
  const allowCorrect = limiter(CORRECT_PER_MIN);
  const allowStory = limiter(STORY_PER_MIN);

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
      return send(res, 200, { status: "ready", style, profile: styleProfileText(style), story: style.story?.cards ?? null });
    }

    if (m === "POST" && p === "/v1/import/skip") {
      const r = skipStyleCard(await readJson(req));
      if (!r.ok) throw new PrepError(400, "bad_skip", "Pick up to 8 short answers.");
      if (d.personalize) await d.personalize.replaceStyle(user, r.card);
      else await d.store.putStyle(user, r.card);
      d.log("import.skipped", { item_count: r.card.itemCount, partial: r.card.partial });
      return send(res, 200, { status: "ready", style: r.card, profile: styleProfileText(r.card) });
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
      let uploadedAt: number;
      let rights = url.searchParams.get("rights") === "1";
      if (ct.startsWith("application/json")) {
        const b = await readJson(req).catch(() => ({}) as Record<string, unknown>);
        uploadedAt = Date.now();
        bytes = Buffer.from(String(b.image ?? "").replace(/^data:[^,]*,/, ""), "base64");
        rights ||= b.rightsAck === true;
      } else {
        bytes = await readBody(req, MAX_IMAGE_BYTES + 1);
        uploadedAt = Date.now();
      }
      // D26 / SUB-8 (#125): the V01 line "I have the right to use this image" must be on; no ack, no check, nothing stored.
      if (!rights) {
        d.log("face.rejected", { reason: "rights_required" });
        throw new PrepError(400, "rights_required", "Confirm you have the right to use this image.");
      }
      const uploadAt = new Date(uploadedAt).toISOString();
      if (!await getOps().reserveUpload(user)) return send(res, 429, { error: "limit_reached", limit: "user_uploads" });
      const rec = await checkImage(d, user, bytes, rights, uploadAt);
      d.log("face.uploaded", { imageId: rec.id, userId: user, bytes: bytes.length, check_ms: rec.ms.check, at: uploadAt });
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
            : { id: v.id, name: v.name, blurb: v.blurb, label: `${v.name} · ${v.blurb.split(",")[0].toLowerCase()}`, ...(v.gender ? { gender: v.gender } : {}), previewUrl: `/v1/companion/voices/${v.id}/preview` },
        ),
        suggested: r.suggested,
        available: r.available,
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
      const wav = await voicePreview(d, id);
      res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length, "cache-control": "public, max-age=86400" });
      return void res.end(wav);
    }

    if (m === "PUT" && p === "/v1/companion/voice") {
      const b = await readJson(req);
      const voice = typeof b.voiceId === "string" ? d.voices.find((v) => v.id === b.voiceId) : undefined;
      if (!voice) throw new PrepError(400, "unknown_voice");
      const c = await d.store.patchCompanion(user, (x) => ({
        ...x,
        voiceId: voice.id,
        persona: x.persona ? { ...x.persona, card: { ...x.persona.card, voice: { id: voice.id } } } : x.persona,
      }));
      if (!c) throw new PrepError(404, "no_companion");
      d.log("voice.selected", { voice_id: voice.id });
      return send(res, 200, companionView(c, await d.store.getStyle(user)));
    }

    if (m === "POST" && p === "/v1/companion") {
      const b = await readJson(req);
      if (await d.store.getCompanion(user)) throw new PrepError(409, "companion_exists", "one companion per user; the face cannot be changed");
      const img = typeof b.imageId === "string" ? await d.store.getImage(b.imageId).catch(() => null) : null;
      if (!img || img.rec.userId !== user) throw new PrepError(404, "unknown_image");
      if (!img.rec.check.passed || !img.rec.check.type) throw new PrepError(422, "image_not_passed");
      const voice = d.voices.find((v) => v.id === b.voiceId);
      if (!voice) throw new PrepError(400, "unknown_voice");
      // F2-L26: same rule as PATCH (blank → the voice card name, invalid → 400)
      const given = typeof b.name === "string" && b.name.trim() ? cleanName(b.name) : undefined;
      if (given === null) throw new PrepError(400, "bad_name", "name must be 1–20 letters");
      const name = given ?? voice.name;
      const c: CompanionRecord = {
        id: randomUUID().replace(/-/g, ""),
        userId: user,
        imageId: img.rec.id,
        type: img.rec.check.type,
        voiceId: voice.id,
        name,
        createdAt: new Date().toISOString(),
        prep: newPrepState(),
      };
      await d.store.putCompanion(c);
      d.log("voice.selected", { companionId: c.id, userId: user, voice_id: voice.id });
      d.log("companion.named", { companionId: c.id, userId: user });
      d.log("companion.created", { companionId: c.id, userId: user, imageId: c.imageId });
      void runner.run(user);
      return send(res, 201, companionView(c, await d.store.getStyle(user)));
    }

    if (m === "POST" && p === "/v1/companion/name/suggest") {
      if (!allowSuggest(user)) throw new PrepError(429, "rate_limited", "try again in a minute");
      const b = await readJson(req);
      const r = await suggestName(d, user, b.imageId);
      return send(res, 200, { name: r.name, ms: r.ms, suggested: r.suggested });
    }

    if (m === "PATCH" && p === "/v1/companion") {
      const b = await readJson(req);
      const name = cleanName(b.name);
      if (!name) throw new PrepError(400, "bad_name", "name must be 1–20 letters");
      const next = await renameCompanion(d.store, user, name);
      if (!next) throw new PrepError(404, "no_companion");
      d.log("companion.named", { by: "app", chars: [...name].length });
      return send(res, 200, companionView(next, await d.store.getStyle(user)));
    }

    if (m === "GET" && p === "/v1/companion") {
      const c = await d.store.getCompanion(user);
      if (!c) throw new PrepError(404, "no_companion");
      return send(res, 200, companionView(c, await d.store.getStyle(user)));
    }

    if (m === "GET" && p === "/v1/companion/prep") {
      const c = await d.store.getCompanion(user);
      if (!c) throw new PrepError(404, "no_companion");
      return send(res, 200, prepView(c));
    }

    const fk = p.match(/^\/v1\/companion\/face\/([A-Za-z0-9_]{1,24})$/);
    if (m === "GET" && fk) {
      const isFlow = fk[1].startsWith("flow_");
      if (!isFlow && !FACE_ASSETS.has(fk[1])) throw new PrepError(404, "not_found");
      const c = await d.store.getCompanion(user);
      if (!c) throw new PrepError(404, "no_companion");
      // only files the manifest lists (a rejected key never is)
      if (isFlow) {
        if (!flowAssets(c.prep.steps.face?.face?.flow).has(fk[1])) throw new PrepError(404, "no_image");
      } else if (fk[1] === "person") {
        if (!c.prep.steps.face?.face?.person) throw new PrepError(404, "no_image");
      } else if (fk[1] !== "neutral" && c.prep.steps.face?.face?.items[fk[1] as FaceKey]?.status !== "done") throw new PrepError(404, "no_image");
      const bytes = await d.store.getAsset(user, c.id, fk[1]);
      if (!bytes) throw new PrepError(404, "no_image");
      res.writeHead(200, { "content-type": sniffImage(bytes) ?? "application/octet-stream", "content-length": bytes.length, "cache-control": "private, max-age=86400" });
      return void res.end(bytes);
    }

    if (m === "POST" && p === "/v1/companion/prep/retry") {
      const c = await d.store.getCompanion(user);
      if (!c) throw new PrepError(404, "no_companion");
      if (c.prep.status === "ready" && !needsFaceSet(c)) return send(res, 200, prepView(c));
      return send(res, 202, prepView(await runner.retry(user)));
    }

    if (m === "POST" && p === "/v1/companion/prefs") {
      const b = await readJson(req);
      const c = await d.store.getCompanion(user);
      if (!c) throw new PrepError(404, "no_companion");
      const next = await savePrefs(d, c, b.depth, b.answers);
      const v = companionView(next, await d.store.getStyle(user));
      return send(res, 200, { summary: next.persona!.summary, persona: next.persona!.card, rules: next.persona!.rules, session: v.session });
    }

    if (m === "GET" && p === "/v1/profile/story") {
      if (!d.personalize) throw new PrepError(404, "not_found");
      if (!allowStory(user)) throw new PrepError(429, "rate_limited", "try again in a minute");
      const w = Number(url.searchParams.get("wait") ?? 0);
      const waitMs = Number.isFinite(w) ? Math.round(Math.min(STORY_WAIT_MAX_S, Math.max(0, w)) * 1000) : 0;
      return send(res, 200, await d.personalize.story(user, waitMs));
    }

    if (m === "PATCH" && p === "/v1/profile") {
      if (!d.personalize) throw new PrepError(404, "not_found");
      const raw = await readBody(req, PROFILE_JSON_LIMIT);
      let b: unknown;
      try { b = JSON.parse(raw.toString("utf8") || "null"); } catch { throw new PrepError(400, "bad_json"); }
      if (!b || typeof b !== "object" || Array.isArray(b)) throw new PrepError(400, "bad_json");
      if (!allowCorrect(user)) throw new PrepError(429, "rate_limited", "try again in a minute");
      try {
        return send(res, 200, await d.personalize.correct(user, b as Record<string, unknown>));
      } catch (err) {
        if (err instanceof PersonalizeError) throw new PrepError(err.status, err.code, err.message);
        throw err;
      }
    }

    throw new PrepError(404, "not_found");
  }

  return {
    handles: (req) => {
      const p = new URL(req.url ?? "/", "http://localhost").pathname;
      return p === "/v1/import" || p.startsWith("/v1/import/") || p === "/v1/companion" || p.startsWith("/v1/companion/") || p === "/v1/profile" || p.startsWith("/v1/profile/");
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
