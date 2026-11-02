/** D41: a self-contained local server. Never inherit deployment/vendor credentials. */
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

export const MISSING_KEY_HINT = "MODEL_API_KEY is not set. Copy .env.example to .env at the repo root and put your Meta API key in it.";

/** Shell wins over server .env, which wins over repo .env. No home-directory env files. */
export function loadLocalEnv(env: NodeJS.ProcessEnv, serverRoot: string): NodeJS.ProcessEnv {
  const loaded: NodeJS.ProcessEnv = {};
  for (const file of [join(serverRoot, "..", ".env"), join(serverRoot, ".env")]) {
    try {
      Object.assign(loaded, parseEnv(readFileSync(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) loaded[key] = value;
  return loaded;
}

// An allowlist also discards unknown/retired vendor keys. Keep only OS essentials and local inputs.
const KEEP = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "TZ",
  "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
  "MODEL_API_KEY", "DATABASE_URL", "PORT", "GENITA_DATA_DIR", "GENITA_SESSION_TOKEN",
]);
const VOICE = new Set([
  "GENITA_VOICE_URL", "GENITA_VOICE_TOKEN", "GENITA_VOICE_SPEAKERS", "GENITA_VOICE_MODEL",
  "GENITA_VOICE_SPEED", "GENITA_VOICE_TIMEOUT_MS", "GENITA_VOICE_ALIGN",
]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function localDatabase(url: string, serverRoot: string): string {
  if (url.startsWith("pglite:")) {
    const dir = url.slice("pglite:".length);
    return dir === "memory" || !dir ? url : `pglite:${resolve(serverRoot, dir)}`;
  }
  try {
    const parsed = new URL(url);
    if (["postgres:", "postgresql:"].includes(parsed.protocol) && LOOPBACK.has(parsed.hostname) && !parsed.search) return url;
  } catch { /* configuration error below deliberately never echoes credentials */ }
  throw new Error("Use a local DATABASE_URL: pglite:<dir>, pglite:memory, or postgres://genita:genita@127.0.0.1:5432/genita (no query parameters).");
}

export function applyLocalDefaults(env: NodeJS.ProcessEnv, serverRoot: string): NodeJS.ProcessEnv {
  if (!env.MODEL_API_KEY?.trim()) throw new Error(MISSING_KEY_HINT);
  const ownGpu = env.GENITA_LOCAL_VOICE === "1";
  for (const key of Object.keys(env)) {
    if (!KEEP.has(key) && !/^LC_[A-Z_]+$/.test(key) && !(ownGpu && VOICE.has(key))) delete env[key];
  }
  env.MODEL_API_KEY = env.MODEL_API_KEY!.trim();
  const data = resolve(serverRoot, env.GENITA_DATA_DIR || ".genita-data");
  env.DATABASE_URL = localDatabase(env.DATABASE_URL || `pglite:${join(data, "db")}`, serverRoot);
  env.GENITA_DATA_DIR = data;
  env.HOST = "127.0.0.1";
  env.PORT ||= "8787";
  env.NODE_ENV = "development"; // email codes are printed only on a loopback development server
  env.GENITA_ENV_FILE = ""; // main.ts must not load ~/.config/genita/meta.env
  mkdirSync(join(data, "blobs"), { recursive: true });
  return env;
}
