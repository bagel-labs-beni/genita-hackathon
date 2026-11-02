/**
 * Runtime config from the environment. Keys are read here and nowhere else,
 * and are never logged. Locally, main.ts loads GENITA_ENV_FILE (default
 * ~/.config/genita/meta.env) before this runs.
 */
export type Config = {
  metaKey: string;
  /** ElevenLabs key; read only when serverTts is on, else null */
  elevenKey: string | null;
  /** GENITA_SERVER_TTS=1: ElevenLabs streaming + voice previews. Off = the app speaks (`say`, device mode) */
  serverTts: boolean;
  /** GENITA_KLING=1: fal (gpt-image-2 scene fallback, Kling clips) in prep; needs FAL_KEY */
  kling: boolean;
  /** GENITA_PETER=1: Peter live worker (GENITA_PETER_URL/TOKEN) + Peter prepare */
  peter: boolean;
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
  /** concurrent identical Spark requests per turn; first text wins (1 = off) */
  sparkHedge: number;
  /** start Spark on a likely-final partial transcript before speechComplete */
  speculate: boolean;
  /** an unpunctuated partial counts as likely-final after this long unchanged */
  speculateStableMs: number;
};

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
}

const flag = (v: string | undefined) => v === "1";

/**
 * Only MODEL_API_KEY is required (11/2: everything at call time is Meta or on
 * the device). Each non-Meta vendor sits behind a flag that is off by default;
 * its key is read and required only when its flag is on.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const metaKey = env.MODEL_API_KEY ?? "";
  if (!metaKey) throw new Error("MODEL_API_KEY is not set");
  const serverTts = flag(env.GENITA_SERVER_TTS);
  const kling = flag(env.GENITA_KLING);
  const peter = flag(env.GENITA_PETER);
  const elevenKey = serverTts ? env.ELEVENLABS_API_KEY || null : null;
  if (serverTts && !elevenKey) throw new Error("GENITA_SERVER_TTS=1 needs ELEVENLABS_API_KEY");
  if (kling && !env.FAL_KEY) throw new Error("GENITA_KLING=1 needs FAL_KEY");
  if (peter && !env.GENITA_PETER_URL) throw new Error("GENITA_PETER=1 needs GENITA_PETER_URL");
  if (peter && !env.GENITA_PETER_TOKEN) throw new Error("GENITA_PETER=1 needs GENITA_PETER_TOKEN");
  return {
    metaKey,
    elevenKey,
    serverTts,
    kling,
    peter,
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
    sparkHedge: Math.max(1, Math.min(3, num(env.GENITA_SPARK_HEDGE, 2))),
    speculate: env.GENITA_SPECULATE !== "0",
    speculateStableMs: num(env.GENITA_SPECULATE_STABLE_MS, 250),
  };
}
