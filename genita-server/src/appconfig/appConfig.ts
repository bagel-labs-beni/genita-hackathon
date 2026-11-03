/**
 * GET /v1/app-config — server-driven config for the iOS and Mac apps (copy strings, feature
 * flags, tuning numbers, update nudges, remote motion asset URLs). Data only: no code is ever
 * sent (App Store 2.5.2), the apps bundle the same defaults and only read known keys.
 *
 * Threat line: callers = the Genita iOS/Mac apps before and after sign-in (so no auth: the body
 * holds no user data, the same for everyone). Abuse = a static JSON of a few KB answered from
 * memory (ETag/304, Cache-Control so CloudFront and the apps cache it); no vendor call, no DB.
 * Exposed data = product copy, flags, build numbers, public https asset URLs.
 *
 * Source: the defaults below, deep-merged with an optional JSON file at GENITA_APP_CONFIG_FILE
 * (re-read when its mtime changes, checked at most every 5 s), so ops can flip a flag or a
 * string without a redeploy. The file is sanitized key by key: flags must be booleans, tuning
 * finite numbers, copy strings, assets https URLs; anything else is dropped. A broken file keeps
 * the last good config. `tuning.bargeInMs` always mirrors the server's own GENITA_BARGE_IN_MIN_MS
 * (read-only: the 400 ms decision is not changed from here).
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

export const APP_CONFIG_PATH = "/v1/app-config";
export const TESTFLIGHT_URL = "https://testflight.apple.com/join/Ybqh482p";
export const MAC_APPCAST_URL = "https://bagel-labs-beni.github.io/genita-legal/mac/appcast.xml";

export type UpdateChannel = { minBuild: number; latestBuild: number; url: string };
export type AppConfig = {
  schema: 1;
  updates: { ios: UpdateChannel; mac: UpdateChannel };
  flags: Record<string, boolean>;
  tuning: Record<string, number>;
  copy: Record<string, string>;
  /** name → https URL (motion assets such as a Rive file or a Lottie-free PNG sequence) */
  assets: Record<string, string>;
};

export const DEFAULT_APP_CONFIG: AppConfig = {
  schema: 1,
  updates: {
    ios: { minBuild: 0, latestBuild: 0, url: TESTFLIGHT_URL },
    mac: { minBuild: 0, latestBuild: 0, url: MAC_APPCAST_URL },
  },
  flags: {
    watchReactions: true,
    textChat: false, // D40: shown greyed out this submission
    judgeAccess: true,
    interactiveSplash: true,
    motion: true,
  },
  tuning: {
    bargeInMs: 400,
    prepContinueAfterSceneMs: 30_000,
    prepStallMs: 45_000,
    firstCallWaitMs: 2_000,
    updateCheckHours: 24,
  },
  copy: {
    "update.title": "A new Genita is ready",
    "update.body": "Update to get the latest fixes.",
    "update.action": "Update",
    "update.required": "This version is no longer supported. Update to keep talking.",
    "mac.update.ready": "Update ready",
    "mac.update.restart": "Restart to update",
    "prep.title": "Bringing {name} to life",
    "prep.stage.scene": "Setting the scene",
    "prep.stage.expressions": "Learning expressions",
    "prep.stage.mouth": "Mouth",
    "call.thinking": "{name} is thinking",
  },
  assets: {},
};

const MAX_FILE_BYTES = 64 * 1024;
const MAX_COPY_CHARS = 500;
const MAX_URL_CHARS = 2048;
const KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const RECHECK_MS = 5_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isHttps = (v: unknown): v is string => {
  if (typeof v !== "string" || v.length > MAX_URL_CHARS) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};
const build = (v: unknown, fallback: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1e9 ? (v as number) : fallback);

function pick<T>(src: unknown, ok: (v: unknown) => v is T): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isObj(src)) return out;
  for (const [k, v] of Object.entries(src)) if (KEY.test(k) && ok(v)) out[k] = v;
  return out;
}
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isCopy = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_COPY_CHARS;

function channel(src: unknown, base: UpdateChannel): UpdateChannel {
  if (!isObj(src)) return base;
  return { minBuild: build(src.minBuild, base.minBuild), latestBuild: build(src.latestBuild, base.latestBuild), url: isHttps(src.url) ? src.url : base.url };
}

/** defaults ⊕ sanitized overrides; bargeInMs is always the server's own value */
export function mergeAppConfig(overrides: unknown, bargeInMs: number, base: AppConfig = DEFAULT_APP_CONFIG): AppConfig {
  const o = isObj(overrides) ? overrides : {};
  const updates = isObj(o.updates) ? o.updates : {};
  return {
    schema: 1,
    updates: { ios: channel(updates.ios, base.updates.ios), mac: channel(updates.mac, base.updates.mac) },
    flags: { ...base.flags, ...pick(o.flags, isBool) },
    tuning: { ...base.tuning, ...pick(o.tuning, isNum), bargeInMs },
    copy: { ...base.copy, ...pick(o.copy, isCopy) },
    assets: { ...base.assets, ...pick(o.assets, isHttps) },
  };
}

export type AppConfigSource = { current(): { body: string; etag: string } };

export function createAppConfigSource(opts: { file?: string | null; bargeInMs: number; log?: (e: string, d: Record<string, unknown>) => void; now?: () => number }): AppConfigSource {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  let mtime = -1;
  let checkedAt = -Infinity;
  let overrides: unknown = {};
  let cached = render();

  function render() {
    const body = JSON.stringify(mergeAppConfig(overrides, opts.bargeInMs));
    return { body, etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"` };
  }
  function refresh() {
    if (!opts.file || now() - checkedAt < RECHECK_MS) return;
    checkedAt = now();
    try {
      const st = statSync(opts.file);
      if (st.mtimeMs === mtime) return;
      if (st.size > MAX_FILE_BYTES) throw new Error(`file over ${MAX_FILE_BYTES} bytes`);
      overrides = JSON.parse(readFileSync(opts.file, "utf8"));
      cached = render();
      mtime = st.mtimeMs; // only a good load is remembered; a failed one is retried at the next check
      log("app_config.loaded", { etag: cached.etag });
    } catch (err) {
      // keep the last good config; a missing file means "defaults"
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (mtime !== -2) {
          overrides = {};
          cached = render();
        }
        mtime = -2;
        return;
      }
      log("app_config.invalid", { message: String(err).slice(0, 200) });
    }
  }
  return {
    current() {
      refresh();
      return cached;
    },
  };
}

export function isAppConfigRoute(pathname: string) {
  return pathname === APP_CONFIG_PATH;
}

export function handleAppConfig(req: IncomingMessage, res: ServerResponse, source: AppConfigSource) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "method_not_allowed" }));
  }
  const { body, etag } = source.current();
  const headers = { etag, "cache-control": "public, max-age=60, stale-while-revalidate=600" };
  const match = req.headers["if-none-match"];
  if (match && (match.trim() === "*" || match.split(",").some((t) => t.trim().replace(/^W\//, "") === etag))) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(req.method === "HEAD" ? undefined : body);
}
