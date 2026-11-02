/**
 * Watch together (F5-L9 · L13 · L14 · L16): one per call, fed by the Mac's
 * screen share over /v1/watch (socket.ts).
 *
 *   frames (only when the picture changed, ≤1024 px JPEG) ─┐
 *   system audio PCM → 2nd Transcribe session (DIARIZATION) ┼→ story memo every
 *                                                            │  ~12 s / after a line (Spark JSON)
 *                                                            ├→ proactive reaction (rules.ts gate)
 *                                                            └→ question context for the session
 *
 * Nothing is stored: frames live ~20 s in memory and are dropped on stop;
 * the memo keeps the last few minutes of 1–2 line notes for this call only.
 * The video's sound gets its own Transcribe session, so it never becomes a
 * user turn (and isVideoEcho drops mic leakage of the same lines).
 */
import type { SparkRequest, SparkStreamEvent } from "../meta/spark.ts";
import type { AsrEvent } from "../meta/transcribe.ts";
import type { WatchServerEvent } from "../protocol.ts";
import { buildMemoRequest, buildQuestionContext, parseMemoVerdict, type DialogueLine, type MemoEntry, type MemoVerdict, type QuestionContext } from "./memo.ts";
import { echoNow, isVideoEcho, pickFrames, reactionAllowed, reactionScript, speakerChipEnabled, SPEAKER_SILENCE_MS } from "./rules.ts";

export interface WatchAsr {
  on(ev: "event", fn: (e: AsrEvent) => void): unknown;
  on(ev: "status", fn: (s: "connected" | "reconnecting" | "closed") => void): unknown;
  on(ev: "error", fn: (e: Error) => void): unknown;
  connect(): Promise<void>;
  sendAudio(pcm: Buffer): void;
  end(): void;
}

export interface WatchHost {
  companion(): { name: string; traits: string[] };
  /** companion idle and the user not speaking */
  conversationQuiet(): boolean;
  /** speak a scripted line now; returns its utteranceId, or null if the turn machine said no */
  react(script: string): number | null;
}

export interface WatchSink {
  send(ev: WatchServerEvent): void;
  close(code: number, reason: string): void;
}

export type WatchDeps = {
  now: () => number;
  openAsr: (mode: "ENDPOINTING" | "DIARIZATION") => WatchAsr;
  spark: (req: SparkRequest, opts: { signal?: AbortSignal; firstEventTimeoutMs?: number }) => AsyncIterable<SparkStreamEvent>;
  diarize?: boolean;
  /**
   * Watch together = watch YouTube together and chat (Chelsea 11/2 21:10): first reactions (MS-2) are on
   * (the session turns them off only with GENITA_WATCH_REACTIONS=0). The speaker chip (FT-SPK) stays cut (D40):
   * on only with GENITA_WATCH_SPEAKER=1. Undefined = on (direct use, tests).
   */
  reactions?: boolean;
  speakerChip?: boolean;
  memoEveryMs?: number;
  memoAfterLineMs?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** test hook: no timers */
  manualTick?: boolean;
};

type Frame = { at: number; url: string };

const FRAME_KEEP_MS = 20_000;
const MAX_FRAMES_KEPT = 30;
const MEMO_KEEP_MS = 5 * 60_000;
const MAX_MEMO = 20;
const LINES_KEEP_MS = 5 * 60_000;
const MAX_LINES = 60;
const QUESTION_LINES_MS = 90_000;
/**
 * Realtime (11/3): a turn sees the screen as it is now — the newest frame (≤1 s old while a video plays) plus
 * one from ~2 s before for motion. Older context comes from the memo, which keeps up every few seconds.
 * Two images instead of four keep the reply's first word near 2 s.
 */
const QUESTION_FRAMES = 2;
const QUESTION_FRAME_SPACING_MS = 2_000;
/** the running scene memo refreshes this often while the screen changes (was 12 s) */
export const MEMO_EVERY_MS = 5_000;
const MEMO_FRAMES = 3;
const ECHO_WINDOW_MS = 10_000;
const ECHO_WAIT_MS = 1_500;
const BLANK_LINE = "<neutral> Hmm, that window shows up black to me. Some apps block screen capture, so I won't guess what's on it.";
const MAX_FRAME_URL = Math.round(1_500_000 * 1.4);
/** Transcribe errors with "Ingress audio slower than real-time" when audio stops (11/2): pad silence */
const PAD_AFTER_MS = 300;
const PAD_CHUNK = Buffer.alloc(24_000 * 2 / 10); // 100 ms

export class WatchController {
  private readonly deps: WatchDeps;
  private readonly host: WatchHost;
  private sink: WatchSink | null = null;
  private sharing = false;
  private source: string | null = null;
  private sharingSince = 0;
  private blank = false;
  private blankSpoken = false;
  private frames: Frame[] = [];
  private lastMemoAt = 0;
  private memo: MemoEntry[] = [];
  private lines: DialogueLine[] = [];
  private names = new Map<string, string>();
  private labelsSeen: { label: string; at: number }[] = [];
  private pendingLabel: string | null = null;
  private dialogueActive = false;
  /** the video's line in progress (partial transcript), for the echo check */
  private openLine = "";
  private lastDialogueEndAt: number | null = null;
  private lineSinceMemo = false;
  private lastReactionAt: number | null = null;
  private memoInFlight: AbortController | null = null;
  private asr: WatchAsr | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private padTimer: NodeJS.Timeout | null = null;
  private lastAudioAt = 0;
  private speakerOffTimer: NodeJS.Timeout | null = null;
  private speakerOn = false;
  private lineWaiters: (() => void)[] = [];
  private closed = false;
  /** counters for logs and the sim */
  readonly stats = { frames: 0, audioBytes: 0, lines: 0, memos: 0, memoMs: [] as number[], reactions: 0, blocked: {} as Record<string, number> };

  constructor(host: WatchHost, deps: WatchDeps) {
    this.host = host;
    this.deps = deps;
  }

  get isSharing(): boolean {
    return this.sharing;
  }

  /** A (new) watch socket from the app. One at a time per call; a new one replaces the old. */
  attach(sink: WatchSink): void {
    if (this.sink && this.sink !== sink) {
      this.sink.close(4409, "replaced");
      this.stop("replaced");
    }
    this.sink = sink;
  }

  detach(sink: WatchSink): void {
    if (this.sink !== sink) return;
    this.stop("disconnected");
    this.sink = null;
  }

  // ───────────────────────── app input ─────────────────────────

  onMessage(msg: Record<string, unknown>): void {
    if (this.closed) return;
    switch (msg.type) {
      case "start":
        return this.start(typeof msg.source === "string" ? msg.source.slice(0, 60) : null);
      case "frame":
        return this.onFrame(msg.image, msg.blank === true);
      case "stop":
        return this.stop("client");
      case "ping":
        return this.sink?.send({ type: "pong", t: msg.t ?? null });
      default:
        return this.sink?.send({ type: "error", code: "unknown_type", message: `Unknown watch message ${String(msg.type).slice(0, 40)}` });
    }
  }

  onAudio(pcm: Buffer): void {
    if (!this.sharing || this.closed) return;
    this.stats.audioBytes += pcm.length;
    this.lastAudioAt = this.deps.now();
    this.asr?.sendAudio(pcm);
  }

  private start(source: string | null): void {
    if (this.sharing) {
      this.source = source ?? this.source;
      return this.emitState();
    }
    this.sharing = true;
    this.source = source;
    this.sharingSince = this.deps.now();
    this.lastMemoAt = this.sharingSince;
    this.blank = false;
    this.blankSpoken = false;
    this.lineSinceMemo = false;
    this.openAsr();
    if (!this.deps.manualTick) {
      this.tickTimer = setInterval(() => this.tick(), 500);
      // a silent or paused video sends no audio; keep the transcriber fed in real time
      this.lastAudioAt = this.sharingSince;
      this.padTimer = setInterval(() => {
        if (this.deps.now() - this.lastAudioAt > PAD_AFTER_MS) this.asr?.sendAudio(PAD_CHUNK);
      }, 100);
    }
    this.emitState();
    this.log("watch.start", { source });
  }

  private openAsr(): void {
    const asr = this.deps.openAsr(this.deps.diarize === false ? "ENDPOINTING" : "DIARIZATION");
    asr.on("event", (e) => this.onAsr(e));
    asr.on("error", (err) => this.log("watch.asr.error", { message: err.message.slice(0, 200) }));
    asr.on("status", (s) => this.log("watch.asr.status", { status: s }));
    this.asr = asr;
    asr.connect().catch((err) => {
      this.log("watch.asr.error", { message: String(err).slice(0, 200) });
      this.sink?.send({ type: "error", code: "asr_unavailable", message: "Could not listen to the shared sound; frames still work" });
    });
  }

  stop(reason: string): void {
    if (!this.sharing) return;
    this.sharing = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.padTimer) clearInterval(this.padTimer);
    this.tickTimer = null;
    this.padTimer = null;
    this.memoInFlight?.abort();
    this.memoInFlight = null;
    this.asr?.end();
    this.asr = null;
    this.frames = []; // never kept past the share
    this.dialogueActive = false;
    this.openLine = "";
    this.pendingLabel = null;
    this.flushWaiters();
    this.setSpeaker(null);
    this.blank = false;
    this.emitState();
    this.log("watch.stop", { reason, ...this.summary() });
  }

  close(): void {
    if (this.closed) return;
    this.stop("session_closed");
    this.closed = true;
    this.sink?.close(1000, "session closed");
    this.sink = null;
  }

  private onFrame(image: unknown, blank: boolean): void {
    if (!this.sharing || typeof image !== "string" || !image) return;
    const url = image.startsWith("data:image/") ? image : `data:image/jpeg;base64,${image}`;
    if (url.length > MAX_FRAME_URL) return this.sink?.send({ type: "error", code: "frame_too_large", message: "Each frame must be under 1.5 MB" });
    const now = this.deps.now();
    this.stats.frames++;
    if (!blank) {
      this.frames.push({ at: now, url });
      // the newest frame stays even when old: a paused screen sends no new frames
      this.frames = this.frames.filter((f, i, all) => i === all.length - 1 || now - f.at <= FRAME_KEEP_MS).slice(-MAX_FRAMES_KEPT);
    }
    if (blank !== this.blank) {
      this.blank = blank;
      if (!blank) this.blankSpoken = false;
      this.emitState();
      this.log("watch.blank", { on: blank });
    }
  }

  // ───────────────────────── video sound ─────────────────────────

  private onAsr(e: AsrEvent): void {
    const now = this.deps.now();
    switch (e.type) {
      case "speechStart":
        this.dialogueActive = true;
        this.openLine = "";
        if (this.speakerOffTimer) clearTimeout(this.speakerOffTimer);
        this.speakerOffTimer = null;
        return;
      case "speaker":
        this.pendingLabel = e.label;
        this.labelsSeen.push({ label: e.label, at: now });
        this.labelsSeen = this.labelsSeen.filter((l) => now - l.at <= 10 * 60_000).slice(-50);
        return;
      case "speechEnd":
        this.dialogueActive = false;
        this.lastDialogueEndAt = now;
        return;
      case "speechComplete": {
        this.dialogueActive = false;
        this.lastDialogueEndAt ??= now;
        const text = e.text.trim();
        const label = this.pendingLabel;
        this.pendingLabel = null;
        this.openLine = "";
        if (text) {
          this.lines.push({ at: now, label, text: text.slice(0, 400) });
          this.lines = this.lines.filter((l) => now - l.at <= LINES_KEEP_MS).slice(-MAX_LINES);
          this.stats.lines++;
          this.lineSinceMemo = true;
          this.log("watch.line", { label, text: text.slice(0, 120) });
          if (label && this.deps.speakerChip !== false && speakerChipEnabled(this.labelsSeen, now)) this.setSpeaker(label);
        }
        this.flushWaiters();
        if (this.speakerOn) {
          if (this.speakerOffTimer) clearTimeout(this.speakerOffTimer);
          this.speakerOffTimer = setTimeout(() => this.setSpeaker(null), SPEAKER_SILENCE_MS);
        }
        return;
      }
      case "partial":
        if (this.dialogueActive) this.openLine = e.text.slice(0, 400);
        return;
    }
  }

  private setSpeaker(label: string | null): void {
    if (label === null) {
      if (this.speakerOffTimer) clearTimeout(this.speakerOffTimer);
      this.speakerOffTimer = null;
      if (!this.speakerOn) return;
      this.speakerOn = false;
      return this.sink?.send({ type: "speaker", on: false });
    }
    this.speakerOn = true;
    this.sink?.send({ type: "speaker", on: true, label, name: this.names.get(label) ?? `Voice ${label}` });
  }

  private flushWaiters(): void {
    const w = this.lineWaiters;
    this.lineWaiters = [];
    for (const f of w) f();
  }

  // ───────────────────────── memo + reaction ─────────────────────────

  /** Runs every 500 ms while sharing (tests call it directly). */
  tick(): void {
    if (!this.sharing || this.memoInFlight || this.closed) return this.maybeSpeakBlank();
    const now = this.deps.now();
    const since = now - this.lastMemoAt;
    const newFrames = this.frames.some((f) => f.at > this.lastMemoAt);
    const due =
      (this.lineSinceMemo && since >= (this.deps.memoAfterLineMs ?? 4_000)) ||
      ((newFrames || this.lineSinceMemo) && since >= (this.deps.memoEveryMs ?? MEMO_EVERY_MS));
    if (due) void this.runMemo();
    this.maybeSpeakBlank();
  }

  /** MS-3: say once per black episode that the window shows up black. */
  private maybeSpeakBlank(): void {
    if (!this.sharing || !this.blank || this.blankSpoken || !this.host.conversationQuiet()) return;
    if (this.host.react(BLANK_LINE) !== null) {
      this.blankSpoken = true;
      this.log("watch.blank.spoken", {});
    }
  }

  async runMemo(): Promise<MemoVerdict | null> {
    const at = this.deps.now();
    const since = this.lastMemoAt;
    const fresh = this.frames.filter((f) => f.at > since);
    const frames = pickFrames(fresh.length ? fresh : this.frames.slice(-1), MEMO_FRAMES, 3_000).map((f) => f.url);
    const lines = this.lines.filter((l) => l.at > since);
    this.lastMemoAt = at;
    this.lineSinceMemo = false;
    const req = buildMemoRequest({
      companion: this.host.companion(),
      source: this.source,
      memo: this.memo,
      lines,
      names: this.names,
      frames,
      blank: this.blank,
    });
    const abort = new AbortController();
    this.memoInFlight = abort;
    let raw = "";
    try {
      for await (const ev of this.deps.spark(req, { signal: abort.signal, firstEventTimeoutMs: 10_000 })) {
        if (ev.type === "text") raw += ev.delta;
        else if (ev.type === "done" && !raw) raw = ev.text;
      }
    } catch (err) {
      if (!abort.signal.aborted) this.log("watch.memo.error", { message: String(err).slice(0, 200) });
      return null;
    } finally {
      if (this.memoInFlight === abort) this.memoInFlight = null;
    }
    if (abort.signal.aborted || !this.sharing) return null;
    const v = parseMemoVerdict(raw);
    const ms = Math.round(this.deps.now() - at);
    this.stats.memos++;
    this.stats.memoMs.push(ms);
    if (!v) {
      this.log("watch.memo.bad", { raw: raw.slice(0, 160) });
      return null;
    }
    const now = this.deps.now();
    if (v.memo) {
      this.memo.push({ at, text: v.memo });
      this.memo = this.memo.filter((e) => now - e.at <= MEMO_KEEP_MS).slice(-MAX_MEMO);
    }
    for (const s of v.speakers) if (s.label && !this.names.has(s.label)) this.names.set(s.label, s.name);
    this.log("watch.memo", { ms, memo: v.memo.slice(0, 160), moment: v.moment, reaction: v.reaction, frames: frames.length, lines: lines.length });
    if (v.moment !== "none") this.tryReact(v, at);
    return v;
  }

  private tryReact(v: MemoVerdict, verdictAt: number): void {
    if (this.deps.reactions === false) return;
    const script = reactionScript(v.moment, v.reaction);
    if (!script) return;
    const gate = reactionAllowed({
      now: this.deps.now(),
      sharing: this.sharing,
      blank: this.blank,
      sharingSince: this.sharingSince,
      lastReactionAt: this.lastReactionAt,
      conversationQuiet: this.host.conversationQuiet(),
      dialogueActive: this.dialogueActive,
      lastDialogueEndAt: this.lastDialogueEndAt,
      verdictAt,
    });
    if (!gate.ok) {
      this.stats.blocked[gate.why] = (this.stats.blocked[gate.why] ?? 0) + 1;
      this.log("watch.react.blocked", { why: gate.why, moment: v.moment, reaction: v.reaction });
      return;
    }
    const utteranceId = this.host.react(script);
    if (utteranceId === null) {
      this.stats.blocked.turn = (this.stats.blocked.turn ?? 0) + 1;
      return;
    }
    this.lastReactionAt = this.deps.now();
    this.stats.reactions++;
    if (v.moment !== "none") this.sink?.send({ type: "reaction", utteranceId, moment: v.moment });
    this.log("watch.react", { utteranceId, moment: v.moment, line: v.reaction });
  }

  // ───────────────────────── session hooks ─────────────────────────

  /** Watch context for the user's question, or null when nothing has been watched. */
  questionContext(): QuestionContext | null {
    if (!this.sharing && !this.memo.length) return null;
    const now = this.deps.now();
    const frames = this.sharing ? pickFrames(this.frames, QUESTION_FRAMES, QUESTION_FRAME_SPACING_MS).map((f) => f.url) : [];
    return buildQuestionContext({
      source: this.source,
      memo: this.memo,
      lines: this.sharing ? this.lines.filter((l) => now - l.at <= QUESTION_LINES_MS).slice(-12) : this.lines.slice(-6),
      names: this.names,
      frames,
      blank: this.sharing && this.blank,
    });
  }

  /**
   * Is this "user turn" really the video's sound in the mic? If the video is
   * mid-line, its partial transcript usually decides at once; only a partial
   * too short to tell waits (≤1.5 s) for that line before deciding.
   */
  async isEcho(userText: string): Promise<boolean> {
    if (!this.sharing) return false;
    const recent = () => this.lines.filter((l) => this.deps.now() - l.at <= ECHO_WINDOW_MS).map((l) => l.text);
    const early = this.dialogueActive ? echoNow(userText, this.openLine) : "user";
    if (early === "echo") return true;
    if (early === "user") return isVideoEcho(userText, recent());
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ECHO_WAIT_MS);
      this.lineWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
    return isVideoEcho(userText, recent());
  }

  summary(): Record<string, unknown> {
    const ms = [...this.stats.memoMs].sort((a, b) => a - b);
    return {
      frames: this.stats.frames,
      audioSec: Math.round(this.stats.audioBytes / 48_000),
      lines: this.stats.lines,
      memos: this.stats.memos,
      memoP50Ms: ms.length ? ms[Math.floor(ms.length / 2)] : null,
      reactions: this.stats.reactions,
      blocked: this.stats.blocked,
    };
  }

  private emitState(): void {
    this.sink?.send({ type: "state", sharing: this.sharing, blank: this.blank, source: this.source });
  }

  private log(event: string, data: Record<string, unknown>): void {
    this.deps.log?.(event, data);
  }
}
