/**
 * Voice GPU capacity bench (D27 / #154).
 *
 * Calls the SeamlessM4T service through the same createSeamless client used by
 * sessions. It measures request -> first PCM chunk, not Spark or ASR latency.
 * Keys are read from GENITA_ENV_FILE (or the usual local meta.env) and are
 * deliberately never printed.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type VoiceConfig } from "../src/config.ts";
import { UpstreamError } from "../src/meta/http.ts";
import { createSeamless, SEAMLESS_MODEL } from "../src/tts/seamless.ts";

type Lang = "eng" | "kor" | "mix";

export type BenchOptions = {
  voice: VoiceConfig;
  calls?: number[];
  replies?: number;
  gapMs?: number;
  jitterMs?: number;
  /** spread a cohort across this many milliseconds (never more than one second by default) */
  startStaggerMs?: number;
  timeoutMs?: number;
  maxMinutes?: number;
  firstSoundThresholdMs?: number;
  speaker?: number;
  lang?: Lang;
  /** tests may skip warm-up; the CLI always warms every configured speaker. */
  warmup?: boolean;
};

export type BenchQuantiles = { p50: number | null; p90: number | null; max: number | null };
export type BenchRow = {
  calls: number;
  firstSound: BenchQuantiles;
  /** Wall-clock synthesis time divided by output-audio duration. Lower is faster than real time. */
  rtfP50: number | null;
  errors: number;
  noAudio: number;
  timeouts: number;
  /** First-sound samples observed (one per reply). */
  replies: number;
  expectedReplies: number;
  status: "complete" | "incomplete";
};
export type BenchResult = { rows: BenchRow[]; recommendedCalls: number | null; thresholdMs: number };

const ENGLISH_REPLIES = [
  ["That jacket fits your clean, relaxed style.", "Start with navy, then check the fit in daylight."],
  ["You have enough for a quick dinner tonight.", "Use tofu first and save kimchi for tomorrow."],
  ["I can stay while you finish that message.", "Take your time; the key point is already clear."],
  ["It was a full day, so keep the next step small.", "Make tea, choose one task, and I will sort the rest."],
  ["The second option feels more like you.", "It is simple, with one memorable detail."],
  ["I found two directions that fit your mood.", "We can narrow them by color, price, or daily use."],
] as const;

const KOREAN_REPLIES = [
  ["그 재킷은 평소 좋아하는 단정하고 편한 분위기와 잘 어울릴 것 같아요.", "네이비부터 입어 보고 자연광에서 핏을 한 번 더 비교해 봐요."],
  ["오늘 저녁은 이미 있는 재료만으로도 충분히 빠르게 만들 수 있어요.", "두부를 먼저 쓰고 김치는 내일 더 산뜻한 메뉴에 남겨 두면 좋아요."],
  ["메시지를 마칠 때까지 여기서 같이 있을게요.", "천천히 해도 돼요, 이미 핵심은 충분히 잘 전달되고 있어요."],
  ["오늘은 일이 많았으니 다음 한 가지만 작게 정해 봐요.", "차를 한 잔 마시고 할 일 하나만 고르면 나머지는 같이 정리할게요."],
  ["두 번째 선택지가 꾸민 티 없이 더 당신답게 느껴져요.", "형태는 단순하지만 기억에 남는 디테일이 하나 있어서 좋아요."],
  ["말해 준 분위기에 맞는 방향을 두 가지로 정리했어요.", "색이나 가격, 매일 쓰기 편한 정도로 하나씩 좁혀 보면 돼요."],
] as const;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function quantiles(values: number[]): BenchQuantiles {
  if (!values.length) return { p50: null, p90: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  return { p50: at(0.5), p90: at(0.9), max: sorted.at(-1)! };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function replyFor(lang: Lang, call: number, reply: number): readonly string[] {
  if (lang === "eng") return ENGLISH_REPLIES[(call + reply) % ENGLISH_REPLIES.length];
  if (lang === "kor") return KOREAN_REPLIES[(call + reply) % KOREAN_REPLIES.length];
  const pool = (call + reply) % 2 ? ENGLISH_REPLIES : KOREAN_REPLIES;
  return pool[(call + reply) % pool.length];
}

function deterministicJitter(call: number, reply: number, max: number): number {
  if (!max) return 0;
  return ((call * 37 + reply * 17) % (max * 2 + 1)) - max;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && /timeout|aborted/i.test(error.message);
}

async function warmSpeakers(voice: VoiceConfig, speaker: number, lang: Lang, signal: AbortSignal): Promise<void> {
  const client = createSeamless(voice);
  const speakers = new Set([voice.speakers.human, voice.speakers.animal, voice.speakers.character, speaker]);
  for (const id of speakers) {
    const text = lang === "kor" ? "준비가 되었습니다, 함께 시작해요." : "I am ready whenever you are.";
    for await (const _ of client.speak({ voiceId: `seamless:${id}`, text, emotion: null, model: SEAMLESS_MODEL, lang: lang === "kor" ? "ko" : "en", signal })) void _;
  }
}

/**
 * Runs a bounded, direct GPU capacity measurement. Kept independent from CLI
 * parsing so node:http fake services can exercise it without external traffic.
 */
export async function runVoiceCapacityBench(options: BenchOptions): Promise<BenchResult> {
  const calls = options.calls ?? [1, 2, 3, 4, 5, 6];
  if (!calls.length || calls.some((n) => !Number.isInteger(n) || n < 1)) throw new Error("calls must be positive integers");
  const replies = options.replies ?? 6;
  if (!Number.isInteger(replies) || replies < 1) throw new Error("replies must be a positive integer");
  const maxMinutes = Math.min(options.maxMinutes ?? 10, 10);
  if (!(maxMinutes > 0)) throw new Error("maxMinutes must be greater than zero");
  const timeoutMs = options.timeoutMs ?? options.voice.timeoutMs;
  if (!(timeoutMs > 0)) throw new Error("timeoutMs must be greater than zero");
  const voice = { ...options.voice, timeoutMs };
  const speaker = options.speaker ?? voice.speakers.human;
  if (!Number.isInteger(speaker) || speaker < 0 || speaker >= 200) throw new Error("speaker must be an integer from 0 to 199");
  const lang = options.lang ?? "mix";
  const thresholdMs = options.firstSoundThresholdMs ?? 3_000;
  const controller = new AbortController();
  const hardStop = setTimeout(() => controller.abort(new Error("bench_max_minutes")), maxMinutes * 60_000);

  try {
    if (options.warmup !== false) await warmSpeakers(voice, speaker, lang, controller.signal);
    const rows: BenchRow[] = [];
    for (const concurrency of calls) {
      const client = createSeamless(voice);
      const firstSounds: number[] = [];
      const rtfs: number[] = [];
      let errors = 0;
      let noAudio = 0;
      let timeouts = 0;
      const gapMs = options.gapMs ?? 5_000;
      const jitterMs = options.jitterMs ?? 500;
      const staggerMs = options.startStaggerMs ?? 1_000;

      const runCall = async (call: number) => {
        const startDelay = concurrency === 1 ? 0 : (call * staggerMs) / (concurrency - 1);
        await sleep(startDelay, controller.signal);
        for (let reply = 0; reply < replies; reply++) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (reply) await sleep(gapMs + deterministicJitter(call, reply, jitterMs), controller.signal);
          const sentences = replyFor(lang, call, reply);
          let firstSound: number | null = null;
          let next: Promise<void> | null = null;

          const requestSentence = async (index: number): Promise<void> => {
            const requestedAt = performance.now();
            let firstChunkAt: number | null = null;
            let audioBytes = 0;
            try {
              for await (const chunk of client.speak({
                voiceId: `seamless:${speaker}`,
                text: sentences[index],
                emotion: null,
                model: SEAMLESS_MODEL,
                lang: lang === "kor" ? "ko" : "en",
                signal: controller.signal,
              })) {
                if (chunk.audio.length && firstChunkAt === null) {
                  firstChunkAt = performance.now();
                  if (index === 0) firstSound = firstChunkAt - requestedAt;
                  // Session behavior: request exactly one sentence ahead once the
                  // current sentence has started streaming.
                  if (index + 1 < sentences.length && !next) next = requestSentence(index + 1);
                }
                audioBytes += chunk.audio.length;
              }
              if (audioBytes === 0) {
                // A {done:true} response without PCM is not a reply. Count it
                // explicitly so a quiet-but-broken GPU cannot look healthy.
                errors++;
                noAudio++;
                return;
              }
              if (firstChunkAt !== null) {
                const wallMs = performance.now() - requestedAt;
                const audioMs = (audioBytes / 2 / 24_000) * 1_000;
                if (wallMs > 0 && audioMs > 0) rtfs.push(wallMs / audioMs);
              }
            } catch (error) {
              errors++;
              if (isTimeout(error)) timeouts++;
            }
          };

          await requestSentence(0);
          if (next) await next;
          if (firstSound !== null) firstSounds.push(firstSound);
        }
      };

      await Promise.all(Array.from({ length: concurrency }, (_, call) => runCall(call)));
      const expectedReplies = concurrency * replies;
      rows.push({
        calls: concurrency,
        firstSound: quantiles(firstSounds),
        rtfP50: median(rtfs),
        errors,
        noAudio,
        timeouts,
        replies: firstSounds.length,
        expectedReplies,
        status: firstSounds.length === expectedReplies ? "complete" : "incomplete",
      });
    }
    const passing = rows.filter((row) => row.status === "complete" && row.errors === 0 && row.firstSound.p90 !== null && row.firstSound.p90 <= thresholdMs);
    const recommended = passing.length ? Math.max(...passing.map((row) => row.calls)) : null;
    return { rows, recommendedCalls: recommended, thresholdMs };
  } finally {
    clearTimeout(hardStop);
  }
}

type SingleGpuAcknowledgement = "assume-single-gpu" | "max-containers=1";
type CliOptions = Omit<BenchOptions, "voice"> & { json: boolean; singleGpuAcknowledgement: SingleGpuAcknowledgement };

class BenchConfigError extends Error {}

export function validateVoiceToken(token: string | undefined): void {
  if (!token || !/^[\x21-\x7e]+$/.test(token)) throw new BenchConfigError("GENITA_VOICE_TOKEN has invalid characters");
}

export function benchErrorReport(error: unknown): string {
  if (error instanceof BenchConfigError) return `bad_config: ${error.message}`;
  if (error instanceof UpstreamError) {
    const code = error.status === null ? (isTimeout(error) ? "timeout" : "network") : `http_${error.status}`;
    return JSON.stringify({ code, status: error.status });
  }
  if (isTimeout(error)) return JSON.stringify({ code: "timeout", status: null });
  return JSON.stringify({ code: "bad_config", status: null });
}

function numberArg(args: string[], name: string, fallback: number): number {
  const raw = args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
}

export function parseVoiceBenchArgs(args: string[]): CliOptions {
  const callsRaw = args.find((arg) => arg.startsWith("--calls="))?.slice(8) ?? "1,2,3,4,5,6";
  const calls = callsRaw.split(",").map((part) => Number(part.trim()));
  const lang = (args.find((arg) => arg.startsWith("--lang="))?.slice(7) ?? "mix") as Lang;
  if (!(["eng", "kor", "mix"] as string[]).includes(lang)) throw new Error("--lang must be eng, kor, or mix");
  const maxMinutes = numberArg(args, "max-minutes", 10);
  if (maxMinutes > 10) throw new Error("--max-minutes cannot exceed 10");
  const assumedSingleGpu = args.includes("--assume-single-gpu");
  const maxContainers = args.find((arg) => arg.startsWith("--max-containers="))?.slice("--max-containers=".length);
  if (!assumedSingleGpu && maxContainers !== "1") throw new BenchConfigError("pass --assume-single-gpu or --max-containers=1 to acknowledge single-GPU isolation");
  if (maxContainers !== undefined && maxContainers !== "1") throw new BenchConfigError("--max-containers must be 1 for this benchmark");
  return {
    calls,
    replies: numberArg(args, "replies", 6),
    gapMs: numberArg(args, "gap-ms", 5_000),
    jitterMs: numberArg(args, "jitter-ms", 500),
    timeoutMs: numberArg(args, "timeout-ms", 8_000),
    maxMinutes,
    speaker: numberArg(args, "speaker", NaN),
    lang,
    json: args.includes("--json"),
    singleGpuAcknowledgement: maxContainers === "1" ? "max-containers=1" : "assume-single-gpu",
  };
}

function printResult(result: BenchResult, json: boolean, singleGpuAcknowledgement: SingleGpuAcknowledgement): void {
  if (json) {
    console.log(JSON.stringify({ ...result, singleGpuAcknowledgement }));
    return;
  }
  console.log(`SINGLE-GPU ACKNOWLEDGEMENT: ${singleGpuAcknowledgement}.`);
  console.log("WARNING: the service NDJSON done line has no container id/hostname. This result is valid only while Modal is scaled to exactly one container; scale.py warm sets min_containers=1, not max_containers.");
  for (const row of result.rows) {
    const f = row.firstSound;
    const rtf = row.rtfP50 === null ? "n/a" : row.rtfP50.toFixed(2);
    console.log(`calls=${row.calls}: first-sound p50=${f.p50 ?? "n/a"}ms p90=${f.p90 ?? "n/a"}ms max=${f.max ?? "n/a"}ms; rtfP50=${rtf}; samples=${row.replies}/${row.expectedReplies} ${row.status}; errors=${row.errors}; no_audio=${row.noAudio}; timeouts=${row.timeouts}`);
  }
  if (result.recommendedCalls === null) console.log(`recommended GENITA_VOICE_MAX_CALLS = none (even N=1 failed or missed ${result.thresholdMs}ms p90)`);
  else console.log(`recommended GENITA_VOICE_MAX_CALLS = ${result.recommendedCalls}`);
}

async function main(): Promise<void> {
  const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  validateVoiceToken(process.env.GENITA_VOICE_TOKEN);
  if (!process.env.GENITA_VOICE_URL) throw new Error("GENITA_VOICE_URL is required; this bench only measures the voice GPU.");
  const config = loadConfig();
  if (!config.voice) throw new Error("GENITA_VOICE_URL and GENITA_VOICE_TOKEN are required for the voice bench.");
  const parsed = parseVoiceBenchArgs(process.argv.slice(2));
  const speaker = Number.isNaN(parsed.speaker) ? config.voice.speakers.human : parsed.speaker;
  const { json, singleGpuAcknowledgement, ...options } = parsed;
  printResult(await runVoiceCapacityBench({ ...options, voice: config.voice, speaker }), json, singleGpuAcknowledgement);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(benchErrorReport(error));
    process.exitCode = 1;
  });
}
