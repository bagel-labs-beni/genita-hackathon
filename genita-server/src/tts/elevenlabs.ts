/**
 * ElevenLabs streaming TTS with character timestamps:
 *   POST /v1/text-to-speech/{voice}/stream/with-timestamps?output_format=pcm_24000
 * Response: newline-delimited JSON, each {audio_base64, alignment,
 * normalized_alignment}. Alignment times are seconds from the start of THIS
 * request's audio (checked 11/2), and `alignment.characters` includes the
 * [audio tags] we sent.
 *
 * Measured 11/2 (warm): eleven_v4_turbo first chunk ≈ 0.3 s, eleven_v3 ≈ 0.86 s.
 */
import { UpstreamError } from "../meta/http.ts";
import type { Alignment } from "../lips/visemes.ts";
import { buildTtsBody, isModelRefusal } from "./tone.ts";

export const PCM_SAMPLE_RATE = 24000;

export type TtsChunk = { audio: Buffer; alignment: Alignment | null; model: string };

export type TtsRequest = {
  apiKey: string;
  voiceId: string;
  text: string;
  emotion: string | null;
  model: string;
  fallbackModel?: string;
  signal?: AbortSignal;
  baseUrl?: string;
};

async function open(req: TtsRequest, model: string): Promise<Response> {
  const url = `${req.baseUrl ?? "https://api.elevenlabs.io"}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}/stream/with-timestamps?output_format=pcm_24000`;
  return fetch(url, {
    method: "POST",
    headers: { "xi-api-key": req.apiKey, "content-type": "application/json" },
    body: JSON.stringify(buildTtsBody(req.text, req.emotion, model)),
    signal: req.signal,
  });
}

export async function* streamSpeech(req: TtsRequest): AsyncGenerator<TtsChunk> {
  let model = req.model;
  let r = await open(req, model);
  if (!r.ok && req.fallbackModel && req.fallbackModel !== model && isModelRefusal(r.status)) {
    await r.body?.cancel().catch(() => {});
    model = req.fallbackModel;
    r = await open(req, model);
  }
  if (!r.ok || !r.body) throw new UpstreamError("elevenlabs", r.status, await r.text().catch(() => ""));

  const dec = new TextDecoder();
  let buf = "";
  let carry: Buffer | null = null; // keep s16 sample alignment across chunks
  const toChunk = (line: string): TtsChunk | null => {
    let j: {
      audio_base64?: string;
      alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null;
    };
    try {
      j = JSON.parse(line);
    } catch {
      return null;
    }
    let audio: Buffer = Buffer.from(j.audio_base64 ?? "", "base64");
    if (carry) {
      audio = Buffer.concat([carry, audio]);
      carry = null;
    }
    if (audio.length % 2) {
      carry = audio.subarray(audio.length - 1);
      audio = audio.subarray(0, audio.length - 1);
    }
    const a = j.alignment;
    const alignment = a?.characters?.length
      ? { chars: a.characters, startsSec: a.character_start_times_seconds, endsSec: a.character_end_times_seconds }
      : null;
    if (!audio.length && !alignment) return null;
    return { audio, alignment, model };
  };
  for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(c, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const chunk = toChunk(line);
      if (chunk) yield chunk;
    }
  }
  if (buf.trim()) {
    const chunk = toChunk(buf.trim());
    if (chunk) yield chunk;
  }
}

export const pcmDurationMs = (bytes: number) => (bytes / 2 / PCM_SAMPLE_RATE) * 1000;
