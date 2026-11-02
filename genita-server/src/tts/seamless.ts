/**
 * Genita voice service client (D3: Meta open model SeamlessM4T v2 on our GPU, deploy/modal-voice).
 *
 *   POST {url}/v1/tts  Bearer token  {text, lang: "eng"|"kor", speaker, speed, tail_ms}
 *   → NDJSON lines {audio_base64 (PCM s16le 24 kHz), alignment {characters, character_start_times_seconds,
 *     character_end_times_seconds} | null}, then {done, gen_ms, audio_ms}
 *
 * Same chunk shape as the ElevenLabs client, so the session's audio/words/mouth path is unchanged.
 *
 * - Text is turned into spoken form first (normalize.ts); captions keep the written text.
 * - Each clause gets a short pause at its end (Seamless trims silence; separate requests would run together).
 * - Short clauses ("Hmm,", "Oh!", "Yeah.") are cached per speaker+lang and prefetched for each speaker.
 * - After a failure the client stays "down" for 30 s and fails fast, so replies go to the app's
 *   own voice (`say`) instead of waiting on a dead service; then it tries again.
 */
import { UpstreamError } from "../meta/http.ts";
import type { VoiceConfig } from "../config.ts";
import type { TtsChunk, TtsRequest } from "./elevenlabs.ts";
import { pauseAfterMs, spokenText } from "../voice/normalize.ts";

export const SEAMLESS_MODEL = "seamless-m4t-v2";
export const FILLERS = ["Hmm,", "Oh!", "Yeah.", "Oh wow,", "Okay,", "Right,", "Mm-hm.", "Aw,", "Haha,", "Well,", "So,", "Oh no,"];
const CACHE_MAX_CHARS = 14;
const CACHE_MAX = 400;
const DOWN_MS = 30_000;

/** The service takes ≤ 400 chars; cut longer spoken text at a clause or word boundary (≤ 380 each). */
export function splitForService(text: string, max = 380): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = -1;
    for (const re of [/[.!?;:,](?=\s)/g, /\s/g]) {
      for (const m of rest.slice(0, max).matchAll(re)) cut = m.index! + (m[0].trim() ? 1 : 0);
      if (cut > max / 3) break;
      cut = -1;
    }
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export type SeamlessRequest = Omit<TtsRequest, "apiKey"> & { lang?: string };

/** BCP-47 / Spark language → Seamless lang code (the two the app uses). */
export function seamlessLang(lang: string | undefined, text: string): "eng" | "kor" {
  if (lang?.toLowerCase().startsWith("ko")) return "kor";
  const hangul = (text.match(/[가-힣]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return hangul > latin ? "kor" : "eng";
}

/** voiceId "seamless:12" (or "12") → speaker 12; anything else → the companion kind's default. */
export function resolveSpeaker(voiceId: string | null | undefined, kind: string | undefined, voice: VoiceConfig): number {
  const m = /^(?:seamless:)?(\d{1,3})$/.exec(voiceId ?? "");
  if (m && Number(m[1]) < 200) return Number(m[1]);
  return voice.speakers[kind === "animal" || kind === "character" ? kind : "human"];
}

const speakerOf = (voiceId: string) => Number(/^seamless:(\d{1,3})$/.exec(voiceId)?.[1] ?? NaN);

export type SeamlessClient = {
  speak: (req: SeamlessRequest) => AsyncGenerator<TtsChunk>;
  /** cache the filler clauses for a speaker (fire and forget) */
  prefetch: (speaker: number) => void;
  isDown: () => boolean;
};

type Fetch = typeof fetch;

export function createSeamless(cfg: VoiceConfig, opts: { fetch?: Fetch; now?: () => number; log?: (e: string, d: Record<string, unknown>) => void } = {}): SeamlessClient {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, TtsChunk[]>();
  const prefetched = new Set<string>();
  let downUntil = 0;
  const modelName = cfg.model === "mms" ? "mms-tts" : SEAMLESS_MODEL;

  async function* request(text: string, lang: "eng" | "kor", speaker: number, tailMs: number, signal?: AbortSignal): AsyncGenerator<TtsChunk> {
    const ctl = new AbortController();
    // no first byte, or a stalled stream: give up after timeoutMs without progress (reset on every chunk)
    let timer = setTimeout(() => ctl.abort(new Error("voice_timeout")), cfg.timeoutMs);
    const progress = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(new Error("voice_timeout")), cfg.timeoutMs);
    };
    const onAbort = () => ctl.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let r: Response;
      try {
        r = await doFetch(`${cfg.url}/v1/tts`, {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
          body: JSON.stringify({ text, lang, speaker, speed: cfg.speed, tail_ms: tailMs, model: cfg.model }),
          signal: ctl.signal,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new UpstreamError("voice", null, err instanceof Error ? err.message : "fetch failed");
      }
      if (!r.ok || !r.body) throw new UpstreamError("voice", r.status, (await r.text().catch(() => "")).slice(0, 200));
      const dec = new TextDecoder();
      let buf = "";
      let done = false;
      const parse = (line: string): TtsChunk | null => {
        let j: { audio_base64?: string; alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null; done?: boolean };
        try {
          j = JSON.parse(line);
        } catch {
          return null;
        }
        if (j.done) {
          done = true;
          return null;
        }
        const audio = Buffer.from(j.audio_base64 ?? "", "base64");
        const a = j.alignment;
        const alignment = a?.characters?.length ? { chars: a.characters, startsSec: a.character_start_times_seconds, endsSec: a.character_end_times_seconds } : null;
        if (!audio.length && !alignment) return null;
        return { audio: audio.length % 2 ? audio.subarray(0, audio.length - 1) : audio, alignment, model: modelName };
      };
      try {
        for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
          progress();
          buf += dec.decode(c, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const chunk = parse(line);
            if (chunk) yield chunk;
          }
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new UpstreamError("voice", null, err instanceof Error ? err.message : "stream failed");
      }
      if (buf.trim()) {
        const chunk = parse(buf.trim());
        if (chunk) yield chunk;
      }
      if (!done && !signal?.aborted) throw new UpstreamError("voice", null, "stream ended early");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  const key = (lang: string, speaker: number, text: string, tail: number) => `${lang}|${speaker}|${tail}|${text}`;
  const remember = (k: string, chunks: TtsChunk[]) => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(k, chunks);
  };

  async function* speak(req: SeamlessRequest): AsyncGenerator<TtsChunk> {
    const lang = seamlessLang(req.lang, req.text);
    const text = spokenText(req.text, lang);
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return; // nothing to say (emoji-only, punctuation)
    const speaker = speakerOf(req.voiceId);
    const spk = Number.isFinite(speaker) ? speaker : 0;
    const tail = pauseAfterMs(text);
    const k = key(lang, spk, text, tail);
    const hit = cache.get(k);
    if (hit) {
      yield* hit;
      return;
    }
    if (now() < downUntil) throw new UpstreamError("voice", null, "voice_down");
    const got: TtsChunk[] = [];
    // normalisation can grow a sentence past the service's 400-char cap: send it in pieces, pause only after
    // the last, and shift each piece's timing onto the sentence's own timeline
    const pieces = splitForService(text);
    try {
      let offsetSec = 0;
      for (const [n, piece] of pieces.entries()) {
        let pieceSec = 0;
        for await (const c of request(piece, lang, spk, n === pieces.length - 1 ? tail : 0, req.signal)) {
          const shifted = offsetSec && c.alignment
            ? { ...c, alignment: { ...c.alignment, startsSec: c.alignment.startsSec.map((t) => t + offsetSec), endsSec: c.alignment.endsSec.map((t) => t + offsetSec) } }
            : c;
          pieceSec += c.audio.length / 2 / 24000;
          got.push(shifted);
          yield shifted;
        }
        offsetSec += pieceSec;
      }
    } catch (err) {
      // bad input (4xx other than 429) is this sentence's problem, not an outage: don't stop the voice for everyone
      const status = err instanceof UpstreamError ? err.status : null;
      const outage = status === null || status >= 500 || status === 429 || status === 401 || status === 403;
      if (!req.signal?.aborted && outage) {
        downUntil = now() + DOWN_MS;
        opts.log?.("voice.down", { message: err instanceof Error ? err.message.slice(0, 160) : "unknown", forMs: DOWN_MS });
      }
      throw err;
    }
    if (text.length <= CACHE_MAX_CHARS && got.length) remember(k, got);
  }

  function prefetch(speaker: number): void {
    const p = `${speaker}`;
    if (prefetched.has(p) || now() < downUntil) return;
    prefetched.add(p);
    void (async () => {
      for (const f of FILLERS) {
        try {
          for await (const _ of speak({ voiceId: `seamless:${speaker}`, text: f, emotion: null, model: SEAMLESS_MODEL, lang: "en" })) void _;
        } catch {
          prefetched.delete(p);
          return;
        }
      }
    })();
  }

  return { speak, prefetch, isDown: () => now() < downUntil };
}
