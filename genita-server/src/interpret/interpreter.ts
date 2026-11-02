/**
 * F8-L1 · Real-time interpretation inside the realtime session.
 *
 * The Session hands every ASR event here while `mode` is "interpret".
 * Differences from the chat reply pipeline (session.runReply):
 *   - Every finished utterance becomes a two-language bubble; nothing is
 *     answered, nothing goes into chat history.
 *   - Who is talking is decided by language (face to face): the user's own
 *     language = "me" → translated into the other language for the person in
 *     front of them; anything else = "them" → translated into the user's
 *     language. Hold-to-talk forces "me". On the Mac, call audio
 *     (ScreenCaptureKit) is always "them" and the mic only counts while held.
 *   - The language pair is decided automatically: the first non-user
 *     language heard becomes "other" (`interpret.pair`).
 *   - Unclear language → nothing is relayed and nothing is spoken (INT-6).
 *   - Speech never cancels a translation. Translations start the moment a
 *     turn ends (in parallel), audio goes out strictly in order. Only a tap
 *     (`barge_in`) or leaving the mode cancels.
 *   - Speed (PRD §17): ENDPOINTING ASR; translation starts on a partial that
 *     looks final (speculation, reused when the final matches); the first
 *     sentence/clause goes to TTS as soon as it is complete.
 *   - Echo guard: a heard utterance that mostly repeats what Genita just said
 *     (her own voice through the phone speaker) is dropped.
 */
import type { SparkRequest, SparkStreamEvent } from "../meta/spark.ts";
import { SPARK_MODEL } from "../meta/spark.ts";
import type { TtsChunk } from "../tts/types.ts";
import { pcmDurationMs, PCM_SAMPLE_RATE } from "../tts/types.ts";
import { speechLang } from "../text/language.ts";
import type { Alignment } from "../lips/visemes.ts";
import type { BubbleReason, BubbleStatus, BubbleVia, InterpretBubbleEvent, InterpretSource, MouthCue, Phase, ServerEvent, WordTiming } from "../protocol.ts";
import { SentenceSplitter } from "../text/sentences.ts";
import { Eager } from "../util/eager.ts";
import { containment, detectLanguage, type Speaker } from "./language.ts";
import { buildTranslateInstructions } from "./prompt.ts";

export type Channel = "mic" | "call";

export interface InterpretHost {
  now(): number;
  send(e: ServerEvent): void;
  /** binary TTS frame for the `audio` event with this seq */
  sendAudio(seq: number, pcm: Buffer): void;
  nextSeq(): number;
  nextUtteranceId(): number;
  translate(req: SparkRequest, signal: AbortSignal): AsyncIterable<SparkStreamEvent>;
  tts(text: string, signal: AbortSignal): AsyncIterable<TtsChunk>;
  /**
   * Device voice mode (PROTOCOL.md): when set, each translated sentence goes out as `say` for the app to
   * speak instead of server TTS audio.
   */
  say?(utteranceId: number, sentence: number, text: string, lang: string): void;
  timing(alignment: Alignment | null, offsetMs: number): { words: WordTiming[]; mouth?: MouthCue[] };
  log(event: string, data: Record<string, unknown>): void;
}

export type InterpretOptions = {
  userLanguage: string;
  source: InterpretSource;
  /** fixed other language; unset = decided by the first one heard */
  other?: string | null;
  app?: string;
  speculate?: boolean;
  speculateStableMs?: number;
};

type Lang = string;
type Resolved =
  | { ok: true; speaker: "them" | "me"; via: BubbleVia; from: Lang; to: Lang; setsOther: Lang | null }
  | { ok: false; speaker: Speaker; via: BubbleVia; lang: Lang | null; status: "unknown" | "skipped"; reason: BubbleReason };

type Bubble = {
  id: number;
  speaker: Speaker;
  via: BubbleVia;
  status: BubbleStatus;
  original: { lang: Lang | null; text: string };
  translation: { lang: Lang; text: string } | null;
  utteranceId?: number;
  reason?: BubbleReason;
};

type Spec = { norm: string; from: Lang; to: Lang; abort: AbortController; stream: Eager<SparkStreamEvent> };

type Metrics = { speechEndAt?: number; completeAt?: number; startAt: number; firstTokenAt?: number; firstSentenceAt?: number; firstAudioAt?: number };

type Job = {
  utteranceId: number;
  bubble: Bubble | null;
  stream: AsyncIterable<SparkStreamEvent>;
  abort: AbortController;
  speculative: "hit" | "miss" | "none";
  m: Metrics;
  spoken: string[];
  audioMs: number;
  playStart: number | null;
};

const LOOKS_FINAL = /[.?!。？！…]["'”’)\]]*$/;
const PLAYBACK_SLACK_MS = 250;
/** device voice estimate per character (same as session.ts deviceSpeechEstimateMs) */
const DEVICE_MS_PER_CHAR = 70;
/** a heard line this similar to something Genita said in the echo window is her own voice */
const ECHO_CONTAINMENT = 0.6;
const ECHO_TAIL_MS = 4000;

export function normTranscript(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
}

async function* fixedText(text: string): AsyncGenerator<SparkStreamEvent> {
  yield { type: "text", delta: text };
  yield { type: "done", responseId: null, text, status: "completed" };
}

export class Interpreter {
  readonly source: InterpretSource;
  readonly app: string | undefined;
  private readonly host: InterpretHost;
  private readonly user: Lang;
  private other: Lang | null;
  private readonly otherFixed: boolean;
  private readonly speculate: boolean;
  private readonly stableMs: number;
  private bubbleSeq = 0;
  private open = new Map<Channel, Bubble>();
  private specs = new Map<Channel, Spec>();
  private specTimers = new Map<Channel, NodeJS.Timeout>();
  private speechEndAt = new Map<Channel, number>();
  private holding = false;
  /** the next mic utterance to finish was (at least partly) held */
  private holdTurn = false;
  /** speech was heard during the current/last hold */
  private heldHeard = false;
  private queue: Job[] = [];
  private running: Job | null = null;
  private playEndAt = 0;
  private phase: Phase = "listening";
  private idleTimer: NodeJS.Timeout | null = null;
  private speakTimers = new Map<number, NodeJS.Timeout>();
  private echo: { text: string; until: number }[] = [];
  private stopped = false;

  constructor(host: InterpretHost, opts: InterpretOptions) {
    this.host = host;
    this.user = opts.userLanguage;
    this.source = opts.source;
    this.app = opts.app;
    this.other = opts.other && opts.other !== opts.userLanguage ? opts.other : null;
    this.otherFixed = !!this.other;
    this.speculate = opts.speculate ?? true;
    this.stableMs = opts.speculateStableMs ?? 250;
  }

  get pair(): { user: Lang; other: Lang | null } {
    return { user: this.user, other: this.other };
  }

  /** Mac call mode: the mic is only listened to while "Hold to reply" is down. */
  get micGated(): boolean {
    return this.source === "call" && !this.holding;
  }

  begin(): void {
    this.sendPair();
    this.host.log("interpret.started", { source: this.source, user: this.user, other: this.other, app: this.app ?? null });
  }

  // ───────────────────────── input ─────────────────────────

  hold(on: boolean): void {
    this.holding = on;
    if (on) {
      this.holdTurn = true;
      this.heldHeard = !!this.open.get("mic");
    } else if (!this.heldHeard) {
      // pressed and let go without saying anything: the next utterance is decided by language again
      this.holdTurn = false;
    }
  }

  speechEnd(ch: Channel): void {
    this.speechEndAt.set(ch, this.host.now());
  }

  partial(ch: Channel, text: string): void {
    if (this.stopped || !text.trim()) return;
    if (ch === "mic" && this.holding) this.heldHeard = true;
    if (ch === "mic" && !this.holding && !this.holdTurn && this.isEcho(text)) return;
    const r = this.resolve(ch, text);
    const b = this.open.get(ch) ?? this.newBubble(r.via);
    this.open.set(ch, b);
    b.speaker = r.speaker;
    b.via = r.via;
    b.original = { lang: r.ok ? r.from : r.lang, text };
    b.status = "hearing";
    this.emit(b);
    if (r.ok) this.considerSpeculation(ch, text, r.from, r.to);
  }

  /** The utterance on this channel ended (ASR speechComplete). */
  final(ch: Channel, text: string): void {
    if (this.stopped) return;
    const completeAt = this.host.now();
    const speechEndAt = this.speechEndAt.get(ch);
    this.speechEndAt.delete(ch);
    const b = this.open.get(ch) ?? null;
    this.open.delete(ch);
    const spec = this.takeSpec(ch);
    const held = ch === "mic" && this.holdTurn;
    if (ch === "mic") this.holdTurn = this.holding;
    const clean = text.trim();
    if (!clean || (ch === "mic" && !held && this.isEcho(clean))) {
      spec?.abort.abort();
      if (b) this.closeBubble(b, "skipped", clean ? "echo" : "empty");
      return;
    }
    const r = this.resolve(ch, clean, held);
    const bubble = b ?? this.newBubble(r.via);
    bubble.speaker = r.speaker;
    bubble.via = r.via;
    if (!r.ok) {
      spec?.abort.abort();
      bubble.original = { lang: r.lang, text: clean };
      this.closeBubble(bubble, r.status, r.reason);
      this.host.log("interpret.detected", { language: r.lang, speaker: r.speaker, relayed: false, reason: r.reason });
      return;
    }
    if (r.setsOther) {
      this.other = r.setsOther;
      this.sendPair();
    }
    bubble.original = { lang: r.from, text: clean };
    this.host.log("interpret.detected", { language: r.from, speaker: r.speaker, via: r.via });
    let speculative: Job["speculative"] = "none";
    let stream: AsyncIterable<SparkStreamEvent> | null = null;
    let abort = new AbortController();
    if (spec) {
      if (spec.norm === normTranscript(clean) && spec.from === r.from && spec.to === r.to) {
        speculative = "hit";
        stream = spec.stream;
        abort = spec.abort;
      } else {
        speculative = "miss";
        spec.abort.abort();
      }
    }
    stream ??= new Eager(this.host.translate(this.request(clean, r.from, r.to), abort.signal));
    this.enqueue(bubble, stream, abort, speculative, { speechEndAt, completeAt, startAt: completeAt }, r.to);
  }

  /** Typed text while interpreting: the user's own words, for the other person. */
  typed(text: string): void {
    if (this.stopped) return;
    const clean = text.trim();
    if (!clean) return;
    const bubble = this.newBubble("text");
    bubble.speaker = "me";
    if (!this.other) {
      bubble.original = { lang: this.user, text: clean };
      return this.closeBubble(bubble, "skipped", "no_other_language");
    }
    bubble.original = { lang: this.user, text: clean };
    const abort = new AbortController();
    const now = this.host.now();
    const stream = new Eager(this.host.translate(this.request(clean, this.user, this.other), abort.signal));
    this.enqueue(bubble, stream, abort, "none", { startAt: now }, this.other);
  }

  /** A fixed line in Genita's voice (e.g. the voice-command confirmation); no bubble. */
  say(text: string): void {
    if (this.stopped) return;
    this.enqueue(null, fixedText(text), new AbortController(), "none", { startAt: this.host.now() }, this.user);
  }

  /** User tapped to stop Genita: cancel what is playing and what is queued. */
  bargeIn(): void {
    const all = [...(this.running ? [this.running] : []), ...this.queue];
    this.queue = [];
    for (const j of all) this.cancelJob(j, "client");
    if (all.length) {
      this.setPhase("interrupted");
      this.setPhase("listening");
    }
  }

  playbackDone(utteranceId: number): void {
    const t = this.speakTimers.get(utteranceId);
    if (!t) return;
    clearTimeout(t);
    this.speakTimers.delete(utteranceId);
    this.host.send({ type: "speaking", on: false, utteranceId });
    if (!this.running && !this.queue.length && this.speakTimers.size === 0) {
      this.playEndAt = Math.min(this.playEndAt, this.host.now());
      this.scheduleIdle();
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.bargeIn();
    this.stopped = true;
    for (const ch of [...this.specs.keys()]) this.takeSpec(ch)?.abort.abort();
    for (const t of this.speakTimers.values()) clearTimeout(t);
    this.speakTimers.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const b of this.open.values()) this.closeBubble(b, "cancelled");
    this.open.clear();
  }

  // ───────────────────────── decisions ─────────────────────────

  private resolve(ch: Channel, text: string, held = false): Resolved {
    const lang = detectLanguage(text, this.user);
    if (ch === "call") {
      const via: BubbleVia = "call";
      if (!lang) return { ok: false, speaker: "them", via, lang, status: "unknown", reason: "language_unclear" };
      if (lang === this.user) return { ok: false, speaker: "them", via, lang, status: "skipped", reason: "same_language" };
      return { ok: true, speaker: "them", via, from: lang, to: this.user, setsOther: this.other ? null : lang };
    }
    const forcedMe = held || this.holding || this.source === "call";
    const via: BubbleVia = held || this.holding ? "hold" : "voice";
    if (forcedMe) {
      if (!this.other) return { ok: false, speaker: "me", via, lang, status: "skipped", reason: "no_other_language" };
      return { ok: true, speaker: "me", via, from: this.user, to: this.other, setsOther: null };
    }
    if (!lang) return { ok: false, speaker: "unknown", via, lang, status: "unknown", reason: "language_unclear" };
    if (lang === this.user) {
      if (!this.other) return { ok: false, speaker: "me", via, lang, status: "skipped", reason: "no_other_language" };
      return { ok: true, speaker: "me", via, from: lang, to: this.other, setsOther: null };
    }
    // another language: the person in front of the user. The pair is fixed by
    // the first one heard; a third language is still passed on to the user.
    return { ok: true, speaker: "them", via, from: lang, to: this.user, setsOther: this.other ? null : lang };
  }

  private request(text: string, from: Lang, to: Lang): SparkRequest {
    return { instructions: buildTranslateInstructions(from, to), input: text, maxOutputTokens: 300 };
  }

  private isEcho(heard: string): boolean {
    const now = this.host.now();
    this.echo = this.echo.filter((e) => e.until > now);
    const live = this.running ? [this.running.spoken.join(" ")] : [];
    const recent = [...this.echo.map((e) => e.text), ...live, ...this.queue.map((j) => j.spoken.join(" "))].filter(Boolean);
    if (normTranscript(heard).replace(/\s/g, "").length < 3) return false;
    return recent.some((s) => containment(heard, s) >= ECHO_CONTAINMENT);
  }

  // ───────────────────────── speculation ─────────────────────────

  private considerSpeculation(ch: Channel, text: string, from: Lang, to: Lang): void {
    if (!this.speculate) return;
    const old = this.specTimers.get(ch);
    if (old) clearTimeout(old);
    this.specTimers.delete(ch);
    if (LOOKS_FINAL.test(text.trim())) return this.startSpeculation(ch, text, from, to);
    this.specTimers.set(
      ch,
      setTimeout(() => {
        this.specTimers.delete(ch);
        if (this.open.has(ch)) this.startSpeculation(ch, text, from, to);
      }, this.stableMs),
    );
  }

  private startSpeculation(ch: Channel, text: string, from: Lang, to: Lang): void {
    const norm = normTranscript(text);
    const cur = this.specs.get(ch);
    if (!norm || this.stopped || (cur && cur.norm === norm && cur.from === from && cur.to === to)) return;
    cur?.abort.abort();
    const abort = new AbortController();
    this.specs.set(ch, { norm, from, to, abort, stream: new Eager(this.host.translate(this.request(text, from, to), abort.signal)) });
  }

  private takeSpec(ch: Channel): Spec | null {
    const t = this.specTimers.get(ch);
    if (t) clearTimeout(t);
    this.specTimers.delete(ch);
    const s = this.specs.get(ch) ?? null;
    this.specs.delete(ch);
    return s;
  }

  // ───────────────────────── output queue ─────────────────────────

  private enqueue(bubble: Bubble | null, stream: AsyncIterable<SparkStreamEvent>, abort: AbortController, speculative: Job["speculative"], m: Metrics, to: Lang): void {
    const utteranceId = this.host.nextUtteranceId();
    if (bubble) {
      bubble.utteranceId = utteranceId;
      bubble.translation = { lang: to, text: "" };
      bubble.status = "translating";
      this.emit(bubble);
    }
    this.queue.push({ utteranceId, bubble, stream, abort, speculative, m, spoken: [], audioMs: 0, playStart: null });
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    while (this.queue.length && !this.stopped) {
      const job = this.queue.shift()!;
      this.running = job;
      try {
        await this.runJob(job);
      } finally {
        this.running = null;
      }
    }
    if (!this.stopped) this.scheduleIdle();
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const wait = Math.max(0, this.playEndAt + PLAYBACK_SLACK_MS - this.host.now());
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.running && !this.queue.length) this.setPhase("listening");
    }, wait);
  }

  private async runJob(job: Job): Promise<void> {
    const { utteranceId, m } = job;
    const signal = job.abort.signal;
    if (this.phase === "listening") this.setPhase("thinking");
    const splitter = new SentenceSplitter({ firstClauseMaxChars: 60 });
    const sentences: string[] = [];
    const waiter: { wake: (() => void) | null } = { wake: null };
    let sparkDone = false;
    let sparkError: unknown = null;
    const push = (list: string[]) => {
      for (const s of list) {
        const t = s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        if (!t) continue;
        m.firstSentenceAt ??= this.host.now();
        sentences.push(t);
        this.host.send({ type: "reply.delta", utteranceId, text: (sentences.length > 1 ? " " : "") + t });
        if (job.bubble?.translation) {
          job.bubble.translation.text = sentences.join(" ");
          this.emit(job.bubble);
        }
      }
      waiter.wake?.();
    };
    const producer = (async () => {
      try {
        for await (const ev of job.stream) {
          if (signal.aborted) return;
          if (ev.type === "text") {
            m.firstTokenAt ??= this.host.now();
            push(splitter.push(ev.delta));
          }
        }
        push(splitter.flush());
      } catch (err) {
        if (!signal.aborted) sparkError = err;
      } finally {
        sparkDone = true;
        waiter.wake?.();
      }
    })();

    const jobs: Eager<TtsChunk>[] = [];
    const startTts = (i: number) => {
      if (!jobs[i] && sentences[i]) jobs[i] = new Eager(this.host.tts(sentences[i], signal));
    };
    let ttsFailed = false;
    let ttsModel: string | null = null;
    for (let i = 0; ; i++) {
      while (!sentences[i] && !sparkDone && !signal.aborted) await new Promise<void>((r) => (waiter.wake = r));
      waiter.wake = null;
      if (signal.aborted || !sentences[i]) break;
      if (ttsFailed) {
        job.spoken.push(sentences[i]);
        continue;
      }
      if (this.host.say) {
        // device voice: the app speaks it; timing is an estimate (~70 ms per character, like the chat path)
        if (job.playStart === null) this.firstAudio(job);
        this.host.say(utteranceId, i, sentences[i], speechLang(sentences[i], job.bubble?.translation?.lang ?? ""));
        ttsModel = "device";
        job.audioMs += sentences[i].length * DEVICE_MS_PER_CHAR;
        this.playEndAt = job.playStart! + job.audioMs;
        job.spoken.push(sentences[i]);
        continue;
      }
      startTts(i);
      const sentenceOffset = job.audioMs;
      try {
        let first = true;
        for await (const chunk of jobs[i]) {
          if (signal.aborted) break;
          if (first) {
            first = false;
            startTts(i + 1);
          }
          if (!chunk.audio.length && !chunk.alignment) continue;
          ttsModel = chunk.model;
          if (job.playStart === null) this.firstAudio(job);
          const seq = this.host.nextSeq();
          const durationMs = pcmDurationMs(chunk.audio.length);
          this.host.send({
            type: "audio",
            utteranceId,
            seq,
            sentence: i,
            offsetMs: Math.round(job.audioMs),
            durationMs: Math.round(durationMs),
            sampleRate: PCM_SAMPLE_RATE,
            model: chunk.model,
            ...this.host.timing(chunk.alignment, sentenceOffset),
          });
          if (chunk.audio.length) {
            this.host.sendAudio(seq, chunk.audio);
          }
          job.audioMs += durationMs;
          this.playEndAt = job.playStart! + job.audioMs;
        }
        if (!signal.aborted) job.spoken.push(sentences[i]);
      } catch (err) {
        if (signal.aborted) break;
        ttsFailed = true;
        job.spoken.push(sentences[i]);
        this.host.send({ type: "error", code: "tts_unavailable", message: "Voice failed for this translation; showing text only", retryable: true });
        this.host.log("tts.error", { message: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
      }
    }
    await producer;
    if (signal.aborted) return;
    const full = job.spoken.join(" ").trim();
    if (sparkError || !full) {
      this.host.send({ type: "error", code: "spark_unavailable", message: "Could not translate that. Say it again?", retryable: true });
      this.host.log("spark.error", { message: sparkError instanceof Error ? sparkError.message.slice(0, 200) : "empty translation" });
    }
    if (job.bubble) {
      if (job.bubble.translation) job.bubble.translation.text = full;
      this.closeBubble(job.bubble, full ? "done" : "unknown", full ? undefined : "empty");
    }
    this.host.send({ type: "reply", utteranceId, text: full, emotion: "neutral", interpret: true, final: true });
    if (full) this.echo.push({ text: full, until: this.playEndAt + ECHO_TAIL_MS });
    const metrics = {
      utteranceId,
      model: SPARK_MODEL,
      ttsModel,
      speechEndToCompleteMs: m.speechEndAt && m.completeAt ? Math.round(m.completeAt - m.speechEndAt) : null,
      replyStartToFirstTokenMs: m.firstTokenAt ? Math.round(m.firstTokenAt - m.startAt) : null,
      replyStartToFirstSentenceMs: m.firstSentenceAt ? Math.round(m.firstSentenceAt - m.startAt) : null,
      firstSentenceToFirstAudioMs: m.firstSentenceAt && m.firstAudioAt ? Math.round(m.firstAudioAt - m.firstSentenceAt) : null,
      speechEndToFirstAudioMs: m.speechEndAt && m.firstAudioAt ? Math.round(m.firstAudioAt - m.speechEndAt) : null,
      stt_ms: m.speechEndAt && m.completeAt ? Math.round(m.completeAt - m.speechEndAt) : null,
      llm_ms: m.firstTokenAt ? Math.round(m.firstTokenAt - m.startAt) : null,
      tts_ms: m.firstSentenceAt && m.firstAudioAt ? Math.round(m.firstAudioAt - m.firstSentenceAt) : null,
      first_audio_ms: m.speechEndAt && m.firstAudioAt ? Math.round(m.firstAudioAt - m.speechEndAt) : null,
      audioMs: Math.round(job.audioMs),
      speculative: job.speculative,
    };
    this.host.send({ type: "turn.metrics", ...metrics });
    this.host.log("turn.answered", {
      mode: "interpret",
      stt_ms: metrics.stt_ms,
      llm_ms: metrics.llm_ms,
      tts_ms: metrics.tts_ms,
      first_audio_ms: metrics.first_audio_ms,
      utteranceId,
    });
    if (job.bubble) this.host.log("interpret.relayed", { ms: metrics.speechEndToFirstAudioMs, speaker: job.bubble.speaker, from: job.bubble.original.lang, to: job.bubble.translation?.lang, speculative: job.speculative });
    // speaking off once this utterance should have finished playing
    if (job.playStart !== null) {
      const end = job.playStart + job.audioMs + PLAYBACK_SLACK_MS;
      const t = setTimeout(() => {
        this.speakTimers.delete(utteranceId);
        this.host.send({ type: "speaking", on: false, utteranceId });
      }, Math.max(0, end - this.host.now()));
      this.speakTimers.set(utteranceId, t);
    }
  }

  private firstAudio(job: Job): void {
    const now = this.host.now();
    job.m.firstAudioAt = now;
    job.playStart = Math.max(now, this.playEndAt);
    this.setPhase("speaking");
    if (job.bubble) {
      job.bubble.status = "speaking";
      this.emit(job.bubble);
    }
    const on = () => this.host.send({ type: "speaking", on: true, utteranceId: job.utteranceId, emotion: "neutral" });
    const wait = job.playStart - now;
    if (wait > 20) setTimeout(() => !job.abort.signal.aborted && on(), wait);
    else on();
  }

  private cancelJob(job: Job, reason: "client"): void {
    if (job.abort.signal.aborted) return;
    job.abort.abort();
    const t = this.speakTimers.get(job.utteranceId);
    if (t) clearTimeout(t);
    this.speakTimers.delete(job.utteranceId);
    this.host.send({ type: "utterance.cancelled", utteranceId: job.utteranceId, reason });
    if (job.playStart !== null) this.host.send({ type: "speaking", on: false, utteranceId: job.utteranceId });
    if (job.bubble) this.closeBubble(job.bubble, "cancelled");
    this.playEndAt = Math.min(this.playEndAt, this.host.now());
  }

  // ───────────────────────── events ─────────────────────────

  private setPhase(p: Phase): void {
    if (p === this.phase && p !== "interrupted") return;
    this.phase = p === "interrupted" ? this.phase : p;
    this.host.send({ type: "state", state: p });
  }

  private sendPair(): void {
    this.host.send({ type: "interpret.pair", user: this.user, other: this.other, source: this.source, by: this.otherFixed ? "client" : "auto", ...(this.app ? { app: this.app } : {}) });
  }

  private newBubble(via: BubbleVia): Bubble {
    return { id: ++this.bubbleSeq, speaker: "unknown", via, status: "hearing", original: { lang: null, text: "" }, translation: null };
  }

  private closeBubble(b: Bubble, status: BubbleStatus, reason?: BubbleReason): void {
    b.status = status;
    if (reason) b.reason = reason;
    this.emit(b);
  }

  private emit(b: Bubble): void {
    const e: InterpretBubbleEvent = { type: "interpret.bubble", bubbleId: b.id, speaker: b.speaker, via: b.via, status: b.status, original: { ...b.original } };
    if (b.translation) e.translation = { ...b.translation };
    if (b.utteranceId !== undefined) e.utteranceId = b.utteranceId;
    if (b.reason) e.reason = b.reason;
    this.host.send(e);
  }
}
