/**
 * POST /v1/transcribe: one short recording → Muse Voice Transcribe → {text}.
 *
 * The iOS "What's off?" sheet (HISY C2, hold to say) used Apple's on-device dictation; the hackathon rule is Meta
 * models only, so the app now records while the mic is held and sends the clip here on release.
 *
 * Threat line: callers are the Genita apps (iOS today). Auth = the user's session JWT (or the dev token), AI-data
 * consent required (the audio goes to Meta). Limits: body ≤ 30 s of audio (413 past it), one request in flight per
 * user, 10 per minute per user, 6 at once server-wide, 7 s end to end. Kill switch GENITA_TRANSCRIBE_HTTP=0 → 404
 * (the app falls back to typing). Logs carry sizes and timings only, never the audio or the words.
 *
 * Body: `audio/wav` (RIFF PCM s16le mono, 16 or 24 kHz) or raw PCM s16le mono (`application/octet-stream`,
 * `audio/L16`; 24 kHz unless `rate=16000` is in the content type). Muse Transcribe takes 24 kHz, so 16 kHz is
 * resampled here.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AsrEvent } from "../meta/transcribe.ts";
import type { AsrLike } from "../session/session.ts";

export const TRANSCRIBE_PATH = "/v1/transcribe";
export const ASR_RATE = 24_000;
export const MAX_AUDIO_MS = 30_000;
/** 30 s at 24 kHz s16 mono + a WAV header with room for extra chunks */
export const MAX_BODY_BYTES = (ASR_RATE * 2 * MAX_AUDIO_MS) / 1000 + 4096;
/** shorter than this is not a word: {text:""} without a vendor call */
export const MIN_AUDIO_MS = 250;
export const PER_MINUTE = 10;
export const MAX_IN_FLIGHT = 6;
export const DEADLINE_MS = 7_000;
/** the whole body must arrive within this long (a slow upload never holds a slot) */
export const BODY_MS = 5_000;
/** silence after the clip so the endpointer closes the last turn */
const TAIL_MS = 800;
/** 80 ms frames, as the call's mic uplink sends */
const FRAME_BYTES = (ASR_RATE * 2 * 80) / 1000;

export type TranscribeRouteOptions = {
  /** opens one Muse Transcribe stream (server: deps.openAsr with the call's languages) */
  openAsr: () => AsrLike;
  log: (event: string, data: Record<string, unknown>) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** audio sent per wall-clock ms (1 = real time). Default 4: a 5 s clip goes up in ~1.3 s. */
  speedup?: number;
  deadlineMs?: number;
  /** how long to wait for the last speechComplete after endStream */
  settleMs?: number;
  /** the body must arrive within this long */
  bodyMs?: number;
};

export type TranscribeRoute = {
  handles(pathname: string): boolean;
  handle(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void>;
};

const send = (res: ServerResponse, status: number, body: unknown) => {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
};

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

async function readBody(req: IncomingMessage, limit: number, ms: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > limit) throw new HttpError(413, "too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  let late = false;
  const timer = setTimeout(() => { late = true; req.destroy(); }, ms);
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new HttpError(413, "too_large");
      chunks.push(chunk as Buffer);
    }
  } catch (err) {
    if (late) throw new HttpError(408, "body_timeout");
    throw err;
  } finally { clearTimeout(timer); }
  if (late) throw new HttpError(408, "body_timeout");
  return Buffer.concat(chunks);
}

/** RIFF/WAVE PCM s16le mono → its samples and rate. Anything else is 415. */
export function parseWav(buf: Buffer): { pcm: Buffer; rate: number } {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new HttpError(415, "bad_audio");
  let off = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= buf.length) {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16 || (fmt.rate !== 16_000 && fmt.rate !== 24_000)) throw new HttpError(415, "bad_audio");
      const end = Math.min(buf.length, body + size);
      return { pcm: buf.subarray(body, end - ((end - body) % 2)), rate: fmt.rate };
    }
    off = body + size + (size % 2);
  }
  throw new HttpError(415, "bad_audio");
}

/** s16le mono 16 kHz → 24 kHz (linear, 2 → 3 samples). */
export function upsample16to24(pcm: Buffer): Buffer {
  const n = pcm.length >> 1;
  const outN = Math.floor((n * 3) / 2);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const pos = (i * 2) / 3;
    const a = Math.floor(pos);
    const b = Math.min(n - 1, a + 1);
    const t = pos - a;
    const v = pcm.readInt16LE(a * 2) * (1 - t) + pcm.readInt16LE(b * 2) * t;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return out;
}

/** The body as 24 kHz s16 mono PCM. */
export function decodeAudio(body: Buffer, contentType: string): Buffer {
  const type = contentType.toLowerCase();
  let pcm: Buffer;
  let rate: number;
  if (type.startsWith("audio/wav") || type.startsWith("audio/x-wav") || type.startsWith("audio/wave")) ({ pcm, rate } = parseWav(body));
  else if (type.startsWith("application/octet-stream") || type.startsWith("audio/l16") || type === "") {
    pcm = body.subarray(0, body.length - (body.length % 2));
    const m = /rate\s*=\s*(\d+)/.exec(type);
    rate = m ? Number(m[1]) : ASR_RATE;
    if (rate !== 16_000 && rate !== 24_000) throw new HttpError(415, "bad_audio");
  } else throw new HttpError(415, "bad_audio");
  return rate === 16_000 ? upsample16to24(pcm) : pcm;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One clip through one Muse Transcribe stream: the frames at `speedup`× real time, a short silence, endStream.
 * The text is every completed turn in order, plus the last partial if its turn never completed in time.
 */
export async function transcribeClip(asr: AsrLike, pcm24: Buffer, o: { speedup: number; deadlineMs: number; settleMs: number; now: () => number; signal?: AbortSignal }): Promise<{ text: string; turns: number; timedOut: boolean }> {
  const started = o.now();
  const done: string[] = [];
  let partial = "";
  let failed: Error | null = null;
  let closed = false;
  let wake: (() => void) | null = null;
  const poke = () => { const w = wake; wake = null; w?.(); };
  let ended = false;
  const end = () => { if (!ended) { ended = true; asr.end(); } };
  asr.on("event", (e: AsrEvent) => {
    if (e.type === "partial") partial = e.text;
    else if (e.type === "speechComplete") { if (e.text.trim()) done.push(e.text.trim()); partial = ""; poke(); }
  });
  asr.on("error", (err: Error) => { failed = err; poke(); });
  // a dropped stream is a failed clip here: no reconnect (TranscribeStream would reopen it for a live call)
  asr.on("status", (s) => { if (s === "closed") closed = true; else if (s === "reconnecting") { failed ??= new Error("asr_dropped"); end(); } poke(); });
  const left = () => o.deadlineMs - (o.now() - started);
  const onAbort = () => { failed ??= new Error("client_gone"); end(); poke(); };
  o.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let timer: NodeJS.Timeout | undefined;
    const connectTimeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(504, "timeout")), Math.max(1, left())); });
    try {
      await Promise.race([asr.connect(), connectTimeout]);
    } finally { clearTimeout(timer); }
    const tail = Buffer.alloc(Math.round((ASR_RATE * 2 * TAIL_MS) / 1000));
    const audio = Buffer.concat([pcm24, tail]);
    const frameMs = (FRAME_BYTES / 2 / ASR_RATE) * 1000;
    // the clip must be sent with time left to settle: a long clip goes faster than `speedup` (30 s → ~8×)
    const audioMs = (audio.length / 2 / ASR_RATE) * 1000;
    const sendBudget = Math.max(500, left() - o.settleMs - 500);
    const speedup = Math.max(o.speedup, audioMs / sendBudget);
    const sendStart = o.now();
    let sent = 0;
    for (let off = 0, i = 0; off < audio.length; off += FRAME_BYTES, i++) {
      if (failed || closed || left() <= 0) break;
      const frame = audio.subarray(off, Math.min(audio.length, off + FRAME_BYTES));
      asr.sendAudio(frame);
      sent += frame.length;
      const due = sendStart + ((i + 1) * frameMs) / speedup - o.now();
      if (due > 0) await sleep(due);
    }
    if (o.signal?.aborted) throw new HttpError(499, "client_gone");
    // part of the clip never went up: not a transcript of what they said
    if (sent < pcm24.length) throw new HttpError(failed ? 502 : 504, failed ? "transcribe_failed" : "timeout");
    end();
    // endStream: the last turn completes, then the vendor closes. Wait for the close (or settleMs, or the deadline).
    const settleBy = o.now() + o.settleMs;
    while (!closed && !failed && o.now() < settleBy && left() > 0) {
      await new Promise<void>((r) => {
        const t = setTimeout(() => { wake = null; r(); }, Math.max(1, Math.min(settleBy - o.now(), left())));
        wake = () => { clearTimeout(t); r(); };
      });
    }
    const text = [...done, partial.trim()].filter(Boolean).join(" ");
    if (failed && !text) throw new HttpError(502, "transcribe_failed");
    return { text, turns: done.length, timedOut: !closed && left() <= 0 };
  } finally { o.signal?.removeEventListener("abort", onAbort); end(); }
}

export function createTranscribeRoute(o: TranscribeRouteOptions): TranscribeRoute {
  const env = o.env ?? process.env;
  const now = o.now ?? Date.now;
  const off = env.GENITA_TRANSCRIBE_HTTP === "0";
  const minute = new Map<string, number[]>();
  const busy = new Set<string>();
  let inFlight = 0;
  o.log("transcribe.http", { enabled: !off });
  return {
    handles: (pathname) => !off && pathname === TRANSCRIBE_PATH,
    async handle(req, res, userId) {
      if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      const t0 = now();
      const recent = (minute.get(userId) ?? []).filter((t) => t0 - t < 60_000);
      if (busy.has(userId)) return send(res, 429, { error: "busy" });
      if (recent.length >= PER_MINUTE) { minute.set(userId, recent); return send(res, 429, { error: "rate_limited" }); }
      if (inFlight >= MAX_IN_FLIGHT) return send(res, 503, { error: "busy" });
      recent.push(t0);
      if (minute.size > 1000) for (const [u, ts] of minute) if (!ts.some((t) => t0 - t < 60_000)) minute.delete(u);
      minute.set(userId, recent);
      busy.add(userId);
      inFlight++;
      let bytes = 0, audioMs = 0, status = 200, code = "ok", turns = 0, chars = 0;
      try {
        const body = await readBody(req, MAX_BODY_BYTES, o.bodyMs ?? BODY_MS);
        bytes = body.length;
        const pcm = decodeAudio(body, String(req.headers["content-type"] ?? ""));
        audioMs = Math.round((pcm.length / 2 / ASR_RATE) * 1000);
        if (audioMs > MAX_AUDIO_MS) throw new HttpError(413, "too_long");
        if (audioMs < MIN_AUDIO_MS) { code = "too_short"; return send(res, 200, { text: "", ms: now() - t0 }); }
        // the app gave up or the connection dropped: stop sending to Meta, free the slot
        const gone = new AbortController();
        res.on("close", () => { if (!res.writableFinished) gone.abort(); });
        const r = await transcribeClip(o.openAsr(), pcm, { speedup: o.speedup ?? 4, deadlineMs: o.deadlineMs ?? DEADLINE_MS, settleMs: o.settleMs ?? 2500, now, signal: gone.signal });
        turns = r.turns; chars = r.text.length;
        if (r.timedOut) code = "deadline";
        send(res, 200, { text: r.text, ms: now() - t0 });
      } catch (err) {
        if (err instanceof HttpError) { status = err.status; code = err.code; }
        else { status = /daily_cap/.test(String(err)) ? 503 : 502; code = status === 503 ? "daily_cap" : "transcribe_failed"; }
        send(res, status, { error: code });
      } finally {
        busy.delete(userId);
        inFlight--;
        // sizes and timings only: never the audio or the words
        o.log("transcribe.request", { userId, status, code, bytes, audioMs, turns, chars, ms: now() - t0 });
      }
    },
  };
}
