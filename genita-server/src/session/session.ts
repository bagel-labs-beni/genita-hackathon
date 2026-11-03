/**
 * One realtime conversation: app socket ↔ Muse Transcribe ↔ Muse Spark ↔
 * the app's on-device voice (`say`, device mode) or Meta SeamlessM4T v2.
 * Turn-taking decisions live in turnMachine.ts (pure); this
 * class only executes their effects and moves bytes. Protocol: PROTOCOL.md.
 */
import { getOps, type OpsLimits } from "../ops/limits.ts";
import type { Config } from "../config.ts";
import type { AsrEvent } from "../meta/transcribe.ts";
import { SPARK_MODEL, type InputMessage, type SparkRequest, type SparkStreamEvent, type ContentPart } from "../meta/spark.ts";
import type { TtsChunk, TtsRequest } from "../tts/types.ts";
import { pcmDurationMs, PCM_SAMPLE_RATE } from "../tts/types.ts";
import { avoidRepeatedOpener, buildInstructions, buildInterpretInstructions, type PersonaCard, type UserProfile } from "../prompt/persona.ts";
import { SentenceSplitter } from "../text/sentences.ts";
import { clauseExpression, parseTaggedSentence, type Expression } from "../text/tags.ts";
import { NarrationJudge, type NarrationDecision } from "../text/toolNarration.ts";
import { isMostlyHangul, speechLang } from "../text/language.ts";
import { resolveSpeaker, seamlessLang, SEAMLESS_MODEL } from "../tts/seamless.ts";
import type { VoiceSeats } from "../tts/capacity.ts";
import { spokenText } from "../voice/normalize.ts";
import { chunkTiming, type LipMode, type LipPlan } from "../lips/source.ts";
import { shiftTiming } from "../lips/visemes.ts";
import { Eager } from "../util/eager.ts";
import { hedged } from "../util/hedge.ts";
import {
  PROTOCOL_VERSION,
  FRAME_HEADER_BYTES,
  FRAME_KIND_TTS_PCM,
  CLIENT_FRAME_KIND_MIC,
  CLIENT_FRAME_KIND_CALL,
  encodeFrameHeader,
  type ServerEvent,
  type ErrorCode,
  type CancelReason,
  type InterpretOptionsWire,
  type TtsMode,
} from "../protocol.ts";
import { Interpreter, type InterpretHost } from "../interpret/interpreter.ts";
import { interpretCommand } from "../interpret/language.ts";
import { initialTurnState, reduceTurn, type Effect, type TurnEvent, type TurnState } from "./turnMachine.ts";
import { MemoryCall, type MemoryService, type UsPhotoService } from "../memory/index.ts";
import { MEMORY_START_BUDGET_MS, within, type MemoryRetryState, type ThreadState } from "../memory/call.ts";
import type { Memory } from "../memory/repository.ts";
import type { CompanionFaceResolver } from "../memory/photos.ts";
import { FindsRunner, type FindsDeps } from "../finds/runner.ts";
import { WatchController, type WatchSink } from "../watch/watch.ts";
import { detectRename } from "./rename.ts";
import { convoV1, initiativeOn } from "../convo/flags.ts";
import { addressUser, fallbackLine, guardSentence, neverSpoken, NO_ANSWER_LINE, type GuardClass } from "../convo/guard.ts";
import { isInterjectionOnly } from "../text/toolNarration.ts";
import { openerBlock } from "../convo/opener.ts";
import { InitiativeGovernor, initiativeBlock, initiativeInput, type InitiativeSource } from "../convo/initiative.ts";
import type { PerceptionSource } from "../convo/types.ts";

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

export type SessionDeps = {
  config: Config;
  /** mode: the Mac's shared-screen sound uses DIARIZATION (watch together) */
  openAsr: (languages: string[], mode?: "ENDPOINTING" | "DIARIZATION") => AsrLike;
  spark: (req: SparkRequest, opts: { signal?: AbortSignal; firstEventTimeoutMs?: number }) => AsyncIterable<SparkStreamEvent>;
  tts: (req: TtsRequest) => AsyncIterable<TtsChunk>;
  now?: () => number;
  /** open the vendor HTTPS connections ahead of the first answer (keepalive.ts warmUp); fire and forget */
  prewarm?: (o: { voice: boolean }) => void;
  /** Test-only clock seam for the delayed first greeting. Returns a cancellation function. */
  greetScheduler?: (fn: () => void, ms: number) => () => void;
  /** Server voice (Seamless): cache a speaker's filler clauses when a call starts with it */
  voicePrefetch?: (speaker: number) => void;
  /** Shared by all calls to the process's voice GPU (not one gate per session). */
  voiceSeats?: VoiceSeats;
  /** Identity is assigned by the authenticated upgrade, never by start.user. */
  userId?: string;
  ops?: OpsLimits;
  /** null: shared-token dev identity has no persisted user row. */
  turnUserId?: string | null;
  /**
   * Handoff: this account's turns from its other live call, or from a call that ended in the last few minutes
   * (server.ts). With server memory on, `start.history` is otherwise ignored, so the Mac lost the iPhone's turns.
   */
  priorTurns?: (revision: number) => HistoryItem[] | null;
  /** Session memory: the thread those turns belong to (same conversation on the next device), read right after priorTurns */
  priorThread?: (revision: number) => ThreadState | null;
  memory?: MemoryService;
  photos?: UsPhotoService;
  resolveCompanionFace?: CompanionFaceResolver;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** result cards (F10); unset = spoken answers only */
  finds?: FindsDeps;
  /** F2-L26 rename by voice: persist the companion's new name (server.ts → prep store); unset = this call only */
  renameCompanion?: (userId: string, name: string) => Promise<unknown>;
  /**
   * Same presence on every device (11/3): the voice saved on this account's companion (prep store). It wins over
   * the start message's voice, so the iPhone and the Mac always speak with one voice. null/unset = the client's.
   */
  companionVoiceId?: () => Promise<string | null | undefined>;
};

/** Demo S5 (agreed with the convo lane 11/3): the product-ask turn's reply while the search runs in the background. */
export const PRODUCT_REACTION_LINE =
  "A shopping search for this is already running in the background and its card will appear on its own. Reply with ONE short, natural, in-character reaction to what they asked or what you see (taste, color, how it goes with the outfit); talk to them as you. Never say you are searching, looking, checking or pulling anything up, no 'let me…'; don't name products, stores, prices or links.";

/** A slow prep store never holds up `ready`: past this the client's voice stays. */
const COMPANION_VOICE_WAIT_MS = 800;

const schedule = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

type Mode = "chat" | "interpret";
export type HistoryItem = { role: "user" | "assistant"; text: string };
type Frames = { images: string[]; at: number };

type Reply = {
  utteranceId: number;
  abort: AbortController;
  spoken: string[];
  firstAudioAt: number | null;
  audioMs: number;
  doneTimer: NodeJS.Timeout | null;
  /** device mode: characters sent in `say` (drives the speaking estimate) */
  chars: number;
  /** server mode: GPU capacity or a voice failure sent this reply to the app as `say` */
  fellBack: boolean;
};

/** server clock (ms) for the latency breakdown; logged with turn.answered as `stages` */
type TurnMetrics = { speechEndAt?: number; completeAt?: number; lastPartialAt?: number; specStartAt?: number };
/** lang = the language the reply is written in (interpretation: the target) */
type Built = { req: SparkRequest; interpret: boolean; detected: { from: string; to: string } | null; images: string[]; lang: string };
/** firstTextAt: when the speculative stream's first text arrived (it is buffered until the final transcript) */
type Speculation = { norm: string; abort: AbortController; built: Built; stream: Eager<SparkStreamEvent>; memoryRetry: MemoryRetryState; confirm: () => void; at: number; firstTextAt?: number };

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
/** longest a ready reply waits for the user to stop talking before its first sound (ASR lost a speechEnd) */
const HOLD_MAX_MS = 3000;
/** re-open vendor connections when the user starts a turn after this much quiet (keep-alive is 60 s) */
const WARM_AGAIN_MS = 45_000;
const DEVICE_MS_PER_CHAR = 70;
const DEVICE_SLACK_MS = 1500;
const DEVICE_MAX_MS = 60_000;
const ASR_RETRY_MS = 2000;

/**
 * Words of `spoken` (the spoken form the voice was given) not yet voiced, given the voiced characters.
 * A word cut mid-way is said again.
 */
export function unspokenRest(spoken: string, voicedChars: string): string {
  const complete = voicedChars.trimStart().split(/\s+/).filter(Boolean).length - (/\s$/.test(voicedChars) ? 0 : 1);
  return spoken.trim().split(/\s+/).slice(Math.max(0, complete)).join(" ");
}

/** Device mode: how long the app should take to speak `chars` characters, if it never sends playback_done. */
export function deviceSpeechEstimateMs(chars: number): number {
  return Math.min(DEVICE_MAX_MS, chars * DEVICE_MS_PER_CHAR + DEVICE_SLACK_MS);
}

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
const ANNOUNCE_WAIT_MS = 20_000;
const GREET_PROMPT = "The call just connected. Greet the user.";
const MAX_GREET_AFTER_MS = 3000;

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
  private memoryCall: MemoryCall | null = null;
  private greeting: { item: Memory | null } | null = null;
  /** conversation engine v1 (GENITA_CONVO_V1, read once per call) */
  private readonly v1 = convoV1();
  /** ms of the user's last message in an earlier call (memory state); null = never; undefined = unknown */
  private lastMessageAt: number | null | undefined = undefined;
  /** the companion speaks first mid-call (src/convo/initiative.ts); null = off for this call */
  private initiative: InitiativeGovernor | null = null;
  private initiativeTimer: NodeJS.Timeout | null = null;
  private initiativeBusy = false;
  /** the pending initiative turn (its input is INITIATIVE_INPUT; never a user line or a memory source) */
  private cueTurn: { source: InitiativeSource; block: string; input: string } | null = null;
  /** memory lines already offered to an initiative this call */
  private offeredThreads = new Set<string>();
  /** perception lane (camera face reading, GENITA_PERCEPTION): read-only, assigned by its message hook */
  perception: PerceptionSource | null = null;
  private perceptionUnsub: (() => void) | null = null;
  /** D21: start.greetAfterMs window; the user speaking or typing inside it cancels the greeting */
  private greetTimer: (() => void) | null = null;
  /** this call continues the account's other call (handoff): no greeting */
  private continued = false;
  private mode: Mode = "chat";
  private language = "English";
  private voiceId: string;
  private lip: LipPlan = { requested: "none", active: "none", reason: null };
  private tts: TtsMode = "device";
  private voiceOverflow = false;
  /** the account's saved companion voice (same presence), looked up as the socket opens */
  private readonly ownedVoice: Promise<string | null>;
  private history: HistoryItem[] = [];
  private historyRevision: number | null = null;
  private recentReplies: string[] = [];
  private frames: Frames | null = null;
  private asr: AsrLike | null = null;
  /** F8 · set while mode is "interpret" */
  private interp: Interpreter | null = null;
  /** F8 · Mac call interpretation: a second ASR stream for the call's sound */
  private callAsr: AsrLike | null = null;
  private readonly asrRetry = {
    mic: { connecting: false, retryAt: 0, failed: false },
    call: { connecting: false, retryAt: 0, failed: false },
  };
  private micOn = true;
  private reply: Reply | null = null;
  private spec: Speculation | null = null;
  private watch: WatchController | null = null;
  private specTimer: NodeJS.Timeout | null = null;
  private specCheck = 0;
  private bargeTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  private lastWarmAt = -Infinity;
  /** replies whose first sound waits for the user to stop talking */
  private quietWaiters: (() => void)[] = [];
  private metrics: TurnMetrics = {};
  private bargeCfg: { bargeInMinMs: number; bargeInMinWords: number };
  private readonly client: ClientSink;
  private finds: FindsRunner | null = null;
  /** a card's line waiting for the current reply to finish (dropped if the user talks first) */
  private pendingAnnounce: { text: string; at: number } | null = null;

  constructor(id: string, client: ClientSink, deps: SessionDeps) {
    this.id = id;
    this.client = client;
    this.deps = deps;
    this.now = deps.now ?? (() => performance.now());
    this.voiceId = deps.config.defaultVoiceId;
    // looked up from the socket's open, so `start` rarely waits for it (Codex P2: no input window)
    this.ownedVoice = this.companionVoice();
    this.bargeCfg = { bargeInMinMs: deps.config.bargeInMinMs, bargeInMinWords: deps.config.bargeInMinWords };
    if (deps.finds) {
      this.finds = new FindsRunner(deps.finds, {
        emit: (e) => !this.closed && this.client.sendJson(e),
        announce: (text) => this.announce(text),
        log: (event, data) => this.log(event, data),
        now: this.now,
      });
    }
  }

  /** F6-L7: `start` was accepted (the handoff layer gives a conversation nobody holds to this device). */
  get hasStarted(): boolean {
    return this.started && !this.closed;
  }

  private pickVoice(id: string | undefined, kind: PersonaCard["kind"]): void {
    this.voiceId = id ?? this.deps.config.defaultVoiceId;
    const voice = this.deps.config.voice;
    // Meta voice service: the voice is a Seamless speaker ("seamless:<n>"); other ids → the kind's default speaker
    if (voice) this.voiceId = `seamless:${resolveSpeaker(id, kind, voice)}`;
  }

  /** The account's saved companion voice, or null (none, store error, or slower than COMPANION_VOICE_WAIT_MS). */
  private async companionVoice(): Promise<string | null> {
    if (!this.deps.companionVoiceId) return null;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), COMPANION_VOICE_WAIT_MS); });
    try {
      const lookup = this.deps.companionVoiceId;
      const id = await Promise.race([Promise.resolve().then(lookup).catch(() => null), late]);
      return typeof id === "string" && id.trim() ? id.trim().slice(0, 64) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * F6-L7: the conversation moved to another device. Stop this device's reply now, the same way a
   * tap on the face does (`utterance.cancelled` reason `client`, so every app build flushes its queue).
   */
  stopForHandoff(): void {
    // the other device has the sound now: this call never speaks first again (Codex 11/3 P2)
    this.stopInitiative();
    if (this.started && !this.closed) this.dispatch({ type: "client_barge_in" });
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
        this.skipPendingGreeting("text");
        if (Array.isArray(msg.frames)) this.setFrames(msg.frames);
        if (this.interp && typeof msg.findId === "string") {
          // "Ask about this" on a card while interpreting would be translated to the other person: not sent
          this.log("finds.ask_ignored_interpreting", { findId: msg.findId.slice(0, 64) });
          return;
        }
        if (typeof msg.findId === "string") this.finds?.focus(msg.findId);
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
      case "find.confirm":
        if (typeof msg.findId === "string" && typeof msg.itemId === "string" && typeof msg.yes === "boolean") this.finds?.confirm(msg.findId, msg.itemId, msg.yes);
        return;
      case "find.stop":
        if (typeof msg.findId === "string") this.finds?.stop(msg.findId);
        return;
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
        if (!this.callAsr?.isOpen) {
          void this.ensureCallAsr();
          return; // live frames are dropped while connecting or cooling down
        }
        this.callAsr.sendAudio(pcm);
        return;
      }
    }
    if (!this.micOn) return;
    // "Hold to reply": outside the hold the mic is silence, which also ends the held turn quickly
    if (this.interp?.micGated) pcm = Buffer.alloc(pcm.length);
    if (!this.asr?.isOpen) {
      void this.ensureAsr();
      return;
    }
    this.asr.sendAudio(pcm);
  }

  // ───────────────────────── lifecycle ─────────────────────────

  private async start(msg: Record<string, unknown>): Promise<void> {
    if (this.started) return this.error("already_started", "Session already started", false);
    const persona = parsePersona(msg.persona);
    if (!persona) return this.error("bad_persona", "start.persona.name is required", false);
    this.persona = persona;
    const u = msg.user && typeof msg.user === "object" ? (msg.user as Record<string, unknown>) : {};
    this.user = { name: str(u.name, 80), profile: str(u.profile, 4000) };
    this.memories = !this.deps.memory && Array.isArray(msg.memories) ? msg.memories.map((m) => str(m, 300)).filter((m): m is string => !!m).slice(-24) : [];
    if (Array.isArray(msg.history) && !this.deps.memory) {
      for (const h of msg.history.slice(-MAX_HISTORY)) {
        const item = h as Record<string, unknown>;
        const text = str(item?.text, 1000);
        if (text && (item.role === "user" || item.role === "assistant")) this.history.push({ role: item.role, text });
      }
      this.recentReplies = this.history.filter((h) => h.role === "assistant").map((h) => h.text).slice(-3);
    }
    const startMode: Mode = msg.mode === "interpret" ? "interpret" : "chat";
    this.language = str(msg.language, 40) ?? "English";
    this.pickVoice(str(msg.voiceId, 64) ?? persona.voice?.id, persona.kind);
    const lip = (msg.lip && typeof msg.lip === "object" ? msg.lip : { mode: msg.lip }) as Record<string, unknown>;
    const asLip = (v: unknown, d: LipMode): LipMode => (v === "atlas" || v === "none" ? v : v === undefined ? d : "none");
    const mode = asLip(lip.mode, persona.kind === "human" ? "none" : "atlas");
    this.lip = { requested: mode, active: mode, reason: null };
    // Server TTS runs only when the server has it on; then the app may still ask for device speech.
    this.tts = this.deps.config.serverTts && msg.tts !== "device" ? "server" : "device";
    this.deviceVoiceForReply();
    // Device speech: no server audio to sync, so no server mouth cues; the device makes its own.
    if (this.tts === "device") this.lip = { requested: this.lip.requested, active: "none", reason: "device_tts" };
    const b = (msg.bargeIn && typeof msg.bargeIn === "object" ? msg.bargeIn : {}) as Record<string, unknown>;
    if (typeof b.minMs === "number" && b.minMs >= 0 && b.minMs <= 3000) this.bargeCfg.bargeInMinMs = b.minMs;
    if (typeof b.minWords === "number" && b.minWords >= 1 && b.minWords <= 10) this.bargeCfg.bargeInMinWords = b.minWords;
    this.micOn = msg.mic !== false;
    const g = msg.greetAfterMs;
    const greetAfterMs = typeof g === "number" && Number.isFinite(g) ? Math.round(Math.min(MAX_GREET_AFTER_MS, Math.max(0, g))) : null;
    this.started = true;
    this.warm();
    (this.deps.ops ?? getOps()).prime(this.limitUserId());
    if (this.deps.memory && this.deps.userId) {
      const memory = this.deps.memory;
      const userId = this.deps.userId;
      this.memoryCall = new MemoryCall(memory, userId, this.id, (revision) => {
        this.dropSpeculation(); this.dispatch({ type: "client_barge_in" });
        this.history = []; this.recentReplies = []; this.memories = []; this.greeting = null;
        this.historyRevision = revision;
      });
      // Bounded (Codex 11/3): a store stalled behind the per-user lock must not hold ready/greeting. Past the
      // budget the call starts without memory context, and the late result never touches this call.
      let abandoned = false;
      const memoryCall = this.memoryCall;
      const init = async () => {
        // startMode, not this.mode: switchMode runs later, so an interpret start would still read "chat" here
        // and the greeting prompt would be sent to the translator
        const item = await memoryCall.open(startMode === "chat");
        // A Forget during open already cleared these; do not restore its older result (nor a late one).
        if (this.historyRevision === null && !abandoned) {
          this.greeting = startMode === "chat" ? { item } : null;
          this.recentReplies = [...memoryCall.recentReplies, ...this.recentReplies].slice(-3);
        }
        // Validate and copy together under the same per-user lock as Forget. The cache/live call must
        // carry this persisted revision. Clients cannot prove their snapshot's age, so after ANY Forget
        // only server-side turns can continue the conversation (even across a service restart).
        await memory.serial(userId, async () => {
          const state = await memory.state.getState(userId);
          const revision = state.revision;
          // before this call's first user message: the previous call's last one (opener gap, DESIGN §4)
          if (!abandoned) this.lastMessageAt = state.last_message_at;
          if (this.closed) return;
          // a slow start never seeds old turns, but once verified, this call's NEW turns can hand off (Codex 11/3)
          if (abandoned) { if (this.historyRevision === null) this.historyRevision = revision; return; }
          this.historyRevision = revision;
          if (startMode !== "chat" || this.history.length) return;
          const server = this.deps.priorTurns?.(revision) ?? null;
          const claimed = revision === 0 && msg.handoff === true ? parseHistory(msg.history) : [];
          const seed = server?.length ? server : claimed;
          if (!seed.length) return;
          this.history = seed.slice(-MAX_HISTORY);
          // a handoff is the same conversation: one thread, one summary (iPhone and Mac write the same row)
          this.memoryCall?.continueThread(server?.length ? this.deps.priorThread?.(revision) ?? null : null, this.history);
          this.recentReplies = [...this.recentReplies, ...this.history.filter((h) => h.role === "assistant").map((h) => h.text)].slice(-3);
          this.greeting = null;
          this.continued = true;
          this.log("history.seeded", { turns: this.history.length, from: server?.length ? "server" : "start" });
        });
      };
      const outcome = await within(init().then(() => "ok" as const, () => "error" as const), MEMORY_START_BUDGET_MS, "slow" as const);
      if (outcome === "error") { this.log("memory.unavailable", {}); memoryCall.close(); this.memoryCall = null; this.historyRevision = null; }
      else if (outcome === "slow") {
        abandoned = true;
        this.log("memory.slow_start", { budget_ms: MEMORY_START_BUDGET_MS });
        // a plain greeting (no shared past); no handoff seeding without a verified Forget revision
        if (startMode === "chat" && !this.greeting && this.historyRevision === null) this.greeting = { item: null };
      }
    }
    if (this.closed) return;
    const owned = await this.ownedVoice;
    if (this.closed) return;
    // One voice per reply: if something already started speaking (input raced the lookup), this call keeps it.
    if (owned && this.turn.utteranceId === 0 && !this.reply) this.pickVoice(owned, persona.kind);
    else if (owned) this.log("voice.owned_late", {});
    // owner = the authenticated account (server.ts); start.user.id is not trusted for ownership
    this.finds?.configure({ owner: this.deps.userId, memories: this.memories, profile: this.user.profile, userName: this.user.name, timeZone: str(u.timeZone, 40) });
    if (this.micOn) {
      await this.ensureAsr();
    }
    if (this.closed) return;
    this.client.sendJson({
      type: "ready",
      protocol: PROTOCOL_VERSION,
      sessionId: this.id,
      mode: startMode,
      audio: { in: "pcm_s16le_24000_mono", out: "pcm_s16le_24000_mono", frameHeaderBytes: FRAME_HEADER_BYTES },
      lip: this.lip,
      voiceId: this.voiceId,
      bargeIn: { minMs: this.bargeCfg.bargeInMinMs, minWords: this.bargeCfg.bargeInMinWords },
      tts: this.tts,
    });
    this.client.sendJson({ type: "state", state: "listening" });
    if (startMode === "interpret") this.enterInterpret(parseInterpretOptions(msg.interpret));
    if (this.tts === "server" && this.deps.config.voice && !this.voiceOverflow) this.deps.voicePrefetch?.(Number(this.voiceId.slice("seamless:".length)));
    if (startMode === "chat" && initiativeOn()) this.startInitiative();
    if (this.continued) return; // handoff: the conversation goes on, no greeting of either kind
    if (greetAfterMs === null) {
      if (this.greeting && !this.closed && !this.reply) this.dispatch({ type: "text", text: GREET_PROMPT });
      return;
    }
    // D21: also without the memory dependency, the plain greeting
    if (startMode === "chat" && !this.greeting) this.greeting = { item: null };
    if (!this.greeting || this.closed) return;
    this.greetTimer = (this.deps.greetScheduler ?? schedule)(() => {
      this.greetTimer = null;
      if (!this.greeting || this.closed) return;
      if (this.reply || this.mode !== "chat" || this.turn.phase !== "listening" || this.turn.userSpeaking) {
        // busy when the window ends: drop it, or the user's next line would be taken as the greeting (Codex 11/2)
        this.greeting = null;
        return this.log("call.greet_skipped", { by: "busy" });
      }
      this.dispatch({ type: "text", text: GREET_PROMPT });
    }, greetAfterMs);
  }

  /** D21: the user spoke or typed first inside the greetAfterMs window → no greeting, just answer them. */
  private skipPendingGreeting(by: "speech" | "text" | "mode"): void {
    if (!this.greetTimer) return;
    this.greetTimer();
    this.greetTimer = null;
    this.greeting = null;
    this.log("call.greet_skipped", { by });
  }

  // ───────────────────────── F8 interpretation ─────────────────────────

  private switchMode(mode: Mode, by: "client" | "model", opts: InterpretOptionsWire = {}): void {
    if (mode === "interpret") {
      this.skipPendingGreeting("mode");
      // a chat reply in progress is cut; the interpreter owns the voice now
      if (this.turn.phase !== "listening") this.dispatch({ type: "client_barge_in" });
      this.dropSpeculation();
      this.mode = "interpret";
      this.client.sendJson({ type: "mode.changed", mode, by });
      this.log("mode.changed", { mode, by });
      this.enterInterpret(opts);
      return;
    }
    this.leaveInterpret();
    this.mode = "chat";
    // back from interpretation: the silence clock starts now, and a call that started interpreting gets a governor
    this.initiative?.activity(this.now());
    if (this.started && initiativeOn()) this.startInitiative();
    this.client.sendJson({ type: "mode.changed", mode, by });
    this.log("mode.changed", { mode, by });
  }

  private enterInterpret(opts: InterpretOptionsWire): void {
    this.interp?.stop();
    this.mode = "interpret";
    this.interp = new Interpreter(this.interpretHost(), {
      userLanguage: this.language,
      source: opts.source ?? "face",
      other: opts.other ?? null,
      app: opts.app,
      speculate: this.deps.config.speculate && !(this.deps.ops ?? getOps()).cappedUser(this.limitUserId()),
      speculateStableMs: this.deps.config.speculateStableMs,
    });
    this.interp.begin();
    if (this.interp.source === "call") void this.ensureCallAsr();
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
    this.asrRetry.call.failed = false;
    this.asrRetry.call.retryAt = 0;
    a?.end();
  }

  private ensureCallAsr(): Promise<void> {
    return this.connectAsr("call");
  }

  private interpretHost(): InterpretHost {
    return {
      now: this.now,
      admitTurn: () => this.admitTurn(),
      send: (e) => this.client.sendJson(e),
      sendAudio: (seq, pcm) => this.client.sendBinary(Buffer.concat([encodeFrameHeader(FRAME_KIND_TTS_PCM, seq), pcm])),
      nextSeq: () => ++this.seq,
      nextUtteranceId: () => {
        // shares the turn machine's counter so ids never repeat across modes
        this.turn = { ...this.turn, utteranceId: this.turn.utteranceId + 1 };
        return this.turn.utteranceId;
      },
      // no memory context or recall/remember tools in translation (useMemory = false)
      translate: (req, signal) => this.sparkSource(req, signal, undefined, false),
      tts: (text, signal) =>
        this.deps.tts({ voiceId: this.voiceId, text, emotion: null, model: SEAMLESS_MODEL, signal }),
      // Overflow stays on the device for the whole interpretation: queued translations would otherwise mix device PCM
      // and server PCM out of order. The seat is retried on the next chat reply.
      useDeviceVoice: () => this.voiceOverflow || this.deviceVoiceForReply(),
      say: (utteranceId, sentence, text, lang) => this.client.sendJson({ type: "say", utteranceId, sentence, text, emotion: "neutral", lang }),
      timing: (alignment, offsetMs) => chunkTiming(this.lip.active, alignment, offsetMs),
      log: (event, data) => this.log(event, data),
    };
  }

  private ensureAsr(): Promise<void> {
    return this.connectAsr("mic");
  }

  /** All entry points (start, unmute, interpretation and live frames) contain provider failures here. */
  private async connectAsr(source: "mic" | "call"): Promise<void> {
    const retry = this.asrRetry[source];
    const current = () => source === "mic" ? this.asr : this.callAsr;
    if (this.closed || current() || retry.connecting || this.now() < retry.retryAt) return;
    if (source === "call" && this.interp?.source !== "call") return;
    retry.connecting = true;
    let asr: AsrLike | null = null;
    try {
      asr = this.deps.openAsr(this.deps.config.asrLanguages);
      const stream = asr;
      if (source === "mic") this.asr = stream;
      else this.callAsr = stream;
      stream.on("event", (e) => {
        if (this.closed || current() !== stream) return;
        if (source === "mic") return this.onAsr(e);
        if (e.type === "partial") this.interp?.partial("call", e.text);
        else if (e.type === "speechEnd") this.interp?.speechEnd("call");
        else if (e.type === "speechComplete") this.interp?.final("call", e.text);
      });
      stream.on("status", (s) => {
        if (this.closed || current() !== stream) return;
        if (s === "closed") {
          if (source === "mic") this.asr = null;
          else this.callAsr = null;
        }
        if (source !== "mic") return;
        if (s === "reconnecting") this.client.sendJson({ type: "asr.status", status: "reconnecting" });
        if (s === "connected") this.client.sendJson({ type: "asr.status", status: "connected" });
      });
      stream.on("error", (err) => this.log(source === "mic" ? "asr.error" : "asr.call.error", { message: err.message.slice(0, 200) }));
      await stream.connect();
      if (current() === stream) {
        retry.failed = false;
        retry.retryAt = 0;
      }
    } catch {
      if (source === "mic" && this.asr === asr) this.asr = null;
      if (source === "call" && this.callAsr === asr) this.callAsr = null;
      // Stop the failed stream's own reconnect timers before allowing a replacement.
      try { asr?.end(); } catch { /* already unusable */ }
      if (this.closed || (source === "call" && this.interp?.source !== "call")) return;
      retry.retryAt = this.now() + ASR_RETRY_MS;
      const reported = this.asrRetry.mic.failed || this.asrRetry.call.failed;
      retry.failed = true;
      if (!reported) this.error("asr_unavailable", source === "mic"
        ? "Speech recognition could not connect; text still works"
        : "Could not listen to the call's sound", true);
    } finally {
      retry.connecting = false;
    }
  }

  close(code = 1000, reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    if (this.tts === "server" && this.deps.config.voice) this.deps.voiceSeats?.release(this.id);
    if (this.bargeTimer) clearTimeout(this.bargeTimer);
    if (this.greetTimer) this.greetTimer();
    if (this.initiativeTimer) clearInterval(this.initiativeTimer);
    this.perceptionUnsub?.();
    this.dropSpeculation();
    if (this.reply) {
      this.reply.abort.abort();
      if (this.reply.doneTimer) clearTimeout(this.reply.doneTimer);
    }
    this.interp?.stop();
    this.dropCallAsr();
    this.asr?.end();
    this.memoryCall?.close();
    // account deleted: Finds stop now and never write again (the delete runs right after)
    this.finds?.close({ purge: reason === "account_deleted" });
    this.watch?.close();
    this.client.close(code, reason);
  }

  // ───────────────────────── ASR → turn machine ─────────────────────────

  /** Open the vendor connections now unless they were opened (or used for a turn) recently. */
  private warm(): void {
    if (!this.deps.prewarm || this.now() - this.lastWarmAt < WARM_AGAIN_MS) return;
    this.lastWarmAt = this.now();
    this.deps.prewarm({ voice: this.tts === "server" && !!this.deps.config.voice });
  }

  private onAsr(e: AsrEvent): void {
    const t = this.now();
    if (e.type === "speechStart") this.warm();
    // interpretation speech counts as talking too: returning to chat never starts on a stale silence (Codex P2)
    if (this.interp && e.type !== "speaker") this.initiative?.userSpoke(t);
    if (this.interp) return this.onInterpretAsr(e);
    switch (e.type) {
      case "speechStart":
        this.metrics = {};
        this.skipPendingGreeting("speech");
        this.client.sendJson({ type: "speech.start", turnId: e.turnId });
        return this.dispatch({ type: "speech_start" });
      case "partial":
        this.metrics.lastPartialAt = t;
        this.client.sendJson({ type: "transcript", final: false, text: e.text });
        this.dispatch({ type: "partial", text: e.text });
        return this.considerSpeculation(e.text);
      case "speechEnd":
        this.metrics = { speechEndAt: t, lastPartialAt: this.metrics.lastPartialAt };
        this.client.sendJson({ type: "speech.end", turnId: e.turnId });
        return this.dispatch({ type: "speech_end" });
      case "speechComplete":
        this.metrics.completeAt = t;
        // order (11/2): the interpret voice command first, then the watch echo filter, then the turn;
        // exactly one final transcript goes out either way
        if (interpretCommand(e.text) === "start") {
          this.client.sendJson({ type: "transcript", final: true, text: e.text, turnId: e.turnId, source: "voice" });
          // INT-0 by voice: "Can you interpret for me?"
          this.switchMode("interpret", "model");
          (this.interp as Interpreter | null)?.say(INTERPRET_ON_LINE);
          return;
        }
        if (this.watch?.isSharing && e.text.trim()) {
          // in order: a slow echo check must not let a later utterance go first (Codex 11/2)
          this.echoChain = this.echoChain.then(() => this.completeUnlessEcho(e.turnId, e.text)).catch(() => {});
          return;
        }
        return this.completeTurn(e.turnId, e.text);
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
        interp.final("mic", e.text);
        return;
    }
  }

  private completeTurn(turnId: number, text: string): void {
    this.client.sendJson({ type: "transcript", final: true, text, turnId, source: "voice" });
    this.dispatch({ type: "speech_complete", text });
    // not consumed by a reply (backchannel / empty): stop the guess
    this.dropSpeculation();
  }

  /** While sharing, the video's own lines leaking into the mic are not a user turn (F5-L13). */
  private echoChain: Promise<void> = Promise.resolve();

  private async completeUnlessEcho(turnId: number, text: string): Promise<void> {
    const echo = (await this.watch?.isEcho(text)) ?? false;
    // re-check after the wait: the call may have closed or switched to interpretation meanwhile
    if (this.closed || this.mode === "interpret") return;
    if (!echo) return this.completeTurn(turnId, text);
    this.log("watch.echo_dropped", { text: text.slice(0, 120) });
    this.dispatch({ type: "speech_complete", text: "" });
    this.dropSpeculation();
  }

  // ───────────────────────── watch together (F5) ─────────────────────────

  /** The Mac opened /v1/watch for this call. Null until `start`. */
  attachWatch(sink: WatchSink): WatchController | null {
    if (!this.started || this.closed) return null;
    this.watch ??= new WatchController(
      {
        companion: () => ({ name: this.persona!.name, traits: this.persona!.traits }),
        conversationQuiet: () => this.turn.phase === "listening" && !this.turn.userSpeaking && !this.turn.pendingBargeIn,
        react: (script) => {
          // interpretation owns the voice: no watch reactions over it
          if (this.mode === "interpret") return null;
          const before = this.turn.utteranceId;
          this.dispatch({ type: "self_speak", text: script, origin: "watch" });
          return this.turn.utteranceId !== before ? this.turn.utteranceId : null;
        },
      },
      {
        now: this.now,
        openAsr: (mode) => this.deps.openAsr(this.deps.config.asrLanguages, mode),
        spark: this.deps.spark,
        // Chelsea 11/2 21:10: watch YouTube together and chat — first reactions ON (GENITA_WATCH_REACTIONS=0 turns
        // them off); the speaker chip stays cut (D40), on only with GENITA_WATCH_SPEAKER=1
        reactions: process.env.GENITA_WATCH_REACTIONS !== "0",
        speakerChip: process.env.GENITA_WATCH_SPEAKER === "1",
        log: (event, data) => this.log(event, data),
      },
    );
    this.watch.attach(sink);
    return this.watch;
  }

  private dispatch(e: TurnEvent): void {
    if (this.closed) return;
    if (e.type === "speech_start" || e.type === "text") this.pendingAnnounce = null;
    if (this.initiative && (e.type === "speech_start" || e.type === "partial" || e.type === "speech_complete" || (e.type === "text" && e.text !== this.cueTurn?.input && e.text !== GREET_PROMPT))) this.initiative.userSpoke(this.now());
    const r = reduceTurn(this.turn, e, this.bargeCfg);
    const reply = r.effects.find((fx) => fx.type === "start_reply");
    // The reducer is pure: admit only actual user replies before committing thinking or running effects.
    // Preserve any barge-in cancellation, but never start a reply or emit thinking on a cap rejection.
    if (reply?.type === "start_reply" && !reply.self && !this.greeting && !(this.cueTurn && reply.text === this.cueTurn.input) && !this.admitTurn()) {
      this.dropSpeculation();
      this.metrics = {};
      this.turn = { ...r.state, phase: "listening" };
      for (const fx of r.effects) if (fx.type === "cancel_reply") this.run(fx);
      this.client.sendJson({ type: "state", state: "listening" });
      return;
    }
    this.turn = r.state;
    for (const fx of r.effects) this.run(fx);
    if (!this.turn.userSpeaking && this.quietWaiters.length) for (const w of this.quietWaiters.splice(0)) w();
    if (e.type === "reply_done" && this.turn.phase === "listening" && this.pendingAnnounce && this.mode !== "interpret") {
      const p = this.pendingAnnounce;
      this.pendingAnnounce = null;
      if (this.now() - p.at < ANNOUNCE_WAIT_MS) this.dispatch({ type: "self_speak", text: p.text, origin: "card" });
    }
  }

  /** Say a card's line now if the companion is idle, else right after the current reply. */
  private announce(text: string): void {
    // interpretation owns the voice: a card that lands mid-interpretation stays on the sheet, unspoken
    if (this.closed || this.mode === "interpret") return;
    if (this.turn.phase === "listening" && !this.turn.userSpeaking) return this.dispatch({ type: "self_speak", text, origin: "card" });
    if (!this.turn.userSpeaking) this.pendingAnnounce = { text, at: this.now() };
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
        void this.runReply(fx.text, fx.utteranceId, fx.self);
        return;
    }
  }

  /**
   * A reply's first sound never starts while the user is talking (they went on after a pause the ASR
   * took for the end of the turn): it waits until they stop — a backchannel — or the barge-in cancels
   * it. Resolves at once when the user is quiet; never waits longer than HOLD_MAX_MS.
   */
  private async untilUserQuiet(signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + HOLD_MAX_MS;
    // re-check after every wake: the user may have stopped and started again before this resumed
    while (this.turn.userSpeaking && !signal.aborted && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          this.quietWaiters = this.quietWaiters.filter((w) => w !== done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
        signal.addEventListener("abort", done, { once: true });
        this.quietWaiters.push(done);
      });
    }
  }

  private cancelReply(utteranceId: number, reason: CancelReason): void {
    const r = this.reply;
    if (!r || r.utteranceId !== utteranceId) return;
    r.abort.abort();
    if (r.doneTimer) clearTimeout(r.doneTimer);
    this.reply = null;
    if (r.spoken.length) this.remember("assistant", r.spoken.join(" ") + " —");
    this.client.sendJson({ type: "utterance.cancelled", utteranceId, reason });
    this.client.sendJson({ type: "speaking", on: false, utteranceId });
    this.log("utterance.cancelled", { utteranceId, reason });
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
    if (urls.length) this.initiative?.framesSent(this.now());
  }

  private takeFrames(): string[] {
    const f = this.frames;
    this.frames = null;
    if (!f || this.now() - f.at > FRAMES_TTL_MS) return [];
    return f.images;
  }

  /** Conversation engine v1 inputs for this turn: style, the greeting's opener, an initiative block, the camera lines. */
  private v1Extras(turn: { greeting?: { item: Memory | null } | null; cue?: { block: string } | null }): Partial<Parameters<typeof buildInstructions>[0]> {
    const last = this.lastMessageAt;
    const opener = turn.greeting
      ? openerBlock({ hasProfile: !!this.user?.profile, sinceLastMs: last === undefined || last === null ? last : Math.max(0, (this.deps.memory?.now ?? Date.now)() - last), hasItem: !!turn.greeting.item })
      : undefined;
    let perception: string | undefined;
    let perceptionHint: string | undefined;
    try {
      perception = this.perception?.contextLine() ?? undefined;
      perceptionHint = turn.greeting || turn.cue ? undefined : this.perception?.pendingHint() ?? undefined;
    } catch { /* the reply never fails on the camera lane */ }
    return { style: "v1", opener, initiative: turn.cue?.block, perception, perceptionHint };
  }

  private stopInitiative(): void {
    if (this.initiativeTimer) clearInterval(this.initiativeTimer);
    this.initiativeTimer = null;
    this.initiative = null;
    this.cueTurn = null;
  }

  /** DESIGN §5: a 1 s check; the governor decides, the session only checks it's idle and speaks. */
  private startInitiative(): void {
    if (this.initiative || this.closed) return;
    // a handed-off call goes on: give it a minute before anything unprompted
    this.initiative = new InitiativeGovernor(this.now() + (this.continued ? 50_000 : 0));
    this.initiativeTimer = setInterval(() => void this.initiativeTick(), 1000);
    this.initiativeTimer.unref?.();
  }

  private initiativeIdle(): boolean {
    return !this.closed && this.mode === "chat" && this.micOn && !this.reply && !this.cueTurn && !this.greeting && !this.greetTimer
      && !this.pendingAnnounce && this.turn.phase === "listening" && !this.turn.userSpeaking && !this.turn.pendingBargeIn && !this.watch?.isSharing;
  }

  /** test seam: one governor check now */
  async initiativeTick(): Promise<void> {
    const gov = this.initiative;
    if (!gov || this.initiativeBusy || this.closed) return;
    if (this.perception && !this.perceptionUnsub) {
      try { this.perceptionUnsub = this.perception.onTrigger((t) => gov.perception(t)); } catch { this.perceptionUnsub = () => {}; }
    }
    const d = gov.decide(this.now(), this.initiativeIdle());
    if (!d.fire) return;
    this.initiativeBusy = true;
    const revision = this.historyRevision;
    const memoryCall = this.memoryCall;
    try {
      const threads = await this.initiativeThreads();
      // a Forget while the lines loaded: what was read may be forgotten now (Codex 11/3 P1)
      if (this.historyRevision !== revision || this.memoryCall !== memoryCall) return;
      // the user may have started talking, or showed the camera, while the threads loaded: decide again (Codex P2)
      if (this.initiative !== gov) return;
      const again = gov.decide(this.now(), this.initiativeIdle());
      if (!again.fire) return;
      gov.markFired(this.now());
      const input = initiativeInput(again.source);
      this.cueTurn = { source: again.source, block: initiativeBlock(again.source, threads), input };
      this.log("convo.initiative", { source: again.source, threads: threads.length, n: gov.count });
      this.dispatch({ type: "text", text: input });
    } finally {
      this.initiativeBusy = false;
    }
  }

  /** Up to 3 follow-up-worthy memory lines not yet offered this call (bounded; empty without memory). */
  private async initiativeThreads(): Promise<string[]> {
    const memory = this.deps.memory;
    const userId = this.deps.userId;
    if (!memory || !userId || !this.memoryCall) return [];
    // under the same per-user lock as Forget: never a list read from before a Forget's delete lands (Codex round 2 P1)
    const items = await within(memory.serial(userId, () => memory.list(userId)).catch(() => [] as Memory[]), 500, [] as Memory[]);
    const picked = items
      .filter((m) => !m.image_ref && !this.offeredThreads.has(m.id))
      .sort((a, b) => Number(b.follow_up) - Number(a.follow_up) || b.updated_at - a.updated_at)
      .slice(0, 3);
    for (const m of picked) this.offeredThreads.add(m.id);
    return picked.map((m) => m.text);
  }

  /** Session memory: this call's conversation thread, for the account's next device after a handoff. */
  threadInfo(): ThreadState | null {
    return this.memoryCall?.threadState() ?? null;
  }

  /** This call's turns (copy) — for the account's next device after a handoff. */
  historySnapshot(): HistoryItem[] {
    return this.history.map((h) => ({ ...h }));
  }

  /** Revision of these turns, not the latest revision at socket close (which may arrive after Forget). */
  get historyForgetRevision(): number | null { return this.historyRevision; }

  private remember(role: "user" | "assistant", text: string): void {
    this.history.push({ role, text });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    if (role === "assistant") this.recentReplies = [...this.recentReplies, text].slice(-3);
  }

  /** Pure apart from consuming pending camera frames. */
  private buildRequest(text: string, renamedFrom?: string, turn: { greeting?: { item: Memory | null } | null; cue?: { block: string } | null } = {}): Built {
    const persona = this.persona!;
    const hangul = isMostlyHangul(text);
    const interpret = this.mode === "interpret" || hangul;
    if (interpret) {
      const from = hangul ? "Korean" : "English";
      const to = hangul ? "English" : "Korean";
      return {
        interpret,
        detected: this.mode === "chat" ? { from, to } : null,
        lang: to,
        req: { instructions: buildInterpretInstructions({ persona, from, to }), input: text, maxOutputTokens: 400 },
        images: [],
      };
    }
    const camera = this.takeFrames();
    const watch = this.watch?.questionContext() ?? null;
    const images = [...camera, ...(watch?.images ?? [])];
    const content: string | ContentPart[] = images.length
      ? [{ type: "input_text", text }, ...images.map((u) => ({ type: "input_image" as const, image_url: u }))]
      : text;
    const input: InputMessage[] = [
      ...this.history.map((h): InputMessage => (h.role === "user" ? { role: "user", content: h.text } : { role: "assistant", content: h.text })),
      { role: "user", content },
    ];
    const v1 = this.v1 ? this.v1Extras(turn) : {};
    const instructions = buildInstructions({
      persona,
      user: this.user,
      memories: this.memories,
      mode: "chat",
      language: this.language,
      cameraAttached: camera.length > 0,
      onScreen: this.finds?.onScreen(),
      renamedFrom,
      ...v1,
    });
    return {
      interpret,
      detected: null,
      // Finds get the camera frames only, never the shared screen
      images: camera,
      lang: this.language,
      req: {
        instructions: watch ? `${instructions}\n${watch.instructions}\n` : instructions,
        input,
        maxOutputTokens: 800,
        tools: this.deps.config.webSearch ? [{ type: "web_search" }] : undefined,
      },
    };
  }

  private sparkSource(req: SparkRequest, signal: AbortSignal, opening?: Memory | null, useMemory = true, confirmed?: Promise<void>, lanes = this.deps.config.sparkHedge, memoryRetry?: MemoryRetryState): AsyncIterable<SparkStreamEvent> {
    const opts = { firstEventTimeoutMs: this.deps.config.sparkFirstTokenTimeoutMs };
    const source = (request: SparkRequest, parent: AbortSignal) => {
      const prefixes: string[] = [];
      return hedged(lanes, (sig) => this.deps.spark(request, { ...opts, signal: sig }), parent,
        (e, lane) => {
          // A complete write call commits this lane before a competing text-only
          // "I'll remember" can discard the save. MemoryCall still gates effects
          // on an accepted transcript and generates this lane's follow-up text.
          if (e.type === "function_call" && e.name === "remember" && this.memoryCall && useMemory) return true;
          if (e.type !== "text") return false;
          prefixes[lane] = (prefixes[lane] ?? "") + e.delta;
          // A partial/complete emotion or audio tag is not spoken text. Keep
          // buffering that lane until actual words arrive, even across deltas.
          return !!parseTaggedSentence(prefixes[lane].replace(/<[^>]*$|\[[^\]]*$/g, "")).displayText;
        },
        // Read tools remain fallbacks: give nearby text a bounded chance to win.
        (e) => e.type === "function_call");
    };
    const last = typeof req.input === "string" ? req.input : req.input.at(-1);
    const query = typeof last === "string" ? last : last && "role" in last && typeof last.content === "string" ? last.content : "";
    return this.memoryCall && useMemory ? this.memoryCall.stream(req, signal, source, query, opening, confirmed, memoryRetry) : source(req, signal);
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
    if (LOOKS_FINAL.test(text.trim())) { void this.startSpeculation(text); return; }
    this.specTimer = setTimeout(() => {
      this.specTimer = null;
      if (this.turn.phase === "listening") void this.startSpeculation(text);
    }, this.deps.config.speculateStableMs);
  }

  private async startSpeculation(text: string): Promise<void> {
    const check = ++this.specCheck;
    const ops = this.deps.ops ?? getOps();
    if (ops.cappedUser(this.limitUserId()) && !ops.canSpeculate(this.limitUserId())) return;
    if (check !== this.specCheck || this.turn.phase !== "listening") return;
    const norm = normTranscript(text);
    if (!norm || this.closed || this.spec?.norm === norm) return;
    this.dropSpeculation();
    const built = this.buildRequest(text);
    const abort = new AbortController();
    let confirm!: () => void;
    const confirmed = new Promise<void>((resolve) => { confirm = resolve; });
    abort.signal.addEventListener("abort", confirm, { once: true });
    const memoryRetry: MemoryRetryState = {};
    const source = this.sparkSource(built.req, abort.signal, undefined, !built.interpret, confirmed, undefined, memoryRetry);
    const spec: Speculation = { norm, abort, built, memoryRetry, confirm, at: this.now(), stream: new Eager(this.stampFirstText(source, (t) => (spec.firstTextAt ??= t))) };
    this.spec = spec;
  }

  private async *stampFirstText(source: AsyncIterable<SparkStreamEvent>, onText: (t: number) => void): AsyncGenerator<SparkStreamEvent> {
    for await (const ev of source) {
      if (ev.type === "text" && ev.delta.trim()) onText(this.now());
      yield ev;
    }
  }

  private dropSpeculation(): void {
    this.specCheck++;
    if (this.specTimer) clearTimeout(this.specTimer);
    this.specTimer = null;
    this.spec?.abort.abort();
    this.spec = null;
  }

  /** Decide at call/reply start only: a running reply keeps its voice even if a seat frees. */
  private deviceVoiceForReply(): boolean {
    if (this.closed || this.tts === "device") return true;
    const seats = this.deps.config.voice ? this.deps.voiceSeats : undefined;
    if (!seats) return false;
    const overflow = !seats.tryTake(this.id);
    if (overflow && !this.voiceOverflow) this.log("voice.capacity_fallback", { sessionId: this.id, holders: seats.holders(), max: this.deps.config.voiceMaxCalls ?? 3 });
    if (!overflow && this.voiceOverflow) this.log("voice.capacity_restored", { sessionId: this.id });
    this.voiceOverflow = overflow;
    return overflow;
  }

  /**
   * self: the companion speaks on its own (one path, 11/2) — "card" = a Finds card's line (F10),
   * "watch" = a watch-together reaction (F5-L14). Spoken as is: no Spark, no user turn, no memory write.
   */
  private async runReply(text: string, utteranceId: number, self?: "card" | "watch"): Promise<void> {
    const greeting = self ? null : this.greeting;
    if (!self) this.greeting = null;
    // an initiative turn (src/convo/initiative.ts): Spark speaks first; its cue is never a user line
    const cue = !self && !greeting && this.cueTurn && text === this.cueTurn.input ? this.cueTurn : null;
    if (cue) this.cueTurn = null;
    const synthetic = !!greeting || !!cue;
    // the vendors are about to be used: their sockets stay open for the keep-alive from here
    if (!self) this.lastWarmAt = this.now();
    // F2-L26: "Call yourself Max" — the new name applies from this reply on (chat only, never a greeting)
    const newName = !self && !synthetic && this.mode === "chat" ? detectRename(text) : null;
    const reply: Reply = { utteranceId, abort: new AbortController(), spoken: [], firstAudioAt: null, audioMs: 0, doneTimer: null, chars: 0, fellBack: this.deviceVoiceForReply() && this.tts === "server" };
    const device = this.tts === "device";
    this.reply = reply;
    const signal = reply.abort.signal;
    const spec = self ? null : this.spec;
    if (!self) this.spec = null; // this turn was admitted synchronously before start_reply
    if (spec) signal.addEventListener("abort", () => spec.abort.abort(), { once: true });
    let renamedFrom: string | undefined;
    if (newName && newName !== this.persona!.name) {
      renamedFrom = await this.applyRename(newName);
      if (signal.aborted || this.reply !== reply) return;
    }
    const m = { ...this.metrics, replyStartAt: this.now() } as TurnMetrics & {
      replyStartAt: number;
      firstTokenAt?: number;
      firstSentenceAt?: number;
      firstAudioAt?: number;
      toolsBeforeText?: number;
      firstSentenceChars?: number;
    };
    this.metrics = {};
    let firstAudioLogged = false;
    const noteFirstAudio = () => {
      if (firstAudioLogged || reply.firstAudioAt === null) return;
      firstAudioLogged = true;
      const ms = Math.round(reply.firstAudioAt - m.replyStartAt);
      this.log("tts.first_audio", { sessionId: this.id, userId: this.deps.userId, utteranceId, ms });
      if (greeting) this.log("call.greeted", { sessionId: this.id, userId: this.deps.userId, utteranceId, ms });
    };
    let speculative: "hit" | "miss" | "none" = "none";
    let pre: AsyncIterable<SparkStreamEvent> | null = null;
    let memoryRetry: MemoryRetryState = {};
    let built: Built | null = null;
    if (!self && this.specTimer) clearTimeout(this.specTimer);
    if (!self) this.specTimer = null;
    if (spec) {
      // a guess built before a rename still carries the old name: ask again
      if (spec.norm === normTranscript(text) && !renamedFrom && !spec.abort.signal.aborted) {
        speculative = "hit";
        m.specStartAt = spec.at;
        spec.confirm();
        built = spec.built;
        pre = spec.stream;
        memoryRetry = spec.memoryRetry;
      } else {
        speculative = "miss";
        spec.abort.abort();
      }
    }
    if (self) built = { req: { input: "" }, interpret: false, detected: null, images: [], lang: this.language };
    built ??= this.buildRequest(text, renamedFrom, { greeting, cue });
    const { req, interpret, lang } = built;
    if (built.detected) this.client.sendJson({ type: "interpret.detected", ...built.detected });
    if (!synthetic && !self) this.memoryCall?.userMessage();
    if (!interpret && !synthetic && !self) this.remember("user", text);
    // F10: a card pipeline runs beside the spoken answer (answer first, card after)
    let resolveSaid: (t: string | null) => void = () => {};
    if (!interpret && !self && !synthetic && this.finds) {
      const said = new Promise<string | null>((r) => (resolveSaid = r));
      // history already holds this turn (remember above): the lines before it
      const recent = this.history.slice(-7, -1).map((h) => `${h.role === "user" ? "User" : "You"}: ${h.text}`);
      const started = this.finds.onTurn({ text, frames: built.images, utteranceId, replyText: said, recent });
      signal.addEventListener("abort", () => resolveSaid(null), { once: true });
      if (started?.ack) {
        // PF-1: a short line now instead of a full answer (a full answer would guess products and links);
        // the card's own line follows when it lands
        if (spec && speculative === "hit") spec.abort.abort();
        const ack = started.ack;
        const fixed = (async function* () {
          yield { type: "text" as const, delta: ack };
          yield { type: "done" as const, responseId: null, text: ack, status: "completed" };
        })();
        if (started.kind === "product") {
          // demo S5: the search can take 10–30 s, so no silent wait and no "On it." — one quick in-character reaction
          // (no tools: nothing to narrate, no guessed products); the card and its own line follow when it lands.
          // A failed reaction falls back to the short ack.
          const react = this.sparkSource({ ...req, instructions: `${req.instructions ?? ""}\n${PRODUCT_REACTION_LINE}\n`, tools: undefined }, signal, undefined, false);
          pre = (async function* () {
            let said = false;
            try {
              for await (const ev of react) {
                if (ev.type === "text" && ev.delta.trim()) said = true;
                yield ev;
                if (ev.type === "done") return;
              }
            } catch (err) {
              if (said) throw err;
            }
            if (!said) yield* fixed;
          })();
        } else pre = fixed;
        this.log("finds.ack", { utteranceId, kind: started.kind });
      }
    }

    // Server voice: first clause goes out at its first comma ("Oh wow,") and long sentences split for rhythm
    const splitOptions = !device && this.deps.config.voice ? { eagerFirstClause: true, clauseMaxChars: 140 } : {};
    let splitter = new SentenceSplitter(splitOptions);
    const sentences: { tts: string; display: string; emotion: string | null; face: { tag: Expression; intensity: number } | null }[] = [];
    let emotion: string | null = null;
    const waiter: { wake: (() => void) | null } = { wake: null };
    let sparkDone = false;
    let sparkError: unknown = null;
    let emptyCause: string | null = null;
    let droppedOpener = false;
    const narration = new NarrationJudge(!interpret && !self);
    const hasAnswer = () => narration.hasAnswer(sentences.map(({ display }) => display));
    let onlyOpener: string | null = null;
    // v1 sentence guard (src/convo/guard.ts): the first dropped sentence, spoken only if nothing else is
    const guarded: { first: { raw: string; cls: GuardClass } | null; narration: boolean; tool: boolean } = { first: null, narration: false, tool: false };
    let laughs = 0;
    const guardCtx = { camera: (built?.images.length ?? 0) > 0, userText: synthetic ? "" : text };
    const enqueueSentences = (list: string[], keepOpener = false) => {
      for (const raw of list) {
        const p = parseTaggedSentence(raw);
        if (p.emotion) emotion = p.emotion;
        // Delivery/emotion tags alone cannot be displayed or spoken. Do not
        // enqueue a blank sentence (or call TTS with just "[laughs]").
        if (!p.displayText) continue;
        let tts = p.ttsText;
        if (!keepOpener && !sentences.length && !interpret && !self) tts = avoidRepeatedOpener(tts, this.recentReplies);
        if (!tts || !parseTaggedSentence(tts).displayText) {
          onlyOpener ??= raw;
          droppedOpener = true; // a whole first clause ("Oh,") was the repeated opener
          continue;
        }
        // v1: never narrate the user in the third person ("She's holding up the trench…" → "You're holding…", QA #354)
        if (this.v1 && !interpret && !self) {
          const addressed = addressUser(tts, { camera: guardCtx.camera, first: !sentences.some((x) => !isInterjectionOnly(x.display)), userText: guardCtx.userText, userName: this.user?.name });
          if (addressed !== tts) { tts = addressed; this.log("convo.addressed_user", { utteranceId }); }
        }
        if (this.v1 && !keepOpener && !interpret && !self) {
          const found = guardSentence(parseTaggedSentence(tts).displayText, guardCtx);
          // an announcement only leads a reply: once content was spoken, a later "lookup" sentence is kept (Codex #356 r6)
          const cls = found === "narration" && sentences.some((x) => !isInterjectionOnly(x.display)) ? null : found;
          if (cls) {
            // narration never becomes the spoken fallback; a style drop does (the first one kept)
            if (!neverSpoken(cls)) guarded.first ??= { raw, cls };
            else guarded.narration = true;
            this.log("convo.guard", { utteranceId, cls });
            continue;
          }
        }
        if (droppedOpener && !sentences.length) tts = tts.replace(/^(\s*(?:\[[^\]]*\]\s*)*)(\p{Ll})/u, (_, lead, c) => lead + c.toUpperCase());
        const display = tts === p.ttsText ? p.displayText : parseTaggedSentence(tts).displayText;
        if (m.firstSentenceAt === undefined) {
          m.firstSentenceAt = this.now();
          m.firstSentenceChars = tts.length;
        }
        // expression layer: one face per clause (Spark's [tag], else its words / the reply's <emotion>); never in interpretation
        let face = interpret ? null : clauseExpression(p, emotion, !!p.emotion, { scaled: this.v1 });
        // v1: one laugh per reply, none on a sad turn (DESIGN §7.2)
        if (this.v1 && face?.tag === "laugh") face = laughs++ > 0 || emotion === "sad" ? null : face;
        sentences.push({ tts, display, emotion, face });
        // captions go out per sentence: the opener guard may rewrite the first one
        if (display) this.client.sendJson({ type: "reply.delta", utteranceId, text: (sentences.length > 1 ? " " : "") + display });
      }
      waiter.wake?.();
    };
    const applyNarration = ({ speak, dropped }: NarrationDecision) => {
      for (const _raw of dropped) {
        droppedOpener = true;
        this.log("reply.narration_dropped", { utteranceId });
      }
      enqueueSentences(speak);
    };
    const pushSentences = (list: string[]) => {
      for (const raw of list) {
        const p = parseTaggedSentence(raw);
        if (p.emotion) emotion = p.emotion;
        applyNarration(narration.push(raw));
      }
    };

    // Producer: Spark stream → sentences
    const producer = (async () => {
      try {
        if (self) {
          m.firstTokenAt = this.now();
          // a card line has no tag of its own: say it warmly; watch reactions carry theirs ("<laugh> ha")
          pushSentences(splitter.push(self === "card" ? `<warm> ${text}` : text));
          pushSentences(splitter.flush());
          return;
        }
        // Retry any answer with no usable content, even with no tools, after
        // an empty speculative hit, or after a pre-text upstream failure.
        for (let attempt = 0; attempt < 2; attempt++) {
          let gotText = false;
          let status = "";
          let attemptError: unknown = null;
          try {
            const stream = attempt === 0 ? (pre ?? this.sparkSource(req, signal, greeting?.item, !interpret && !cue, undefined, undefined, memoryRetry)) : this.sparkSource(req, signal, greeting?.item, !interpret && !cue, undefined, 1, memoryRetry);
            for await (const ev of stream) {
              if (signal.aborted) return;
              if (ev.type === "text") {
                // a speculation hit's tokens waited in a buffer: count from when Spark sent the first one
                if (ev.delta.trim() && m.firstTokenAt === undefined) m.firstTokenAt = attempt === 0 && pre && spec?.firstTextAt !== undefined ? Math.min(spec.firstTextAt, this.now()) : this.now();
                gotText ||= !!ev.delta.trim();
                pushSentences(splitter.push(ev.delta));
              } else if (ev.type === "tool") {
                guarded.tool = true;
                if (!interpret) {
                  // A tool may follow a sentence with no trailing space, or an unfinished clause.
                  pushSentences(splitter.flush());
                  // Completion alone is also tool evidence; some streams omit the start event.
                  applyNarration(narration.onToolCall());
                }
                if (m.firstTokenAt === undefined) m.toolsBeforeText = (m.toolsBeforeText ?? 0) + 1;
                this.client.sendJson({ type: "tool", utteranceId, name: ev.name, status: ev.status });
              } else if (ev.type === "done") status = ev.status;
            }
          } catch (err) {
            if (signal.aborted) return;
            attemptError = err;
          }
          if (signal.aborted) return;
          pushSentences(splitter.flush());
          applyNarration(narration.finish());
          // A bare "Yes!"/"Okay." is a valid answer. Defer a dropped eager
          // opener until EOF so "Oh, the rest" still loses the repeated Oh.
          if (!sentences.length && guarded.first && !neverSpoken(guarded.first.cls)) {
            // never an empty reply: a style drop speaks its sentence; a safety drop says the fallback line
            const fb = fallbackLine(guarded.first.cls);
            enqueueSentences(fb ? [fb] : [guarded.first.raw], true);
          }
          if (!sentences.length && onlyOpener) enqueueSentences([onlyOpener], true);
          // the retry also only announced a lookup and NO tool ran: say so honestly. With a tool, never "not sure"
          // right before (or instead of) the real result — say nothing (main 11/3: Scene 4 map, Scene 5 products)
          if (!sentences.length && attempt === 1 && guarded.narration && !guarded.tool) enqueueSentences([NO_ANSWER_LINE], true);
          if (hasAnswer()) { sparkError = attemptError; break; }
          emptyCause = attemptError ? "upstream_error_before_text" : gotText ? "filtered_only_content" : `${status || "stream_ended"}_without_text`;
          if (attempt === 0) this.log("spark.empty_retry", { utteranceId, cause: emptyCause, status });
          if (attempt === 1) sparkError = attemptError;
          splitter = new SentenceSplitter(splitOptions);
          onlyOpener = null;
          guarded.first = null;
          laughs = 0;
          emotion = null;
          droppedOpener = false;
          m.firstTokenAt = undefined;
        }
      } catch (err) {
        if (!signal.aborted) sparkError = err;
      } finally {
        if (!signal.aborted) applyNarration(narration.finish());
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
          model: SEAMLESS_MODEL,

          signal,
          lang: speechLang(s.display || s.tts, lang),
        }),
      );
    };
    let ttsFailed = false;
    let ttsModelUsed: string | null = null;
    let sentEmotion: string | null | undefined;
    // The app speaks it: plain text (tags already stripped), no vendor call, no audio frames.
    // Device mode always; server mode when the voice service failed for this reply.
    const sayOnDevice = (i: number, s: { display: string; emotion: string | null }, record = true) => {
      if (record) reply.spoken.push(s.display);
      if (!s.display) return;
      if (reply.firstAudioAt === null) {
        reply.firstAudioAt = this.now();
        m.firstAudioAt = reply.firstAudioAt;
        this.dispatch({ type: "first_audio", utteranceId });
        noteFirstAudio();
      }
      if (s.emotion !== sentEmotion) {
        sentEmotion = s.emotion;
        this.client.sendJson({ type: "speaking", on: true, utteranceId, emotion: s.emotion ?? "neutral" });
      }
      this.client.sendJson({ type: "say", utteranceId, sentence: i, text: s.display, emotion: s.emotion ?? "neutral", lang: speechLang(s.display, lang) });
      reply.chars += s.display.length;
    };
    for (let i = 0; ; i++) {
      while (!sentences[i] && !sparkDone && !signal.aborted) await new Promise<void>((r) => (waiter.wake = r));
      waiter.wake = null;
      if (signal.aborted || !sentences[i]) break;
      const s = sentences[i];
      if (device || reply.fellBack) {
        if (reply.firstAudioAt === null) await this.untilUserQuiet(signal);
        if (signal.aborted) break;
        sayOnDevice(i, s);
        continue;
      }
      if (ttsFailed) {
        reply.spoken.push(s.display);
        continue;
      }
      startJob(i);
      const sentenceOffset = reply.audioMs;
      let sentAudio = false;
      let firstSeq: number | null = null; // this clause's first audio chunk: `audio.timing` is keyed to it
      let sentChars = ""; // characters of this sentence already voiced (from the voice's timing)
      let clauseWords = null as { s: number; e: number } | null; // aligner span of this clause (reply timeline)
      try {
        let first = true;
        for await (const chunk of jobs[i]) {
          if (signal.aborted) break;
          if (first) {
            first = false;
            startJob(i + 1); // prefetch next sentence while this one streams
          }
          if (chunk.timing) {
            // forced-aligner timing of the clause, after its audio (it never holds the first frame)
            if (firstSeq !== null) {
              const t = shiftTiming(chunk.timing, sentenceOffset);
              this.client.sendJson({ type: "audio.timing", utteranceId, sentence: i, seq: firstSeq, words: t.words, phonemes: t.phonemes });
              // a long clause can be several service requests (several timings): keep the whole clause's span
              if (t.words.length) clauseWords = { s: Math.min(clauseWords?.s ?? Infinity, t.words[0].s), e: Math.max(clauseWords?.e ?? -Infinity, t.words[t.words.length - 1].e) };
            }
            continue;
          }
          if (!chunk.audio.length && !chunk.alignment) continue;
          ttsModelUsed = chunk.model;
          if (reply.firstAudioAt === null) {
            await this.untilUserQuiet(signal);
            if (signal.aborted) break;
            reply.firstAudioAt = this.now();
            m.firstAudioAt = reply.firstAudioAt;
            this.dispatch({ type: "first_audio", utteranceId });
            noteFirstAudio();
          }
          if (s.emotion !== sentEmotion) {
            sentEmotion = s.emotion;
            this.client.sendJson({ type: "speaking", on: true, utteranceId, emotion: s.emotion ?? "neutral" });
          }
          const seq = ++this.seq;
          firstSeq ??= seq;
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
          sentAudio = true;
          if (chunk.alignment) sentChars += chunk.alignment.chars.join("");
          if (chunk.audio.length) {
            this.client.sendBinary(Buffer.concat([encodeFrameHeader(FRAME_KIND_TTS_PCM, seq), chunk.audio]));
          }
          reply.audioMs += durationMs;
        }
        if (!signal.aborted) {
          reply.spoken.push(s.display);
          // after the clause's audio: its words' span (aligner) or else its audio span, same timeline as audio.offsetMs
          if (s.face && sentAudio && this.deps.config.voice?.expressions !== false) {
            const startMs = clauseWords?.s ?? Math.round(sentenceOffset);
            const endMs = Math.max(startMs, clauseWords?.e ?? Math.round(reply.audioMs));
            this.client.sendJson({ type: "expression", utteranceId, sentence: i, tag: s.face.tag, intensity: s.face.intensity, startMs, endMs });
          }
        }
      } catch (err) {
        if (signal.aborted) break;
        ttsFailed = true;
        if (!(err instanceof Error && err.message === "tts_off")) {
          // tts_off = no server voice configured (the app speaks on-device): text-only is the normal path
          this.error("tts_unavailable", "Voice failed for this reply; showing text only", true);
          this.log("tts.error", { message: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
          if (this.deps.config.voice) {
            // Meta voice service down/slow: the rest of this reply goes to the app's own voice (`say`)
            reply.fellBack = true;
            this.log("tts.fallback_device", { sessionId: this.id, userId: this.deps.userId, utteranceId, reason: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
            if (!sentAudio) {
              if (reply.firstAudioAt === null) await this.untilUserQuiet(signal);
              if (signal.aborted) break;
              sayOnDevice(i, s);
            }
            else {
              // the voice died mid-sentence: the device says the words that were not voiced yet
              // Timing chars are of the spoken form, so count against that; no timing (MMS) → say it all again.
              reply.spoken.push(s.display);
              const spoken = spokenText(s.display, seamlessLang(speechLang(s.display, lang), s.display));
              const rest = sentChars.trim() ? unspokenRest(spoken, sentChars) : s.display;
              if (rest) sayOnDevice(i, { display: rest, emotion: s.emotion }, false);
            }
            continue;
          }
        }
        reply.spoken.push(s.display);
      }
    }
    await producer;
    if (signal.aborted || this.reply !== reply) return;

    if (!reply.spoken.join(" ").trim() || !hasAnswer()) {
      resolveSaid(null);
      this.error("spark_unavailable", "The companion could not answer. Try again.", true);
      this.log("spark.empty", { utteranceId, cause: self ? "self_filtered_only_content" : emptyCause ?? "upstream_error_before_text" });
      this.finishReply(reply);
      return;
    }
    if (sparkError) {
      this.error("spark_unavailable", "The companion could not answer. Try again.", true);
      this.log("spark.error", { message: sparkError instanceof Error ? sparkError.message.slice(0, 200) : "unknown" });
    }
    if (device) {
      ttsModelUsed = "device";
      reply.audioMs = reply.firstAudioAt === null ? 0 : deviceSpeechEstimateMs(reply.chars);
    } else if (reply.fellBack) {
      ttsModelUsed = ttsModelUsed ? `${ttsModelUsed}+device` : "device";
      reply.audioMs += reply.chars ? deviceSpeechEstimateMs(reply.chars) : 0;
    }
    const full = reply.spoken.join(" ").trim();
    resolveSaid(full || null);
    // self speech (card line, watch reaction) stays in the chat history but is never a memory source:
    // its script would otherwise be extracted as something the user said
    if (full && !interpret) { this.remember("assistant", full); if (!self) this.memoryCall?.assistantMessage(full); }
    if (full && !interpret && !synthetic && !self) this.memoryCall?.completedTurn(text, full);
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
      stt_ms: m.speechEndAt && m.completeAt ? Math.round(m.completeAt - m.speechEndAt) : null,
      llm_ms: m.firstTokenAt ? Math.round(m.firstTokenAt - m.replyStartAt) : null,
      tts_ms: m.firstSentenceAt && m.firstAudioAt ? Math.round(m.firstAudioAt - m.firstSentenceAt) : null,
      first_audio_ms: m.speechEndAt && m.firstAudioAt ? Math.round(m.firstAudioAt - m.speechEndAt) : null,
      audioMs: Math.round(reply.audioMs),
      speculative,
    };
    this.client.sendJson({ type: "turn.metrics", ...metrics });
    // stage timeline for the latency breakdown (ms from the ASR's speechEnd; server clock; log only)
    const rel = (x?: number) => (x !== undefined && m.speechEndAt !== undefined ? Math.round(x - m.speechEndAt) : null);
    const stages = {
      lastPartial: rel(m.lastPartialAt),
      specStart: rel(m.specStartAt),
      complete: rel(m.completeAt),
      replyStart: rel(m.replyStartAt),
      firstToken: rel(m.firstTokenAt),
      firstSentence: rel(m.firstSentenceAt),
      firstAudio: rel(m.firstAudioAt),
      toolsBeforeText: m.toolsBeforeText ?? 0,
      firstSentenceChars: m.firstSentenceChars ?? null,
    };
    this.log("turn.answered", { ...metrics, stages });

    // The app is still playing what we sent faster than real time; stay in
    // "speaking" (so barge-in still works) until playback should be over or
    // the app says playback_done. Device mode: audioMs is already the estimate
    // (70 ms/char + 1.5 s, ≤ 60 s) counted from the first `say`.
    const playEnd = reply.firstAudioAt === null ? 0 : reply.firstAudioAt + reply.audioMs + (device ? 0 : PLAYBACK_SLACK_MS);
    const wait = Math.max(0, playEnd - this.now());
    reply.doneTimer = setTimeout(() => this.finishReply(reply), wait);
  }

  /**
   * Saves the new name first (own companion; no-op without one), then switches this call to it and tells the app.
   * A failed save keeps the old name everywhere (call, labels, stored) rather than splitting them (Codex 11/2).
   * Returns the old name, or undefined if nothing changed.
   */
  private async applyRename(name: string): Promise<string | undefined> {
    const userId = this.deps.userId;
    if (userId && this.deps.renameCompanion) {
      try {
        await this.deps.renameCompanion(userId, name);
      } catch (err) {
        this.log("companion.rename_failed", { message: String(err).slice(0, 200) });
        return undefined;
      }
    }
    if (this.closed) return undefined;
    const from = this.persona!.name;
    this.persona = { ...this.persona!, name };
    this.client.sendJson({ type: "companion.named", name });
    this.log("companion.named", { sessionId: this.id, userId, by: "voice", chars: [...name].length });
    this.log("companion.renamed", { by: "voice", chars: [...name].length });
    return from;
  }

  private finishReply(reply: Reply): void {
    reply.doneTimer = null;
    if (this.reply !== reply) return;
    this.reply = null;
    this.initiative?.activity(this.now());
    if (reply.firstAudioAt !== null) this.client.sendJson({ type: "speaking", on: false, utteranceId: reply.utteranceId });
    this.dispatch({ type: "reply_done", utteranceId: reply.utteranceId });
  }

  private limitUserId(): string | null | undefined {
    return this.deps.turnUserId === null ? null : this.deps.turnUserId ?? this.deps.userId;
  }

  private admitTurn(): boolean {
    if (this.closed) return false;
    let admitted = false;
    (this.deps.ops ?? getOps()).userTurn(this.limitUserId(), () => { admitted = true; }, (message) => this.error("spark_unavailable", message, false));
    return admitted;
  }

  private error(code: ErrorCode, message: string, retryable: boolean): void {
    this.client.sendJson({ type: "error", code, message, retryable });
  }

  private log(event: string, data: Record<string, unknown>): void {
    this.deps.log?.(event, { session: this.id, ...data });
  }
}

/** `start.history` from the app: role + text only, capped. */
function parseHistory(v: unknown): HistoryItem[] {
  if (!Array.isArray(v)) return [];
  const out: HistoryItem[] = [];
  for (const h of v.slice(-MAX_HISTORY)) {
    const item = h as Record<string, unknown>;
    const text = typeof item?.text === "string" ? item.text.replace(/\s+/g, " ").trim().slice(0, 1000) : "";
    if (text && (item.role === "user" || item.role === "assistant")) out.push({ role: item.role, text });
  }
  return out;
}
