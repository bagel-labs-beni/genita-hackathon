/**
 * One realtime conversation: app socket ↔ Muse Transcribe ↔ Muse Spark ↔
 * the app's on-device voice (`say`, device mode) or Meta SeamlessM4T v2.
 * Turn-taking decisions live in turnMachine.ts (pure); this
 * class only executes their effects and moves bytes. Protocol: PROTOCOL.md.
 */
import { getOps, type OpsLimits } from "../ops/limits.ts";
import type { Config } from "../config.ts";
import type { TurnGate } from "../auth/judge.ts";
import type { AsrEvent } from "../meta/transcribe.ts";
import type { WebSearch } from "../finds/webAnswer.ts";
import { SPARK_MODEL, type InputMessage, type SparkRequest, type SparkStreamEvent, type ContentPart } from "../meta/spark.ts";
import type { TtsChunk, TtsRequest } from "../tts/types.ts";
import { pcmDurationMs, PCM_SAMPLE_RATE } from "../tts/types.ts";
import { avoidRepeatedOpener, recentOpeningWords, dropRepeatedName, buildInstructions, buildInterpretInstructions, type PersonaCard, type UserProfile } from "../prompt/persona.ts";
import { SentenceSplitter } from "../text/sentences.ts";
import { clauseExpression, parseTaggedSentence, type Expression } from "../text/tags.ts";
import { NarrationJudge, type NarrationDecision } from "../text/toolNarration.ts";
import { isMostlyHangul, speechLang } from "../text/language.ts";
import { HOLD_LINE, RECOVER_LINE, resolveSpeaker, seamlessLang, SEAMLESS_MODEL } from "../tts/seamless.ts";
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
import { MEMORY_START_BUDGET_MS, within, type MemoryRetryState, type ThreadState , replyMemoryTools } from "../memory/call.ts";
import type { Memory } from "../memory/repository.ts";
import type { CompanionFaceResolver } from "../memory/photos.ts";
import { FindsRunner, type FindsDeps } from "../finds/runner.ts";
import { isOutfitAsk, isProductAsk } from "../finds/intent.ts";
import { inhalePcmBase64 } from "../watch/breath.ts";
import { WatchController, type WatchSink } from "../watch/watch.ts";
import { PerceptionController } from "../perception/controller.ts";
import { detectRename } from "./rename.ts";
import type { CallStart, VoiceUpdate } from "../personalize/service.ts";
import type { CallTurn } from "../personalize/extract.ts";
import { ASK_TURNS, replyAsks } from "../personalize/unknowns.ts";
import { mightBeCorrection } from "../personalize/corrections.ts";
import { taskHint } from "../convo/taskHints.ts";
import { ageSays, foldAge, isMinor, MINOR_LINE, NO_AGE, type AgeSay } from "../convo/minorBoundary.ts";
import { cameraOffHint } from "../convo/cameraAsk.ts";
import { unbackedPast } from "../convo/pastGuard.ts";
import { forgetInCall, forgetKeyText, isAnaphoricForget, isCorrection, isRememberRequest, pointedLine } from "../convo/forgetInCall.ts";
import { avoidKeys, forgetTarget, isForgetRequest, mentionsAvoided, scrubHistory, type Removed } from "../personalize/forgotten.ts";
import { isForgetRequest as isMemoryForgetRequest } from "../memory/extract.ts";
import { localTimeLine } from "../personalize/knows.ts";
import type { UnknownItem } from "../personalize/story.ts";
import type { TasteLine } from "../personalize/reasons.ts";
import { backchannelOn, convoV1, englishOnly, eotHoldOn, initiativeOn } from "../convo/flags.ts";
import { Backchannel } from "../convo/backchannel.ts";
import { EOT, eotTuning, joinSegments, judgeEndOfTurn, type EotKind, type EotVerdict } from "../convo/endOfTurn.ts";
import { addressUser, thirdPersonCouldBeUser, fallbackLine, guardSentence, neverSpoken, NO_ANSWER_LINE, LOST_LINE, UPSTREAM_RETRY_MS, realCrisisSignal, mayBeSelfHarm, nameAsYou, type GuardClass } from "../convo/guard.ts";
import { isInterjectionOnly } from "../text/toolNarration.ts";
import { daySeed, openerBlock, openerKind, profileHooks } from "../convo/opener.ts";
import { mentionsProfile, moodFrom, moodLine, turnHints, type Mood } from "../convo/rhythm.ts";
import { carriedMood, moodScaledIntensity, saveCallMood } from "../convo/callMood.ts";
import { holdsSteady, personaBaseline, restingFace } from "../convo/moodState.ts";
import { forgetOpenerTopics, pickOpenerTopic, storedTopics } from "../convo/openerTopics.ts";
import { InitiativeGovernor, initiativeBlock, initiativeInput, type InitiativeSource } from "../convo/initiative.ts";
import { cueRhythm } from "../convo/rhythm.ts";
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
  /** Chelsea 11/4 greeting (a): the name opener first (server.ts sets it from GENITA_GREET_OPENER, default on) */
  greetOpener?: boolean;
  /** Test-only clock seam for the delayed first greeting. Returns a cancellation function. */
  greetScheduler?: (fn: () => void, ms: number) => () => void;
  /** Server voice (Seamless): cache a speaker's filler clauses when a call starts with it */
  voicePrefetch?: (speaker: number) => void;
  /** boot only (main.ts): prefetch the curated speakers so their cold-GPU lines are on disk */
  voiceWarm?: () => void;
  /** Shared by all calls to the process's voice GPU (not one gate per session). */
  voiceSeats?: VoiceSeats;
  /** Identity is assigned by the authenticated upgrade, never by start.user. */
  userId?: string;
  /** D41 per-account daily turn cap (judge demo accounts only); unset = no cap. */
  turnGate?: TurnGate;
  ops?: OpsLimits;
  /** null: shared-token dev identity has no persisted user row. */
  turnUserId?: string | null;
  /**
   * Handoff: this account's turns from its other live call, or from a call that ended in the last few minutes
   * (server.ts). With server memory on, `start.history` is otherwise ignored, so the Mac lost the iPhone's turns.
   */
  priorTurns?: (revision: number) => HistoryItem[] | null;
  /** Codex #640 r13: what this account's other / just-ended calls said about their age, held by the server and handed
   * over at start, independent of a slow memory read or history restore */
  accountAge?: () => AgeSay;
  /** Session memory: the thread those turns belong to (same conversation on the next device), read right after priorTurns */
  priorThread?: (revision: number) => ThreadState | null;
  /** same-device return visit: the last lines of the call the user just hung up (server.ts), read right after priorTurns */
  lastCall?: () => { turns: HistoryItem[]; threadId: string | null; covered: number } | null;
  /** Server handoff ordering: actual history writes, never socket open/close or a copied seed. */
  onHistoryChange?: (role: HistoryItem["role"]) => void;
  memory?: MemoryService;
  photos?: UsPhotoService;
  resolveCompanionFace?: CompanionFaceResolver;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** result cards (F10); unset = spoken answers only */
  finds?: FindsDeps;
  /** F2-L26 rename by voice: persist the companion's new name (server.ts → prep store); unset = this call only */
  renameCompanion?: (userId: string, name: string) => Promise<unknown>;
  /** Demo S4: iPhone calls only — the account's Mac app is open, so an outfit ask can move to the Mac's camera */
  macNearby?: () => boolean;
  /** lane 개인화 (src/personalize/service.ts): server profile, first-call asks, voice corrections, post-call growth */
  personalize?: SessionPersonalize;
  /** server.ts: this call continues the account's conversation from the other device (memory-independent; P1 11/3) */
  continuesCall?: () => boolean;
  /** resolves true once this call's device may play sound (handoff owner, lease over), false if it won't soon */
  untilPlayable?: () => Promise<boolean>;
  /**
   * Same presence on every device (11/3): the voice saved on this account's companion (prep store). It wins over
   * the start message's voice, so the iPhone and the Mac always speak with one voice. null/unset = the client's.
   */
  companionVoiceId?: () => Promise<string | null | undefined>;
  /**
   * AU-53: the name saved on this account's companion (prep store; a voice rename writes it there). It wins over
   * start.persona.name, so a device with a cached older name still calls the companion by its current one.
   */
  companionName?: () => Promise<string | null | undefined>;
};

/** Demo S5 (agreed with the convo lane 11/3): the product-ask turn's reply while the search runs in the background. */
export const PRODUCT_REACTION_LINE =
  "A shopping search for this is already running in the background and its card will appear on its own. Reply with ONE short sentence (under 10 words): a natural, in-character reaction to what they asked or what you see (taste, color, how it goes with the outfit); talk to them as you. Never say you are searching, looking, checking or pulling anything up, no 'let me…'; don't name products, stores, prices or links.";
/** The slice of the personalize service a call uses (structural, so tests can fake it). */
export type SessionPersonalize = {
  startCall(userId: string, opts?: { plan?: boolean }): Promise<CallStart | null>;
  /** watch together attached before the question: not a new conversation after all (give the count back) */
  unplanCall?(userId: string, item: string | null): Promise<void>;
  /** "Forget all of this" was the last profile event in this process (AU-92): a failed / timed-out read uses no profile */
  isForgotten?(userId: string): boolean;
  /** bumped by "Forget all of this": a profile read from before it is never applied */
  generation?(userId: string): number;
  voiceCorrection(userId: string, line: string, lastAssistant?: string, signal?: AbortSignal, asked?: UnknownItem | null, since?: number): Promise<VoiceUpdate | null>;
  endCall(userId: string, turns: CallTurn[], asked: string | null, startedAt?: string): Promise<number>;
  /** Knows-Me S1: the user cut two long replies short → observed "short replies" line; null = not saved */
  noteShorter?(userId: string): Promise<{ text: string; fields: string[]; profile: string } | null>;
};
/** Knows-Me S1 (GENITA_BARGE_SHORTER=0 turns it off): cut off this many times mid-reply → shorter replies */
const SHORTER_AFTER_CUTS = 2;
/** the call starts with the app's profile if the store takes longer than this */
const STARTCALL_TIMEOUT_MS = 1500;
/** at most this many correction checks per call, one at a time */
const MAX_CORRECTION_CHECKS = 12;

/** A slow prep store never holds up `ready`: past this the client's voice stays. */
const COMPANION_VOICE_WAIT_MS = 800;
/** waits before each retry of a clause the voice service failed (a busy GPU frees a slot in ~0.5 s; a cold one takes longer) */
const TTS_RETRY_MS = [400, 1500];
/** first-byte budget of a reply's last retry while nothing of it was heard: a cold voice GPU starts in 25-40 s */
const COLD_WAIT_MS = 40_000;

/** Demo S4: said once per call, on the first outfit ask while the Mac app is open. */
export const SUGGEST_MAC_LINE =
  "The user's Mac is open and its bigger camera can see their whole outfit. Before giving outfit advice, warmly ask them to move this call to their Mac (Move to Mac in the menu) so you can see the whole outfit. Keep it to one or two short sentences.";

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
  /**
   * AU-49: when the app's queued speech ends, on the server clock. The app plays each clip at
   * max(its queue end, arrival), so a gap between clips (a line, a web search, then the answer)
   * pushes the end out; audioMs alone does not count the gap.
   */
  playEnd: number;
  doneTimer: NodeJS.Timeout | null;
  /** device mode: characters sent in `say` (drives the speaking estimate) */
  chars: number;
  /** server mode: GPU capacity or a voice failure sent this reply to the app as `say` */
  fellBack: boolean;
  /** Chelsea 11/3: the sources card of a web-searched answer, shown once the answer has played (never after a barge-in) */
  webAnswer?: (() => void) | null;
};

/** server clock (ms) for the latency breakdown; logged with turn.answered as `stages` */
type TurnMetrics = { speechEndAt?: number; completeAt?: number; lastPartialAt?: number; specStartAt?: number };
/** lang = the language the reply is written in (interpretation: the target) */
type Built = { req: SparkRequest; interpret: boolean; detected: { from: string; to: string } | null; images: string[]; lang: string; suggestMac?: boolean };
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
/** AU-49: the gap-aware playback end never holds a reply in "speaking" longer than this from now */
const PLAYBACK_MAX_WAIT_MS = 60_000;
/** longest a ready reply waits for the user to stop talking before its first sound (ASR lost a speechEnd) */
const HOLD_MAX_MS = 3000;
/** CA-14: a held turn whose resumed segment never got its final (ASR dropped) commits after this much ASR silence */
const HOLD_WATCHDOG_MS = 5000;
/** re-open vendor connections when the user starts a turn after this much quiet (keep-alive is 60 s) */
const WARM_AGAIN_MS = 45_000;
const DEVICE_MS_PER_CHAR = 70;
const DEVICE_SLACK_MS = 1500;
const DEVICE_MAX_MS = 60_000;
const ASR_RETRY_MS = 2000;
/** F8: interpretation always hears both sides, even when chat listens in English only (prod GENITA_ASR_LANGUAGES=English) */
const INTERPRET_ASR_LANGUAGES = ["English", "Korean"];

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
/** Codex #585 r2 P1: a last opener topic the user since asked to forget is never named, even as "don't open on X" */
function lastSafeHook(recent: string[], removed: Removed[]): string | null {
  const last = recent.at(-1) ?? null;
  return last && removed.length && mentionsAvoided(last, avoidKeys(removed)) ? null : last;
}
/** AU-44: notes-based follow-up greetings, like the memory opener (memory/service.ts revisitGapHours) */
const NOTES_OPENER_GAP_MS = 6 * 3_600_000;
const NOTES_CALLBACK_MS = 10 * 60_000;
/** hold cap: the longest the first sound waits on a held line (a pre-tool preamble) before a short beat */
const HOLD_BEAT_MS = 1500;
/** speech end → first sound cap (GENITA_HOLD_CAP_MS, 0 = off) */
export function holdCapMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.GENITA_HOLD_CAP_MS ?? 2200);
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : 2200;
}
/**
 * Hold beats: audio only (never in captions, the reply text or history), short, and never the same one twice in a
 * row in a call — "Hmm" is 1 of 6 (QA item 16: replies opening with "Hmm" ≤ 1/6; Chelsea: no Hmm/Oh repeats).
 */
export const HOLD_BEATS = ["<warm> Mm.", "<curious> Ooh.", "<warm> Yeah.", "<warm> Okay, so.", "<curious> Hmm.", "<warm> Mm-hm."];
/** a greeting / initiative sentence that is plainly a question (QA P3: it ended with "." 1/2) */
const EXPLICIT_REMEMBER = /\b(?:remember|don'?t forget|keep in mind|note) (?:that|this|i|my|me)\b/i;
/** the backchannel cue's echo in a transcript ("mm-hm", "mhm", "mm"), never a real word */
export function stripCueEcho(text: string): string {
  return text.replace(/(^|[\s,])(?:m+-?h+m+|mh+m+|m{2,})[.,!?…]*(?=\s|$)/gi, "$1").replace(/\s{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
}
/** AI sweep 11/3 [P1 safety]: a real crisis reply must point to real help now */
export const CRISIS_HELP_LINE = "<sad> Please reach out right now: call or text a crisis line, like 988 in the US, or your local emergency number, or someone you trust. I'm right here.";
/** real help outside the call — "reach out to me" is not one (Codex #423 final P1) */
const HELP_POINTER = /\b(?:988|911|112|999|nine eight eight|nine one one|crisis (?:line|text line)|hotline|emergency (?:services|number|room)|someone you trust|samaritans|lifeline|a doctor|a counselor)\b/i;
/** lead 11/4 (intel eval crisis-means: 1/5 said "emergency services or a crisis helpline" with no number): a real number */
export const CRISIS_NUMBER_LINE = "<sad> You can call or text 988 any time in the US, or your local emergency number.";
/** what a real crisis reply still needs: the whole help line (no pointer at all), just the number line, or nothing */
// Codex r8: only explicit crisis services earn the number line (not "someone you trust", not a generic hotline)
export function crisisFollowUp(said: string[]): string | null {
  // Codex r10: main's rule only (no help pointer at all → the help line); the number comes from the prompt's "988 in the
  // US" (sweep: the model said it 20/20), so no new forced path versus main
  return said.some((x) => HELP_POINTER.test(x.replace(/[‘’ʼ]/g, "'").replace(SAID_I_CANT, " "))) ? null : CRISIS_HELP_LINE;
}
/** Codex r13: "No, I can't call a crisis line for you." names a line but points nowhere; that clause earns no pass */
const SAID_I_CANT = /\b(?:(?:no|nope|sorry),?\s*)?i\s*(?:can't|cannot|can not|won't|couldn't|am not able to|'m not able to|am unable to|'m unable to|don't have)\b[^,.;!?]*/gi;
/**
 * The follow-up for this turn: on a real signal (detector) the full rule above; otherwise, when the user's words come
 * near harm AND the model itself pointed to help (it judged it a crisis), just the number if it left one out. A
 * detector miss ("thinking of ending everything tonight") still ends with a number; an idiom with no help pointer gets
 * nothing (integration 11/4: number 20/20 on real lines, forced 988 0 on ordinary ones).
 */
export function crisisFollowUpFor(userText: string, said: string[]): string | null {
  // Codex r7: no number line on a detector miss (the sweep used it 0×; the prompt's "988 in the US" gives the number)
  return realCrisisSignal(userText) ? crisisFollowUp(said) : null;
}
const QUESTION_START = /^(?:(?:hey|hi|okay|ok|so|wait|yo)\b[^,.!?]{0,20},?\s*)?(?:so,?\s*)?(?:(?:how|what|when|where|who|why|which)(?:'s|'re|'d| is| am| are| was| were| did| do| does| has| have| had| will| would| can| could| should)\b|(?:did|do|does|are|is|was|were|have|has|can|could|will|would) (?:you|it|they|we|that|this|he|she)\b|you (?:feeling|ready|nervous|excited)\b)/i;
/** Demo S4 (QA P2: Spark ignored SUGGEST_MAC_LINE 1/4 and gave outfit advice in 8.5 s): the iPhone's outfit ask with the
 * Mac open always gets this line, at once (no Spark); rotates by utterance */
const SUGGEST_MAC_TAIL = "<happy> Can you move our call to your Mac? I want to see your whole outfit.";
export const SUGGEST_MAC_REPLIES = [
  "<excited> Of course! Can you move our call to your Mac? I want to see your whole outfit.",
  "<happy> Ooh, yes. Move our call to your Mac real quick? I want to see the whole fit.",
  "<teasing> Okay, outfit emergency. Can you move our call to your Mac? I need to see all of it.",
];

/**
 * Demo S4: pass Spark's suggest-turn reply through once it names the Mac; if two sentences (or 160 chars, or 2.5 s
 * of text) go by without it, or the reply ends without it, say the fixed line instead and stop reading Spark.
 * Upstream errors still throw (a failed reply keeps the suggestion for the retry).
 */
export async function* mustNameMac(src: AsyncIterable<SparkStreamEvent>, line: string, now: () => number = Date.now, waitMs = 2500): AsyncGenerator<SparkStreamEvent> {
  let buf = "";
  let passing = false;
  let firstTextAt: number | null = null;
  const fixed = function* (): Generator<SparkStreamEvent> {
    yield { type: "text", delta: line };
    yield { type: "done", responseId: null, text: line, status: "completed" };
  };
  const it = src[Symbol.asyncIterator]();
  const STALL = Symbol("stall");
  try {
    for (;;) {
      let res: IteratorResult<SparkStreamEvent> | typeof STALL;
      if (!passing && firstTextAt !== null) {
        // a stalled stream after the first words must not hold the turn (Codex #423 P2): the wait runs on its own clock
        const left = waitMs - (now() - firstTextAt);
        if (left <= 0) { yield* fixed(); void it.return?.(); return; }
        let timer: ReturnType<typeof setTimeout> | undefined;
        res = await Promise.race([it.next(), new Promise<typeof STALL>((r) => { timer = setTimeout(() => r(STALL), left); })]);
        clearTimeout(timer);
        if (res === STALL) { yield* fixed(); void it.return?.(); return; }
      } else res = await it.next();
      if (res.done) return;
      const ev = res.value;
      if (passing) { yield ev; continue; }
      if (ev.type === "text") {
        buf += ev.delta;
        firstTextAt ??= now();
        if (/\bMac\b/i.test(buf)) { passing = true; yield { type: "text", delta: buf }; continue; }
        const sentences = (buf.replace(/<[^>]*>|\[[^\]]*\]/g, " ").match(/[.!?](?:\s|$)/g) ?? []).length;
        if (sentences >= 2 || buf.length > 160 || now() - firstTextAt > waitMs) { yield* fixed(); void it.return?.(); return; }
        continue;
      }
      if (ev.type === "done") {
        // an incomplete reply keeps its own ending (the suggestion stays unused for the retry, Codex P2 round 3)
        if (/\bMac\b/i.test(buf) || ev.status !== "completed") { if (buf) yield { type: "text", delta: buf }; yield ev; } else yield* fixed();
        return;
      }
      yield ev;
    }
  } catch (err) {
    // a stream cut mid-reply behaves as before: what was written so far is said, then the error (Codex P2 round 2)
    if (!passing && buf) yield { type: "text", delta: buf };
    throw err;
  }
}
/** #387 follow-up: said instead of a reply whose only sentence was the question watch together took back */
const WATCH_ASK_FALLBACK = "<happy> Ooh, okay. Let's watch.";
const GREET_PROMPT = "The call just connected. Greet the user.";
/** the call came back after a drop (same device, or the other device after a gap): no full greeting, one short line */
export const RECONNECT_LINE = "Sorry, we got cut off — where were we?";
/**
 * Greeting option (a), Chelsea 11/4 (GENITA_GREET_OPENER=0 turns it off): the call's first words are
 * said at once from the user's name ("Hey, Summer!"); Spark's greeting continues right after it (first sound ~0.4 s
 * instead of Spark's first token, ~2.3 s on prod).
 */
export function greetOpenerOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GENITA_GREET_OPENER !== "0";
}
/** Chelsea 11/4: 3–4 variants, never the same every time; "Hey!" family without a name */
export const GREET_OPENERS = ["Hey, {name}!", "Hi, {name}!", "Oh hey, {name}!", "Hey hey, {name}!"];
export const GREET_OPENERS_NO_NAME = ["Hey!", "Hi!", "Oh hey!", "Hey there!"];
export function pickGreetOpener(name: string | undefined, rand: () => number = Math.random): string {
  const first = (name ?? "").trim().split(/\s+/)[0]?.slice(0, 40) ?? "";
  const pool = first ? GREET_OPENERS : GREET_OPENERS_NO_NAME;
  return pool[Math.floor(rand() * pool.length) % pool.length].replace("{name}", first);
}
/** a leading "Hey…," / "Hi Summer!" the model still wrote after the opener was said */
const LEADING_HELLO = /^(\s*(?:(?:<[^>]*>|\[[^\]]*\])\s*)*)(?:oh,?\s+)?(?:hey|hi+|hello|heya|hiya)\b(?:\s+(?:there|you))?(?:,?\s+[\p{L}'-]+)?\s*[,!.]+\s*/iu;
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
  /** option (a): the opener said before this call's greeting (set when the greeting request is built) */
  private greetOpener: string | null = null;
  /** conversation engine v1 (GENITA_CONVO_V1, read once per call) */
  private readonly v1 = convoV1();
  /** ms of the user's last message in an earlier call (memory state); null = never; undefined = unknown */
  private lastMessageAt: number | null | undefined = undefined;
  /** #341: profile things recent greetings opened on (oldest → newest); undefined = not read yet */
  private openerRecent: string[] | undefined = undefined;
  /** #344: where this call's mood starts (the last call's ending mood, faded); null = the persona's baseline */
  private startMood: Mood | null = null;
  /** #344: where this companion's mood rests (moodState.ts, from its traits / speaking style) */
  private get moodBase(): Mood {
    return personaBaseline(this.persona);
  }
  /** the mood so far this call (user lines folded on the start mood, decaying toward the persona baseline) */
  private callMood(extra?: string): Mood {
    const lines = this.history.filter((h) => h.role === "user").map((h) => h.text);
    const base = this.moodBase;
    return moodFrom(extra ? [...lines, extra] : lines, this.startMood ?? base, base);
  }
  /** the companion speaks first mid-call (src/convo/initiative.ts); null = off for this call */
  private initiative: InitiativeGovernor | null = null;
  private initiativeTimer: NodeJS.Timeout | null = null;
  private initiativeBusy = false;
  /** the pending initiative turn (its input is INITIATIVE_INPUT; never a user line or a memory source) */
  private cueTurn: { source: InitiativeSource; block: string; input: string } | null = null;
  /** memory lines already offered to an initiative this call */
  private offeredThreads = new Set<string>();
  /** K-test 11/3: personal things this call brought up unprompted (opener hook, a follow-up, the GK-1 question, a
   *  profile taste said without the user going there); MENTION_RULE's budget is one per call */
  private personalUsed = 0;
  /** this call's number for the account (personalize growth.calls), for the engine's closeness line (P1) */
  private callNumber: number | undefined;
  /** P1 #345: "mm" / "yeah" mid-turn on a long user turn (GENITA_BACKCHANNEL=1); the app plays its own clip */
  private backchannel: Backchannel | null = backchannelOn()
    ? new Backchannel({
        now: () => this.now(),
        // CA-14: a turn the end-of-turn hold keeps open is still the user's turn
        stillListening: () => this.mode === "chat" && !this.interp && !this.watch && !this.reply && this.turn.phase === "listening" && this.userTurnOpen(),
        send: (kind) => void this.sendBackchannel(kind),
      })
    : null;
  /** perception lane (camera face reading, GENITA_PERCEPTION): read-only, assigned by its message hook */
  perception: PerceptionSource | null = null;

  /**
   * P1 #345: the cue in the companion's own voice ("Mm-hm." / "Yeah." are prefetched fillers, so no GPU wait) rides
   * the event as base64 PCM; the app plays it beside the reply queue and silences its uplink for it + 300 ms.
   * Device voice: no audio (the app plays nothing). Sent only if it is still the user's turn after the lookup.
   */
  /** bumped on every speech start / partial / end: a cue whose lookup outlived its pause is dropped (Codex #475 P2) */
  private bcGen = 0;
  /** a cue played during this user turn: a stray "mm-hm" in its transcript is the cue's echo, not the user */
  private cuedTurn = false;
  /**
   * CA-14 (11/4): a Transcribe final that looked unfinished ("…and then he started."), held until `timer` commits it
   * (src/convo/endOfTurn.ts). The user resuming clears the timer and the next final is joined to `text`. Never set
   * in interpretation, while a reply runs, or with the mic off. null = no held turn.
   */
  private held: { text: string; turnId: number; kind: EotKind; since: number; segments: number; timer: NodeJS.Timeout | null } | null = null;

  /**
   * CA-14: a chat segment started and its final has not been handled yet (the user is talking, or Transcribe is still
   * closing it), or a final waits on the watch echo check. Either way a final is on its way and re-decides a held turn,
   * so neither the silence clock nor muting commits it first (Codex r2). lastAsrAt: a watchdog for a lost final.
   */
  private segmentOpen = false;
  /** the open segment's latest partial; a watchdog commit keeps it, and then that segment's late final is dropped */
  private segmentPartial = "";
  private dropLateFinal = false;
  /** bumped on a proximity handoff: an echo check that started before it never completes a turn */
  private asrEpoch = 0;
  /** set by stopForHandoff; the server feeds this call's mic again only once it owns the sound (mayPlay) */
  private handedOff = false;
  private echoPending = 0;
  private lastAsrAt = 0;
  /** the user is talking, or paused inside a turn the end-of-turn hold keeps open */
  private userTurnOpen(): boolean {
    return this.turn.userSpeaking || this.held !== null;
  }

  private async sendBackchannel(kind: "mm" | "yeah"): Promise<void> {
    const gen = this.bcGen;
    let audio: string | undefined;
    if (this.tts === "server" && !this.voiceOverflow) {
      try {
        const parts: Buffer[] = [];
        for await (const c of this.deps.tts({ voiceId: this.voiceId, text: "Mm-hm.", emotion: null, model: SEAMLESS_MODEL, signal: AbortSignal.timeout(800), lang: "en-US" })) if (c.audio.length) parts.push(c.audio);
        const pcm = Buffer.concat(parts);
        if (pcm.length && pcm.length <= 24_000 * 2 * 1.5) audio = pcm.toString("base64");
      } catch { /* no cue audio: the event still goes (the app plays nothing) */ }
    }
    if (this.closed || this.mode !== "chat" || this.reply || !this.userTurnOpen() || gen !== this.bcGen) return;
    this.client.sendJson({ type: "backchannel", kind, ...(audio ? { audio } : {}) });
    // the app sends the uplink untouched; whatever of the cue survives echo cancellation is dropped from this turn
    this.cuedTurn = true;
    this.log("convo.backchannel", { kind, audio: !!audio });
  }
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
  /** over the seat cap with the device fallback off: logged once per stretch, the call keeps the server voice */
  private seatsOver = false;
  /** the account's saved companion voice (same presence), looked up as the socket opens */
  private readonly ownedVoice: Promise<string | null>;
  /** AU-53: the stored companion name, looked up as the socket opens (bounded) */
  private readonly ownedName: Promise<string | null>;
  private history: HistoryItem[] = [];
  private historyRevision: number | null = null;
  private recentReplies: string[] = [];
  private frames: Frames | null = null;
  /** Demo S4: the move-to-Mac suggestion was made in this call */
  private macSuggested = false;
  private asr: AsrLike | null = null;
  /** the languages `asr` was opened with (joined), so a mode switch can tell whether it must reopen */
  private asrLanguagesKey: string | null = null;
  /** set while `start` runs: `mode` only becomes "interpret" in enterInterpret, after the mic ASR is opened */
  private startingMode: Mode | null = null;
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
  /** first call after onboarding (D21 greetAfterMs): the greeting's Spark answer starts at once, played when the window ends */
  private preGreet: { built: Built; stream: Eager<SparkStreamEvent>; abort: AbortController; confirm: () => void; memoryRetry: MemoryRetryState } | null = null;
  private watch: WatchController | null = null;
  private specTimer: NodeJS.Timeout | null = null;
  private specCheck = 0;
  private bargeTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  private lastWarmAt = -Infinity;
  /** next hold beat (rotates through HOLD_BEATS, so two in a row are never the same) */
  private beatIx = 0;
  /** replies whose first sound waits for the user to stop talking */
  private quietWaiters: (() => void)[] = [];
  private metrics: TurnMetrics = {};
  private bargeCfg: { bargeInMinMs: number; bargeInMinWords: number };
  private readonly client: ClientSink;
  private finds: FindsRunner | null = null;
  /** FD-01: the in-flight read of a card named by find.focus; a typed turn waits for it */
  private readonly focusLoads = new Set<Promise<void>>();
  /** barge_in count: a typed turn that waited for a card and was interrupted meanwhile is dropped (Codex r4) */
  private bargeSeq = 0;
  /** typed questions so far: one that waited for a card is dropped when a newer one came meanwhile (Codex r6) */
  private textSeq = 0;
  /** lane 개인화: this call's one still-to-confirm question (first ASK_TURNS user turns) */
  private ask: { line: string; item: string; topic: UnknownItem | null; asked: boolean } | null = null;
  /** the companion just asked this call's question: the next user line is checked for the answer */
  private awaitingAnswer: UnknownItem | null = null;
  private userTurns = 0;
  private callStartedAt: string | null = null;
  /** profile lines the user removed (personalize): kept out of memory, notes and handed-off turns */
  private removedLines: Removed[] = [];
  /** resolves when the running correction check ends (a "forget that …" waits for it instead of being skipped) */
  private correctionDone: Promise<void> = Promise.resolve();
  /** this call was counted as a new call by personalize (not a handoff) */
  private callPlanned = false;
  /** the question watch together took back: a reply built before still asking it has that sentence dropped */
  private askDropped: UnknownItem | null = null;
  /** Knows-Me: the user's IANA time zone (start.user.timeZone) and call 1's greeting nod */
  private timeZone: string | undefined;
  private nod: string | null = null;
  /** Knows-Me S1: long replies the user cut off in this call; the one-time "I'll keep it short" line */
  private longCuts = 0;
  private shorterLine: string | null = null;
  private taste: TasteLine[] = [];
  private correcting: AbortController | null = null;
  private correctionChecks = 0;
  /** a card's line waiting for the current reply to finish (dropped if the user talks first) */
  private pendingAnnounce: { text: string; at: number } | null = null;
  /** PERC-1 (#319): sets `perception` (declared above) when GENITA_PERCEPTION is on */
  private perceptionCtl: PerceptionController | null = null;
  /** for perception timing: when the companion's last reply ended / the user last stopped speaking */
  private lastReplyEndAt: number | null = null;
  private lastUserSpeechAt: number | null = null;

  constructor(id: string, client: ClientSink, deps: SessionDeps) {
    this.id = id;
    this.client = client;
    this.deps = deps;
    this.now = deps.now ?? (() => performance.now());
    this.voiceId = deps.config.defaultVoiceId;
    // looked up from the socket's open, so `start` rarely waits for it (Codex P2: no input window)
    this.ownedVoice = this.companionVoice();
    this.ownedName = this.boundedLookup(deps.companionName, 80);
    this.bargeCfg = { bargeInMinMs: deps.config.bargeInMinMs, bargeInMinWords: deps.config.bargeInMinWords };
    if (deps.config.perception) {
      this.perceptionCtl = new PerceptionController({
        spark: deps.spark,
        now: this.now,
        convo: () => ({
          companionSpeaking: this.turn.phase === "speaking",
          lastReplyEndAt: this.lastReplyEndAt,
          userSpeaking: this.userTurnOpen(),
          lastUserSpeechAt: this.lastUserSpeechAt,
        }),
        log: (event, data) => this.log(event, data),
        // nobody reacts in interpretation or while watching together: no reads there (also for a waiting frame)
        active: () => this.mode === "chat" && !this.watch?.isSharing,
      });
      this.perception = this.perceptionCtl;
    }
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
  /**
   * "Forget all of this" during this call (AU-92): the profile, taste lines, the planned question and the first-call
   * nod go now — the next reply and the next search know nothing about them.
   */
  profileForgotten(): void {
    // the call's own turns go too, like a memory Forget — not left to the memory subscription, which a failed memory
    // start may not have (Codex #583 r22)
    this.dropSpeculation(); this.dispatch({ type: "client_barge_in" });
    this.history = []; this.recentReplies = []; this.memories = []; this.greeting = null;
    this.user = { ...this.user, profile: undefined };
    this.taste = [];
    this.ask = null;
    this.nod = null;
    if (this.started) this.finds?.configure({ owner: this.deps.userId, memories: this.memories, profile: undefined, userName: this.user.name, timeZone: this.timeZone, taste: [] });
    this.finds?.forgetTaste();   // the card on screen stops quoting the old taste (Codex #583 r5)
    this.correcting?.abort();     // a voice correction under way was said under the old profile
    this.log("profile.forgotten_in_call", {});
  }

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

  /** A start lookup that never holds the call up: null when unset, failed, blank, or slower than COMPANION_VOICE_WAIT_MS. */
  private async boundedLookup(lookup: (() => Promise<string | null | undefined>) | undefined, max: number): Promise<string | null> {
    if (!lookup) return null;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), COMPANION_VOICE_WAIT_MS); });
    try {
      const v = await Promise.race([Promise.resolve().then(lookup).catch(() => null), late]);
      return str(v, max) ?? null;
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
    // a turn the end-of-turn hold kept open is not answered here later (CA-14, handover b9-6 P2): this device lost the
    // sound and the mic, so its reply would only land in the shared history; no cue either
    this.dropHeld();
    // …nor a final still on its way from this device (an open segment, an echo check): Codex b9-6 P2
    if (this.segmentOpen) this.dropLateFinal = true;
    this.segmentOpen = false;
    this.asrEpoch++;
    // the dropped turn's cue-echo filter goes with it (Codex b9-6 r2)
    this.cuedTurn = false;
    this.handedOff = true;
    this.bcGen++;
    this.backchannel?.stop();
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
        // muting ends the turn: a held one is answered now (CA-14). If the user had resumed it, the final the 0.8 s of
        // silence brings joins it and commits at once (no hold with the mic off) — one turn, not two (Codex P2)
        if (!this.finalOnItsWay()) this.commitHeld("mic_off");
        return;
      case "text": {
        const text = str(msg.text, 2000)?.trim();
        if (!text) return;
        // a held voice turn ends here, as before CA-14: its reply starts and the typed line cuts it (reducer `text`).
        // First, so the typed line's own frames / card focus go with the typed line, not the held one (Codex P2)
        this.commitHeld("text");
        this.skipPendingGreeting("text");
        if (Array.isArray(msg.frames)) this.setFrames(msg.frames);
        if (this.interp && typeof msg.findId === "string") {
          // "Ask about this" on a card while interpreting would be translated to the other person: not sent
          this.log("finds.ask_ignored_interpreting", { findId: msg.findId.slice(0, 64) });
          return;
        }
        // a card "Talk about this" just named may still be loading from Finds: this turn is about it (Codex P2);
        // interrupted, closed or switched to interpreting meanwhile → this question is over (Codex r4/r5)
        const barge = this.bargeSeq;
        // a newer typed question while this one waited for its card wins (Codex r6)
        const mine = ++this.textSeq;
        const waited = this.focusLoads.size > 0 || typeof msg.findId === "string";
        if (this.focusLoads.size) await this.focusSettled();
        if (typeof msg.findId === "string") await this.finds?.focus(msg.findId.slice(0, 64));
        if (waited && (this.closed || barge !== this.bargeSeq || mine !== this.textSeq)) return;
        if (waited && this.interp && typeof msg.findId === "string") {
          this.log("finds.ask_ignored_interpreting", { findId: msg.findId.slice(0, 64) });
          return;
        }
        this.client.sendJson({ type: "transcript", final: true, text, source: "text" });
        if (this.interp) return this.interp.typed(text);
        return this.dispatch({ type: "text", text });
      }
      case "barge_in":
        this.bargeSeq++;
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
      case "perception.frame":
        // PERC-1: background face read (the controller skips it in interpretation / watch together)
        this.perceptionCtl?.frame(msg.image);
        return;
      case "stop":
        // the app's hang-up (CallSocket.close sends stop, then a normal close): a new call later is a return, not a move
        this.endedByUser = true;
        return this.close(1000, "stopped");
      case "find.confirm":
        if (typeof msg.findId === "string" && typeof msg.itemId === "string" && typeof msg.yes === "boolean") this.finds?.confirm(msg.findId, msg.itemId, msg.yes);
        return;
      case "find.stop":
        if (typeof msg.findId === "string") this.finds?.stop(msg.findId);
        return;
      case "find.focus":
        // FD-01 "Talk about this on a call": later turns are about this card (one from an earlier call too)
        if (typeof msg.findId === "string") {
          const load: Promise<void> = (this.finds?.focus(msg.findId.slice(0, 64)) ?? Promise.resolve()).catch(() => {}).then(() => {
            this.focusLoads.delete(load);
          });
          this.focusLoads.add(load);
          // a guess built before the card was there has no card in it
          this.dropSpeculation();
          await load;
        }
        return;
      default:
        return this.error("unknown_type", `Unknown message type ${String(type).slice(0, 40)}`, false);
    }
  }

  onClientAudio(frame: Buffer): void {
    if (!this.started) return;
    if (this.handedOff) {
      // the sound came back to this device: what the user says now is theirs, even inside the segment the move cut
      // (no new speechStart) — its final is answered (Codex b9-6 r2)
      this.handedOff = false;
      this.dropLateFinal = false;
    }
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
    // fail closed (lead 11/4, AU-92): with the server's profile store, the app's copy is never used — not even for a
    // line that arrives before the store answers. Only the server's profile (when it lands) counts.
    const serverProfile = !!(this.deps.personalize && this.deps.userId);
    this.user = { name: str(u.name, 80), profile: serverProfile ? undefined : str(u.profile, 4000) };
    this.memories = !this.deps.memory && Array.isArray(msg.memories) ? msg.memories.map((m) => str(m, 300)).filter((m): m is string => !!m).slice(-24) : [];
    if (Array.isArray(msg.history) && !this.deps.memory) {
      for (const h of msg.history.slice(-MAX_HISTORY)) {
        const item = h as Record<string, unknown>;
        const text = str(item?.text, 1000);
        if (text && (item.role === "user" || item.role === "assistant")) this.history.push({ role: item.role, text });
      }
      this.recentReplies = this.history.filter((h) => h.role === "assistant").map((h) => h.text).slice(-3);
      // the whole claimed history, not just the kept 16 (Codex #502 P1 r5)
      if (claimedCrisis(msg.history)) this.crisisInCall = true;
      this.ageSaid = foldAge(this.ageSaid, claimedAge(msg.history));
    }
    this.ageSaid = foldAge(this.ageSaid, this.deps.accountAge?.() ?? NO_AGE);
    const startMode: Mode = msg.mode === "interpret" ? "interpret" : "chat";
    // the mic ASR opened during start listens in the start mode's languages (no English-only stream to replace)
    this.startingMode = startMode;
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
    // first sound on connect (Chelsea 05:04, p50 ≤ 1 s): where start → ready goes, per stage
    const spanT0 = this.now();
    const spans: Record<string, number> = {};
    const span = (k: string, from: number) => { spans[k] = Math.round(this.now() - from); };
    this.warm();
    (this.deps.ops ?? getOps()).prime(this.limitUserId());
    if (this.deps.memory && this.deps.userId) {
      const memory = this.deps.memory;
      const userId = this.deps.userId;
      this.memoryCall = new MemoryCall(memory, userId, this.id, (revision) => {
        // a turn the end-of-turn hold kept open, and a final still in its echo check, are from before the Forget:
        // never answered (and so never saved) after it (CA-14, #585 Codex P1)
        // …and so is the segment being spoken at that moment: its late final is dropped (d5c9c86e Codex P1)
        this.dropHeld(); this.asrEpoch++; this.bcGen++; this.backchannel?.stop(); this.cuedTurn = false;
        if (this.segmentOpen) { this.dropLateFinal = true; this.segmentOpen = false; }
        this.dropSpeculation(); this.dispatch({ type: "client_barge_in" });
        this.history = []; this.recentReplies = []; this.memories = []; this.greeting = null;
        this.handedPast = false; // Codex #536 r2: after a Forget the other device's turns are gone as a past too
        this.historyRevision = revision;
        // #341: what greetings opened on goes too (Codex #352)
        this.openerRecent = [];
        this.startMood = null;
        forgetOpenerTopics(userId, memory, (e) => this.log("convo.opener_topic_failed", { message: String(e).slice(0, 120) }));
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
          if (!abandoned) { this.lastMessageAt = state.last_message_at; this.openerRecent = storedTopics(state); this.startMood = carriedMood(state, (memory.now ?? Date.now)(), this.moodBase); }
          // AU-42: a start without a name (the Mac) uses the one the account's iPhone sent; a start with one keeps it fresh
          if (!abandoned) {
            const said = this.user?.name?.trim();
            if (!said && state.user_name) this.user = { ...(this.user ?? {}), name: state.user_name };
            else if (said && state.user_name !== said) { state.user_name = said; await memory.state.putState(userId, state); }
          }
          if (this.closed) return;
          // a slow start never seeds old turns, but once verified, this call's NEW turns can hand off (Codex 11/3)
          if (abandoned) { if (this.historyRevision === null) this.historyRevision = revision; return; }
          this.historyRevision = revision;
          if (startMode !== "chat" || this.history.length) return;
          const server = this.deps.priorTurns?.(revision) ?? null;
          if (!server?.length) { const last = this.deps.lastCall?.(); if (last) this.memoryCall?.setLastCall(last.turns, last.threadId, last.covered); }
          const claimed = revision === 0 && msg.handoff === true ? parseHistory(msg.history) : [];
          const seed = server?.length ? server : claimed;
          if (!seed.length) return;
          // a "forget that…" turn and the reply to it are never carried to the next device (QA post-deploy 11/3)
          this.history = scrubHistory(seed, []).slice(-MAX_HISTORY);
          // a crisis anywhere in the handed-over turns stays with the call: server turns carry the flag (server.ts);
          // a client-claimed history is read whole, not just the kept 16 (Codex #502 P1 r4/r5)
          if (server?.length ? seed.some((h) => h.role === "user" && realCrisisSignal(h.text)) : claimedCrisis(msg.history)) this.crisisInCall = true;
          // Codex #640 r4: fold the flags (never a bare "minor" from a partial history; an adult age can still win)
          this.ageSaid = foldAge(this.ageSaid, server?.length ? seed.filter((h) => h.role === "user").reduce((a, h) => foldAge(a, ageSays(h.text)), NO_AGE) : claimedAge(msg.history));
          // a handoff is the same conversation: one thread, one summary (iPhone and Mac write the same row)
          const prior = server?.length ? this.deps.priorThread?.(revision) ?? null : null;
          // Codex #547 P1: the other device's forgotten lines keep this call's input, memory and notes clear of them too
          if (prior?.removed?.length) this.removedLines = [...this.removedLines, ...prior.removed].slice(-40);
          this.memoryCall?.continueThread(prior, this.history);
          this.recentReplies = [...this.recentReplies, ...this.history.filter((h) => h.role === "assistant").map((h) => h.text)].slice(-3);
          this.greeting = null;
          this.continued = true;
          this.handedPast = true;
          this.log("history.seeded", { turns: this.history.length, from: server?.length ? "server" : "start" });
        });
      };
      const memT0 = this.now();
      const outcome = await within(init().then(() => "ok" as const, () => "error" as const), MEMORY_START_BUDGET_MS, "slow" as const);
      span("memoryMs", memT0);
      if (outcome === "error") { this.log("memory.unavailable", {}); memoryCall.close(); this.memoryCall = null; this.historyRevision = null; }
      else if (outcome === "slow") {
        abandoned = true;
        this.log("memory.slow_start", { budget_ms: MEMORY_START_BUDGET_MS });
        // a plain greeting (no shared past); no handoff seeding without a verified Forget revision
        if (startMode === "chat" && !this.greeting && this.historyRevision === null) this.greeting = { item: null };
      }
    }
    if (this.closed) return;
    const voiceT0 = this.now();
    const owned = await this.ownedVoice;
    span("voiceMs", voiceT0);
    if (this.closed) return;
    // One voice per reply: if something already started speaking (input raced the lookup), this call keeps it.
    if (owned && this.turn.utteranceId === 0 && !this.reply) this.pickVoice(owned, persona.kind);
    else if (owned) this.log("voice.owned_late", {});
    const ownedName = await this.ownedName;
    if (this.closed) return;
    // AU-53: the stored companion name is the current one (a voice rename saved it); a device's cached start may be older.
    // Unlike the voice, a name can switch even if a first input raced the lookup: like a voice rename, a reply already
    // under way keeps its prompt and the next one uses the stored name (Codex AU-53 P2).
    let nameSynced = false;
    if (ownedName && ownedName !== this.persona!.name) {
      this.log("companion.name_synced", { chars: [...ownedName].length, raced: this.turn.utteranceId !== 0 || !!this.reply });
      this.persona = { ...this.persona!, name: ownedName };
      nameSynced = true;
    }
    // lane 개인화: the stored profile (with corrections) replaces the app's copy; this call's one question
    if (this.deps.personalize && this.deps.userId && startMode === "chat") {
      try {
        // never hold the call up for the profile store: past STARTCALL_TIMEOUT_MS the app's copy is used
        // a handoff (iPhone → Mac, seeded or `start.handoff`) is the same conversation: profile only, no question,
        // no first-call nod, not counted as a call (P1 11/3: the Mac's S4 answer ended with the call-2 question)
        let continuation = this.continued || msg.handoff === true;
        try { continuation ||= this.deps.continuesCall?.() ?? false; } catch { /* never fails the call */ }
        this.callPlanned = !continuation;
        const profileT0 = this.now();
        const TIMED_OUT = Symbol("timed_out");
        const genAtStart = this.deps.personalize.generation?.(this.deps.userId);
        const read = this.deps.personalize.startCall(this.deps.userId, { plan: !continuation });
        const p = await Promise.race([
          read,
          new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), STARTCALL_TIMEOUT_MS).unref?.()),
        ]);
        span("profileMs", profileT0);
        this.callStartedAt = new Date().toISOString();
        if (p === TIMED_OUT) {
          // fail closed (lead 11/4, AU-92): never the app's copy — it may hold what they asked to forget. No profile until
          // the server's lands, then it applies to the rest of the call.
          this.user = { ...this.user, profile: undefined }; this.taste = [];
          this.log("profile.start_timeout", {});
          void read.then((late) => {
            if (!late || this.closed) return;
            // read before "Forget all of this" landed: never applied (Codex #583 r4)
            if (this.deps.userId && this.deps.personalize?.generation?.(this.deps.userId) !== genAtStart) return;
            this.user = { ...this.user, profile: late.profile || undefined };
            this.taste = late.taste ?? [];
            // Finds was configured meanwhile with the app's copy: it follows too
            if (this.started) this.finds?.configure({ owner: this.deps.userId, memories: this.memories, profile: this.user.profile, userName: this.user.name, timeZone: this.timeZone, taste: this.taste });
          }).catch(() => {});
        }
        // read before "Forget all of this" landed (answered in time, but from the old profile): not used (Codex #583 r5)
        const stale = p !== TIMED_OUT && !!p && !!this.deps.userId && this.deps.personalize.generation?.(this.deps.userId) !== genAtStart;
        if (stale) { this.user = { ...this.user, profile: undefined }; this.taste = []; }
        const got = p === TIMED_OUT || stale ? null : p;
        // a stored profile always wins, even an empty one (a deleted preference must not come back from the app's copy)
        if (got) this.user = { ...this.user, profile: got.profile || undefined };
        if (got?.nod) this.nod = got.nod;
        // what they removed from their profile stays out of memory, notes and the handed-off turns
        if (got?.removed?.length) {
          // keep what a handed-off call already forgot (Codex #547 P1) alongside the profile's removed lines
          this.removedLines = [...got.removed, ...this.removedLines.filter((r) => !got.removed!.includes(r))].slice(-40);
          this.memoryCall?.setAvoid(this.removedLines);
          this.history = scrubHistory(this.history, avoidKeys(got.removed));
        }
        if (got?.calls) this.callNumber = got.calls;
        if (got?.ask && got.askItem) this.ask = { line: got.ask, item: got.askItem, topic: got.askTopic ?? null, asked: false };
        this.taste = got?.taste ?? [];
      } catch (err) {
        // the read failed: fail closed (lead 11/4, AU-92) — no profile rather than the app's copy
        this.user = { ...this.user, profile: undefined }; this.taste = [];
        this.log("profile.unavailable", { message: String(err).slice(0, 120) });
      }
      if (this.closed) return;
    } else if (this.deps.personalize && this.deps.userId) {
      // an interpretation start: no call plan, but the profile is still the server's, never the app's copy — a switch
      // to chat later must not use what they asked to forget (Codex #583 r6). Profile only (plan: false), off the path.
      const personalize = this.deps.personalize, userId = this.deps.userId;
      const gen = personalize.generation?.(userId);
      // interpretation doesn't use the profile: the app's copy is dropped outright, only the server's (when it lands) counts
      this.user = { ...this.user, profile: undefined }; this.taste = [];
      void personalize.startCall(userId, { plan: false }).then((p) => {
        if (!p || this.closed || personalize.generation?.(userId) !== gen) return;
        this.user = { ...this.user, profile: p.profile || undefined };
        this.taste = p.taste ?? [];
        if (this.started) this.finds?.configure({ owner: userId, memories: this.memories, profile: this.user.profile, userName: this.user.name, timeZone: this.timeZone, taste: this.taste });
      }).catch(() => {});
    }
    // owner = the authenticated account (server.ts); start.user.id is not trusted for ownership
    this.timeZone = str(u.timeZone, 40);
    this.finds?.configure({ owner: this.deps.userId, memories: this.memories, profile: this.user.profile, userName: this.user.name, timeZone: this.timeZone, taste: this.taste });
    if (this.micOn) {
      const asrT0 = this.now();
      await this.ensureAsr();
      span("asrMs", asrT0);
    }
    if (this.closed) return;
    span("totalMs", spanT0);
    this.log("call.start_spans", spans);
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
      ...(this.perceptionCtl ? { perception: true } : {}),
    });
    this.client.sendJson({ type: "state", state: "listening" });
    // AU-53: the app's labels (and its reconnect start) follow the stored name, the same event as a voice rename
    if (nameSynced) this.client.sendJson({ type: "companion.named", name: this.persona!.name });
    this.startingMode = null;
    if (startMode === "interpret") this.enterInterpret(parseInterpretOptions(msg.interpret));
    if (this.tts === "server" && this.deps.config.voice && !this.voiceOverflow) this.deps.voicePrefetch?.(Number(this.voiceId.slice("seamless:".length)));
    if (startMode === "chat" && initiativeOn()) this.startInitiative();
    if (this.continued) {
      // handoff: the conversation goes on, no greeting of either kind. A drop coming back (same device, or a gap)
      // says one short line so the user isn't met by silence (coordinator 11/4 WT-06 follow-up)
      if (this.reconnected && startMode === "chat") void this.sayReconnectLine();
      return;
    }
    if (greetAfterMs === null) {
      if (this.greeting && !this.closed && !this.reply) this.dispatch({ type: "text", text: GREET_PROMPT });
      return;
    }
    // Chelsea 11/4 (a): the name opener goes out as soon as the call is ready, the first call too (no D21 wait)
    if (this.deps.greetOpener === true && startMode === "chat") {
      this.greeting ??= { item: null };
      if (!this.closed && !this.reply) this.dispatch({ type: "text", text: GREET_PROMPT });
      return;
    }
    // D21: also without the memory dependency, the plain greeting
    if (startMode === "chat" && !this.greeting) this.greeting = { item: null };
    if (!this.greeting || this.closed) return;
    // the greeting's Spark answer (≈2.3 s to its first token on prod) runs during the wait, not after it (11/3)
    if (greetAfterMs > 0) this.startPreGreet();
    this.greetTimer = (this.deps.greetScheduler ?? schedule)(() => {
      this.greetTimer = null;
      if (!this.greeting || this.closed) return;
      if (this.reply || this.mode !== "chat" || this.turn.phase !== "listening" || this.userTurnOpen()) {
        // busy when the window ends: drop it, or the user's next line would be taken as the greeting (Codex 11/2)
        this.greeting = null;
        this.dropPreGreet();
        return this.log("call.greet_skipped", { by: "busy" });
      }
      this.dispatch({ type: "text", text: GREET_PROMPT });
    }, greetAfterMs);
  }

  /**
   * The reconnect line, once this device may play (the start claim and a switch's short lease: said into a closed
   * gate it was lost — Codex #555), and only if nothing happened meanwhile: no user turn yet, still a chat (not
   * interpretation), no reply under way (Codex #555 P2s).
   */
  private async sayReconnectLine(): Promise<void> {
    const playable = (await this.deps.untilPlayable?.().catch(() => false)) ?? true;
    if (!playable || this.closed || this.reply || this.mode !== "chat" || this.turn.utteranceId !== 0) {
      this.log("call.reconnect_skipped", { playable, busy: !!this.reply, mode: this.mode, turns: this.turn.utteranceId });
      return;
    }
    this.log("call.reconnect_line", {});
    this.dispatch({ type: "self_speak", text: RECONNECT_LINE, origin: "card" });
  }

  private startPreGreet(): void {
    if (!this.greeting || this.closed || this.preGreet) return;
    const built = this.buildRequest(GREET_PROMPT, undefined, { greeting: this.greeting, cue: null });
    const abort = new AbortController();
    let confirm!: () => void;
    const confirmed = new Promise<void>((resolve) => { confirm = resolve; });
    abort.signal.addEventListener("abort", confirm, { once: true });
    const memoryRetry: MemoryRetryState = {};
    const source = this.sparkSource(built.req, abort.signal, this.greeting.item, true, confirmed, undefined, memoryRetry);
    this.preGreet = { built, stream: new Eager(source), abort, confirm, memoryRetry };
  }

  private dropPreGreet(): void {
    this.preGreet?.abort.abort();
    this.preGreet = null;
  }

  /** D21: the user spoke or typed first inside the greetAfterMs window → no greeting, just answer them. */
  private skipPendingGreeting(by: "speech" | "text" | "mode"): void {
    if (!this.greetTimer) return;
    this.greetTimer();
    this.greetTimer = null;
    this.greeting = null;
    this.dropPreGreet();
    this.log("call.greet_skipped", { by });
  }

  // ───────────────────────── F8 interpretation ─────────────────────────

  private switchMode(mode: Mode, by: "client" | "model", opts: InterpretOptionsWire = {}): void {
    if (mode === "interpret") {
      this.skipPendingGreeting("mode");
      // a chat reply in progress is cut; the interpreter owns the voice now
      if (this.turn.phase !== "listening") this.dispatch({ type: "client_barge_in" });
      this.dropHeld();
      this.dropSpeculation();
      this.mode = "interpret";
      this.client.sendJson({ type: "mode.changed", mode, by });
      this.log("mode.changed", { mode, by });
      this.enterInterpret(opts);
      return;
    }
    this.leaveInterpret();
    this.mode = "chat";
    this.retuneMicAsr();
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
      // capped accounts don't guess on partials: a guess calls Spark before the turn is admitted
      speculate: this.deps.config.speculate && !this.deps.turnGate && !(this.deps.ops ?? getOps()).cappedUser(this.limitUserId()),
      speculateStableMs: this.deps.config.speculateStableMs,
    });
    this.interp.begin();
    if (this.interp.source === "call") void this.ensureCallAsr();
    else this.dropCallAsr();
    this.retuneMicAsr();
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
      // D41 daily cap: each translation is a user turn, charged in admitTurn() together with the D46 cap.
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
      // the call's sound is only listened to for interpretation
      const languages = this.asrLanguages(source === "call" ? "interpret" : this.startingMode ?? this.mode);
      asr = this.deps.openAsr(languages);
      const stream = asr;
      if (source === "mic") { this.asr = stream; this.asrLanguagesKey = languages.join(","); }
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
    // the mode changed while this stream was connecting
    if (source === "mic") this.retuneMicAsr();
  }

  /** Chat listens in the configured languages; interpretation adds English and Korean (the face-to-face pair). */
  private asrLanguages(mode: Mode): string[] {
    const base = this.deps.config.asrLanguages;
    return mode === "interpret" ? [...new Set([...base, ...INTERPRET_ASR_LANGUAGES])] : base;
  }

  /** Mode switch: reopen the mic ASR when it listens in the wrong languages (not while one is connecting). */
  private retuneMicAsr(): void {
    const stream = this.asr;
    if (this.closed || !stream || this.asrRetry.mic.connecting) return;
    const want = this.asrLanguages(this.startingMode ?? this.mode).join(",");
    if (this.asrLanguagesKey === want) return;
    this.log("asr.retune", { mode: this.mode, languages: want });
    this.asr = null;
    this.asrLanguagesKey = null;
    try { stream.end(); } catch { /* already unusable */ }
    if (this.micOn) void this.ensureAsr();
  }

  close(code = 1000, reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    if (this.tts === "server" && this.deps.config.voice) this.deps.voiceSeats?.release(this.id);
    if (this.bargeTimer) clearTimeout(this.bargeTimer);
    if (this.greetTimer) this.greetTimer();
    this.dropPreGreet();
    if (this.initiativeTimer) clearInterval(this.initiativeTimer);
    this.perceptionUnsub?.();
    this.dropHeld();
    this.dropSpeculation();
    if (this.reply) {
      // the call ended while a looked-up answer was still playing: it was said, so it is kept in Finds
      // (an account delete purges right after)
      const card = this.reply.webAnswer;
      this.reply.webAnswer = null;
      if (card && reason !== "account_deleted" && !this.reply.abort.signal.aborted) card();
      this.reply.abort.abort();
      if (this.reply.doneTimer) clearTimeout(this.reply.doneTimer);
    }
    this.interp?.stop();
    this.perceptionCtl?.close();
    this.backchannel?.stop();
    this.dropCallAsr();
    this.asr?.end();
    // #344: the call's ending mood carries into the next call (numbers only; not after an account delete or Forget-less unknown state)
    if (this.v1 && this.deps.memory && this.deps.userId && this.memoryCall && this.historyRevision !== null && reason !== "account_deleted" && this.history.some((h) => h.role === "user")) {
      saveCallMood(this.deps.memory, this.deps.userId, this.callMood(), (this.deps.memory.now ?? Date.now)(), this.historyRevision, (e) => this.log("convo.mood_save_failed", { message: String(e).slice(0, 120) }));
    }
    this.memoryCall?.close();
    this.correcting?.abort();
    // lane 개인화: the call's turns grow the profile (not after an account delete)
    if (this.deps.personalize && this.deps.userId && reason !== "account_deleted" && this.userTurns > 0) {
      const turns: CallTurn[] = this.history.map((h) => ({ role: h.role, text: h.text }));
      void this.deps.personalize.endCall(this.deps.userId, turns, this.ask?.item ?? null, this.callStartedAt ?? undefined).then(
        (n) => this.log("profile.grown", { applied: n }),
        (err) => this.log("profile.grow_failed", { message: String(err).slice(0, 120) }),
      );
    }
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
    if (this.interp) { this.segmentOpen = false; this.dropLateFinal = false; return this.onInterpretAsr(e); }
    this.lastAsrAt = t;
    if (this.cuedTurn && (e.type === "partial" || e.type === "speechComplete")) e = { ...e, text: stripCueEcho(e.text) };
    switch (e.type) {
      case "speechStart": {
        this.metrics = {};
        this.bcGen++;
        this.segmentOpen = true;
        this.segmentPartial = "";
        this.dropLateFinal = false; // a new segment: the lost one's final is not coming
        // the user goes on inside a held turn (CA-14): no commit while they talk (the hold's clock waits for their
        // final, see holdTimerFired); their next final joins it
        const resumed = this.held !== null;
        if (this.held) this.log("turn.resumed", { afterMs: Math.round(this.now() - this.held.since), segments: this.held.segments });
        this.backchannel?.start(resumed);
        this.skipPendingGreeting("speech");
        this.client.sendJson({ type: "speech.start", turnId: e.turnId });
        return this.dispatch({ type: "speech_start" });
      }
      case "partial": {
        this.metrics.lastPartialAt = t;
        this.segmentPartial = e.text;
        this.bcGen++;
        // inside a held turn the partial continues it: the bubble, the cue's word count and the guess see the whole turn
        const text = this.held ? joinSegments(this.held.text, e.text) : e.text;
        this.backchannel?.partial(text);
        this.client.sendJson({ type: "transcript", final: false, text });
        this.dispatch({ type: "partial", text });
        return this.considerSpeculation(text);
      }
      case "speechEnd":
        this.bcGen++;
        this.backchannel?.stop();
        this.metrics = { speechEndAt: t, lastPartialAt: this.metrics.lastPartialAt };
        this.client.sendJson({ type: "speech.end", turnId: e.turnId });
        return this.dispatch({ type: "speech_end" });
      case "speechComplete":
        this.bcGen++;
        this.segmentOpen = false;
        this.segmentPartial = "";
        if (this.dropLateFinal) {
          // the watchdog already answered this segment with its partial (Codex r3): one reply, not two
          this.dropLateFinal = false;
          this.log("turn.late_final_dropped", { words: e.text.split(/\s+/).filter(Boolean).length });
          return;
        }
        this.backchannel?.stop();
        this.metrics.completeAt = t;
        // order (11/2): the interpret voice command first, then the watch echo filter, then the turn;
        // exactly one final transcript goes out either way
        if (interpretCommand(e.text) === "start") {
          this.cuedTurn = false;
          this.dropHeld();
          this.client.sendJson({ type: "transcript", final: true, text: e.text, turnId: e.turnId, source: "voice" });
          // INT-0 by voice: "Can you interpret for me?"
          this.switchMode("interpret", "model");
          (this.interp as Interpreter | null)?.say(INTERPRET_ON_LINE);
          return;
        }
        if (this.watch?.isSharing && (e.text.trim() || this.echoPending > 0)) {
          // in order: a slow echo check must not let a later utterance go first (Codex 11/2) — an empty final too, while
          // one is pending (Codex CA-14 r2)
          this.echoPending++;
          const epoch = this.asrEpoch;
          this.echoChain = this.echoChain.then(() => (epoch === this.asrEpoch ? this.completeUnlessEcho(e.turnId, e.text, epoch) : undefined)).catch(() => {}).finally(() => { this.echoPending--; });
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

  /**
   * A Transcribe final. CA-14 (11/4): it is a candidate end of turn, not a commit. An unfinished-looking turn
   * (src/convo/endOfTurn.ts) is held open — the backchannel cue may play inside the hold, Spark may already guess —
   * and only a long enough silence commits it; if the user resumes, the next final is joined to it.
   */
  private completeTurn(turnId: number, text: string): void {
    const whole = this.held ? joinSegments(this.held.text, text) : text;
    const v = this.holdVerdict(whole);
    if (v) return this.holdTurn(turnId, whole, v);
    if (this.held?.timer) clearTimeout(this.held.timer);
    const h = this.held;
    this.held = null;
    if (h) this.log("turn.commit", { reason: "final", heldMs: Math.round(this.now() - h.since), segments: h.segments + 1, kind: h.kind });
    this.commitTurn(turnId, whole);
  }

  private commitTurn(turnId: number, text: string): void {
    this.cuedTurn = false;
    this.backchannel?.stop();
    this.client.sendJson({ type: "transcript", final: true, text, turnId, source: "voice" });
    this.dispatch({ type: "speech_complete", text });
    // not consumed by a reply (backchannel / empty): stop the guess
    this.dropSpeculation();
  }

  /** hold this final? Only a plain chat turn to a quiet companion, with the mic on; null = commit now */
  private holdVerdict(text: string): EotVerdict | null {
    if (!eotHoldOn() || this.closed || this.mode !== "chat" || this.interp || !this.micOn || !text.trim()) return null;
    if (this.turn.phase !== "listening" || this.turn.backchannel || this.turn.pendingBargeIn) return null;
    const v = judgeEndOfTurn(text, eotTuning());
    return v.holdMs > 0 ? v : null;
  }

  private holdTurn(turnId: number, text: string, v: EotVerdict): void {
    if (this.held?.timer) clearTimeout(this.held.timer);
    const prev = this.held;
    const timer = setTimeout(() => this.holdTimerFired(), v.holdMs);
    this.held = { text, turnId, kind: v.kind, since: prev?.since ?? this.now(), segments: (prev?.segments ?? 0) + 1, timer };
    // the cue only for a turn that looks unfinished; a missing "." alone just waits a little
    if (v.kind === "incomplete") this.backchannel?.held(text, EOT.cueAfterMs, v.holdMs);
    // the bubble keeps the whole turn (the final goes out on commit)
    this.client.sendJson({ type: "transcript", final: false, text });
    // Spark may start on it now (it is buffered until the commit; a resumed turn makes it a miss)
    if (this.deps.config.speculate && !(this.frames && this.now() - this.frames.at <= FRAMES_TTL_MS)) {
      if (this.specTimer) clearTimeout(this.specTimer);
      this.specTimer = null;
      void this.startSpeculation(text);
    }
    this.log("turn.hold", { kind: v.kind, why: v.why, holdMs: v.holdMs, segment: this.held.segments, words: text.split(/\s+/).length });
  }

  /** a final is still coming (the user went on, Transcribe is closing their segment, or an echo check runs) */
  private finalOnItsWay(): boolean {
    return this.segmentOpen || this.echoPending > 0;
  }

  /**
   * The hold's silence ran out. If a final is on its way it re-decides (the user went on — Codex P1/r2): check again
   * shortly. A final lost with its ASR stream never holds the turn more than HOLD_WATCHDOG_MS past the last ASR event.
   */
  private holdTimerFired(): void {
    const h = this.held;
    if (!h || this.closed) return;
    h.timer = null;
    if (this.finalOnItsWay() && this.now() - this.lastAsrAt < HOLD_WATCHDOG_MS) {
      h.timer = setTimeout(() => this.holdTimerFired(), 250);
      return;
    }
    // the watchdog: a segment still open after HOLD_WATCHDOG_MS of ASR silence lost its final; its words so far go
    // with the turn, and if the final turns up after all it is dropped (Codex r3)
    if (this.segmentOpen) {
      h.text = joinSegments(h.text, this.segmentPartial);
      this.dropLateFinal = true;
      this.segmentOpen = false;
    }
    this.commitHeld("silence");
  }

  /** the held turn ends now (silence ran out, the mic went off, the user typed) */
  private commitHeld(reason: "silence" | "mic_off" | "text"): void {
    const h = this.held;
    if (!h) return;
    if (h.timer) clearTimeout(h.timer);
    this.held = null;
    if (this.closed) return;
    this.log("turn.commit", { reason, heldMs: Math.round(this.now() - h.since), segments: h.segments, kind: h.kind });
    this.commitTurn(h.turnId, h.text);
  }

  /** the held turn is dropped unanswered (the call closed or switched to interpretation) */
  private dropHeld(): void {
    if (this.held?.timer) clearTimeout(this.held.timer);
    this.held = null;
  }

  /** While sharing, the video's own lines leaking into the mic are not a user turn (F5-L13). */
  private echoChain: Promise<void> = Promise.resolve();

  private async completeUnlessEcho(turnId: number, text: string, epoch = this.asrEpoch): Promise<void> {
    const echo = text.trim() ? ((await this.watch?.isEcho(text)) ?? false) : false;
    // re-check after the wait: the call may have closed, switched to interpretation or moved to the other device
    if (this.closed || this.mode === "interpret" || epoch !== this.asrEpoch) return;
    if (!echo) return this.completeTurn(turnId, text);
    this.log("watch.echo_dropped", { text: text.slice(0, 120) });
    // a held turn waits again from here (the video's line was not the user going on); if the user went on meanwhile,
    // the hold's clock waits for their final (holdTimerFired)
    if (this.held) return this.completeTurn(turnId, "");
    // the turn ended (as the video's echo): the cue-echo filter is for that turn only (handover b9-6 P2)
    this.cuedTurn = false;
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
        conversationQuiet: () => this.turn.phase === "listening" && !this.userTurnOpen() && !this.turn.pendingBargeIn,
        nonverbal: () => {
          // lead's call 11/4: brows up + a small inhale, no words, beside (never as) a reply; the app's face part
          // follows `backchannel.kind: "inhale"` (PROTOCOL.md 11/4)
          if (this.mode !== "chat" || this.interp || this.reply || this.turn.phase !== "listening" || this.userTurnOpen()) return false;
          this.client.sendJson({ type: "backchannel", kind: "inhale", audio: inhalePcmBase64() });
          return true;
        },
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
    // watch together is not a getting-to-know-you call: drop this call's question and give the count back
    if (this.callPlanned && this.deps.personalize?.unplanCall && this.deps.userId && !this.ask?.asked) {
      const item = this.ask?.item ?? null;
      this.callPlanned = false;
      this.askDropped = this.ask?.topic ?? null;
      this.ask = null;
      this.nod = null;
      void this.deps.personalize.unplanCall(this.deps.userId, item).catch((err) => this.log("profile.unplan_failed", { message: String(err).slice(0, 120) }));
      // the stored count goes back one: keep this call's closeness stage the same as the device that takes it over (Codex P2)
      if (this.callNumber) this.callNumber = Math.max(1, this.callNumber - 1);
    }
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
    const before = this.turn;
    this.turn = r.state;
    if (before.phase === "speaking" && r.state.phase !== "speaking") this.lastReplyEndAt = this.now();
    if (before.userSpeaking && !r.state.userSpeaking) this.lastUserSpeechAt = this.now();
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
    if (this.turn.phase === "listening" && !this.userTurnOpen()) return this.dispatch({ type: "self_speak", text, origin: "card" });
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
    // the user talked over a reply that was already a sentence or more in: they want it shorter
    // long = two sentences or ~80 characters already out (a "Sure thing." cut is not a long reply — Codex round 6)
    if (reason !== "client" && this.mode === "chat" && (r.spoken.length >= 2 || r.spoken.join(" ").length >= 80)) this.noteLongCut();
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

  /** Knows-Me S1: the second long reply cut off → "Updated: shorter replies" + one "I'll keep it short" line. */
  private noteLongCut(): void {
    const p = this.deps.personalize;
    if (process.env.GENITA_BARGE_SHORTER === "0" || !p?.noteShorter || !this.deps.userId) return;
    this.longCuts++;
    if (this.longCuts !== SHORTER_AFTER_CUTS) return;
    // they asked for long answers themselves: two cut-offs don't override that (the server checks the labels too)
    if (/\b(?:long|longer|detailed|thorough|in[- ]depth|whole story)\b[^.\n]{0,30}\b(?:answers?|repl(?:y|ies)|explanations?)\b/i.test(this.user?.profile ?? "")) return;
    // set now so the very next reply says it; cleared if the server doesn't save it
    // silent adaptation (main 11/3 P0): just get shorter — never mention the interruptions or the change (meta + guilt on camera)
    const line = "Keep this reply, and the rest of the call, to one short sentence. Never mention that they interrupted you or that you're keeping it short.";
    this.shorterLine = line;
    void p.noteShorter(this.deps.userId).then(
      (r) => {
        if (!r) { if (this.shorterLine === line) this.shorterLine = null; return; }
        if (this.closed) return;
        this.user = { ...this.user, profile: r.profile };
        this.finds?.setProfile(r.profile, this.taste);
        this.client.sendJson({ type: "profile.updated", text: r.text, fields: r.fields });
        this.log("profile.updated", { fields: r.fields, by: "cuts" });
      },
      (err) => this.log("profile.correction_failed", { message: String(err).slice(0, 120) }),
    );
  }

  /** lane 개인화: "actually I don't like X" → merge → profile.updated. Beside the reply, never blocking it. */
  private checkCorrection(text: string, since?: number): void {
    const p = this.deps.personalize;
    const userId = this.deps.userId;
    // the profile it was said under: a line queued behind another runs with it, so a forget in between drops it (Codex #583 r14)
    const gen = since ?? (userId ? p?.generation?.(userId) : undefined);
    // "forget that …": from this line on, memory, notes and the turns handed on leave its target out (no Spark wait)
    // "forget I said that" points back: the line to forget is their previous one (strict match, not loose words of
    // "i don't wanna get into it" — intel eval 11/4)
    const pointsBack = isAnaphoricForget(text);
    if ((isForgetRequest(text) || pointsBack) && !isCorrection(text) && !isRememberRequest(text) && this.mode === "chat") {
      const prev = pointsBack ? pointedLine(this.history) : null;
      // anaphoric: the pointed-at line's distinctive words, loosely (Codex #547 P1: "Likes jasmine tea." must go too)
      const removed: Removed | null = pointsBack ? (prev && forgetKeyText(prev) ? { text: forgetKeyText(prev), forget: true } : null) : forgetTarget(text) ? { text: forgetTarget(text), forget: true } : null;
      if (removed) { this.removedLines = [...this.removedLines, removed].slice(-40); this.memoryCall?.setAvoid(this.removedLines); }
    }
    const asked = this.awaitingAnswer;
    this.awaitingAnswer = null;
    // only lines that will reach Spark count toward the per-call budget
    // a "forget that …" is never skipped because another check is still running: it runs right after it
    if (this.correcting && p && userId && this.mode === "chat" && isForgetRequest(text) && !this.closed) {
      const waitFor = this.correctionDone;
      void waitFor.then(() => { if (!this.closed) this.checkCorrection(text, gen); });
      return;
    }
    if (!p || !userId || this.mode !== "chat" || this.correcting || this.correctionChecks >= MAX_CORRECTION_CHECKS || (!asked && !mightBeCorrection(text))) return;
    const lastAssistant = [...this.history].reverse().find((h) => h.role === "assistant")?.text;
    const abort = new AbortController();
    this.correcting = abort;
    this.correctionChecks++;
    let done!: () => void;
    this.correctionDone = new Promise<void>((r) => (done = r));
    void p.voiceCorrection(userId, text, lastAssistant, abort.signal, asked, gen).then(
      (r) => {
        if (!r || this.closed || abort.signal.aborted) return;
        this.user = { ...this.user, profile: r.profile };
        // "forget that…" in this call: from now on memory, notes and the turns handed on leave it out too
        const gone = r.applied.flatMap((a) => a.removed);
        if (gone.length) { this.removedLines = [...this.removedLines, ...gone].slice(-40); this.memoryCall?.setAvoid(this.removedLines); }
        // lines said in this call are "You said: …" on result cards (grey), the stored ones "Your taste: …" (blue)
        const said = new Set(r.applied.filter((a) => a.field === "likes" && a.text).map((a) => a.text));
        // the latest taste lines, even none (a "forget that" can empty them — Codex round 6)
        this.taste = r.taste.map((t) => (said.has(t.text) || this.taste.some((x) => x.fromCall && x.text === t.text) ? { ...t, fromCall: true } : t));
        this.finds?.setProfile(r.profile, this.taste);
        for (const e of r.events) this.client.sendJson({ type: "profile.updated", text: e.text, fields: e.fields });
        this.log("profile.updated", { fields: r.applied.map((a) => a.field), answered: r.answered });
      },
      (err) => this.log("profile.correction_failed", { message: String(err).slice(0, 120) }),
    ).finally(() => { if (this.correcting === abort) this.correcting = null; done(); });
  }

  /** #345: a smile / laugh the camera saw at the last reply, until the next user turn reads it */
  private faceLanded: { kind: "smiled" | "laughed"; at: number } | null = null;

  /** one perception subscription per call: feeds the initiative governor (if on) and what-landed (#345) */
  private subscribePerception(): void {
    if (!this.perception || this.perceptionUnsub) return;
    try {
      this.perceptionUnsub = this.perception.onTrigger((t) => {
        if (t.kind === "smiled_at_reply" || t.kind === "laughed") this.faceLanded = { kind: t.kind === "laughed" ? "laughed" : "smiled", at: this.now() };
        this.initiative?.perception(t);
      });
    } catch { this.perceptionUnsub = () => {}; }
  }

  /** the landed face for this turn, if it was seen in the last 20 s; consumed once */
  private takeFaceLanded(): "smiled" | "laughed" | null {
    const f = this.faceLanded;
    this.faceLanded = null;
    return f && this.now() - f.at <= 20_000 ? f.kind : null;
  }

  /** Conversation engine v1 inputs for this turn: style, the greeting's opener, an initiative block, the camera lines. */
  private v1Extras(turn: { greeting?: { item: Memory | null } | null; cue?: { block: string } | null }, userText = "", cameraFrames = 0, screenFrames = 0): Partial<Parameters<typeof buildInstructions>[0]> {
    const last = this.lastMessageAt;
    let opener: string | undefined;
    if (turn.greeting) {
      const now = (this.deps.memory?.now ?? Date.now)();
      const sinceLastMs = last === undefined || last === null ? last : Math.max(0, now - last);
      // AU-44: notes are a thread to pick up only after the same 6 h gap as a memory opener (or right after a hang-up,
      // lastCall); otherwise every call with notes was a "followup" on the same open thread, call after call
      const notes = this.memoryCall?.visibleSummaries?.() ?? [];
      // a call-back within minutes of the hang-up is the same conversation picking up (P1 FILM 11/3): still due
      const notesDue = notes.length > 0 && (!!this.memoryCall?.lastCall || sinceLastMs === null || sinceLastMs === undefined || sinceLastMs < NOTES_CALLBACK_MS || sinceLastMs >= NOTES_OPENER_GAP_MS);
      const o = { hasProfile: !!this.user?.profile, sinceLastMs, hasItem: !!turn.greeting.item || notesDue || !!this.memoryCall?.lastCall };
      // ^ notes from the last call (#307) are a thread to pick up too: "followup", not a bare "back" line (eval 11/3)
      // #341: open on a different profile thing than the last calls (not for a follow-up or a "back already" line)
      const kind = openerKind(o);
      // AU-44: a notes follow-up names ONE open thread / promise, rotated like profile hooks (recorded per account)
      const notesFollowup = kind === "followup" && !turn.greeting.item && !this.memoryCall?.lastCall && notesDue;
      if (this.memoryCall) this.memoryCall.notesOpener = notesDue || !!this.memoryCall.lastCall;
      const rotates = kind === "first_known" || kind === "known" || kind === "back_today" || kind === "back_days" || notesFollowup;
      const hooks = notesFollowup ? [...new Set(notes.flatMap((n) => [...n.open_threads, ...n.promises]).map((x) => x.trim().slice(0, 80)).filter((x) => x.length >= 3))].slice(0, 8) : rotates ? profileHooks(this.user?.profile) : [];
      // read-pick-record in one step for the account (an iPhone and a Mac greeting together never pick the same)
      const { hook, recent } = pickOpenerTopic(this.deps.userId, hooks, this.openerRecent, daySeed(now) + (kind === "first_known" ? Math.floor(Math.random() * 1000) : 0), this.memoryCall ? this.deps.memory : undefined, (e) => this.log("convo.opener_topic_failed", { message: String(e).slice(0, 120) }), this.deps.memory && this.deps.userId ? this.historyRevision : 0);
      // rotating kinds with no safe hook pass null (open on the companion's own thing); others pass undefined
      opener = openerBlock({ ...o, hook: rotates ? hook : undefined, lastHook: lastSafeHook(recent, this.removedLines), lastMood: this.memoryCall?.summaries[0]?.mood ?? null });
      if (hook) this.log("convo.opener", { kind, hooks: hooks.length, recent: recent.length });
      if (hook || o.hasItem) this.personalUsed++;
    }
    let perception: string | undefined;
    let perceptionHint: string | undefined;
    try {
      perception = this.perception?.contextLine() ?? undefined;
      perceptionHint = turn.greeting || turn.cue ? undefined : this.perception?.pendingHint() ?? undefined;
    } catch { /* the reply never fails on the camera lane */ }
    // intel eval 11/4: "do I look ok?" with the camera off got an empty reply (the unseen guard dropped "You look great")
    // Codex #541 P2: an explicit "do I look ok?" beats a lingering face hint, and shared-screen images count as seeing
    // Codex #541 r2: only this turn's camera frames say the camera is on (a cached face line can outlive it); a shared
    // screen counts for "look at this", never for "do I look ok?"
    // Codex #541 r3: never on a crisis line or in a call that had one (no "playful" nudge there)
    if (!turn.greeting && !turn.cue && userText && !realCrisisSignal(userText) && !this.crisisInCall) { const off = cameraOffHint(userText, cameraFrames > 0, screenFrames > 0); if (off) perceptionHint = off; }
    // P1: closeness, question rhythm, mood, what landed, recall — one "This turn:" line on a user turn (never a greeting / cue)
    let turnLine: string | undefined;
    this.subscribePerception();
    if (!turn.greeting && !turn.cue && userText) {
      turnLine = turnHints({
        callNumber: this.callNumber,
        lastReply: this.recentReplies.at(-1),
        userText,
        // never an upbeat / playful mood hint on a real crisis line (Codex #490 P1)
        mood: realCrisisSignal(userText) || this.crisisInCall ? null : moodLine(this.callMood(userText), { steady: holdsSteady(this.persona) }),
        remembers: this.memories.length > 0 || !!this.memoryCall?.summaries.length,
        mentionSpent: this.personalUsed > 0,
        faceLanded: this.takeFaceLanded(),
        recentReplies: this.recentReplies,
        crisisInCall: this.crisisInCall,
      }) ?? undefined;
    }
    // safety gate 11/4: once they said they're a minor in this call, no romance at all (rides the This-turn line)
    // Codex #640 r3: every chat request of a call known to be with a minor carries it (greeting and cues too)
    {
      const minor = isMinor([this.ageSaid, userText ? ageSays(userText) : NO_AGE]) ? MINOR_LINE : null;
      // first in the line: the This-turn block is cut at 400 chars, the safety part must never be the cut part
      if (minor) turnLine = turnLine ? turnLine.replace(/^This turn: /, `This turn: ${minor} `) : `This turn: ${minor}`;
    }
    // intel eval 11/4: plan / math / how-to asks get the real work, an unknown "him" gets a question, a reused word is named
    const task = !turn.greeting && !turn.cue && userText ? taskHint(userText, this.history, this.crisisInCall, this.persona?.kind) ?? undefined : undefined;
    return { style: "v1", opener, initiative: turn.cue?.block, perception, perceptionHint, turn: turnLine, task };
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
      && !this.pendingAnnounce && this.turn.phase === "listening" && !this.userTurnOpen() && !this.turn.pendingBargeIn && !this.watch?.isSharing;
  }

  /** test seam: one governor check now */
  async initiativeTick(): Promise<void> {
    const gov = this.initiative;
    if (!gov || this.initiativeBusy || this.closed) return;
    if (this.perception && !this.perceptionUnsub) {
      this.subscribePerception();
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
      this.cueTurn = { source: again.source, block: cueRhythm(initiativeBlock(again.source, threads), again.source, this.recentReplies), input };
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

  /** CV-01: anything from before this call reached the model (memories, notes, last call, recall, the other device's turns) */
  /** the other device's turns came with this call (cleared by a Forget) */
  private handedPast = false;
  private hasPast(): boolean {
    // a handoff's turns count only while they're still here (Codex #536 P2: a Forget clears them, the flag stayed)
    return this.handedPast || this.memories.length > 0 || !!this.memoryCall?.pastShown;
  }

  /** Session memory: this call's conversation thread, for the account's next device after a handoff. */
  threadInfo(): ThreadState | null {
    return this.memoryCall?.threadState() ?? null;
  }

  /** This call's turns (copy) — for the account's next device after a handoff. */
  historySnapshot(): HistoryItem[] {
    // the next device never gets a "forget that…" turn or what it removed (QA post-deploy 11/3)
    return forgetInCall(this.history, this.removedLines).map((h) => ({ ...h }));
  }

  /** Revision of these turns, not the latest revision at socket close (which may arrive after Forget). */
  get historyForgetRevision(): number | null { return this.historyRevision; }
  /** stopped or closed, even if its socket has not finished closing yet */
  get isClosed(): boolean { return this.closed; }
  /** the user asked to forget something at any point in this call (#447) */
  forgetAsked = false;
  /** a real crisis line came up anywhere in this call: sticky (the 16-line history trim never clears it) and handed to
   * the next device with the turns (server.ts), like forgetAsked. No take nudge after it (Codex #502 P1 r1–r3) */
  crisisInCall = false;
  /** Codex #640: what they said about their own age in this call, kept past the 16-line trim (never stored) */
  ageSaid: AgeSay = NO_AGE;
  /** they're a minor by what this call said (server.ts carries ageSaid across a handoff, like crisisInCall) */
  get minorInCall(): boolean { return isMinor([this.ageSaid]); }
  /** a handed-over or claimed history said "minor" (explicitly) */
  set minorInCall(v: boolean) { if (v) this.ageSaid = foldAge(this.ageSaid, { minor: true, adult: false, teen: false }); }
  /** set by the server when this call picked up a dropped one (same device, or > RECONNECT_GAP_MS later): RECONNECT_LINE */
  reconnected = false;
  /** the user hung up (`stop`), as opposed to a dropped socket or a move to the other device */
  endedByUser = false;

  private remember(role: "user" | "assistant", text: string): void {
    // whole call, not just the kept history: a forget request anywhere keeps this call's raw lines out of a return visit
    // either detector: #442's (personalize, drives the do-not-mention scrub) or memory's broader one (#443)
    if (role === "user" && (isForgetRequest(text) || isMemoryForgetRequest(text) || isAnaphoricForget(text))) this.forgetAsked = true;
    if (role === "user" && realCrisisSignal(text)) this.crisisInCall = true;
    // Codex #640: kept for the whole call (the 16-line history trim would drop the "I'm 15" line)
    if (role === "user") this.ageSaid = foldAge(this.ageSaid, ageSays(text));
    this.history.push({ role, text });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    this.deps.onHistoryChange?.(role);
    if (role === "assistant") this.recentReplies = [...this.recentReplies, text].slice(-3);
  }

  /** Pure apart from consuming pending camera frames. */
  private buildRequest(text: string, renamedFrom?: string, turn: { greeting?: { item: Memory | null } | null; cue?: { block: string } | null } = {}): Built {
    const greeting = !!turn.greeting;
    const persona = this.persona!;
    const hangul = isMostlyHangul(text);
    // English only (11/3): in chat a Hangul transcript is answered in English, not auto-interpreted; the explicit
    // interpretation mode is unchanged. GENITA_ENGLISH_ONLY=0 restores the F8 auto-switch.
    const interpret = this.mode === "interpret" || (hangul && !englishOnly());
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
      // intel eval 11/4: what they asked to forget in this call is not sent back to Spark either (convo/forgetInCall.ts)
      ...forgetInCall(this.history, this.removedLines).map((h): InputMessage => (h.role === "user" ? { role: "user", content: h.text } : { role: "assistant", content: h.text })),
      { role: "user", content },
    ];
    const v1 = this.v1 ? this.v1Extras(turn, text, camera.length, images.length - camera.length) : {};
    const base = buildInstructions({
      persona,
      user: this.user,
      memories: this.memories,
      mode: "chat",
      language: this.language,
      cameraAttached: camera.length > 0,
      onScreen: this.finds?.onScreen(),
      renamedFrom,
      // this call's one question rides the first user turns (the turn being built is userTurns + 1)
      // never while watching together (the question would land on top of the show)
      // the GK-1 question asks what we DON'T know: not a MENTION_RULE "personal thing you know" (Codex #423 P2: holding
      // it behind the budget skipped it on every call 1–3 while beginCall had already used it up)
      ask: this.ask && !this.ask.asked && !this.watch && this.userTurns < ASK_TURNS ? this.ask.line : undefined,
      localTime: localTimeLine(this.timeZone, new Date()) ?? undefined,
      // call 1's greeting only (v1 has its own first_known opener: no second personal mention)
      nod: greeting && this.nod && !this.v1 ? this.nod : turn.cue ? undefined : this.shorterLine ?? undefined,
      ...v1,
    });
    // a refine after a product search in this call ("another one in black…") stays a search: the Finds runner's own rule
    const recent = this.history.slice(-6).map((h) => `${h.role === "user" ? "User" : "You"}: ${h.text}`);
    const afterProduct = this.finds ? this.finds.afterProduct(recent) : recent.some((l) => l.startsWith("User: ") && isProductAsk(l.slice(6)));
    const suggestMac = !this.macSuggested && isOutfitAsk(text, afterProduct) && this.deps.macNearby?.() === true;
    const instructions = suggestMac ? `${base}\n${SUGGEST_MAC_LINE}\n` : base;
    // said once, on the next reply the user asked for (not a greeting or an initiative turn)
    if (!greeting && !turn.cue) this.shorterLine = null;
    let finalInstructions = watch ? `${instructions}\n${watch.instructions}\n` : instructions;
    if (greeting && !interpret && this.deps.greetOpener === true) {
      this.greetOpener = pickGreetOpener(this.user?.name);
      finalInstructions += `\nYou already said "${this.greetOpener}" out loud as your first words. Continue right after it: do not greet them again (no hey / hi / hello) and do not say their name again.\n`;
    }
    return {
      interpret,
      detected: null,
      // Finds get the camera frames only, never the shared screen
      images: camera,
      lang: this.language,
      suggestMac,
      req: {
        instructions: finalInstructions,
        input,
        maxOutputTokens: 800,
        // a real crisis turn answers at once, never after a web search (AI sweep C5: searched for hotlines, said nothing)
        tools: this.deps.config.webSearch && !realCrisisSignal(text) ? [{ type: "web_search" }] : undefined,
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
    // Codex r4 P2: a camera turn's content is an array (input_text + images) — its text is the query too
    const content = last && typeof last !== "string" && "role" in last ? last.content : undefined;
    const query = typeof last === "string" ? last : typeof content === "string" ? content
      : Array.isArray(content) ? content.map((p) => (p && typeof p === "object" && "type" in p && p.type === "input_text" && "text" in p ? String(p.text) : "")).join(" ").trim() : "";
    // Codex r8: a crisis line earlier in THIS call also keeps the "no hotlines" check-in away
    if (this.memoryCall) this.memoryCall.callHadCrisis = this.crisisInCall || realCrisisSignal(query);
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
    if (this.deps.turnGate && !this.deps.turnGate.peek()) return; // over the judge daily cap: no Spark guess
    const norm = normTranscript(text);
    if (!norm || this.closed || this.spec?.norm === norm) return;
    if (this.focusLoads.size) return; // the card "Talk about this" named is still loading (Codex r2)
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

  /** Every find.focus read started so far is done, a later one included (overlapping picks, Codex r3). */
  private async focusSettled(): Promise<void> {
    while (this.focusLoads.size) await Promise.all([...this.focusLoads]);
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
    // 11/4: a full GPU no longer hands the call to the phone's voice (another, robotic voice): the call keeps the
    // companion's own voice and waits its turn on the autoscaling GPU. The seat is still taken (holders = live load).
    if (!this.deps.config.voice?.deviceFallback) {
      const over = !seats.tryTake(this.id);
      if (over && !this.seatsOver) this.log("voice.capacity_over", { sessionId: this.id, holders: seats.holders(), max: this.deps.config.voiceMaxCalls ?? 3 });
      this.seatsOver = over;
      return false;
    }
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
    const reply: Reply = { utteranceId, abort: new AbortController(), spoken: [], firstAudioAt: null, audioMs: 0, playEnd: 0, doneTimer: null, chars: 0, fellBack: this.deviceVoiceForReply() && this.tts === "server" };
    const device = this.tts === "device";
    this.reply = reply;
    // D41 daily cap: real user turns were charged in admitTurn(); the greeting and an initiative cue only run
    // while a turn is left and never spend one. Over the cap: no Spark call, a daily_limit error, the call stays open.
    if (synthetic && this.deps.turnGate && !this.deps.turnGate.peek()) {
      this.dropSpeculation();
      this.dailyLimit();
      // after the reducer's own effects (state thinking) went out, so the last state is listening
      queueMicrotask(() => this.finishReply(reply));
      return;
    }
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
    /** a Finds turn answered with a fixed ack / product reaction: no first-sound cap beat on top */
    let ackTurn = false;
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
    // the greeting started during the D21 wait: its stream is already running (or done)
    const preGreet = greeting && !self && text === GREET_PROMPT ? this.preGreet : null;
    // a card / watch line spoken during the wait keeps the pre-started greeting (Codex r2 #461); any other turn ends it
    if (!self) this.preGreet = null;
    if (preGreet && !preGreet.abort.signal.aborted && !pre) {
      preGreet.confirm();
      // barge-in, mode switch, Forget or close stop the adopted stream too (Codex P1 #461)
      signal.addEventListener("abort", () => preGreet.abort.abort(), { once: true });
      built = preGreet.built;
      pre = preGreet.stream;
      memoryRetry = preGreet.memoryRetry;
      this.log("call.greet_prestarted", { utteranceId });
    } else preGreet?.abort.abort();
    if (!built && this.focusLoads.size) {
      await this.focusSettled();
      // barged in or replaced while the card loaded: this turn is over (Codex r3)
      if (signal.aborted || this.reply !== reply || this.closed) return;
    }
    built ??= this.buildRequest(text, renamedFrom, { greeting, cue });
    if (greeting) this.nod = null;
    const greetLine = greeting && !self && this.deps.greetOpener === true ? this.greetOpener : null;
    this.greetOpener = null;
    const { req, interpret, lang } = built;
    if (built.detected) this.client.sendJson({ type: "interpret.detected", ...built.detected });
    if (!synthetic && !self) this.memoryCall?.userMessage();
    if (!interpret && !synthetic && !self) {
      this.checkCorrection(text);
      this.userTurns++;
      this.remember("user", text);
      // an explicit "remember …" goes to the memory extraction now, not after the answer (Codex #423 P1)
      if (EXPLICIT_REMEMBER.test(text) && !replyMemoryTools().some((t) => "name" in t && t.name === "remember")) this.memoryCall?.saveNow(text);
    }
    // F10: a card pipeline runs beside the spoken answer (answer first, card after)
    let resolveSaid: (t: string | null) => void = () => {};
    // Chelsea 11/3: a web-searched answer also lands in the sheet with its sources (not when a card runs for this turn)
    let cardTurn = false;
    let searches: WebSearch[] = [];
    // Demo S4: the suggest turn makes no outfit card from the phone's (maybe still kitchen) frames
    if (!interpret && !self && !synthetic && this.finds && !built.suggestMac) {
      const said = new Promise<string | null>((r) => (resolveSaid = r));
      // history already holds this turn (remember above): the lines before it
      const recent = this.history.slice(-7, -1).map((h) => `${h.role === "user" ? "User" : "You"}: ${h.text}`);
      const started = this.finds.onTurn({ text, frames: built.images, utteranceId, replyText: said, recent });
      cardTurn = !!started;
      signal.addEventListener("abort", () => resolveSaid(null), { once: true });
      if (started?.ack) {
        ackTurn = true;
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
          // text only: the frames already went to the search, and an image costs the reaction ~1–2 s of first word
          const textOnly = Array.isArray(req.input)
            ? req.input.map((m) => ("content" in m && Array.isArray(m.content) ? { ...m, content: m.content.filter((c) => c.type === "input_text").map((c) => (c as { text: string }).text).join(" ") } : m))
            : req.input;
          const react = this.sparkSource({ ...req, input: textOnly as typeof req.input, instructions: `${req.instructions ?? ""}\n${PRODUCT_REACTION_LINE}\n`, tools: undefined }, signal, undefined, false);
          pre = (async function* () {
            let said = false;
            try {
              for await (const ev of react) {
                if (ev.type === "done") {
                  if (said) { yield ev; return; }
                  break; // an empty reaction: the short ack below, never the tool-carrying retry
                }
                if (ev.type === "text" && ev.delta.trim()) said = true;
                yield ev;
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
    const sentences: { tts: string; display: string; emotion: string | null; face: { tag: Expression; intensity: number } | null; beat?: true; drop?: true; opener?: true }[] = [];
    // #387 follow-up: watch together took the call's question back. The question is judged as a whole sentence,
    // never clause by clause: server voice cuts "Weekends for you, | are they packed or lazy?" at the comma.
    const ends = (d: string) => LOOKS_FINAL.test(d.trim());
    let askHold: string[] = [];
    let askReleasing = false;
    /** a hold beat goes out on its own: it never releases or joins a held question clause (Codex r1 P2) */
    let beating = false;
    let droppedAsk = false;
    /** the queued, not-yet-ended clauses of the sentence in progress (before the next one) */
    const openClauses = (): number[] => {
      const out: number[] = [];
      // a dropped clause is a boundary: the dropped question never joins the next sentence (Codex r1 P2)
      for (let k = sentences.length - 1; k >= 0 && !sentences[k].beat && !sentences[k].drop && !ends(sentences[k].display); k--) out.unshift(k);
      return out;
    };
    /** Consumer side: clause i is part of a whole queued sentence that asks the dropped question → drop all of it. */
    const askedAt = (i: number): boolean => {
      if (!this.askDropped || interpret || self || sentences[i]?.beat) return false;
      if (sentences[i].drop) return true;
      let a = i, b = i;
      while (a > 0 && !sentences[a - 1].beat && !sentences[a - 1].drop && !ends(sentences[a - 1].display)) a--;
      while (b < sentences.length && !sentences[b].drop && !ends(sentences[b].display)) b++;
      if (b < sentences.length && sentences[b].drop) return false;
      if (b >= sentences.length) return false; // the sentence isn't finished yet: its end is judged on enqueue
      const full = sentences.slice(a, b + 1).map((x) => x.display).join(" ");
      if (!/\?\s*$/.test(sentences[b].display) || !replyAsks(full, this.askDropped)) return false;
      // never leave the reply empty: when the question was its only real sentence and nothing else is coming,
      // a short reaction takes its place (coordinator 11/3)
      const alone = sparkDone && !sentences.some((x, k) => (k < a || k > b) && !x.beat && !x.drop);
      for (let k = a; k <= b; k++) sentences[k].drop = true;
      droppedAsk = true;
      this.log("profile.ask_dropped", { utteranceId, queued: true, replaced: alone });
      if (!alone || i < a) return true;
      const ack = parseTaggedSentence(WATCH_ASK_FALLBACK);
      sentences[i] = { tts: ack.ttsText, display: ack.displayText, emotion: ack.emotion ?? sentences[i].emotion, face: null };
      if (jobs[i]) jobs[i] = undefined as never; // a prefetched TTS of the question is not used
      return false;
    };
    /** real sentences only: a hold beat ("Mm, okay.") is never the answer (Codex #384) */
    /** the name opener (greeting a) is said, but is not the model's answer: an empty greeting still retries (Codex #461) */
    const said = () => sentences.filter((x) => !x.beat && !x.drop && !x.opener);
    /** AU-45: the greeting's "Hey, Summer!" opener went out — a whole greeting on its own when Spark adds nothing */
    const openerSpoken = () => greeting && sentences.some((x) => x.opener && !x.drop);
    let emotion: string | null = null;
    const waiter: { wake: (() => void) | null } = { wake: null };
    let sparkDone = false;
    let sparkError: unknown = null;
    let emptyCause: string | null = null;
    let lostLine = false;
    let droppedOpener = false;
    // a she/he in the reply is the user only when their own line is about themselves (the v1 address check)
    const narration = new NarrationJudge(!interpret && !self, { thirdPersonIsUser: !synthetic && thirdPersonCouldBeUser(text, this.user?.name) });
    const hasAnswer = () => narration.hasAnswer(said().map(({ display }) => display));
    let onlyOpener: string | null = null;
    // v1 sentence guard (src/convo/guard.ts): the first dropped sentence, spoken only if nothing else is
    const guarded: { first: { raw: string; cls: GuardClass } | null; narration: boolean; tool: boolean } = { first: null, narration: false, tool: false };
    // #344: this reply's mood (the user's line already in history for a user turn)
    const replyMood: Mood | null = this.v1 && !interpret && !self ? this.callMood() : null;
    let laughs = 0;
    // #194 GK-1: this turn carries the call's one still-to-confirm question; the guard lets that question through
    // (read from the request itself: it was built before this turn was counted)
    const askTurn = !synthetic && !interpret && !!this.ask && (req.instructions ?? "").includes(this.ask.line);
    const guardCtx = { camera: (built?.images.length ?? 0) > 0, userText: synthetic ? "" : text, askTurn, crisisInCall: this.crisisInCall };
    let cutBefore = false;
    const enqueueSentences = (list: string[], keepOpener = false) => {
      for (const raw of list) {
        const p = parseTaggedSentence(raw);
        if (p.emotion) emotion = p.emotion;
        // Delivery/emotion tags alone cannot be displayed or spoken. Do not
        // enqueue a blank sentence (or call TTS with just "[laughs]").
        if (!p.displayText) continue;
        let tts = p.ttsText;
        // option (a): the opener already greeted them — the model's own "Hey Summer!" is not said again
        if (greetLine && !keepOpener && sentences.length === 1) {
          // a hello split at its comma by the server voice ("Hey," + "Summer! How…"): the name piece goes too
          const first = this.user?.name?.trim().split(/\s+/)[0];
          const nameLead = first ? new RegExp(`^(\\s*(?:(?:<[^>]*>|\\[[^\\]]*\\])\\s*)*)${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[,!.]+\\s*`, "iu") : null;
          let cut = tts.replace(LEADING_HELLO, "$1");
          if (nameLead) cut = cut.replace(nameLead, "$1");
          if (cut !== tts && parseTaggedSentence(cut).displayText) tts = cut.replace(/^(\s*(?:<[^>]*>\s*)?)(\p{Ll})/u, (_, lead, c) => lead + c.toUpperCase());
          else if (cut !== tts) continue;
        }
        // a hold beat is not the reply's first sentence (Codex P2 #427): the model's first one still gets these checks
        const modelFirst = !sentences.some((x) => !x.beat && !x.opener);
        if (!keepOpener && modelFirst && !interpret && !self) tts = avoidRepeatedOpener(tts, this.recentReplies);
        // v1: the user's name as a vocative once per few replies, not every line (11/3 tone pass)
        if (this.v1 && tts && !keepOpener && !interpret && !self) {
          const named = dropRepeatedName(tts, this.user?.name, [...this.recentReplies.slice(-2), ...sentences.map((x) => x.display)]);
          if (named !== tts) { tts = named; this.log("convo.name_dropped", { utteranceId }); }
        }
        // v1 (AI sweep 11/3): "Summer should know that by now" — the user's name as a sentence subject → "You …"
        if (this.v1 && tts && !interpret && !self) {
          const you = nameAsYou(tts, this.user?.name);
          if (you !== tts) { tts = you; this.log("convo.name_to_you", { utteranceId }); }
        }
        // CV-01 (eval v2 11/4): no past in this call → no habit "again" / "like usual", no claimed earlier talk (convo/pastGuard.ts)
        if (this.v1 && tts && !interpret && !self) {
          const kept = unbackedPast(tts, { past: this.hasPast(), userText: guardCtx.userText, callText: this.history.map((h) => h.text).join(" ") }); // Codex #536 r6: what Genita itself said this call counts too ("We talked about kimchi fried rice")
          if (kept !== tts) { tts = kept; this.log("convo.unbacked_past", { utteranceId, dropped: !kept }); }
        }
        // AI sweep C1: "I'm really glad you told me — …" then "…, and I'm really glad you told me." — said once per reply
        if (this.v1 && tts && !interpret && !self && sentences.some((x) => /\bglad you told me\b/i.test(x.display))) {
          const once = tts.replace(/,?\s*(?:and\s+)?i'?m (?:really |so |just )?glad you told me(?: that)?(?=\s*[,.!?…]|$)/i, "");
          if (once !== tts) { tts = once.replace(/\s+([.!?])/, "$1"); this.log("convo.phrase_repeat_dropped", { utteranceId }); }
        }
        // v1: "Hmm. Hmm, okay so…" (QA r5, 1/6: a hold beat then Spark's own "Hmm,"): a sentence that opens with the
        // interjection the previous sentence was made of drops it ("Hmm." + "Hmm, okay so…" → "Hmm." + "Okay so…")
        // a hold beat is audio only and never the model's: the model's own "Hmm." after a beat "Hmm." is kept (Codex #427)
        const prevSaid = [...sentences].reverse().find((x) => !x.beat)?.display;
        // only a standalone interjection ("Hmm," / "Oh!"), never a word in use ("Well water…", "Oh Sehun…", Codex P2)
        const lead = /^(?:\s*\[[^\]]*\]\s*)*([\p{L}']+)[,.!?…—-]/u.exec(tts)?.[1]?.toLowerCase();
        const prevLead = /[\p{L}']+/u.exec(prevSaid ?? "")?.[0]?.toLowerCase();
        if (this.v1 && tts && prevSaid && lead && lead === prevLead && isInterjectionOnly(prevSaid) && !interpret && !self) {
          const once = avoidRepeatedOpener(tts, [prevSaid]);
          // the model's whole answer was the beat's own word ("Hmm." after the cap's "Hmm."): the beat becomes the answer
          // instead of an empty reply and a retry (Codex P2 #427)
          if (once !== tts) { tts = once; this.log("convo.interjection_dropped", { utteranceId }); }
        }
        if (!tts || !parseTaggedSentence(tts).displayText) {
          cutBefore = true;
          onlyOpener ??= raw;
          droppedOpener = true; // a whole first clause ("Oh,") was the repeated opener
          continue;
        }
        // v1: never narrate the user in the third person ("She's holding up the trench…" → "You're holding…", QA #354)
        if (this.v1 && !interpret && !self) {
          const addressed = addressUser(tts, { camera: guardCtx.camera, first: !sentences.some((x) => !x.beat && !isInterjectionOnly(x.display)), userText: guardCtx.userText, userName: this.user?.name });
          if (addressed !== tts) { tts = addressed; this.log("convo.addressed_user", { utteranceId }); }
        }
        // watch together took this call's question back: a reply already asking it (built before) drops that sentence
        if (this.askDropped && !interpret && !self && !askReleasing && !beating) {
          const shown = parseTaggedSentence(tts).displayText;
          // a clause that may start the question waits for the rest of its sentence
          if (!ends(shown) && (askHold.length || replyAsks(`${shown.replace(/[\s,;:—-]+$/u, "")}?`, this.askDropped))) {
            askHold.push(raw);
            continue;
          }
          if (askHold.length || /\?\s*$/.test(shown)) {
            const held = askHold;
            askHold = [];
            const queued = openClauses();
            const full = [...queued.map((k) => sentences[k].display), ...held.map((h) => parseTaggedSentence(h).displayText), shown].join(" ");
            if (/\?\s*$/.test(shown) && replyAsks(full, this.askDropped)) {
              for (const k of queued) sentences[k].drop = true; // its first clause, queued before watch attached
              droppedAsk = true;
              this.log("profile.ask_dropped", { utteranceId });
              continue;
            }
            if (held.length) {
              askReleasing = true;
              try { enqueueSentences(held, keepOpener); } finally { askReleasing = false; }
            }
          }
        }
        if (this.v1 && !keepOpener && !interpret && !self) {
          const found = guardSentence(parseTaggedSentence(tts).displayText, guardCtx);
          // an announcement only leads a reply: once content was spoken, a later "lookup" sentence is kept (Codex #356 r6)
          const cls = found === "narration" && sentences.some((x) => !x.beat && !isInterjectionOnly(x.display)) ? null : found;
          if (cls) {
            // narration never becomes the spoken fallback; a style drop does (the first one kept)
            if (!neverSpoken(cls)) guarded.first ??= { raw, cls };
            else guarded.narration = true;
            this.log("convo.guard", { utteranceId, cls });
            cutBefore = true;
            continue;
          }
        }
        // a sentence start is never lower case (QA P3: a guard dropped "Summer," after the hold beat → "Hmm. told you
        // you'd crush it"); a clause after a comma ("Oh wow," + "that's huge") keeps its case
        // a hold beat is audio only: the caption's previous sentence is the model's own (#427)
        const prevEnd = [...sentences].reverse().find((x) => !x.beat)?.display.trim();
        // only where a guard cut something (Codex #423 P2: "npm install ws." must stay as written)
        // …and a plain word Spark itself wrote lower case at a sentence start ("finally, you did it"; r3 sweep), never a
        // command or code ("npm install ws.")
        const plainLower = /^(?:\s*\[[^\]]*\]\s*)*[a-z][a-z']+\b/.test(tts) && !/[`/\\_=<>{}]|\b(?:npm|npx|git|cd|ls|pip|brew|yarn|node|python|sudo|curl|https?|www)\b/i.test(tts);
        if ((droppedOpener && !sentences.some((x) => !x.beat)) || (this.v1 && !interpret && (cutBefore || tts !== p.ttsText || plainLower) && (!prevEnd || /[.!?…]["')\]]*$/.test(prevEnd)))) tts = tts.replace(/^(\s*(?:\[[^\]]*\]\s*)*)(\p{Ll})/u, (_, lead, c) => lead + c.toUpperCase());
        // …and the other way round (QA P3 2/3: "Got you, Black top…"): mid-sentence after a comma piece, a word a guard
        // capitalised goes back to how Spark wrote it
        if (this.v1 && !interpret && prevEnd && !/[.!?…]["')\]]*$/.test(prevEnd) && tts !== p.ttsText) {
          const w = /^(\s*(?:\[[^\]]*\]\s*)*)(\p{Lu})([\p{Ll}']*)/u.exec(tts);
          if (w && w[2] + w[3] !== "I" && !new RegExp(`\\b${w[2]}${w[3]}\\b`, "u").test(p.ttsText) && new RegExp(`\\b${w[2].toLowerCase()}${w[3]}\\b`, "u").test(p.ttsText)) tts = w[1] + w[2].toLowerCase() + tts.slice(w[1].length + 1);
        }
        // QA P3: a returning greeting's question ended with "." 1/2 ("…how's the prep going.") — a greeting or initiative
        // sentence that is plainly a question ends with "?"
        if (this.v1 && synthetic && QUESTION_START.test(parseTaggedSentence(tts).displayText) && /\.\s*$/.test(tts) && !/\.\.\.\s*$/.test(tts)) tts = tts.replace(/\.\s*$/, "?");
        const display = tts === p.ttsText ? p.displayText : parseTaggedSentence(tts).displayText;
        // a memory tool's follow-up round may repeat what was already said before the call (bug-fix lane smoke 11/3:
        // "I knew you'd crush it… I knew you'd crush it…"): a sentence already spoken in this reply is not said twice
        if (this.v1 && !interpret && !self) {
          const key = normTranscript(display);
          // only after a tool ran in this reply: an intentional repeat ("Breathe in. Breathe out." ×2) is kept (Codex r23)
          if (key && guarded.tool && !isInterjectionOnly(display) && sentences.some((x) => !x.beat && normTranscript(x.display) === key)) { this.log("convo.duplicate_dropped", { utteranceId }); continue; }
        }
        if (m.firstSentenceAt === undefined) {
          m.firstSentenceAt = this.now();
          m.firstSentenceChars = tts.length;
        }
        // expression layer: one face per clause (Spark's [tag], else its words / the reply's <emotion>); never in interpretation
        let face = interpret ? null : clauseExpression(p, emotion, !!p.emotion, { scaled: this.v1 });
        // #344: the face follows the call's mood — size by energy, and a reply with no face of its own keeps a faint
        // one on its first clause instead of snapping back to neutral
        if (this.v1 && !interpret && !self && replyMood) {
          if (face && face.tag !== "laugh") face = { ...face, intensity: moodScaledIntensity(face.intensity, replyMood) };
          // never on a crisis turn or after an explicit [neutral] (Codex #477/#490 P1)
          else if (!face && !sentences.length && !emotion && p.expression !== "neutral" && !realCrisisSignal(guardCtx.userText)) face = restingFace(replyMood);
        }
        // v1: one laugh per reply, none on a sad turn (DESIGN §7.2)
        if (this.v1 && face?.tag === "laugh") face = laughs++ > 0 || emotion === "sad" ? null : face;
        sentences.push({ tts, display, emotion, face });
        cutBefore = false;
        // captions go out per sentence: the opener guard may rewrite the first one
        // a hold beat is audio only: no caption (the answer's first caption word is the answer's own)
        if (display && !beating) this.client.sendJson({ type: "reply.delta", utteranceId, text: (sentences.slice(0, -1).some((x) => !x.beat) ? " " : "") + display });
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
    /** a held clause whose sentence never ended was not the question: say it */
    const releaseAskHold = () => {
      if (!askHold.length) return;
      const held = askHold;
      askHold = [];
      askReleasing = true;
      try { enqueueSentences(held); } finally { askReleasing = false; }
    };
    const pushSentences = (list: string[]) => {
      for (const raw of list) {
        const p = parseTaggedSentence(raw);
        if (p.emotion) emotion = p.emotion;
        applyNarration(narration.push(raw));
      }
    };

    // Producer: Spark stream → sentences
    // hold cap (prod smoke 11/3 13:0x: a held pre-tool line kept a memory turn silent 5.9 s): if nothing has been
    // said 1.5 s after Spark's first text, one short human beat goes out — never narration, never "let me…"
    let beatTimer: NodeJS.Timeout | null = null;
    let capTimer: NodeJS.Timeout | null = null;
    const beat = () => {
        if (signal.aborted || this.reply !== reply || sentences.length) return;
        const before = sentences.length;
        beating = true;
        // rotate (never the same twice in a row), and never the opening word of the last replies (QA P3, #423)
        const used = recentOpeningWords(this.recentReplies);
        const firstWord = (b: string) => b.replace(/<[^>]*>/g, "").trim().split(/[\s,.]/)[0].toLowerCase();
        let k = 0;
        while (k < HOLD_BEATS.length - 1 && used.includes(firstWord(HOLD_BEATS[(this.beatIx + k) % HOLD_BEATS.length]))) k++;
        const beat = HOLD_BEATS[(this.beatIx + k) % HOLD_BEATS.length];
        this.beatIx += k + 1;
        try { enqueueSentences([beat], true); } finally { beating = false; }
        for (let i = before; i < sentences.length; i++) sentences[i].beat = true;
        this.log("convo.hold_beat", { utteranceId });
    };
    const armBeat = () => {
      if (beatTimer || !this.v1 || interpret || self) return;
      beatTimer = setTimeout(beat, HOLD_BEAT_MS);
      beatTimer.unref?.();
    };
    // first-sound cap (sweep 11/3 [P1]: speech end → first sound p50 3.34 s, max 5.3 s; Spark's first token alone
    // is 1.3–3.4 s): nothing said HOLD_CAP_MS after the user stopped → the same one short beat. Not on a greeting or
    // an initiative turn (nobody is waiting), not on a fixed ack (it is instant).
    const capMs = holdCapMs();
    if (capMs > 0 && this.v1 && !interpret && !self && !greeting && !cue && !ackTurn) {
      const since = m.speechEndAt !== undefined ? this.now() - m.speechEndAt : 0;
      capTimer = setTimeout(() => { this.log("convo.first_sound_cap", { utteranceId, capMs }); beat(); }, Math.max(0, capMs - since));
      capTimer.unref?.();
    }
    const producer = (async () => {
      try {
        if (self) {
          m.firstTokenAt = this.now();
          // a card line has no tag of its own: say it warmly; watch reactions carry theirs ("<laugh> ha")
          pushSentences(splitter.push(self === "card" ? `<warm> ${text}` : text));
          pushSentences(splitter.flush());
          return;
        }
        // option (a): the opener is said at once, Spark's greeting follows it
        if (greeting && greetLine) {
          m.firstTokenAt = this.now();
          const at = sentences.length;
          enqueueSentences([`<happy> ${greetLine}`], true);
          for (let i = at; i < sentences.length; i++) sentences[i].opener = true;
          this.log("call.greet_opener", { utteranceId });
        }
        // Retry any answer with no usable content, even with no tools, after
        // an empty speculative hit, or after a pre-text upstream failure.
        for (let attempt = 0; attempt < 2; attempt++) {
          let gotText = false;
          let status = "";
          let attemptError: unknown = null;
          try {
            const raw = attempt === 0 ? (pre ?? this.sparkSource(req, signal, greeting?.item, !interpret && !cue, undefined, undefined, memoryRetry)) : this.sparkSource(req, signal, greeting?.item, !interpret && !cue, undefined, 1, memoryRetry);
            // Demo S4 (QA P2): the suggest turn must name the Mac; a reply that doesn't is swapped for the fixed line
            const stream = built.suggestMac && !interpret && !self ? mustNameMac(raw, SUGGEST_MAC_REPLIES[utteranceId % SUGGEST_MAC_REPLIES.length], this.now) : raw;
            for await (const ev of stream) {
              if (signal.aborted) return;
              if (ev.type === "text") {
                if (ev.delta.trim()) armBeat();
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
              } else if (ev.type === "sources") {
                if (!interpret && searches.length < 4) searches.push({ query: ev.query, urls: ev.urls.slice(0, 10) });
              } else if (ev.type === "done") status = ev.status;
            }
          } catch (err) {
            if (signal.aborted) return;
            attemptError = err;
          }
          if (signal.aborted) return;
          pushSentences(splitter.flush());
          applyNarration(narration.finish());
          releaseAskHold();
          // A bare "Yes!"/"Okay." is a valid answer. Defer a dropped eager
          // opener until EOF so "Oh, the rest" still loses the repeated Oh.
          if (!said().length && guarded.first && !neverSpoken(guarded.first.cls)) {
            // never an empty reply: a style drop speaks its sentence; a safety drop says the fallback line
            const fb = fallbackLine(guarded.first.cls);
            enqueueSentences(fb ? [fb] : [guarded.first.raw], true);
          }
          if (!said().length && onlyOpener) enqueueSentences([onlyOpener], true);
          // the retry also only announced a lookup and NO tool ran: say so honestly. With a tool, never "not sure"
          // right before (or instead of) the real result — say nothing (main 11/3: Scene 4 map, Scene 5 products)
          if (!said().length && attempt === 1 && guarded.narration && !guarded.tool) enqueueSentences([NO_ANSWER_LINE], true);
          // the only real sentence was the question watch together took back: a short reaction instead of a retry
          if (!said().length && droppedAsk) enqueueSentences([WATCH_ASK_FALLBACK], true);
          // AI sweep 11/3 [P1 safety] (2/13): a real crisis hint answered with a promise or "I'm staying with you" and no
          // pointer to real help gets one fixed line (DESIGN §8.1)
          // a reply the help line now covers is not an error card either (Codex gate P2)
          if (this.v1 && !interpret && !self && !synthetic) { const need = crisisFollowUpFor(text, sentences.filter((x) => !x.drop).map((x) => x.display)); if (need) { enqueueSentences([need], true); lostLine = true; } }
          // S4: a guard dropped the Mac sentence ("You look great already, but move our call to your Mac…", camera off):
          // the ask is still said (Codex #423 final P2)
          if (built.suggestMac && !interpret && !self && !sparkError && (guarded.first || guarded.narration) && sentences.length && !sentences.some((x) => /\bMac\b/i.test(x.display))) enqueueSentences([SUGGEST_MAC_TAIL], true);
          if (hasAnswer()) { sparkError = attemptError; break; }
          emptyCause = attemptError ? "upstream_error_before_text" : gotText ? "filtered_only_content" : `${status || "stream_ended"}_without_text`;
          if (attempt === 0) this.log("spark.empty_retry", { utteranceId, cause: emptyCause, status });
          if (attempt === 1) sparkError = attemptError;
          // a 504 / dropped call: a short pause before the one retry, not straight back into the same spike
          if (attempt === 0 && attemptError) await new Promise((r) => setTimeout(r, UPSTREAM_RETRY_MS));
          if (signal.aborted) return;
          splitter = new SentenceSplitter(splitOptions);
          searches = [];
          askHold = [];
          onlyOpener = null;
          guarded.first = null;
          laughs = 0;
          emotion = null;
          droppedOpener = false;
          m.firstTokenAt = undefined;
        }
        // both tries came back empty or failed: the call goes on — one line in character, never the error card
        // AU-45: a greeting whose "Hey, Summer!" opener already went out is a fine greeting on its own — never followed by
        // "Sorry, I lost you… say that again?" before the user said anything
        if (!signal.aborted && !hasAnswer() && !interpret && !self && !openerSpoken()) {
          // a real crisis turn never gets "say that again": the help line instead (AI sweep, P1 safety)
          enqueueSentences([this.v1 && realCrisisSignal(text) ? CRISIS_HELP_LINE : LOST_LINE], true);
          lostLine = true;
          this.log("spark.lost_line", { utteranceId, cause: emptyCause, error: sparkError instanceof Error ? sparkError.message.slice(0, 120) : null });
        }
      } catch (err) {
        if (!signal.aborted) sparkError = err;
      } finally {
        if (!signal.aborted) {
          applyNarration(narration.finish());
          releaseAskHold();
          // the consumer dropped the only real sentence while Spark was still writing (nothing else came)
          if (!said().length && droppedAsk) enqueueSentences([WATCH_ASK_FALLBACK], true);
          // AI sweep 11/3 [P1 safety] (2/13): a real crisis hint answered with a promise or "I'm staying with you" and no
          // pointer to real help gets one fixed line (DESIGN §8.1)
          // a reply the help line now covers is not an error card either (Codex gate P2)
          if (this.v1 && !interpret && !self && !synthetic) { const need = crisisFollowUpFor(text, sentences.filter((x) => !x.drop).map((x) => x.display)); if (need) { enqueueSentences([need], true); lostLine = true; } }
          // S4: a guard dropped the Mac sentence ("You look great already, but move our call to your Mac…", camera off):
          // the ask is still said (Codex #423 final P2)
          if (built.suggestMac && !interpret && !self && !sparkError && (guarded.first || guarded.narration) && sentences.length && !sentences.some((x) => /\bMac\b/i.test(x.display))) enqueueSentences([SUGGEST_MAC_TAIL], true);
        }
        sparkDone = true;
        if (beatTimer) clearTimeout(beatTimer);
        if (capTimer) clearTimeout(capTimer);
        waiter.wake?.();
      }
    })();

    // Consumer: sentences → TTS (one sentence prefetched ahead) → client
    const jobs: Eager<TtsChunk>[] = [];
    const ttsJob = (s: (typeof sentences)[number], force?: true, waitMs?: number) =>
      new Eager(
        this.deps.tts({
          voiceId: this.voiceId,
          text: s.tts,
          emotion: s.emotion,
          model: SEAMLESS_MODEL,

          signal,
          lang: speechLang(s.display || s.tts, lang),
          ...(force ? { force } : {}),
          ...(waitMs ? { waitMs } : {}),
        }),
      );
    const startJob = (i: number) => {
      if (jobs[i] || !sentences[i] || askedAt(i)) return;
      jobs[i] = ttsJob(sentences[i]);
    };
    let ttsFailed = false;
    // 11/4 (no device voice): retries per reply for a clause the voice service failed before any of its audio went
    // out, then once the cached recovery line
    let retries = 0;
    let recovered = false;
    let held = false; // the hold line was tried for this reply
    let holdVoiced = false;
    let heard = false; // a clause of the reply itself was voiced (the hold line does not count)
    // a cold-GPU line from the cache or disk (never the service) into the reply's audio; true if any of it went out
    const playCached = async (text: string, sentence: number): Promise<boolean> => {
      let voiced = false;
      const offset = reply.audioMs; // the clip's alignment is from its own start (Codex re-review P2)
      try {
        for await (const chunk of this.deps.tts({ voiceId: this.voiceId, text, emotion: null, model: SEAMLESS_MODEL, signal, lang: "en-US", cachedOnly: true })) {
          if (signal.aborted || !chunk.audio.length) continue;
          if (reply.firstAudioAt === null) {
            await this.untilUserQuiet(signal);
            if (signal.aborted) break;
            reply.firstAudioAt = this.now();
            m.firstAudioAt = reply.firstAudioAt;
            this.dispatch({ type: "first_audio", utteranceId });
            noteFirstAudio();
            this.client.sendJson({ type: "speaking", on: true, utteranceId, emotion: "neutral" });
          } else if (!voiced) {
            // a later clip (the recovery line after the hold line and a wait): the user may be talking now (Codex P2)
            await this.untilUserQuiet(signal);
            if (signal.aborted) break;
          }
          // the player sat idle during the wait: this clip's playback starts now (done timer, Codex P1)
          const idle = this.now() - (reply.firstAudioAt + reply.audioMs);
          if (idle > 0) reply.firstAudioAt += idle;
          const seq = ++this.seq;
          const durationMs = pcmDurationMs(chunk.audio.length);
          this.client.sendJson({ type: "audio", utteranceId, seq, sentence, offsetMs: Math.round(reply.audioMs), durationMs: Math.round(durationMs), sampleRate: PCM_SAMPLE_RATE, model: chunk.model, ...chunkTiming(this.lip.active, chunk.alignment, offset) });
          this.client.sendBinary(Buffer.concat([encodeFrameHeader(FRAME_KIND_TTS_PCM, seq), chunk.audio]));
          reply.audioMs += durationMs;
          reply.playEnd = Math.max(reply.playEnd, this.now()) + durationMs; // AU-49 queue clock, cached clips too
          ttsModelUsed = chunk.model;
          voiced = true;
        }
      } catch { /* not cached for this speaker: nothing to play */ }
      return voiced;
    };
    let ttsModelUsed: string | null = null;
    let sentEmotion: string | null | undefined;
    // The app speaks it: plain text (tags already stripped), no vendor call, no audio frames.
    // Device mode always; server mode when the voice service failed for this reply.
    const sayOnDevice = (i: number, s: { display: string; emotion: string | null; beat?: true }, record = true) => {
      if (record && !s.beat) reply.spoken.push(s.display);
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
      reply.playEnd = Math.max(reply.playEnd, this.now()) + s.display.length * DEVICE_MS_PER_CHAR;
    };
    for (let i = 0; ; i++) {
      while (!sentences[i] && !sparkDone && !signal.aborted) await new Promise<void>((r) => (waiter.wake = r));
      waiter.wake = null;
      if (signal.aborted || !sentences[i]) break;
      // watch together attached while this question was queued (or its TTS prefetched): it is not said
      // (read the sentence after the check: the only sentence may have been replaced by the short reaction)
      if (askedAt(i)) continue;
      const s = sentences[i];
      if (device || reply.fellBack) {
        if (reply.firstAudioAt === null) await this.untilUserQuiet(signal);
        if (signal.aborted) break;
        // watch together may have attached while waiting for the user to go quiet
        if (askedAt(i)) continue;
        sayOnDevice(i, sentences[i]);
        continue;
      }
      if (ttsFailed) {
        if (!s.beat) reply.spoken.push(s.display);
        continue;
      }
      startJob(i);
      const sentenceOffset = reply.audioMs;
      let sentAudio = false;
      let firstSeq: number | null = null; // this clause's first audio chunk: `audio.timing` is keyed to it
      let sentChars = ""; // characters of this sentence already voiced (from the voice's timing)
      let clauseWords = null as { s: number; e: number } | null; // aligner span of this clause (reply timeline)
      // watch together can attach while this clause's TTS is still coming (after the askedAt check above): judged
      // again right before its first audio goes out, and a clause marked dropped stops (Codex #401 r1 P1)
      let skipped = false;
      let replaced = false;
      const stillAsked = (): boolean => {
        if (!this.askDropped || interpret || self) return false;
        if (!sentAudio && askedAt(i)) return true;
        if (sentences[i]?.drop) return true;
        if (!sentAudio && sentences[i] !== s) { replaced = true; return true; }
        return false;
      };
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
          if (stillAsked()) { skipped = true; break; }
          ttsModelUsed = chunk.model;
          if (reply.firstAudioAt === null) {
            await this.untilUserQuiet(signal);
            if (signal.aborted) break;
            if (stillAsked()) { skipped = true; break; }
            reply.firstAudioAt = this.now();
            m.firstAudioAt = reply.firstAudioAt;
            this.dispatch({ type: "first_audio", utteranceId });
            noteFirstAudio();
          } else if (held && !heard) {
            // the reply itself after the hold line and a wait: the user may have started talking meanwhile (Codex P2)
            await this.untilUserQuiet(signal);
            if (signal.aborted) break;
            if (stillAsked()) { skipped = true; break; }
          }
          // the app's player went idle in a gap (a wait for the GPU after the hold line): the reply's playback clock
          // restarts now, so the done timer covers the audio still to play (Codex P1)
          const idle = this.now() - (reply.firstAudioAt + reply.audioMs);
          if (idle > 0) reply.firstAudioAt += idle;
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
          heard = true;
          if (chunk.alignment) sentChars += chunk.alignment.chars.join("");
          if (chunk.audio.length) {
            this.client.sendBinary(Buffer.concat([encodeFrameHeader(FRAME_KIND_TTS_PCM, seq), chunk.audio]));
          }
          reply.audioMs += durationMs;
          reply.playEnd = Math.max(reply.playEnd, this.now()) + durationMs;
        }
        if (skipped) {
          this.log("profile.ask_dropped", { utteranceId, midTts: true, replaced });
          // the only sentence became the short reaction: say that one instead (its own TTS)
          if (replaced) { jobs[i] = undefined as never; i--; }
          continue;
        }
        if (!signal.aborted) {
          if (!s.beat) reply.spoken.push(s.display);
          // after the clause's audio: its words' span (aligner) or else its audio span, same timeline as audio.offsetMs
          if (s.face && sentAudio && this.deps.config.voice?.expressions !== false) {
            const startMs = clauseWords?.s ?? Math.round(sentenceOffset);
            const endMs = Math.max(startMs, clauseWords?.e ?? Math.round(reply.audioMs));
            this.client.sendJson({ type: "expression", utteranceId, sentence: i, tag: s.face.tag, intensity: s.face.intensity, startMs, endMs });
          }
        }
      } catch (err) {
        if (signal.aborted) break;
        const ttsOff = err instanceof Error && err.message === "tts_off";
        const ownVoiceOnly = !ttsOff && !!this.deps.config.voice && !this.deps.config.voice.deviceFallback;
        const reason = err instanceof Error ? err.message.slice(0, 120) : "unknown";
        if (ownVoiceOnly && !sentAudio && !heard && !held) {
          // handover b9-6: the reply's first clause missed (usually a cold GPU, 25-40 s): "One sec." in the companion's
          // own voice from the cache or disk right away, while the clause is retried below
          held = true;
          holdVoiced = await playCached(HOLD_LINE, i);
          if (signal.aborted) break;
          this.log("tts.hold_line", { sessionId: this.id, utteranceId, voiced: holdVoiced, reason });
        }
        if (ownVoiceOnly && !sentAudio && retries < TTS_RETRY_MS.length) {
          // the companion's own voice, never the phone's (11/4): wait for the voice service and ask again for this
          // clause, even while it is parked as down. While nothing of the reply was heard, the last retry waits for a
          // cold container (COLD_WAIT_MS) instead of the 4 s live budget.
          const waitMs = TTS_RETRY_MS[retries++];
          const last = retries === TTS_RETRY_MS.length;
          this.log("tts.retry", { sessionId: this.id, utteranceId, sentence: i, attempt: retries, reason });
          await new Promise<void>((r) => { const t = setTimeout(r, waitMs); signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
          if (signal.aborted) break;
          // watch together may have taken the question back (or swapped it for the short reaction) meanwhile:
          // the loop head judges it again (Codex review P2)
          jobs[i] = sentences[i] === s && !sentences[i]?.drop ? ttsJob(s, true, last && !heard ? COLD_WAIT_MS : undefined) : (undefined as never);
          i--;
          continue;
        }
        if (ownVoiceOnly && !sentAudio && !heard && !recovered) {
          // nothing of this reply was heard and the voice service stayed down: say the short recovery line in the
          // companion's own voice (cache, or the copy kept on disk), so the call is never just silent (the call screen
          // shows no captions, Codex review P1). The reply's words still go to the history.
          recovered = true;
          ttsFailed = true;
          const taken = askedAt(i) || !!sentences[i]?.drop;
          if (!taken && !sentences[i]?.beat) reply.spoken.push(sentences[i].display);
          const voiced = await playCached(RECOVER_LINE, i);
          if (signal.aborted) break;
          this.log("tts.recover_line", { sessionId: this.id, userId: this.deps.userId, utteranceId, voiced, reason });
          if (!voiced && !holdVoiced) this.error("tts_unavailable", "Voice failed for this reply; showing text only", true);
          continue;
        }
        ttsFailed = true;
        if (!ttsOff) {
          // tts_off = no server voice configured (the app speaks on-device): text-only is the normal path
          this.error("tts_unavailable", "Voice failed for this reply; showing text only", true);
          this.log("tts.error", { message: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
          if (ownVoiceOnly) {
            // no other voice stands in for the companion: the rest of the reply goes to the history only
            this.log("tts.text_only", { sessionId: this.id, userId: this.deps.userId, utteranceId, reason });
            // a question watch together took back is not recorded either (Codex review P2)
            if (askedAt(i) || sentences[i]?.drop) continue;
            if (!sentAudio && sentences[i] !== s) { if (!sentences[i].beat) reply.spoken.push(sentences[i].display); continue; }
          } else if (this.deps.config.voice) {
            // Meta voice service down/slow: the rest of this reply goes to the app's own voice (`say`)
            reply.fellBack = true;
            this.log("tts.fallback_device", { sessionId: this.id, userId: this.deps.userId, utteranceId, reason: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
            if (!sentAudio) {
              if (reply.firstAudioAt === null) await this.untilUserQuiet(signal);
              if (signal.aborted) break;
              // the device fallback is judged too: a question watch together took back is never said (Codex #401 r2)
              if (askedAt(i) || sentences[i]?.drop) continue;
              sayOnDevice(i, sentences[i]);
            }
            else {
              // the voice died mid-sentence: the device says the words that were not voiced yet
              // Timing chars are of the spoken form, so count against that; no timing (MMS) → say it all again.
              if (sentences[i]?.drop) continue; // a dropped question is not finished on the device either
              if (!s.beat) reply.spoken.push(s.display);
              const spoken = spokenText(s.display, seamlessLang(speechLang(s.display, lang), s.display));
              const rest = sentChars.trim() ? unspokenRest(spoken, sentChars) : s.display;
              if (rest) sayOnDevice(i, { display: rest, emotion: s.emotion }, false);
            }
            continue;
          }
        }
        if (!s.beat) reply.spoken.push(s.display);
      }
    }
    await producer;
    if (signal.aborted || this.reply !== reply) return;

    if (!reply.spoken.join(" ").trim() || (!hasAnswer() && !openerSpoken())) {
      resolveSaid(null);
      this.error("spark_unavailable", "The companion could not answer. Try again.", true);
      this.log("spark.empty", { utteranceId, cause: self ? "self_filtered_only_content" : emptyCause ?? "upstream_error_before_text" });
      this.finishReply(reply);
      return;
    }
    if (sparkError) {
      // the lost-you line already covered it: no error card over a call that goes on
      if (!lostLine && !openerSpoken()) this.error("spark_unavailable", "The companion could not answer. Try again.", true);
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
    // Demo S4: counted as asked only once the reply actually named the Mac (a failed or cut-off reply can ask again)
    if (built.suggestMac && /\bMac\b/i.test(full)) { this.macSuggested = true; this.log("handoff.suggest_mac", { utteranceId }); }
    if (this.v1 && full && !interpret && !self && !greeting && !cue) {
      if (mentionsProfile(full, this.user?.profile, text)) { this.personalUsed++; this.log("convo.personal_mention", { utteranceId, used: this.personalUsed }); }
    }
    // GK-1: this reply asked the call's planned question → "Getting to know you · {topic}"; the next line may answer it
    if (full && !interpret && !self && this.ask?.topic && !this.ask.asked && replyAsks(full, this.ask.topic)) {
      this.ask.asked = true;
      this.awaitingAnswer = this.ask.topic;
      this.client.sendJson({ type: "profile.asking", topic: this.ask.topic.topic });
      this.log("profile.asked", {});
    }
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
    // AU-49: never before the app's queue ends (gaps between clips included), bounded from now.
    const estimate = reply.firstAudioAt === null ? 0 : reply.firstAudioAt + reply.audioMs + (device ? 0 : PLAYBACK_SLACK_MS);
    const queued = reply.firstAudioAt === null ? 0 : reply.playEnd + (device || reply.chars ? DEVICE_SLACK_MS : PLAYBACK_SLACK_MS);
    const playEnd = Math.max(estimate, Math.min(queued, this.now() + PLAYBACK_MAX_WAIT_MS));
    const wait = Math.max(0, playEnd - this.now());
    reply.doneTimer = setTimeout(() => this.finishReply(reply), wait);
    // speech first, sheet after: the sources card when the answer has played (finishReply: playback_done or the estimate)
    if (searches.length && full && !interpret && !self && !synthetic && !cardTurn && !sparkError && this.finds) {
      const finds = this.finds;
      const looked = searches;
      reply.webAnswer = () => {
        if (this.finds !== finds) return;
        const findId = finds.webAnswer({ utteranceId, question: text, said: full, searches: looked });
        if (findId) this.log("finds.web_answer", { utteranceId, findId, searches: looked.length });
      };
    }
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
    const card = reply.webAnswer;
    reply.webAnswer = null;
    if (card && !reply.abort.signal.aborted && !this.closed && this.mode !== "interpret") card();
    this.initiative?.activity(this.now());
    if (reply.firstAudioAt !== null) this.client.sendJson({ type: "speaking", on: false, utteranceId: reply.utteranceId });
    this.dispatch({ type: "reply_done", utteranceId: reply.utteranceId });
  }

  private dailyLimit(): void {
    this.log("turn.daily_limit", {});
    this.error("daily_limit", "Today's turns for this access code are used up. The limit resets at 00:00 UTC.", false);
  }

  private limitUserId(): string | null | undefined {
    return this.deps.turnUserId === null ? null : this.deps.turnUserId ?? this.deps.userId;
  }

  /** One admission point for both caps: the D41 judge cap is checked first and spent only when the D46 cap
   * also admits the turn, so a refusal by either never charges the other. */
  private admitTurn(): boolean {
    if (this.closed) return false;
    const gate = this.deps.turnGate;
    if (gate && !gate.peek()) {
      this.dailyLimit();
      return false;
    }
    let admitted = false;
    (this.deps.ops ?? getOps()).userTurn(this.limitUserId(), () => { admitted = true; }, (message) => this.error("spark_unavailable", message, false));
    if (admitted && gate) gate.take();
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
/** a real crisis line anywhere in a claimed start.history (the whole list, before the 16-line trim; Codex #502 P1 r5) */
/** Codex #640: what a handed-over history (up to 200 lines) said about their own age, as flags */
function claimedAge(v: unknown): AgeSay {
  if (!Array.isArray(v)) return NO_AGE;
  return v.slice(-200).filter((h) => (h as Record<string, unknown>)?.role === "user" && typeof (h as Record<string, unknown>).text === "string")
    .reduce((a: AgeSay, h) => foldAge(a, ageSays(String((h as Record<string, unknown>).text).slice(0, 1000))), NO_AGE);
}
function claimedCrisis(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  return v.slice(-200).some((h) => {
    const item = h as Record<string, unknown>;
    return item?.role === "user" && typeof item.text === "string" && realCrisisSignal(item.text.slice(0, 1000));
  });
}

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
