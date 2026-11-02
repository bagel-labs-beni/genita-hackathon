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
 * self_speak: the companion speaks on its own — a Finds card's line (F10) or a
 * watch-together reaction (F5-L14) — only from an idle state, never over the
 * user or its own reply. One path for both (11/2).
 */
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
};

export type TurnEvent =
  | { type: "speech_start" }
  | { type: "partial"; text: string }
  | { type: "speech_end" }
  | { type: "speech_complete"; text: string }
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

export type TurnConfig = { bargeInMinMs: number; bargeInMinWords: number };

export function initialTurnState(): TurnState {
  return { phase: "listening", utteranceId: 0, userSpeaking: false, pendingBargeIn: false, backchannel: false };
}

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const busy = (s: TurnState) => s.phase === "thinking" || s.phase === "speaking";

function cancel(s: TurnState, reason: CancelReason): { state: TurnState; effects: Effect[] } {
  return {
    state: { ...s, phase: "listening", pendingBargeIn: false, backchannel: false },
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
    state: { ...s, phase: "thinking", utteranceId, pendingBargeIn: false, backchannel: false },
    effects: [
      self ? { type: "start_reply", text, utteranceId, self } : { type: "start_reply", text, utteranceId },
      { type: "emit_state", phase: "thinking" },
    ],
  };
}

export function reduceTurn(s: TurnState, e: TurnEvent, cfg: TurnConfig): { state: TurnState; effects: Effect[] } {
  const none = (state: TurnState = s) => ({ state, effects: [] as Effect[] });
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
