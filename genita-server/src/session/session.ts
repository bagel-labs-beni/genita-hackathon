/**
 * One realtime conversation: app socket ↔ Muse Transcribe ↔ Muse Spark ↔
 * ElevenLabs. Turn-taking decisions live in turnMachine.ts (pure); this
 * class only executes their effects and moves bytes. Protocol: PROTOCOL.md.
 */
import type { Config } from "../config.ts";
import type { AsrEvent } from "../meta/transcribe.ts";
import { SPARK_MODEL, type InputMessage, type SparkRequest, type SparkStreamEvent, type ContentPart } from "../meta/spark.ts";
import type { TtsChunk, TtsRequest } from "../tts/elevenlabs.ts";
import { pcmDurationMs, PCM_SAMPLE_RATE } from "../tts/elevenlabs.ts";
import { avoidRepeatedOpener, buildInstructions, buildInterpretInstructions, type PersonaCard, type UserProfile } from "../prompt/persona.ts";
import { SentenceSplitter } from "../text/sentences.ts";
import { parseTaggedSentence } from "../text/tags.ts";
import { isMostlyHangul } from "../text/language.ts";
import { chunkTiming, planLips, type LipMode, type LipPlan } from "../lips/source.ts";
import { Eager } from "../util/eager.ts";
import { hedged } from "../util/hedge.ts";
import {
  PROTOCOL_VERSION,
  FRAME_HEADER_BYTES,
  FRAME_KIND_TTS_PCM,
  FRAME_KIND_PETER,
  CLIENT_FRAME_KIND_MIC,
  CLIENT_FRAME_KIND_CALL,
  encodeFrameHeader,
  type ServerEvent,
  type ErrorCode,
  type CancelReason,
  type InterpretOptionsWire,
} from "../protocol.ts";
import { Interpreter, type InterpretHost } from "../interpret/interpreter.ts";
import { interpretCommand } from "../interpret/language.ts";
import { initialTurnState, reduceTurn, type Effect, type TurnEvent, type TurnState } from "./turnMachine.ts";

export { PROTOCOL_VERSION, FRAME_HEADER_BYTES, FRAME_KIND_TTS_PCM } from "../protocol.ts";

export interface ClientSink {
  sendJson(msg: ServerEvent): void;
  sendBinary(buf: Buffer): void;
  close(code: number, reason: string): void;
}

export interface AsrLike {
  on(ev: "event", fn: (e: AsrEvent) => void): unknown;
  on(ev: "status", fn: (s: "connected" | "reconnecting" | "closed") => void): unknown;
  on(ev: "error", fn: (e: Error) => void): unknown;
  connect(): Promise<void>;
  sendAudio(pcm: Buffer): void;
  end(): void;
  readonly isOpen: boolean;
}

export interface PeterLike {
  on(ev: "crop", fn: (c: { requestId: number; frame: number; jpeg: Buffer }) => void): unknown;
  on(ev: "closed", fn: (code: number) => void): unknown;
  connect(): Promise<{ bundleId: string; pasteDy: number; fps: number }>;
  readonly isReady: boolean;
  begin(requestId: number, startFrame?: number): void;
  audio24k(requestId: number, pcm24k: Buffer): void;
  end(requestId: number): void;
  cancel(requestId: number): void;
  close(): void;
}

export type SessionDeps = {
  config: Config;
  openAsr: (languages: string[]) => AsrLike;
  spark: (req: SparkRequest, opts: { signal?: AbortSignal; firstEventTimeoutMs?: number }) => AsyncIterable<SparkStreamEvent>;
  tts: (req: Omit<TtsRequest, "apiKey">) => AsyncIterable<TtsChunk>;
  now?: () => number;
  /** Peter worker connection factory; unset = Peter not deployed */
  openPeter?: (opts?: { avatarId?: string }) => PeterLike;
  log?: (event: string, data: Record<string, unknown>) => void;
};

type Mode = "chat" | "interpret";
type HistoryItem = { role: "user" | "assistant"; text: string };
type Frames = { images: string[]; at: number };

type Reply = {
  utteranceId: number;
  abort: AbortController;
  spoken: string[];
  firstAudioAt: number | null;
  audioMs: number;
  doneTimer: NodeJS.Timeout | null;
  /** this reply's audio is going to Peter */
  peter: boolean;
};

type TurnMetrics = { speechEndAt?: number; completeAt?: number };
type Built = { req: SparkRequest; interpret: boolean; detected: { from: string; to: string } | null };
type Speculation = { norm: string; abort: AbortController; built: Built; stream: Eager<SparkStreamEvent> };

/** Transcript comparison for speculation: case and punctuation do not matter. */
export function normTranscript(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
}
const LOOKS_FINAL = /[.?!。？！…]["'”’)\]]*$/;

const MAX_HISTORY = 16;
const MAX_FRAMES = 2;
const MAX_FRAME_BYTES = 1_500_000;
const FRAMES_TTL_MS = 15_000;
const PLAYBACK_SLACK_MS = 250;
/** spoken after "Can you interpret for me?" */
const INTERPRET_ON_LINE = "Sure, I'll pass on what I hear.";

function parseInterpretOptions(v: unknown): InterpretOptionsWire {
  if (!v || typeof v !== "object") return {};
  const o = v as Record<string, unknown>;
  return {
    source: o.source === "call" ? "call" : "face",
    other: str(o.other, 40),
    app: str(o.app, 40),
  };
}

function str(v: unknown, max = 4000): string | undefined {
  return typeof v === "string" ? v.slice(0, max) : undefined;
}

function parsePersona(v: unknown): PersonaCard | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  const name = str(p.name, 80);
  if (!name) return null;
  const kind = p.kind === "animal" || p.kind === "character" ? p.kind : "human";
  const traits = Array.isArray(p.traits) ? p.traits.map((t) => str(t, 80)).filter((t): t is string => !!t).slice(0, 12) : [];
  const voice = p.voice && typeof p.voice === "object" ? (p.voice as Record<string, unknown>) : null;
  return {
    name,
    kind,
    traits,
    speakingStyle: str(p.speakingStyle, 400),
    backstory: str(p.backstory, 1200),
    voice: voice && str(voice.id, 64) ? { id: str(voice.id, 64)!, description: str(voice.description, 200) } : undefined,
  };
}

export class Session {
  readonly id: string;
  private readonly deps: SessionDeps;
  private readonly now: () => number;
  private turn: TurnState = initialTurnState();
  private started = false;
  private closed = false;
  private persona: PersonaCard | null = null;
  private user: UserProfile | undefined;
  private memories: string[] = [];
  private mode: Mode = "chat";
  private language = "English";
  private voiceId: string;
  private lip: LipPlan = { requested: "none", active: "none", reason: null };
  /** start.lip.avatarId: the companion's baked Peter cache (GET /v1/companion/prep → lips.peter.avatarId) */
  private peterAvatarId: string | undefined;
  private history: HistoryItem[] = [];
  private recentReplies: string[] = [];
  private frames: Frames | null = null;
  private asr: AsrLike | null = null;
  /** F8 · set while mode is "interpret" */
  private interp: Interpreter | null = null;
  /** F8 · Mac call interpretation: a second ASR stream for the call's sound */
  private callAsr: AsrLike | null = null;
  private micOn = true;
  private reply: Reply | null = null;
  private spec: Speculation | null = null;
  private peter: PeterLike | null = null;
  private peterCancelled = new Set<number>();
  private specTimer: NodeJS.Timeout | null = null;
  private bargeTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  private metrics: TurnMetrics = {};
  private bargeCfg: { bargeInMinMs: number; bargeInMinWords: number };
  private readonly client: ClientSink;

  constructor(id: string, client: ClientSink, deps: SessionDeps) {
    this.id = id;
    this.client = client;
    this.deps = deps;
    this.now = deps.now ?? (() => performance.now());
    this.voiceId = deps.config.defaultVoiceId;
    this.bargeCfg = { bargeInMinMs: deps.config.bargeInMinMs, bargeInMinWords: deps.config.bargeInMinWords };
  }

  // ───────────────────────── client input ─────────────────────────

  async onClientText(raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.error("bad_message", "Message is not JSON", false);
    }
    const type = msg.type;
    if (type === "start") return this.start(msg);
    if (type === "ping") return this.client.sendJson({ type: "pong", t: msg.t ?? null });
    if (!this.started) return this.error("not_started", "Send start first", false);
    switch (type) {
      case "audio_start":
        this.micOn = true;
        await this.ensureAsr();
        return;
      case "audio_stop":
        this.micOn = false;
        // ~0.8 s of silence lets endpointing finish a sentence cut by the mute
        this.asr?.sendAudio(Buffer.alloc(Math.round(PCM_SAMPLE_RATE * 0.8) * 2));
        return;
      case "text": {
        const text = str(msg.text, 2000)?.trim();
        if (!text) return;
        if (Array.isArray(msg.frames)) this.setFrames(msg.frames);
        this.client.sendJson({ type: "transcript", final: true, text, source: "text" });
        if (this.interp) return this.interp.typed(text);
        return this.dispatch({ type: "text", text });
      }
      case "barge_in":
        if (this.interp) return this.interp.bargeIn();
        return this.dispatch({ type: "client_barge_in" });
      case "hold":
        this.interp?.hold(msg.on === true);
        return;
      case "playback_done": {
        if (this.interp && typeof msg.utteranceId === "number") this.interp.playbackDone(msg.utteranceId);
        const r = this.reply;
        if (r && msg.utteranceId === r.utteranceId && r.doneTimer) {
          clearTimeout(r.doneTimer);
          this.finishReply(r);
        }
        return;
      }
      case "mode":
        if (msg.mode === "chat" || msg.mode === "interpret") this.switchMode(msg.mode, "client", parseInterpretOptions(msg.interpret));
        return;
      case "frames":
        this.setFrames(msg.images);
        return;
      case "stop":
        return this.close(1000, "stopped");
      default:
        return this.error("unknown_type", `Unknown message type ${String(type).slice(0, 40)}`, false);
    }
  }

  onClientAudio(frame: Buffer): void {
    if (!this.started) return;
    let pcm = frame;
    // F8 Mac call mode: frames carry a "GA" header saying mic (3) or call sound (4)
    if (frame.length > FRAME_HEADER_BYTES && frame[0] === 0x47 && frame[1] === 0x41 && frame[3] === 0 && (frame[2] === CLIENT_FRAME_KIND_MIC || frame[2] === CLIENT_FRAME_KIND_CALL)) {
      pcm = frame.subarray(FRAME_HEADER_BYTES);
      if (frame[2] === CLIENT_FRAME_KIND_CALL) {
        if (this.interp?.source !== "call") return;
        if (!this.callAsr?.isOpen) void this.ensureCallAsr();
        this.callAsr?.sendAudio(pcm);
        return;
      }
    }
    if (!this.micOn) return;
    // "Hold to reply": outside the hold the mic is silence, which also ends the held turn quickly
    if (this.interp?.micGated) pcm = Buffer.alloc(pcm.length);
    if (!this.asr?.isOpen) void this.ensureAsr();
    this.asr?.sendAudio(pcm);
  }

  // ───────────────────────── lifecycle ─────────────────────────

  private async start(msg: Record<string, unknown>): Promise<void> {
    if (this.started) return this.error("already_started", "Session already started", false);
    const persona = parsePersona(msg.persona);
    if (!persona) return this.error("bad_persona", "start.persona.name is required", false);
    this.persona = persona;
    const u = msg.user && typeof msg.user === "object" ? (msg.user as Record<string, unknown>) : {};
    this.user = { name: str(u.name, 80), profile: str(u.profile, 4000) };
    this.memories = Array.isArray(msg.memories) ? msg.memories.map((m) => str(m, 300)).filter((m): m is string => !!m).slice(-24) : [];
    if (Array.isArray(msg.history)) {
      for (const h of msg.history.slice(-MAX_HISTORY)) {
        const item = h as Record<string, unknown>;
        const text = str(item?.text, 1000);
        if (text && (item.role === "user" || item.role === "assistant")) this.history.push({ role: item.role, text });
      }
      this.recentReplies = this.history.filter((h) => h.role === "assistant").map((h) => h.text).slice(-3);
    }
    const startMode: Mode = msg.mode === "interpret" ? "interpret" : "chat";
    this.language = str(msg.language, 40) ?? "English";
    this.voiceId = str(msg.voiceId, 64) ?? persona.voice?.id ?? this.deps.config.defaultVoiceId;
    const lip = (msg.lip && typeof msg.lip === "object" ? msg.lip : { mode: msg.lip }) as Record<string, unknown>;
    const asLip = (v: unknown, d: LipMode): LipMode => (v === "peter" || v === "atlas" || v === "none" ? v : d);
    this.peterAvatarId = typeof lip.avatarId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(lip.avatarId) ? lip.avatarId : undefined;
    this.lip = planLips(asLip(lip.mode, persona.kind === "human" ? "none" : "atlas"), asLip(lip.fallback, "none"), !!this.deps.openPeter);
    const b = (msg.bargeIn && typeof msg.bargeIn === "object" ? msg.bargeIn : {}) as Record<string, unknown>;
    if (typeof b.minMs === "number" && b.minMs >= 0 && b.minMs <= 3000) this.bargeCfg.bargeInMinMs = b.minMs;
    if (typeof b.minWords === "number" && b.minWords >= 1 && b.minWords <= 10) this.bargeCfg.bargeInMinWords = b.minWords;
    this.micOn = msg.mic !== false;
    this.started = true;
    if (this.micOn) {
      try {
        await this.ensureAsr();
      } catch {
        this.error("asr_unavailable", "Speech recognition could not connect; text still works", true);
      }
    }
    this.client.sendJson({
      type: "ready",
      protocol: PROTOCOL_VERSION,
      sessionId: this.id,
      mode: startMode,
      audio: { in: "pcm_s16le_24000_mono", out: "pcm_s16le_24000_mono", frameHeaderBytes: FRAME_HEADER_BYTES },
      lip: this.lip,
      voiceId: this.voiceId,
      bargeIn: { minMs: this.bargeCfg.bargeInMinMs, minWords: this.bargeCfg.bargeInMinWords },
    });
    this.client.sendJson({ type: "state", state: "listening" });
    if (startMode === "interpret") this.enterInterpret(parseInterpretOptions(msg.interpret));
    if (this.lip.reason === "peter_connecting") void this.connectPeter();
  }

  // ───────────────────────── F8 interpretation ─────────────────────────

  private switchMode(mode: Mode, by: "client" | "model", opts: InterpretOptionsWire = {}): void {
    if (mode === "interpret") {
      // a chat reply in progress is cut; the interpreter owns the voice now
      if (this.turn.phase !== "listening") this.dispatch({ type: "client_barge_in" });
      this.dropSpeculation();
      this.mode = "interpret";
      this.client.sendJson({ type: "mode.changed", mode, by });
      this.enterInterpret(opts);
      return;
    }
    this.leaveInterpret();
    this.mode = "chat";
    this.client.sendJson({ type: "mode.changed", mode, by });
  }

  private enterInterpret(opts: InterpretOptionsWire): void {
    this.interp?.stop();
    this.mode = "interpret";
    this.interp = new Interpreter(this.interpretHost(), {
      userLanguage: this.language,
      source: opts.source ?? "face",
      other: opts.other ?? null,
      app: opts.app,
      speculate: this.deps.config.speculate,
      speculateStableMs: this.deps.config.speculateStableMs,
    });
    this.interp.begin();
    if (this.interp.source === "call") void this.ensureCallAsr().catch(() => this.error("asr_unavailable", "Could not listen to the call's sound", true));
    else this.dropCallAsr();
  }

  private leaveInterpret(): void {
    this.interp?.stop();
    this.interp = null;
    this.dropCallAsr();
  }

  private dropCallAsr(): void {
    const a = this.callAsr;
    this.callAsr = null;
    a?.end();
  }

  private async ensureCallAsr(): Promise<void> {
    if (this.closed || this.callAsr) return;
    const asr = this.deps.openAsr(this.deps.config.asrLanguages);
    this.callAsr = asr;
    asr.on("event", (e) => {
      if (this.callAsr !== asr || !this.interp) return;
      if (e.type === "partial") this.interp.partial("call", e.text);
      else if (e.type === "speechEnd") this.interp.speechEnd("call");
      else if (e.type === "speechComplete") this.interp.final("call", e.text);
    });
    asr.on("status", (s) => {
      if (s === "closed" && this.callAsr === asr) this.callAsr = null;
    });
    asr.on("error", (err) => this.log("asr.call.error", { message: err.message.slice(0, 200) }));
    await asr.connect();
  }

  private interpretHost(): InterpretHost {
    return {
      now: this.now,
      send: (e) => this.client.sendJson(e),
      sendAudio: (seq, pcm) => this.client.sendBinary(Buffer.concat([encodeFrameHeader(FRAME_KIND_TTS_PCM, seq), pcm])),
      nextSeq: () => ++this.seq,
      nextUtteranceId: () => {
        // shares the turn machine's counter so ids never repeat across modes
        this.turn = { ...this.turn, utteranceId: this.turn.utteranceId + 1 };
        return this.turn.utteranceId;
      },
      translate: (req, signal) => this.sparkSource(req, signal),
      tts: (text, signal) =>
        this.deps.tts({ voiceId: this.voiceId, text, emotion: null, model: this.deps.config.ttsModel, fallbackModel: this.deps.config.ttsFallbackModel, signal }),
      timing: (alignment, offsetMs) => chunkTiming(this.lip.active, alignment, offsetMs),
      lipBegin: (uid) => {
        if (this.lip.active !== "peter" || !this.peter?.isReady) return false;
        this.peter.begin(uid);
        return true;
      },
      lipAudio: (uid, pcm) => this.peter?.audio24k(uid, pcm),
      lipEnd: (uid) => this.peter?.end(uid),
      lipCancel: (uid) => {
        this.peterCancelled.add(uid);
        this.peter?.cancel(uid);
      },
      log: (event, data) => this.log(event, data),
    };
  }

  private async connectPeter(): Promise<void> {
    const fallback = this.lip.active;
    const peter = this.deps.openPeter!({ avatarId: this.peterAvatarId });
    this.peter = peter;
    peter.on("crop", (c) => {
      if (this.closed || this.peterCancelled.has(c.requestId)) return;
      const frame = Buffer.alloc(4);
      frame.writeUInt32LE(c.frame >>> 0, 0);
      this.client.sendBinary(Buffer.concat([encodeFrameHeader(FRAME_KIND_PETER, c.requestId), frame, c.jpeg]));
    });
    peter.on("closed", () => {
      if (this.closed || this.lip.active !== "peter") return;
      this.lip = { requested: "peter", active: fallback, reason: "peter_unavailable" };
      this.client.sendJson({ type: "lip.changed", lip: this.lip });
    });
    try {
      const r = await peter.connect();
      if (this.closed) return peter.close();
      this.lip = { requested: "peter", active: "peter", reason: null };
      this.client.sendJson({ type: "lip.changed", lip: this.lip, peter: { bundleId: r.bundleId, pasteDy: r.pasteDy, fps: r.fps } });
    } catch (err) {
      this.peter = null;
      if (this.closed) return;
      this.lip = { requested: "peter", active: fallback, reason: "peter_unavailable" };
      this.client.sendJson({ type: "lip.changed", lip: this.lip });
      this.log("peter.error", { message: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
    }
  }

  private async ensureAsr(): Promise<void> {
    if (this.closed || (this.asr && this.asr.isOpen)) return;
    if (!this.asr) {
      const asr = this.deps.openAsr(this.deps.config.asrLanguages);
      asr.on("event", (e) => this.onAsr(e));
      asr.on("status", (s) => {
        if (s === "reconnecting") this.client.sendJson({ type: "asr.status", status: "reconnecting" });
        if (s === "connected") this.client.sendJson({ type: "asr.status", status: "connected" });
        if (s === "closed" && this.asr === asr) this.asr = null;
      });
      asr.on("error", (err) => this.log("asr.error", { message: err.message.slice(0, 200) }));
      this.asr = asr;
      await asr.connect();
    }
  }

  close(code = 1000, reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    if (this.bargeTimer) clearTimeout(this.bargeTimer);
    this.dropSpeculation();
    if (this.reply) {
      this.reply.abort.abort();
      if (this.reply.doneTimer) clearTimeout(this.reply.doneTimer);
    }
    this.interp?.stop();
    this.dropCallAsr();
    this.asr?.end();
    this.peter?.close();
    this.client.close(code, reason);
  }

  // ───────────────────────── ASR → turn machine ─────────────────────────

  private onAsr(e: AsrEvent): void {
    const t = this.now();
    if (this.interp) return this.onInterpretAsr(e);
    switch (e.type) {
      case "speechStart":
        this.client.sendJson({ type: "speech.start", turnId: e.turnId });
        return this.dispatch({ type: "speech_start" });
      case "partial":
        this.client.sendJson({ type: "transcript", final: false, text: e.text });
        this.dispatch({ type: "partial", text: e.text });
        return this.considerSpeculation(e.text);
      case "speechEnd":
        this.metrics = { speechEndAt: t };
        this.client.sendJson({ type: "speech.end", turnId: e.turnId });
        return this.dispatch({ type: "speech_end" });
      case "speechComplete":
        this.metrics.completeAt = t;
        this.client.sendJson({ type: "transcript", final: true, text: e.text, turnId: e.turnId, source: "voice" });
        if (interpretCommand(e.text) === "start") {
          // INT-0 by voice: "Can you interpret for me?"
          this.switchMode("interpret", "model");
          (this.interp as Interpreter | null)?.say(INTERPRET_ON_LINE);
          return;
        }
        this.dispatch({ type: "speech_complete", text: e.text });
        // not consumed by a reply (backchannel / empty): stop the guess
        return this.dropSpeculation();
    }
  }

  /** Interpret mode: the mic's ASR events become bubbles, not chat turns. */
  private onInterpretAsr(e: AsrEvent): void {
    const interp = this.interp!;
    switch (e.type) {
      case "speechStart":
        this.client.sendJson({ type: "speech.start", turnId: e.turnId });
        return;
      case "partial":
        this.client.sendJson({ type: "transcript", final: false, text: e.text });
        return interp.partial("mic", e.text);
      case "speechEnd":
        this.client.sendJson({ type: "speech.end", turnId: e.turnId });
        return interp.speechEnd("mic");
      case "speechComplete":
        this.client.sendJson({ type: "transcript", final: true, text: e.text, turnId: e.turnId, source: "voice" });
        if (interpretCommand(e.text) === "stop") return this.switchMode("chat", "model");
        return interp.final("mic", e.text);
    }
  }

  private dispatch(e: TurnEvent): void {
    if (this.closed) return;
    const r = reduceTurn(this.turn, e, this.bargeCfg);
    this.turn = r.state;
    for (const fx of r.effects) this.run(fx);
  }

  private run(fx: Effect): void {
    switch (fx.type) {
      case "emit_state":
        this.client.sendJson({ type: "state", state: fx.phase });
        return;
      case "arm_barge_timer":
        if (this.bargeTimer) clearTimeout(this.bargeTimer);
        this.bargeTimer = setTimeout(() => {
          this.bargeTimer = null;
          this.dispatch({ type: "barge_timer" });
        }, fx.ms);
        return;
      case "cancel_reply":
        return this.cancelReply(fx.utteranceId, fx.reason);
      case "start_reply":
        void this.runReply(fx.text, fx.utteranceId);
        return;
    }
  }

  private cancelReply(utteranceId: number, reason: CancelReason): void {
    const r = this.reply;
    if (!r || r.utteranceId !== utteranceId) return;
    r.abort.abort();
    if (r.doneTimer) clearTimeout(r.doneTimer);
    this.reply = null;
    if (r.peter) {
      this.peterCancelled.add(utteranceId);
      this.peter?.cancel(utteranceId);
    }
    if (r.spoken.length) this.remember("assistant", r.spoken.join(" ") + " —");
    this.client.sendJson({ type: "utterance.cancelled", utteranceId, reason });
    this.client.sendJson({ type: "speaking", on: false, utteranceId });
    this.log("turn.cancelled", { utteranceId, reason });
  }

  // ───────────────────────── reply pipeline ─────────────────────────

  private setFrames(images: unknown): void {
    if (!Array.isArray(images)) return;
    const urls: string[] = [];
    for (const img of images.slice(0, MAX_FRAMES)) {
      if (typeof img !== "string") continue;
      const url = img.startsWith("data:image/") ? img : `data:image/jpeg;base64,${img}`;
      if (url.length > MAX_FRAME_BYTES * 1.4) return this.error("frame_too_large", "Each frame must be under 1.5 MB", false);
      urls.push(url);
    }
    this.frames = urls.length ? { images: urls, at: this.now() } : null;
  }

  private takeFrames(): string[] {
    const f = this.frames;
    this.frames = null;
    if (!f || this.now() - f.at > FRAMES_TTL_MS) return [];
    return f.images;
  }

  private remember(role: "user" | "assistant", text: string): void {
    this.history.push({ role, text });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    if (role === "assistant") this.recentReplies = [...this.recentReplies, text].slice(-3);
  }

  /** Pure apart from consuming pending camera frames. */
  private buildRequest(text: string): Built {
    const persona = this.persona!;
    const hangul = isMostlyHangul(text);
    const interpret = this.mode === "interpret" || hangul;
    if (interpret) {
      const from = hangul ? "Korean" : "English";
      const to = hangul ? "English" : "Korean";
      return {
        interpret,
        detected: this.mode === "chat" ? { from, to } : null,
        req: { instructions: buildInterpretInstructions({ persona, from, to }), input: text, maxOutputTokens: 400 },
      };
    }
    const images = this.takeFrames();
    const content: string | ContentPart[] = images.length
      ? [{ type: "input_text", text }, ...images.map((u) => ({ type: "input_image" as const, image_url: u }))]
      : text;
    const input: InputMessage[] = [
      ...this.history.map((h): InputMessage => (h.role === "user" ? { role: "user", content: h.text } : { role: "assistant", content: h.text })),
      { role: "user", content },
    ];
    const instructions = buildInstructions({
      persona,
      user: this.user,
      memories: this.memories,
      mode: "chat",
      language: this.language,
      cameraAttached: images.length > 0,
    });
    return {
      interpret,
      detected: null,
      req: { instructions, input, maxOutputTokens: 800, tools: this.deps.config.webSearch ? [{ type: "web_search" }] : undefined },
    };
  }

  private sparkSource(req: SparkRequest, signal: AbortSignal): AsyncIterable<SparkStreamEvent> {
    const opts = { firstEventTimeoutMs: this.deps.config.sparkFirstTokenTimeoutMs };
    return hedged(this.deps.config.sparkHedge, (sig) => this.deps.spark(req, { ...opts, signal: sig }), signal, (e) => e.type === "text");
  }

  // ───────────────────────── speculation ─────────────────────────
  // Start Spark on a partial transcript that looks final (ends with . ? !)
  // or has not changed for speculateStableMs, while the user is still
  // finishing the turn. If speechComplete's text matches (case/punctuation
  // aside) the reply reuses that stream ("hit"); otherwise it is aborted.

  private considerSpeculation(text: string): void {
    if (!this.deps.config.speculate || this.turn.phase !== "listening") return;
    if (this.frames && this.now() - this.frames.at <= FRAMES_TTL_MS) return; // frames are consumed per turn; don't guess
    if (this.specTimer) clearTimeout(this.specTimer);
    this.specTimer = null;
    if (LOOKS_FINAL.test(text.trim())) return this.startSpeculation(text);
    this.specTimer = setTimeout(() => {
      this.specTimer = null;
      if (this.turn.phase === "listening") this.startSpeculation(text);
    }, this.deps.config.speculateStableMs);
  }

  private startSpeculation(text: string): void {
    const norm = normTranscript(text);
    if (!norm || this.closed || this.spec?.norm === norm) return;
    this.dropSpeculation();
    const built = this.buildRequest(text);
    const abort = new AbortController();
    this.spec = { norm, abort, built, stream: new Eager(this.sparkSource(built.req, abort.signal)) };
  }

  private dropSpeculation(): void {
    if (this.specTimer) clearTimeout(this.specTimer);
    this.specTimer = null;
    this.spec?.abort.abort();
    this.spec = null;
  }

  private async runReply(text: string, utteranceId: number): Promise<void> {
    const reply: Reply = { utteranceId, abort: new AbortController(), spoken: [], firstAudioAt: null, audioMs: 0, doneTimer: null, peter: false };
    this.reply = reply;
    const signal = reply.abort.signal;
    const m = { ...this.metrics, replyStartAt: this.now() } as TurnMetrics & {
      replyStartAt: number;
      firstTokenAt?: number;
      firstSentenceAt?: number;
      firstAudioAt?: number;
    };
    this.metrics = {};
    let speculative: "hit" | "miss" | "none" = "none";
    let pre: AsyncIterable<SparkStreamEvent> | null = null;
    let built: Built | null = null;
    const spec = this.spec;
    this.spec = null;
    if (this.specTimer) clearTimeout(this.specTimer);
    this.specTimer = null;
    if (spec) {
      if (spec.norm === normTranscript(text)) {
        speculative = "hit";
        built = spec.built;
        pre = spec.stream;
        signal.addEventListener("abort", () => spec.abort.abort(), { once: true });
      } else {
        speculative = "miss";
        spec.abort.abort();
      }
    }
    built ??= this.buildRequest(text);
    const { req, interpret } = built;
    if (built.detected) this.client.sendJson({ type: "interpret.detected", ...built.detected });
    if (!interpret) this.remember("user", text);

    const splitter = new SentenceSplitter();
    const sentences: { tts: string; display: string; emotion: string | null }[] = [];
    let emotion: string | null = null;
    const waiter: { wake: (() => void) | null } = { wake: null };
    let sparkDone = false;
    let sparkError: unknown = null;
    const pushSentences = (list: string[]) => {
      for (const raw of list) {
        const p = parseTaggedSentence(raw);
        if (p.emotion) emotion = p.emotion;
        let tts = p.ttsText;
        if (!sentences.length && !interpret) tts = avoidRepeatedOpener(tts, this.recentReplies);
        if (!tts) continue;
        const display = tts === p.ttsText ? p.displayText : parseTaggedSentence(tts).displayText;
        if (m.firstSentenceAt === undefined) m.firstSentenceAt = this.now();
        sentences.push({ tts, display, emotion });
        // captions go out per sentence: the opener guard may rewrite the first one
        if (display) this.client.sendJson({ type: "reply.delta", utteranceId, text: (sentences.length > 1 ? " " : "") + display });
      }
      waiter.wake?.();
    };

    // Producer: Spark stream → sentences
    const producer = (async () => {
      try {
        // An answer with no text (seen once on 11/2 after a web search) gets
        // one retry without tools rather than silence.
        for (let attempt = 0; attempt < 2; attempt++) {
          let gotText = false;
          let status = "";
          const stream = attempt === 0 ? (pre ?? this.sparkSource(req, signal)) : this.sparkSource({ ...req, tools: undefined }, signal);
          for await (const ev of stream) {
            if (signal.aborted) return;
            if (ev.type === "text") {
              if (m.firstTokenAt === undefined) m.firstTokenAt = this.now();
              gotText = true;
              pushSentences(splitter.push(ev.delta));
            } else if (ev.type === "tool") {
              this.client.sendJson({ type: "tool", utteranceId, name: ev.name, status: ev.status });
            } else status = ev.status;
          }
          if (gotText || !req.tools?.length) break;
          this.log("spark.empty", { utteranceId, status, retry: attempt === 0 });
        }
        pushSentences(splitter.flush());
      } catch (err) {
        if (!signal.aborted) sparkError = err;
      } finally {
        sparkDone = true;
        waiter.wake?.();
      }
    })();

    // Consumer: sentences → TTS (one sentence prefetched ahead) → client
    const jobs: Eager<TtsChunk>[] = [];
    const startJob = (i: number) => {
      if (jobs[i] || !sentences[i]) return;
      const s = sentences[i];
      jobs[i] = new Eager(
        this.deps.tts({
          voiceId: this.voiceId,
          text: s.tts,
          emotion: s.emotion,
          model: this.deps.config.ttsModel,
          fallbackModel: this.deps.config.ttsFallbackModel,
          signal,
        }),
      );
    };
    let ttsFailed = false;
    let ttsModelUsed: string | null = null;
    let sentEmotion: string | null | undefined;
    for (let i = 0; ; i++) {
      while (!sentences[i] && !sparkDone && !signal.aborted) await new Promise<void>((r) => (waiter.wake = r));
      waiter.wake = null;
      if (signal.aborted || !sentences[i]) break;
      const s = sentences[i];
      if (ttsFailed) {
        reply.spoken.push(s.display);
        continue;
      }
      startJob(i);
      const sentenceOffset = reply.audioMs;
      try {
        let first = true;
        for await (const chunk of jobs[i]) {
          if (signal.aborted) break;
          if (first) {
            first = false;
            startJob(i + 1); // prefetch next sentence while this one streams
          }
          if (!chunk.audio.length && !chunk.alignment) continue;
          ttsModelUsed = chunk.model;
          if (reply.firstAudioAt === null) {
            if (this.lip.active === "peter" && this.peter?.isReady) {
              reply.peter = true;
              this.peter.begin(utteranceId);
            }
            reply.firstAudioAt = this.now();
            m.firstAudioAt = reply.firstAudioAt;
            this.dispatch({ type: "first_audio", utteranceId });
          }
          if (s.emotion !== sentEmotion) {
            sentEmotion = s.emotion;
            this.client.sendJson({ type: "speaking", on: true, utteranceId, emotion: s.emotion ?? "neutral" });
          }
          const seq = ++this.seq;
          const durationMs = pcmDurationMs(chunk.audio.length);
          this.client.sendJson({
            type: "audio",
            utteranceId,
            seq,
            sentence: i,
            offsetMs: Math.round(reply.audioMs),
            durationMs: Math.round(durationMs),
            sampleRate: PCM_SAMPLE_RATE,
            model: chunk.model,
            ...chunkTiming(this.lip.active, chunk.alignment, sentenceOffset),
          });
          if (chunk.audio.length) {
            this.client.sendBinary(Buffer.concat([encodeFrameHeader(FRAME_KIND_TTS_PCM, seq), chunk.audio]));
            if (reply.peter) this.peter?.audio24k(utteranceId, chunk.audio);
          }
          reply.audioMs += durationMs;
        }
        if (!signal.aborted) reply.spoken.push(s.display);
      } catch (err) {
        if (signal.aborted) break;
        ttsFailed = true;
        reply.spoken.push(s.display);
        this.error("tts_unavailable", "Voice failed for this reply; showing text only", true);
        this.log("tts.error", { message: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
      }
    }
    await producer;
    if (signal.aborted || this.reply !== reply) return;
    if (reply.peter) this.peter?.end(utteranceId);

    if (sparkError) {
      this.error("spark_unavailable", "The companion could not answer. Try again.", true);
      this.log("spark.error", { message: sparkError instanceof Error ? sparkError.message.slice(0, 200) : "unknown" });
    }
    const full = reply.spoken.join(" ").trim();
    if (full && !interpret) this.remember("assistant", full);
    this.client.sendJson({ type: "reply", utteranceId, text: full, emotion: emotion ?? "neutral", interpret, final: true });
    const metrics = {
      utteranceId,
      model: SPARK_MODEL,
      ttsModel: ttsModelUsed,
      speechEndToCompleteMs: m.speechEndAt && m.completeAt ? Math.round(m.completeAt - m.speechEndAt) : null,
      replyStartToFirstTokenMs: m.firstTokenAt ? Math.round(m.firstTokenAt - m.replyStartAt) : null,
      replyStartToFirstSentenceMs: m.firstSentenceAt ? Math.round(m.firstSentenceAt - m.replyStartAt) : null,
      firstSentenceToFirstAudioMs: m.firstSentenceAt && m.firstAudioAt ? Math.round(m.firstAudioAt - m.firstSentenceAt) : null,
      speechEndToFirstAudioMs: m.speechEndAt && m.firstAudioAt ? Math.round(m.firstAudioAt - m.speechEndAt) : null,
      audioMs: Math.round(reply.audioMs),
      speculative,
    };
    this.client.sendJson({ type: "turn.metrics", ...metrics });
    this.log("turn.answered", metrics);

    // The app is still playing what we sent faster than real time; stay in
    // "speaking" (so barge-in still works) until playback should be over or
    // the app says playback_done.
    const playEnd = reply.firstAudioAt === null ? 0 : reply.firstAudioAt + reply.audioMs + PLAYBACK_SLACK_MS;
    const wait = Math.max(0, playEnd - this.now());
    reply.doneTimer = setTimeout(() => this.finishReply(reply), wait);
  }

  private finishReply(reply: Reply): void {
    reply.doneTimer = null;
    if (this.reply !== reply) return;
    this.reply = null;
    if (reply.firstAudioAt !== null) this.client.sendJson({ type: "speaking", on: false, utteranceId: reply.utteranceId });
    this.dispatch({ type: "reply_done", utteranceId: reply.utteranceId });
  }

  private error(code: ErrorCode, message: string, retryable: boolean): void {
    this.client.sendJson({ type: "error", code, message, retryable });
  }

  private log(event: string, data: Record<string, unknown>): void {
    this.deps.log?.(event, { session: this.id, ...data });
  }
}
