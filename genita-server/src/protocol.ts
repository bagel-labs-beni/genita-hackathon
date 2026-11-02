/**
 * F0-L4 · Wire types for the realtime session (PROTOCOL.md). The Swift twin
 * is shared/GenitaKit/Sources/GenitaKit/Protocol.swift; both sides test
 * against the same samples in shared/protocol-samples/. Names here are the
 * contract: change them only with a PROTOCOL.md changelog entry.
 */
export const PROTOCOL_VERSION = 1;

/** Binary server frame: "GA" | kind u8 | reserved u8 | seq u32 LE | payload */
export const FRAME_HEADER_BYTES = 8;
export const FRAME_KIND_TTS_PCM = 1;
/** Peter mouth crop: header seq = utteranceId; payload = frame u32 LE + JPEG (F4-L17) */
export const FRAME_KIND_PETER = 2;

export type LipMode = "peter" | "atlas" | "none";
export type Mode = "chat" | "interpret";
export type Phase = "listening" | "thinking" | "speaking" | "interrupted";
export type CancelReason = "barge_in" | "text" | "client";
export type Viseme = "X" | "A" | "E" | "O" | "U" | "M" | "F" | "L" | "S";
export type MouthCue = { t: number; v: Viseme };
export type WordTiming = { w: string; s: number; e: number };
export type LipPlan = { requested: LipMode; active: LipMode; reason: string | null };

// ───────────────────────── app → server ─────────────────────────

export type PersonaWire = {
  name: string;
  kind?: "human" | "animal" | "character";
  traits?: string[];
  speakingStyle?: string;
  backstory?: string;
  voice?: { id: string; description?: string };
};

export type StartMessage = {
  type: "start";
  persona: PersonaWire;
  user?: { name?: string; profile?: string };
  memories?: string[];
  history?: { role: "user" | "assistant"; text: string }[];
  mode?: Mode;
  language?: string;
  voiceId?: string;
  lip?: LipMode | { mode: LipMode; fallback?: LipMode };
  bargeIn?: { minMs?: number; minWords?: number };
  mic?: boolean;
};

export type ClientMessage =
  | StartMessage
  | { type: "audio_start" }
  | { type: "audio_stop" }
  | { type: "text"; text: string; frames?: string[] }
  | { type: "frames"; images: string[] }
  | { type: "barge_in" }
  | { type: "playback_done"; utteranceId: number }
  | { type: "mode"; mode: Mode }
  | { type: "ping"; t?: unknown }
  | { type: "stop" };

// ───────────────────────── server → app ─────────────────────────

export type ServerEvent =
  | {
      type: "ready";
      protocol: number;
      sessionId: string;
      mode: Mode;
      audio: { in: string; out: string; frameHeaderBytes: number };
      lip: LipPlan;
      voiceId: string;
      bargeIn: { minMs: number; minWords: number };
    }
  | { type: "state"; state: Phase }
  | { type: "speech.start"; turnId: number }
  | { type: "speech.end"; turnId: number }
  | { type: "transcript"; text: string; final: boolean; turnId?: number; source?: "voice" | "text" }
  | { type: "interpret.detected"; from: string; to: string }
  | { type: "tool"; utteranceId: number; name: string; status: string }
  | { type: "reply.delta"; utteranceId: number; text: string }
  | { type: "speaking"; on: boolean; utteranceId: number; emotion?: string }
  | {
      type: "audio";
      utteranceId: number;
      seq: number;
      sentence: number;
      offsetMs: number;
      durationMs: number;
      sampleRate: number;
      model: string;
      words: WordTiming[];
      mouth?: MouthCue[];
    }
  | { type: "reply"; utteranceId: number; text: string; emotion: string; interpret: boolean; final: true }
  | { type: "utterance.cancelled"; utteranceId: number; reason: CancelReason }
  | {
      type: "turn.metrics";
      utteranceId: number;
      model: string;
      ttsModel: string | null;
      speechEndToCompleteMs: number | null;
      replyStartToFirstTokenMs: number | null;
      replyStartToFirstSentenceMs: number | null;
      firstSentenceToFirstAudioMs: number | null;
      speechEndToFirstAudioMs: number | null;
      audioMs: number;
      speculative?: "hit" | "miss" | "none";
    }
  | { type: "asr.status"; status: "connected" | "reconnecting" }
  | { type: "mode.changed"; mode: Mode; by: "client" | "model" }
  | { type: "lip.changed"; lip: LipPlan; peter?: { bundleId: string; pasteDy: number; fps: number } }
  | { type: "error"; code: ErrorCode; message: string; retryable: boolean }
  | { type: "pong"; t: unknown };

export type ErrorCode =
  | "spark_unavailable"
  | "tts_unavailable"
  | "asr_unavailable"
  | "not_started"
  | "already_started"
  | "bad_persona"
  | "bad_message"
  | "unknown_type"
  | "frame_too_large";

export type ServerEventType = ServerEvent["type"];

/**
 * Required fields per server event, for runtime checks in tests (and any
 * debugging client). Kept next to the types so they change together; the
 * test in test/protocol.test.ts fails if a type is missing here.
 */
export const SERVER_EVENT_FIELDS: Record<ServerEventType, { required: string[]; optional: string[] }> = {
  ready: { required: ["protocol", "sessionId", "mode", "audio", "lip", "voiceId", "bargeIn"], optional: [] },
  state: { required: ["state"], optional: [] },
  "speech.start": { required: ["turnId"], optional: [] },
  "speech.end": { required: ["turnId"], optional: [] },
  transcript: { required: ["text", "final"], optional: ["turnId", "source"] },
  "interpret.detected": { required: ["from", "to"], optional: [] },
  tool: { required: ["utteranceId", "name", "status"], optional: [] },
  "reply.delta": { required: ["utteranceId", "text"], optional: [] },
  speaking: { required: ["on", "utteranceId"], optional: ["emotion"] },
  audio: { required: ["utteranceId", "seq", "sentence", "offsetMs", "durationMs", "sampleRate", "model", "words"], optional: ["mouth"] },
  reply: { required: ["utteranceId", "text", "emotion", "interpret", "final"], optional: [] },
  "utterance.cancelled": { required: ["utteranceId", "reason"], optional: [] },
  "turn.metrics": {
    required: [
      "utteranceId",
      "model",
      "ttsModel",
      "speechEndToCompleteMs",
      "replyStartToFirstTokenMs",
      "replyStartToFirstSentenceMs",
      "firstSentenceToFirstAudioMs",
      "speechEndToFirstAudioMs",
      "audioMs",
    ],
    optional: ["speculative"],
  },
  "asr.status": { required: ["status"], optional: [] },
  "mode.changed": { required: ["mode", "by"], optional: [] },
  "lip.changed": { required: ["lip"], optional: ["peter"] },
  error: { required: ["code", "message", "retryable"], optional: [] },
  pong: { required: ["t"], optional: [] },
};

/** Problems with a server event object; [] = conforms. */
export function checkServerEvent(o: Record<string, unknown>): string[] {
  const spec = SERVER_EVENT_FIELDS[o.type as ServerEventType];
  if (!spec) return [`unknown type ${String(o.type)}`];
  const problems: string[] = [];
  for (const k of spec.required) if (!(k in o)) problems.push(`${o.type}: missing ${k}`);
  for (const k of Object.keys(o)) if (k !== "type" && !spec.required.includes(k) && !spec.optional.includes(k)) problems.push(`${o.type}: extra ${k}`);
  return problems;
}

export function encodeFrameHeader(kind: number, seq: number): Buffer {
  const head = Buffer.alloc(FRAME_HEADER_BYTES);
  head.write("GA", 0, "latin1");
  head.writeUInt8(kind, 2);
  head.writeUInt32LE(seq, 4);
  return head;
}

export function decodeFrameHeader(buf: Buffer): { kind: number; seq: number } | null {
  if (buf.length < FRAME_HEADER_BYTES || buf.toString("latin1", 0, 2) !== "GA") return null;
  return { kind: buf.readUInt8(2), seq: buf.readUInt32LE(4) };
}
