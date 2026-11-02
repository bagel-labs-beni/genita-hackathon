/**
 * Runtime config from the environment. Keys are read here and nowhere else,
 * and are never logged. Locally, main.ts loads GENITA_ENV_FILE (default
 * ~/.config/genita/meta.env) before this runs.
 */
export type Config = {
  metaKey: string;
  elevenKey: string;
  host: string;
  port: number;
  /** shared bearer token apps must present; unset = loopback-only dev mode */
  sessionToken: string | null;
  ttsModel: string;
  ttsFallbackModel: string;
  defaultVoiceId: string;
  webSearch: boolean;
  asrLanguages: string[];
  bargeInMinMs: number;
  bargeInMinWords: number;
  maxSessions: number;
  maxSessionMs: number;
  sparkFirstTokenTimeoutMs: number;
};

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const metaKey = env.MODEL_API_KEY ?? "";
  const elevenKey = env.ELEVENLABS_API_KEY ?? "";
  if (!metaKey) throw new Error("MODEL_API_KEY is not set");
  if (!elevenKey) throw new Error("ELEVENLABS_API_KEY is not set");
  return {
    metaKey,
    elevenKey,
    host: env.HOST ?? "127.0.0.1",
    port: num(env.PORT, 8787),
    sessionToken: env.GENITA_SESSION_TOKEN || null,
    ttsModel: env.GENITA_TTS_MODEL ?? "eleven_v4_turbo",
    ttsFallbackModel: env.GENITA_TTS_FALLBACK_MODEL ?? "eleven_v3",
    defaultVoiceId: env.GENITA_DEFAULT_VOICE_ID ?? "7PbNGDB5sJCFnOZuMPNL",
    webSearch: env.GENITA_WEB_SEARCH !== "0",
    asrLanguages: (env.GENITA_ASR_LANGUAGES ?? "English,Korean").split(",").map((s) => s.trim()).filter(Boolean),
    bargeInMinMs: num(env.GENITA_BARGE_IN_MIN_MS, 400),
    bargeInMinWords: num(env.GENITA_BARGE_IN_MIN_WORDS, 2),
    maxSessions: num(env.GENITA_MAX_SESSIONS, 16),
    maxSessionMs: num(env.GENITA_MAX_SESSION_MS, 30 * 60_000),
    sparkFirstTokenTimeoutMs: num(env.GENITA_SPARK_TIMEOUT_MS, 8000),
  };
}
