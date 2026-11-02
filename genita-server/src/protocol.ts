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

export type LipMode = "atlas" | "none";
/** Who speaks the reply: the server (Meta voice PCM frames) or the device (`say` text, on-device TTS). */
export type TtsMode = "server" | "device";
export type Mode = "chat" | "interpret";
export type Phase = "listening" | "thinking" | "speaking" | "interrupted";
export type CancelReason = "barge_in" | "text" | "client";
export type Viseme = "X" | "A" | "E" | "O" | "U" | "M" | "F" | "L" | "S";
export type MouthCue = { t: number; v: Viseme };
export type WordTiming = { w: string; s: number; e: number };
export type LipPlan = { requested: LipMode; active: LipMode; reason: string | null };

// F8 interpretation
export type InterpretSource = "face" | "call";
/** how the original reached Genita: mic by language, mic while held, the Mac call's sound, typed */
export type BubbleVia = "voice" | "hold" | "call" | "text";
export type BubbleStatus = "hearing" | "translating" | "speaking" | "done" | "unknown" | "skipped" | "cancelled";
export type BubbleReason = "language_unclear" | "no_other_language" | "same_language" | "echo" | "empty";
export type InterpretOptionsWire = { source?: InterpretSource; other?: string; app?: string };
export type InterpretBubbleEvent = {
  type: "interpret.bubble";
  bubbleId: number;
  speaker: "them" | "me" | "unknown";
  via: BubbleVia;
  status: BubbleStatus;
  original: { lang: string | null; text: string };
  translation?: { lang: string; text: string };
  utteranceId?: number;
  reason?: BubbleReason;
};

/** Client binary frames, only when interpret.source is "call": "GA" | kind | 0 | 0 u32, then PCM */
export const CLIENT_FRAME_KIND_MIC = 3;
export const CLIENT_FRAME_KIND_CALL = 4;

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
  /** id: stable owner key for Finds until login (F1-L5); timeZone: IANA, for "7:12 PM" in cards */
  user?: { name?: string; profile?: string; id?: string; timeZone?: string };
  memories?: string[];
  history?: { role: "user" | "assistant"; text: string }[];
  mode?: Mode;
  language?: string;
  voiceId?: string;
  lip?: LipMode | { mode: LipMode; fallback?: LipMode };
  bargeIn?: { minMs?: number; minWords?: number };
  mic?: boolean;
  /** default: "device" unless the server runs server TTS (GENITA_VOICE_URL + GENITA_VOICE_TOKEN) */
  tts?: TtsMode;
  /** F8: only read when mode is "interpret" */
  interpret?: InterpretOptionsWire;
  /**
   * D21 first call after onboarding (app sends 2000): wait up to this many ms (clamped 0–3000) for the user
   * to speak or type first; if they do, no greeting; if not, the companion greets. Unset = greet as before.
   */
  greetAfterMs?: number;
};

export type ClientMessage =
  | StartMessage
  | { type: "audio_start" }
  | { type: "audio_stop" }
  | { type: "text"; text: string; frames?: string[]; findId?: string }
  | { type: "frames"; images: string[] }
  | { type: "barge_in" }
  | { type: "playback_done"; utteranceId: number }
  | { type: "mode"; mode: Mode; interpret?: InterpretOptionsWire }
  | { type: "hold"; on: boolean }
  | { type: "ping"; t?: unknown }
  | { type: "stop" }
  | { type: "find.confirm"; findId: string; itemId: string; yes: boolean }
  | { type: "find.stop"; findId: string };

// ───────────────────────── Finds (F5-L3, F5-L8, F10) ─────────────────────────

export type FindKind = "recipe" | "outfit" | "link";
/** checking → have (Spark YES + SAM box) | maybe (Spark YES, no box: "맞아?") | buy (recipe only) */
export type FindTier = "checking" | "have" | "maybe" | "buy";
/** 0..1 of the camera frame the box was found on */
export type NormBox = { x1: number; y1: number; x2: number; y2: number };
export type FindItem = {
  id: string;
  name: string;
  tier: FindTier;
  from: "camera" | "recipe" | "both";
  count?: number;
  optional?: boolean;
  /** SAM box for the item's name (only on "have") */
  box?: NormBox;
  /** SAM box for how it looks ("red jar") — a hint on "maybe", never proof */
  hint?: NormBox;
  /** the user answered "맞아?" */
  confirmed?: "yes" | "no";
};
export type FindImage = { slot: string; status: "pending" | "ready" | "failed"; url?: string };
export type FindCard = {
  id: string;
  kind: FindKind;
  createdAt: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  /** short line for the collapsed sheet, e.g. "Need rice" */
  status?: string;
  /** what the companion says when the card lands */
  say?: string;
  hero?: FindImage;
  /** which camera frame boxes are drawn on (the app keeps the frame; the server never stores it) */
  camera?: { frame: number; at: string; w: number; h: number; label: string };
  items: FindItem[];
  steps: { text: string; source?: string; image?: FindImage }[];
  options: { label: string; frame: number; picked: boolean; box?: NormBox }[];
  why: string[];
  ask: string[];
  sources: { title: string; url: string; domain: string }[];
  /** lane 개인화 E: 1–2 chips from the user's own taste lines, e.g. "Your style: clean, minimal clothes", "You said: no cilantro" (source = that line) */
  reasons?: { text: string; source: string; from: "profile" | "call" }[];
  how: string[];
  page?: { url: string; opened: boolean };
  saved?: boolean;
};

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
      /** the voice mode actually used for this call */
      tts: TtsMode;
    }
  | { type: "state"; state: Phase }
  | { type: "speech.start"; turnId: number }
  | { type: "speech.end"; turnId: number }
  | { type: "transcript"; text: string; final: boolean; turnId?: number; source?: "voice" | "text" }
  | { type: "interpret.detected"; from: string; to: string }
  | { type: "interpret.pair"; user: string; other: string | null; source: InterpretSource; by: "auto" | "client"; app?: string }
  | InterpretBubbleEvent
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
  /** device mode: one sentence for the app to speak, in order. Plain text (no tags); lang is BCP-47. */
  | { type: "say"; utteranceId: number; sentence: number; text: string; emotion: string; lang: string }
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
  | { type: "lip.changed"; lip: LipPlan }
  | { type: "error"; code: ErrorCode; message: string; retryable: boolean }
  | { type: "pong"; t: unknown }
  | { type: "find.started"; findId: string; utteranceId: number; kind: FindKind; title: string; detail: string }
  | { type: "find.progress"; findId: string; detail: string }
  /** subtitle/status: the card's "You have 4, need rice" lines, once a card exists */
  | { type: "find.items"; findId: string; items: FindItem[]; checking: boolean; subtitle?: string; status?: string }
  | { type: "observe.boxes"; findId: string; frame: number; w: number; h: number; items: { label: string; box: NormBox }[] }
  | { type: "find.created"; findId: string; card: FindCard }
  | { type: "find.image"; findId: string; slot: string; status: "ready" | "failed"; url?: string }
  | { type: "find.failed"; findId: string; reason: "unclear" | "search_failed" | "error" | "stopped"; message: string }
  /** F2-L26: the user renamed the companion by voice ("Call yourself Max"); already saved — update every {name} label */
  | { type: "companion.named"; name: string }
  /** lane 개인화 B: a correction said in the call was saved ("Updated: no cilantro") — show it as a chip for 2.5 s */
  | { type: "profile.updated"; text: string; fields: string[] }
  /** lane 개인화 GK-1: the companion just asked this call's getting-to-know-you question — soft chip "Getting to know you · {topic}" */
  | { type: "profile.asking"; topic: string };

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
  ready: { required: ["protocol", "sessionId", "mode", "audio", "lip", "voiceId", "bargeIn", "tts"], optional: [] },
  state: { required: ["state"], optional: [] },
  "speech.start": { required: ["turnId"], optional: [] },
  "speech.end": { required: ["turnId"], optional: [] },
  transcript: { required: ["text", "final"], optional: ["turnId", "source"] },
  "interpret.detected": { required: ["from", "to"], optional: [] },
  "interpret.pair": { required: ["user", "other", "source", "by"], optional: ["app"] },
  "interpret.bubble": { required: ["bubbleId", "speaker", "via", "status", "original"], optional: ["translation", "utteranceId", "reason"] },
  tool: { required: ["utteranceId", "name", "status"], optional: [] },
  "reply.delta": { required: ["utteranceId", "text"], optional: [] },
  speaking: { required: ["on", "utteranceId"], optional: ["emotion"] },
  audio: { required: ["utteranceId", "seq", "sentence", "offsetMs", "durationMs", "sampleRate", "model", "words"], optional: ["mouth"] },
  say: { required: ["utteranceId", "sentence", "text", "emotion", "lang"], optional: [] },
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
  "lip.changed": { required: ["lip"], optional: [] },
  error: { required: ["code", "message", "retryable"], optional: [] },
  pong: { required: ["t"], optional: [] },
  "find.started": { required: ["findId", "utteranceId", "kind", "title", "detail"], optional: [] },
  "find.progress": { required: ["findId", "detail"], optional: [] },
  "find.items": { required: ["findId", "items", "checking"], optional: ["subtitle", "status"] },
  "observe.boxes": { required: ["findId", "frame", "w", "h", "items"], optional: [] },
  "find.created": { required: ["findId", "card"], optional: [] },
  "find.image": { required: ["findId", "slot", "status"], optional: ["url"] },
  "find.failed": { required: ["findId", "reason", "message"], optional: [] },
  "companion.named": { required: ["name"], optional: [] },
  "profile.updated": { required: ["text", "fields"], optional: [] },
  "profile.asking": { required: ["topic"], optional: [] },
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

// ───────────────────────── watch socket (F5, /v1/watch) ─────────────────────────
// A second socket per call, opened by the Mac while it shares its screen.
// See PROTOCOL.md "Watch together". Binary app → server = system audio PCM
// s16le mono 24 kHz (the shared screen's sound, never the mic).

export type WatchClientMessage =
  | { type: "start"; source?: string }
  | { type: "frame"; image: string; blank?: boolean }
  | { type: "stop" }
  | { type: "ping"; t?: unknown };

export type WatchServerEvent =
  | { type: "ready"; protocol: number; sessionId: string }
  | { type: "state"; sharing: boolean; blank: boolean; source: string | null }
  | { type: "reaction"; utteranceId: number; moment: "funny" | "surprising" | "sweet" }
  | { type: "speaker"; on: boolean; label?: string; name?: string }
  | { type: "error"; code: "unknown_type" | "bad_message" | "frame_too_large" | "asr_unavailable" | "not_started"; message: string }
  | { type: "pong"; t: unknown };

export type WatchServerEventType = WatchServerEvent["type"];

export const WATCH_EVENT_FIELDS: Record<WatchServerEventType, { required: string[]; optional: string[] }> = {
  ready: { required: ["protocol", "sessionId"], optional: [] },
  state: { required: ["sharing", "blank", "source"], optional: [] },
  reaction: { required: ["utteranceId", "moment"], optional: [] },
  speaker: { required: ["on"], optional: ["label", "name"] },
  error: { required: ["code", "message"], optional: [] },
  pong: { required: ["t"], optional: [] },
};

export function checkWatchEvent(o: Record<string, unknown>): string[] {
  const spec = WATCH_EVENT_FIELDS[o.type as WatchServerEventType];
  if (!spec) return [`unknown watch type ${String(o.type)}`];
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
