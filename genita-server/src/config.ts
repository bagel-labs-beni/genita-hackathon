/**
 * Runtime config from the environment. Keys are read here and nowhere else,
 * and are never logged. Locally, main.ts loads GENITA_ENV_FILE (default
 * ~/.config/genita/meta.env) before this runs.
 */
export type Config = {
  metaKey: string;
  /** Operational controls (D46); optional for legacy embedded/test configs. */
  paused?: boolean;
  /** GENITA_PAUSE_FILE: while this file exists, generation is paused (no restart needed) */
  pauseFile?: string | null;
  metaDailyCalls?: number;
  metaDailyImages?: number;
  userDailyTurns?: number;
  /**
   * Server voice on our GPU (D3, Meta open model SeamlessM4T v2 on Modal): set by GENITA_VOICE_URL +
   * GENITA_VOICE_TOKEN. Optional: without it the server runs device mode (the app speaks), so a
   * judge can run the public repo with only a Meta key.
   */
  voice?: VoiceConfig | null;
  /** Concurrent voice-GPU calls; default 3, 0 = unlimited. Older injected configs may omit it. */
  voiceMaxCalls?: number;
  /** Whether the Meta voice service is configured; otherwise the app speaks. */
  serverTts: boolean;
  host: string;
  port: number;
  /** shared bearer token apps must present; unset = loopback-only dev mode */
  sessionToken: string | null;
  defaultVoiceId: string;
  webSearch: boolean;
  /** PERC-1 (#319): camera perception (Spark face reads → triggers for the conversation engine). GENITA_PERCEPTION=1; default off. */
  perception?: boolean;
  asrLanguages: string[];
  bargeInMinMs: number;
  bargeInMinWords: number;
  maxSessions: number;
  maxSessionMs: number;
  sparkFirstTokenTimeoutMs: number;
  /**
   * concurrent identical Spark requests per turn; first text wins (1 = off). 3 since 11/3: in-region,
   * 40 turns each, speech end → first audio p50 1488 → 1265 ms, p90 2127 → 1924 ms vs 2 lanes.
   */
  sparkHedge: number;
  /** idle ms a vendor HTTPS socket stays open between turns (0 = Node's 4 s default) */
  httpKeepAliveMs?: number;
  /** start Spark on a likely-final partial transcript before speechComplete */
  speculate: boolean;
  /** an unpunctuated partial counts as likely-final after this long unchanged */
  speculateStableMs: number;
};

export type VoiceConfig = {
  url: string;
  token: string;
  /** Seamless speaker per companion kind (0..199), picked by the 11/2 UTMOS sweep */
  speakers: { human: number; animal: number; character: number };
  /** speaking rate (1 = model default) */
  speed: number;
  /** give up on a sentence if its first audio takes longer than this (then it is retried once, else captions only) */
  timeoutMs: number;
  /** "seamless" (default) or "mms" (Meta MMS-TTS backup on the same service, no timing) */
  model: "seamless" | "mms";
  /** GENITA_VOICE_ALIGN=1: ask the service for word + phoneme timing (Meta MMS forced aligner), sent to the app
   * as `audio.timing` after each clause's audio. Off: requests are unchanged. */
  align?: boolean;
  /** false (default since 11/4): the raw vocoder voice, no post chain, no emotion pitch/tone. GENITA_VOICE_POST=1 turns post.py on. */
  post?: boolean;
  /** GENITA_VOICE_EMOTION=0: keep the post chain but send no reply emotion (no pitch/tone moves). Unset: emotion on. */
  emotion?: boolean;
  /** `expression` events per reply clause (face expression layer, 11/3). Default on; GENITA_EXPRESSION=0 turns them off. */
  expressions?: boolean;
  /**
   * GENITA_VOICE_DEVICE_FALLBACK=1: the old fallback (a full GPU or a failed clause → the app's system voice via `say`).
   * Off by default since 11/4 (Chelsea, build 7: "왜 여자 + 기계식"): the phone's voice is another person (iOS picks a
   * female en-US voice) and robotic, so a call keeps the companion's own voice and retries; captions cover a clause
   * the voice service could not voice.
   */
  deviceFallback?: boolean;
};

/** "human:12,animal:7,character:33" → per-kind Seamless speaker ids */
export function parseSpeakers(v: string | undefined, d: VoiceConfig["speakers"]): VoiceConfig["speakers"] {
  const out = { ...d };
  for (const part of (v ?? "").split(",")) {
    const [k, n] = part.split(":").map((x) => x.trim());
    const id = Number(n);
    if ((k === "human" || k === "animal" || k === "character") && Number.isInteger(id) && id >= 0 && id < 200) out[k] = id;
  }
  return out;
}

const flag = (v: string | undefined) => v === "1";

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
}

const DEFAULT_SPEAKERS: VoiceConfig["speakers"] = { human: 0, animal: 0, character: 0 };

/**
 * Only MODEL_API_KEY is required (11/2: everything at call time is Meta or on
 * the device). Prep uses Meta scene and face generation.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const metaKey = env.MODEL_API_KEY ?? "";
  if (!metaKey) throw new Error("MODEL_API_KEY is not set");
  const voiceUrl = (env.GENITA_VOICE_URL ?? "").replace(/\/+$/, "");
  const voice: VoiceConfig | null =
    voiceUrl && env.GENITA_VOICE_TOKEN
      ? {
          url: voiceUrl,
          token: env.GENITA_VOICE_TOKEN,
          speakers: parseSpeakers(env.GENITA_VOICE_SPEAKERS, DEFAULT_SPEAKERS),
          speed: Math.min(1.3, Math.max(0.8, num(env.GENITA_VOICE_SPEED, 1))),
          timeoutMs: num(env.GENITA_VOICE_TIMEOUT_MS, 4000),
          model: env.GENITA_VOICE_MODEL === "mms" ? "mms" : "seamless",
          align: env.GENITA_VOICE_ALIGN === "1",
          // 11/4: the raw Seamless voice by default. The GPU post chain (post.py: emotion pitch by varispeed, tone/gain,
          // 3 kHz cut) is opt-in with GENITA_VOICE_POST=1; it moved the speaker's pitch per reply (Chelsea build 7:
          // "여자 + 기계식"). Speed per emotion (seamless.ts EMOTION_SPEED) stays.
          ...(env.GENITA_VOICE_POST === "1" ? {} : { post: false }),
          ...(env.GENITA_VOICE_EMOTION === "0" ? { emotion: false } : {}),
          expressions: env.GENITA_EXPRESSION !== "0",
          ...(env.GENITA_VOICE_DEVICE_FALLBACK === "1" ? { deviceFallback: true } : {}),
        }
      : null;
  if (voiceUrl && !voice) throw new Error("GENITA_VOICE_URL needs GENITA_VOICE_TOKEN");
  const serverTts = !!voice;
  // 11/3 (D27 sweep: 8 calls -> 9/16 turns on the device voice): the GPU autoscales (deploy/modal-voice TARGET_INPUTS)
  // and served 8 calls x 4 replies with 0/32 fallbacks in the load test, so the seat cap follows (was 3)
  const voiceMaxCalls = num(env.GENITA_VOICE_MAX_CALLS?.trim(), 8);
  return {
    metaKey,
    paused: flag(env.GENITA_PAUSED),
    pauseFile: env.GENITA_PAUSE_FILE?.trim() || null,
    metaDailyCalls: num(env.GENITA_META_DAILY_CALLS, 20_000),
    metaDailyImages: num(env.GENITA_META_DAILY_IMAGES, 600),
    userDailyTurns: num(env.GENITA_USER_DAILY_TURNS, 300),
    serverTts,
    voice,
    voiceMaxCalls: Number.isSafeInteger(voiceMaxCalls) && voiceMaxCalls >= 0 ? voiceMaxCalls : 8,
    host: env.HOST ?? "127.0.0.1",
    port: num(env.PORT, 8787),
    sessionToken: env.GENITA_SESSION_TOKEN || null,
    defaultVoiceId: env.GENITA_DEFAULT_VOICE_ID ?? "seamless:0",
    webSearch: env.GENITA_WEB_SEARCH !== "0",
    perception: env.GENITA_PERCEPTION === "1",
    asrLanguages: (env.GENITA_ASR_LANGUAGES ?? "English,Korean").split(",").map((s) => s.trim()).filter(Boolean),
    bargeInMinMs: num(env.GENITA_BARGE_IN_MIN_MS, 400),
    bargeInMinWords: num(env.GENITA_BARGE_IN_MIN_WORDS, 2),
    maxSessions: num(env.GENITA_MAX_SESSIONS, 16),
    maxSessionMs: num(env.GENITA_MAX_SESSION_MS, 30 * 60_000),
    sparkFirstTokenTimeoutMs: num(env.GENITA_SPARK_TIMEOUT_MS, 8000),
    sparkHedge: Math.max(1, Math.min(3, num(env.GENITA_SPARK_HEDGE, 3))),
    httpKeepAliveMs: Math.max(0, num(env.GENITA_HTTP_KEEPALIVE_MS, 60_000)),
    speculate: env.GENITA_SPECULATE !== "0",
    speculateStableMs: num(env.GENITA_SPECULATE_STABLE_MS, 250),
  };
}
