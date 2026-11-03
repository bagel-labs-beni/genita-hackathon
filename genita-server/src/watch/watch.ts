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
import { buildMemoRequest, buildQuestionContext, buildQuickRequest, cleanTitle, earlyVerdict, parseMemoVerdict, parseQuick, type DialogueLine, type MemoEntry, type MemoVerdict, type QuestionContext } from "./memo.ts";
import { echoNow, isVideoEcho, pickFrames, REACT_MIN_GAP_MS, reactionAllowed, reactionScript, speakerChipEnabled, SPEAKER_SILENCE_MS } from "./rules.ts";

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
  memoLanes?: number;
  memoConcurrency?: number;
  /** quick look on motion spikes (default on; GENITA_WATCH_QUICK=0 turns it off) */
  quick?: boolean;
  quickEveryMs?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** test hook: no timers */
  manualTick?: boolean;
};

type Frame = { at: number; url: string };

const FRAME_KEEP_MS = 20_000;
/** ~20 s at the Mac's 3 fps (motion-aware vision, 11/3) */
const MAX_FRAMES_KEPT = 90;
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
const QUESTION_FRAMES = 3;
const QUESTION_FRAME_SPACING_MS = 700;
/** the running scene memo refreshes this often while the screen changes (was 12 s) */
const MEMO_EVERY_MS = 2_000;
/** a finished line of the video (often the punchline) gets its memo this soon, so a laugh lands ~4 s after (was 4 s) */
const MEMO_AFTER_LINE_MS = 1_200;
/** a reaction held back by the video's dialogue or by the conversation waits for a pause, until it is stale */
const HOLD_WHY = new Set(["dialogue", "conversation", "turn"]);
/** the timeline memo sees a short motion sequence: 5 frames ~0.6 s apart (≈2.4 s), not stills seconds apart */
const MEMO_FRAMES = 4;
/** memo Spark lanes raced per memo (GENITA_WATCH_MEMO_LANES, default 2) */
const MEMO_LANES = Number(process.env.GENITA_WATCH_MEMO_LANES ?? 1) || 1;
/** memos in flight at once (GENITA_WATCH_MEMOS, default 2), started at least this far apart */
const MEMO_CONCURRENCY = Number(process.env.GENITA_WATCH_MEMOS ?? 3) || 1;
const MEMO_STAGGER_MS = 1_000;
const MEMO_FRAME_SPACING_MS = 600;
/** a frame this different from the last one (a cut, a fall, a big move) asks for the memo right away */
export const MOTION_SPIKE = 0.06;
/** …after this long, so the frames show what the move turned into */
const SPIKE_SETTLE_MS = 400;
/** quick look (11/3, visual moments ≤5 s): a spike's own small Spark call on the last ~1 s, one at a time */
const QUICK_AFTER_SPIKE_MS = 250;
const QUICK_MIN_GAP_MS = 700;
/** …and every 1.5 s while the picture changes: small subjects (a dunk far away, a skateboard trick) barely move the
 *  32×18 luma, so a spike alone misses them */
const QUICK_EVERY_MS = 1_000;
/** quick looks in flight at once: a second spike (the trick right after a cut) doesn't wait for the first */
const QUICK_CONCURRENCY = 2;
/** a sound counts as dialogue for the reaction gate once it has a word ("Stop!" counts). Wordless crowd noise
 *  and cheers don't; a stray transcribed word over a crowd is left to the model's talkOver */
const words = (s: string) => s.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
/** 2 frames (~0.3–0.9 s apart, the newest last): enough for the motion, fewer images = a faster call (11/3 15:30) */
const QUICK_FRAMES = 2;
const QUICK_ON = process.env.GENITA_WATCH_QUICK !== "0";
const ECHO_WINDOW_MS = 10_000;
const ECHO_WAIT_MS = 1_500;
/** a partial that doesn't match the user's words gets this long to catch up before the turn counts as theirs */
const ECHO_SETTLE_MS = 350;
const BLANK_LINE = "<neutral> Hmm, I can't see that one. It's protected and shows up black to me. Wanna put on a YouTube clip?";
/** memo: a black video picture inside a visible page (Netflix in a browser): the same honest line, once per share */
const PROTECTED_HOLD_MS = 15_000;
const PROTECTED_LINE = "<neutral> I can't see that video, it's protected and shows up black to me. Wanna put on a YouTube clip?";
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
  /** the shared window's title (a YouTube tab: "<video title> - YouTube"), from the Mac app */
  private title: string | null = null;
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
  private speechEndAt: number | null = null;
  /** counts the video's speech turns: a talkOver verdict only covers the sound it heard (Codex P2) */
  private speechSeq = 0;
  private wordsLogged = false;
  private lastDialogueEndAt: number | null = null;
  private lineSinceMemo = false;
  private lastReactionAt: number | null = null;
  /** last motion spike (scene cut / big move) not yet looked at by a memo */
  private salientAt: number | null = null;
  /** a spike waiting for its quick look (needs one frame after it) */
  private quickSpikeAt: number | null = null;
  private quickInFlight = new Set<AbortController>();
  private lastQuickAt = -Infinity;
  private motionAware = false;
  private protectedSpoken = false;
  private protectedPending = false;
  private protectedSince = 0;
  /** a funny moment waiting for the video's line (or the conversation) to pause */
  private held: { v: MemoVerdict; at: number } | null = null;
  /** memos running now: up to MEMO_CONCURRENCY, started ≥ MEMO_STAGGER_MS apart, so a moment waits ≤ ~1.5 s for one */
  private memosInFlight = new Set<AbortController>();
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
    const type = msg.type;
    if (typeof type !== "string") {
      return this.sink?.send({ type: "error", code: "bad_message", message: "Watch message type must be a string" });
    }
    switch (type) {
      case "start":
        if ("title" in msg) this.setTitle(msg.title);
        // another window or display: the old window's title must not ride along with the new picture
        else if (this.sharing && typeof msg.source === "string" && msg.source.slice(0, 60) !== this.source) this.title = null;
        return this.start(typeof msg.source === "string" ? msg.source.slice(0, 60) : null);
      case "context":
        return this.setTitle(msg.title);
      case "frame":
        return this.onFrame(msg.image, msg.blank === true, typeof msg.motion === "number" && Number.isFinite(msg.motion) ? msg.motion : null);
      case "stop":
        return this.stop("client");
      case "ping":
        return this.sink?.send({ type: "pong", t: msg.t ?? null });
      default:
        return this.sink?.send({ type: "error", code: "unknown_type", message: `Unknown watch message ${type.slice(0, 40)}` });
    }
  }

  onAudio(pcm: Buffer): void {
    if (!this.sharing || this.closed) return;
    this.stats.audioBytes += pcm.length;
    this.lastAudioAt = this.deps.now();
    this.asr?.sendAudio(pcm);
  }

  /** the title changed = usually another video or page: the memo sees it on its next run (no extra Spark call) */
  private setTitle(raw: unknown): void {
    const t = cleanTitle(raw);
    if (t === this.title) return;
    this.title = t;
    // the text itself can be private (a document, a mail subject): only its length is logged
    this.log("watch.title", { chars: t?.length ?? 0 });
  }

  private start(source: string | null): void {
    if (this.sharing) {
      // another window or display: an older "protected" verdict was about the old one
      if (source !== null && source !== this.source) this.protectedPending = false;
      this.source = source ?? this.source;
      return this.emitState();
    }
    this.sharing = true;
    this.source = source;
    this.sharingSince = this.deps.now();
    this.lastMemoAt = this.sharingSince;
    this.lastQuickAt = this.sharingSince;
    this.blank = false;
    this.blankSpoken = false;
    this.protectedSpoken = false;
    this.protectedPending = false;
    this.salientAt = null;
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
    for (const m of this.memosInFlight) m.abort();
    this.memosInFlight.clear();
    for (const q of this.quickInFlight) q.abort();
    this.quickInFlight.clear();
    this.quickSpikeAt = null;
    this.held = null;
    this.asr?.end();
    this.asr = null;
    this.frames = []; // never kept past the share
    this.title = null;
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

  private onFrame(image: unknown, blank: boolean, motion: number | null = null): void {
    if (!this.sharing || typeof image !== "string" || !image) return;
    const url = image.startsWith("data:image/") ? image : `data:image/jpeg;base64,${image}`;
    if (url.length > MAX_FRAME_URL) return this.sink?.send({ type: "error", code: "frame_too_large", message: "Each frame must be under 1.5 MB" });
    const now = this.deps.now();
    this.stats.frames++;
    if (!blank) {
      if (motion !== null) this.motionAware = true;
      if (motion !== null && motion >= MOTION_SPIKE) {
        this.salientAt = now;
        this.quickSpikeAt ??= now; // the first pending spike; the quick look takes the newest frames anyway
      }
      this.frames.push({ at: now, url });
      // the newest frame stays even when old: a paused screen sends no new frames
      this.frames = this.frames.filter((f, i, all) => i === all.length - 1 || now - f.at <= FRAME_KEEP_MS).slice(-MAX_FRAMES_KEPT);
      this.maybeQuick();
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
        this.speechSeq++;
        this.wordsLogged = false;
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
        if (this.dialogueActive && this.wordsLogged) this.log("watch.dialogue", { on: false });
        this.wordsLogged = false;
        this.dialogueActive = false;
        this.speechEndAt = now;
        if (words(this.openLine) >= 1) this.lastDialogueEndAt = now;
        return;
      case "speechComplete": {
        if (this.dialogueActive && this.wordsLogged) this.log("watch.dialogue", { on: false });
        this.wordsLogged = false;
        this.dialogueActive = false;
        const text = e.text.trim();
        if (words(text) >= 1) this.lastDialogueEndAt = this.speechEndAt ?? now;
        this.speechEndAt = null;
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
        if (this.dialogueActive && !this.wordsLogged && words(this.openLine) >= 1) { this.wordsLogged = true; this.log("watch.dialogue", { on: true }); }
        this.flushWaiters();
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
    this.maybeQuick();
    if (this.protectedPending && this.sharing && !this.closed) this.speakProtected();
    if (this.held && this.sharing && !this.closed) this.tryReact(this.held.v, this.held.at, true);
    const now = this.deps.now();
    const since = now - this.lastMemoAt;
    const busy = this.memosInFlight.size >= (this.deps.memoConcurrency ?? MEMO_CONCURRENCY) || (this.memosInFlight.size > 0 && since < MEMO_STAGGER_MS);
    // while the user and the companion talk, no new memo starts: the reply gets Spark's full attention (and its
    // frames come straight from the buffer anyway); the timeline catches up in the next pause
    if (!this.sharing || busy || this.closed || !this.host.conversationQuiet()) return this.maybeSpeakBlank();
    const newFrames = this.frames.some((f) => f.at > this.lastMemoAt);
    const spike = this.salientAt !== null && this.salientAt > this.lastMemoAt && now - this.salientAt >= SPIKE_SETTLE_MS;
    const due =
      spike ||
      (this.lineSinceMemo && since >= (this.deps.memoAfterLineMs ?? MEMO_AFTER_LINE_MS)) ||
      ((newFrames || this.lineSinceMemo) && since >= (this.deps.memoEveryMs ?? MEMO_EVERY_MS));
    if (due) void this.runMemo();
    this.maybeSpeakBlank();
  }

  /** DRM: a black video inside a page that captures fine (Netflix in a browser). Said once per share, when quiet. */
  private speakProtected(): void {
    if (this.protectedSpoken) return;
    // said in the next pause (nobody talking, the video's line done) — tick retries; a newer clear picture, another
    // source or 15 s cancel it (Codex P2)
    const now = this.deps.now();
    if (!this.protectedPending) this.protectedSince = now;
    this.protectedPending = true;
    if (now - this.protectedSince > PROTECTED_HOLD_MS) { this.protectedPending = false; return; }
    const videoTalking = this.dialogueActive || (this.lastDialogueEndAt !== null && now - this.lastDialogueEndAt < 700);
    if (!this.host.conversationQuiet() || videoTalking) return;
    if (this.host.react(PROTECTED_LINE) !== null) {
      this.protectedSpoken = true;
      this.protectedPending = false;
      this.log("watch.protected.spoken", {});
    }
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
    // spread over everything new since the last memo (a move between two memos is never skipped), ≥0.6 s apart
    const span = fresh.length > 1 ? fresh[fresh.length - 1].at - fresh[0].at : 0;
    const spacing = Math.max(MEMO_FRAME_SPACING_MS, Math.floor(span / (MEMO_FRAMES - 1)));
    const frames = pickFrames(fresh.length ? fresh : this.frames.slice(-1), MEMO_FRAMES, spacing).map((f) => f.url);
    const salient = this.salientAt !== null && this.salientAt > since;
    const lines = this.lines.filter((l) => l.at > since);
    const memoSeq = this.speechSeq;
    // how fresh the moment is = its newest frame or line, not when this memo started (Codex P2: a memo started late
    // after a long talk must not react to a scene from 20 s ago)
    const contentAt = Math.max(fresh.at(-1)?.at ?? this.frames.at(-1)?.at ?? at, lines.at(-1)?.at ?? -Infinity);
    this.lastMemoAt = at;
    this.lineSinceMemo = false;
    const req = buildMemoRequest({
      companion: this.host.companion(),
      source: this.source,
      title: this.title,
      memo: this.memo,
      lines,
      names: this.names,
      frames,
      blank: this.blank,
    });
    const abort = new AbortController();
    this.memosInFlight.add(abort);
    let raw = "";
    let early = false;
    try {
      // lanes race, first complete JSON wins; the reaction can go out as soon as the verdict part has streamed
      // (before the memo text is written)
      raw = await this.memoRace(req, abort.signal, (this.deps.memoLanes ?? MEMO_LANES) > 1 ? undefined : (e) => {
        early = true;
        this.log("watch.memo.early", { ms: Math.round(this.deps.now() - at), moment: e.moment });
        this.tryReact({ memo: "", moment: e.moment, reaction: e.reaction, speakers: [], talkOver: e.talkOver, talkOverSeq: memoSeq }, contentAt);
      });
    } catch (err) {
      if (!abort.signal.aborted) this.log("watch.memo.error", { message: String(err).slice(0, 200) });
      return null;
    } finally {
      this.memosInFlight.delete(abort);
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
      // overlapping memos finish out of order: keep the timeline in scene order
      this.memo.sort((a, b) => a.at - b.at);
      this.memo = this.memo.filter((e) => now - e.at <= MEMO_KEEP_MS).slice(-MAX_MEMO);
    }
    for (const s of v.speakers) if (s.label && !this.names.has(s.label)) this.names.set(s.label, s.name);
    this.log("watch.memo", { ms, memo: v.memo.slice(0, 160), moment: v.moment, reaction: v.reaction, frames: frames.length, lines: lines.length, salient, protectedVideo: v.protectedVideo === true });
    if (v.protectedVideo) {
      this.speakProtected();
      return v;
    }
    this.protectedPending = false; // a clear picture now: an older "protected" no longer applies
    if (v.moment !== "none" && !early) this.tryReact({ ...v, talkOverSeq: memoSeq }, contentAt);
    return v;
  }

  private async memoRace(req: SparkRequest, signal: AbortSignal, onEarly?: (e: { moment: Exclude<MemoVerdict["moment"], "none">; reaction: string; talkOver: boolean }) => void): Promise<string> {
    let earlyDone = false;
    const lanes = Math.max(1, this.deps.memoLanes ?? MEMO_LANES);
    const kids = Array.from({ length: lanes }, () => new AbortController());
    const stop = () => kids.forEach((k) => k.abort());
    signal.addEventListener("abort", stop, { once: true });
    const one = async (k: AbortController): Promise<string> => {
      let raw = "";
      for await (const ev of this.deps.spark(req, { signal: k.signal, firstEventTimeoutMs: 10_000 })) {
        if (ev.type === "text") raw += ev.delta;
        else if (ev.type === "done" && !raw) raw = ev.text;
        if (!earlyDone && onEarly && ev.type === "text") {
          const e = earlyVerdict(raw);
          if (e) { earlyDone = true; onEarly(e); }
        }
      }
      if (!parseMemoVerdict(raw)) throw new Error("memo: no verdict");
      return raw;
    };
    try {
      return await Promise.any(kids.map(one));
    } catch (err) {
      throw err instanceof AggregateError ? err.errors[0] : err;
    } finally {
      stop();
      signal.removeEventListener("abort", stop);
    }
  }

  /** A spike with one frame after it (or 0.4 s of stillness) gets a quick look right away — no memo wait. */
  private maybeQuick(): void {
    if (!QUICK_ON || this.deps.quick === false || this.deps.reactions === false || !this.sharing || this.closed) return;
    const now = this.deps.now();
    let spike = this.quickSpikeAt;
    const after = spike !== null && (this.frames.some((f) => f.at > spike! + QUICK_AFTER_SPIKE_MS - 50) || now - spike >= 400);
    const newest = this.frames.at(-1)?.at ?? -Infinity;
    // the cadence needs a motion-aware Mac (frames carry `motion`, ≤3 fps); older builds get spikes only
    const cadence = !after && this.motionAware && newest > this.lastQuickAt && now - this.lastQuickAt >= (this.deps.quickEveryMs ?? QUICK_EVERY_MS);
    if (!(after || cadence) || this.quickInFlight.size >= QUICK_CONCURRENCY || now - this.lastQuickAt < QUICK_MIN_GAP_MS) return;
    spike = after ? spike : newest;
    this.quickSpikeAt = null;
    // no point looking when a reaction couldn't go out anyway
    if (this.blank || !this.host.conversationQuiet() || (this.lastReactionAt !== null && now - this.lastReactionAt < REACT_MIN_GAP_MS)) return;
    void this.runQuick(spike!);
  }

  async runQuick(spikeAt: number): Promise<void> {
    const at = this.deps.now();
    this.lastQuickAt = at;
    const frames = pickFrames(this.frames.filter((f) => f.at >= Math.min(spikeAt, (this.frames.at(-1)?.at ?? spikeAt)) - 900), QUICK_FRAMES, 300).map((f) => f.url);
    const seq = this.speechSeq;
    const heard = [this.dialogueActive ? this.openLine : "", ...this.lines.filter((l) => at - l.at <= 3_000).map((l) => l.text)].filter(Boolean).slice(-2);
    const abort = new AbortController();
    this.quickInFlight.add(abort);
    let raw = "";
    try {
      for await (const ev of this.deps.spark(buildQuickRequest({ companion: this.host.companion(), frames, heard }), { signal: abort.signal, firstEventTimeoutMs: 6_000 })) {
        if (ev.type === "text") raw += ev.delta;
        else if (ev.type === "done" && !raw) raw = ev.text;
      }
    } catch (err) {
      if (!abort.signal.aborted) this.log("watch.quick.error", { message: String(err).slice(0, 200) });
      return;
    } finally {
      this.quickInFlight.delete(abort);
    }
    if (abort.signal.aborted || !this.sharing) return;
    const q = parseQuick(raw);
    this.log("watch.quick", { ms: Math.round(this.deps.now() - at), react: !!q, moment: q?.moment ?? "none", line: q?.line ?? "", talkOver: q?.talkOver ?? null, frames: frames.length });
    if (q) this.tryReact({ memo: "", moment: q.moment, reaction: q.line, speakers: [], talkOver: q.talkOver, talkOverSeq: seq }, spikeAt, false, "quick");
  }

  private tryReact(v: MemoVerdict, verdictAt: number, retry = false, via: "memo" | "quick" = "memo"): void {
    if (this.deps.reactions === false) return;
    const script = reactionScript(v.moment, v.reaction);
    if (!script) return;
    // an older moment (a slower memo finishing late) never replaces or clears a newer one that is waiting
    if (!retry && this.held && verdictAt < this.held.at) return;
    const gate = reactionAllowed({
      now: this.deps.now(),
      sharing: this.sharing,
      blank: this.blank,
      sharingSince: this.sharingSince,
      lastReactionAt: this.lastReactionAt,
      conversationQuiet: this.host.conversationQuiet(),
      dialogueActive: this.dialogueActive && words(this.openLine) >= 1,
      lastDialogueEndAt: this.lastDialogueEndAt,
      verdictAt,
      // talkOver covers only the sound that verdict heard: a new speech turn since then (a scene's dialogue
      // starting) needs its own pause
      talkOver: v.talkOver === true && (v.talkOverSeq ?? this.speechSeq) === this.speechSeq,
    });
    if (!gate.ok) {
      // the video is mid-line or someone is talking: hold it and try again on each tick until it is stale
      if (HOLD_WHY.has(gate.why)) {
        if (!this.held) this.log("watch.react.held", { why: gate.why, moment: v.moment, reaction: v.reaction });
        this.held = { v, at: verdictAt };
        return;
      }
      if (retry || (this.held && this.held.at <= verdictAt)) this.held = null;
      this.stats.blocked[gate.why] = (this.stats.blocked[gate.why] ?? 0) + 1;
      this.log("watch.react.blocked", { why: gate.why, moment: v.moment, reaction: v.reaction, held: retry });
      return;
    }
    const utteranceId = this.host.react(script);
    if (utteranceId === null) {
      this.held = { v, at: verdictAt };
      if (!retry) this.log("watch.react.held", { why: "turn", moment: v.moment, reaction: v.reaction });
      return;
    }
    this.held = null;
    const now = this.deps.now();
    this.lastReactionAt = now;
    this.stats.reactions++;
    if (v.moment !== "none") this.sink?.send({ type: "reaction", utteranceId, moment: v.moment });
    this.log("watch.react", {
      utteranceId,
      moment: v.moment,
      line: v.reaction,
      held: retry,
      via,
      // eval: how long after the video's last line the reaction started, and that no line was open
      afterLineMs: this.lastDialogueEndAt === null ? null : Math.round(now - this.lastDialogueEndAt),
      lineOpen: this.dialogueActive && words(this.openLine) >= 1,
      talkOver: v.talkOver === true,
    });
  }

  // ───────────────────────── session hooks ─────────────────────────

  /** Watch context for the user's question, or null when nothing has been watched. */
  questionContext(): QuestionContext | null {
    if (!this.sharing && !this.memo.length) return null;
    const now = this.deps.now();
    const frames = this.sharing ? pickFrames(this.frames, QUESTION_FRAMES, QUESTION_FRAME_SPACING_MS).map((f) => f.url) : [];
    return buildQuestionContext({
      source: this.source,
      title: this.title,
      memo: this.memo,
      lines: this.sharing ? this.lines.filter((l) => now - l.at <= QUESTION_LINES_MS).slice(-12) : this.lines.slice(-6),
      names: this.names,
      frames,
      blank: this.sharing && this.blank,
    });
  }

  /**
   * Is this "user turn" really the video's sound in the mic? If the video is
   * mid-line, its partial transcript decides within 350 ms; only a partial
   * too short to tell waits (≤ 1.5 s) for the line.
   */
  async isEcho(userText: string): Promise<boolean> {
    if (!this.sharing) return false;
    const recent = () => this.lines.filter((l) => this.deps.now() - l.at <= ECHO_WINDOW_MS).map((l) => l.text);
    const t0 = Date.now();
    let settleUntil: number | null = null;
    while (this.sharing && this.dialogueActive) {
      const v = echoNow(userText, this.openLine);
      if (v === "echo") return true;
      // A mismatching partial may lag the mic by a word or two: keep re-checking its updates for 350 ms before
      // the turn counts as the user's (Codex P2 ×2). A partial too short to tell waits up to the full 1.5 s.
      const now = Date.now();
      if (v === "user") settleUntil ??= now + ECHO_SETTLE_MS;
      const until = Math.min(t0 + ECHO_WAIT_MS, settleUntil ?? Infinity);
      if (until - now <= 0) break;
      await this.nextSound(until - now);
    }
    return isVideoEcho(userText, recent());
  }

  /** Resolves on the video's next partial or finished line, or after `ms`. */
  private nextSound(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.lineWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
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
