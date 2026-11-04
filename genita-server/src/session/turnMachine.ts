/**
 * Turn-taking and barge-in as a pure reducer. The Session feeds it ASR,
 * TTS and client events and executes the effects it returns, so every
 * timing rule here is unit-testable without sockets.
 *
 * Barge-in rule (F4-L8): while the companion is thinking or speaking, the
 * user's speechStart only cancels once it is clearly speech, not a
 * backchannel — after bargeInMinMs of continued speech or bargeInMinWords
 * words of partial transcript. A short "yeah" that ends first is ignored
 * (no cancel, no new reply). bargeInMinMs = 0 cancels on speechStart.
 * Typed text and an explicit client barge_in cancel immediately.
 *
 * Words mode (cfg.words, default on; GENITA_BARGE_IN_WORDS=0 is the rule above): the iPhone speaker's
 * echo is sustained VAD with a transcript of the companion's own line, so while it is busy only real
 * words cancel: bargeInMinWords non-echo words in a partial, or one word once the speech has lasted
 * bargeInMinMs. VAD alone, a hum or a partial flagged `echo` never cancels, and a barge-in cancel
 * comes at most once per debounceMs (cancel → resume flapped every 200 ms on build 13).
 *
 * self_speak: the companion speaks on its own — a Finds card's line (F10) or a
 * watch-together reaction (F5-L14) — only from an idle state, never over the
 * user or its own reply. One path for both (11/2).
 */
import { realWords } from "./bargeEcho.ts";

export type Phase = "listening" | "thinking" | "speaking";
export type EmittedPhase = Phase | "interrupted";
export type CancelReason = "barge_in" | "text" | "client";

export type TurnState = {
  phase: Phase;
  utteranceId: number;
  userSpeaking: boolean;
  pendingBargeIn: boolean;
  /** the current user turn was judged a backchannel; drop its final transcript */
  backchannel: boolean;
  /** words mode: the pending barge-in's speech has lasted bargeInMinMs */
  sustained?: boolean;
  /** words mode: real (non-echo) words in the pending barge-in's latest partial */
  heardWords?: number;
  /** words mode: when the last barge-in cancel happened (cfg.now clock) */
  lastBargeAt?: number;
};

export type TurnEvent =
  | { type: "speech_start" }
  | { type: "partial"; text: string; /** the companion's own line heard back through the mic */ echo?: boolean }
  | { type: "speech_end" }
  | { type: "speech_complete"; text: string; echo?: boolean }
  | { type: "barge_timer" }
  | { type: "text"; text: string }
  /** the companion speaks on its own: a Finds card's line (F10) or a watch reaction (F5-L14) */
  | { type: "self_speak"; text: string; origin: "card" | "watch" }
  | { type: "client_barge_in" }
  | { type: "first_audio"; utteranceId: number }
  | { type: "reply_done"; utteranceId: number }
  /** the server wants the companion to say a line on its own (a result card landed) */;

export type Effect =
  | { type: "start_reply"; text: string; utteranceId: number; self?: "card" | "watch" }
  | { type: "cancel_reply"; utteranceId: number; reason: CancelReason }
  | { type: "arm_barge_timer"; ms: number }
  | { type: "emit_state"; phase: EmittedPhase };

export type TurnConfig = {
  bargeInMinMs: number;
  bargeInMinWords: number;
  /** words mode (see top); off = VAD + bargeInMinMs alone cancels */
  words?: boolean;
  /** clock for the barge-in debounce (ms) */
  now?: number;
  /** words mode: at most one barge-in cancel per this many ms */
  debounceMs?: number;
};

export const BARGE_DEBOUNCE_MS = 1500;

export function initialTurnState(): TurnState {
  return { phase: "listening", utteranceId: 0, userSpeaking: false, pendingBargeIn: false, backchannel: false };
}

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const clearPending = { pendingBargeIn: false, sustained: false, heardWords: 0 };
const busy = (s: TurnState) => s.phase === "thinking" || s.phase === "speaking";

function cancel(s: TurnState, reason: CancelReason): { state: TurnState; effects: Effect[] } {
  return {
    state: { ...s, phase: "listening", ...clearPending, backchannel: false },
    effects: [
      { type: "cancel_reply", utteranceId: s.utteranceId, reason },
      { type: "emit_state", phase: "interrupted" },
      { type: "emit_state", phase: "listening" },
    ],
  };
}

function start(s: TurnState, text: string, self?: "card" | "watch"): { state: TurnState; effects: Effect[] } {
  const utteranceId = s.utteranceId + 1;
  return {
    state: { ...s, phase: "thinking", utteranceId, ...clearPending, backchannel: false },
    effects: [
      self ? { type: "start_reply", text, utteranceId, self } : { type: "start_reply", text, utteranceId },
      { type: "emit_state", phase: "thinking" },
    ],
  };
}

/** words mode: a barge-in cancel, unless one happened within debounceMs (then the reply plays on) */
function bargeCancel(s: TurnState, cfg: TurnConfig): { state: TurnState; effects: Effect[] } | null {
  const now = cfg.now;
  if (now !== undefined && s.lastBargeAt !== undefined && now - s.lastBargeAt < (cfg.debounceMs ?? BARGE_DEBOUNCE_MS)) return null;
  const c = cancel(s, "barge_in");
  return now === undefined ? c : { ...c, state: { ...c.state, lastBargeAt: now } };
}

/** words mode: partial / barge_timer / speech_complete while the companion is busy */
function reduceWords(s: TurnState, e: TurnEvent, cfg: TurnConfig): { state: TurnState; effects: Effect[] } | null {
  const none = (state: TurnState = s) => ({ state, effects: [] as Effect[] });
  switch (e.type) {
    case "speech_start": {
      if (!busy(s)) return null;
      const next = { ...s, userSpeaking: true, backchannel: false, pendingBargeIn: true, sustained: cfg.bargeInMinMs <= 0, heardWords: 0 };
      return cfg.bargeInMinMs <= 0 ? none(next) : { state: next, effects: [{ type: "arm_barge_timer", ms: cfg.bargeInMinMs }] };
    }
    case "partial": {
      if (!s.pendingBargeIn || !busy(s) || e.echo) return none();
      const w = realWords(e.text);
      const next = { ...s, heardWords: w };
      if (w >= cfg.bargeInMinWords || (w >= 1 && s.sustained)) return bargeCancel(next, cfg) ?? none(next);
      return none(next);
    }
    case "barge_timer":
      if (!(s.pendingBargeIn && s.userSpeaking && busy(s))) return null;
      if ((s.heardWords ?? 0) >= 1) return bargeCancel(s, cfg) ?? none({ ...s, sustained: true });
      return none({ ...s, sustained: true });
    case "speech_complete": {
      const next = { ...s, userSpeaking: false };
      // the companion's own line heard back (also just after it ended): never a turn
      if (e.echo) return none({ ...next, ...clearPending, backchannel: false });
      if (!busy(s) || !(s.backchannel || s.pendingBargeIn)) return null;
      // a whole interruption whose partials came late: real words still take the turn
      if (realWords(e.text) >= cfg.bargeInMinWords) {
        const c = bargeCancel(next, cfg);
        if (!c) return none({ ...next, ...clearPending, backchannel: false });
        const st = start(c.state, e.text);
        return { state: st.state, effects: [...c.effects, ...st.effects] };
      }
      return null;
    }
    default:
      return null;
  }
}

export function reduceTurn(s: TurnState, e: TurnEvent, cfg: TurnConfig): { state: TurnState; effects: Effect[] } {
  const none = (state: TurnState = s) => ({ state, effects: [] as Effect[] });
  if (cfg.words) {
    const w = reduceWords(s, e, cfg);
    if (w) return w;
  }
  switch (e.type) {
    case "speech_start": {
      const next = { ...s, userSpeaking: true, backchannel: false };
      if (!busy(s)) return none(next);
      if (cfg.bargeInMinMs <= 0) return cancel(next, "barge_in");
      return { state: { ...next, pendingBargeIn: true }, effects: [{ type: "arm_barge_timer", ms: cfg.bargeInMinMs }] };
    }
    case "partial":
      if (s.pendingBargeIn && busy(s) && words(e.text) >= cfg.bargeInMinWords) return cancel(s, "barge_in");
      return none();
    case "barge_timer":
      if (s.pendingBargeIn && s.userSpeaking && busy(s)) return cancel(s, "barge_in");
      return none({ ...s, pendingBargeIn: false });
    case "speech_end":
      if (s.pendingBargeIn) return none({ ...s, userSpeaking: false, pendingBargeIn: false, backchannel: true });
      return none({ ...s, userSpeaking: false });
    case "speech_complete": {
      const next = { ...s, userSpeaking: false };
      if (s.backchannel || (s.pendingBargeIn && busy(s))) return none({ ...next, backchannel: false, pendingBargeIn: false });
      if (!e.text.trim()) return none(next);
      if (busy(s)) {
        const c = cancel(next, "barge_in");
        const st = start(c.state, e.text);
        return { state: st.state, effects: [...c.effects, ...st.effects] };
      }
      return start(next, e.text);
    }
    case "text": {
      if (!e.text.trim()) return none();
      if (busy(s)) {
        const c = cancel(s, "text");
        const st = start(c.state, e.text);
        return { state: st.state, effects: [...c.effects, ...st.effects] };
      }
      return start(s, e.text);
    }
    case "self_speak":
      // only into silence: never over the user, a pending barge-in, or another reply
      if (!e.text.trim() || busy(s) || s.userSpeaking || s.pendingBargeIn) return none();
      return start(s, e.text, e.origin);
    case "client_barge_in":
      return busy(s) ? cancel(s, "client") : none();
    case "first_audio":
      if (e.utteranceId !== s.utteranceId || s.phase !== "thinking") return none();
      return { state: { ...s, phase: "speaking" }, effects: [{ type: "emit_state", phase: "speaking" }] };
    case "reply_done":
      if (e.utteranceId !== s.utteranceId || !busy(s)) return none();
      return { state: { ...s, phase: "listening" }, effects: [{ type: "emit_state", phase: "listening" }] };
  }
}
