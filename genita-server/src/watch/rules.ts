/**
 * Watch-together rules as pure functions (F5-L13/L14/L16), so every timing
 * rule is unit-testable without sockets or vendors.
 */

/** at most one reaction every ~25 s (Chelsea 11/3: one per 20–30 s) */
export const REACT_MIN_GAP_MS = 25_000;
/** no reaction in the first seconds of a share: nothing has happened yet */
export const REACT_AFTER_START_MS = 6_000;
/** a dialogue line that ended this recently still counts as "talking" */
export const DIALOGUE_TAIL_MS = 700;
/** a memo verdict older than this is about a moment that has passed */
export const REACT_MAX_STALE_MS = 9_000;

export type ReactGate = {
  now: number;
  sharing: boolean;
  blank: boolean;
  sharingSince: number;
  lastReactionAt: number | null;
  /** companion idle (listening) and the user is not speaking */
  conversationQuiet: boolean;
  /** the video's audio has an open speech turn */
  dialogueActive: boolean;
  lastDialogueEndAt: number | null;
  /** when the frames/lines the verdict is about were current */
  verdictAt: number;
  /** the video's sound right now is crowd, music, commentary or narration (fine to talk over), not a scene's dialogue */
  talkOver?: boolean;
};

export type GateResult = { ok: true } | { ok: false; why: string };

/** F5-L14: only while sharing, at most once per 30 s, never over dialogue or anyone talking. */
export function reactionAllowed(g: ReactGate): GateResult {
  if (!g.sharing) return { ok: false, why: "not_sharing" };
  if (g.blank) return { ok: false, why: "blank" };
  if (g.now - g.sharingSince < REACT_AFTER_START_MS) return { ok: false, why: "just_started" };
  if (g.lastReactionAt !== null && g.now - g.lastReactionAt < REACT_MIN_GAP_MS) return { ok: false, why: "gap" };
  if (!g.conversationQuiet) return { ok: false, why: "conversation" };
  if (!g.talkOver && g.dialogueActive) return { ok: false, why: "dialogue" };
  if (!g.talkOver && g.lastDialogueEndAt !== null && g.now - g.lastDialogueEndAt < DIALOGUE_TAIL_MS) return { ok: false, why: "dialogue" };
  if (g.now - g.verdictAt > REACT_MAX_STALE_MS) return { ok: false, why: "stale" };
  return { ok: true };
}

export type Moment = "none" | "funny" | "surprising" | "sweet";

const AUDIO_TAG = /\[[^\[\]\n]{1,30}\]/g;
const EMOTION_TAG = /<\s*[A-Za-z][A-Za-z_-]{0,23}\s*>/g;

/**
 * A reaction that tells a story the frames can't show (AI sweep 11/3, prod + local watch-sim: a blurred jumpstyle
 * dance became "Whoa he's losing balance", "Oh he totally dodged that", "Oh his shoe flew off"): balance, dodging,
 * near misses, things flying off, what's about to happen. Better silent than invented; the memo's next verdict can
 * still react. A plain fall or fail ("he fell", "total wipeout") is not a guess and stays.
 */
const GUESS = /\b(?:los(?:ing|t|es) (?:(?:his|her|their|the) )?balance|off balance|dodg(?:e|ed|es|ing)|almost|nearly|about to|gonna (?:fall|eat it|crash)|(?:shoe|hat|cap|shirt|pants|wig|glasses) (?:flew|flying|fell|falling|came) off|flew off|wobbl\w*|stumbl\w*|slipp(?:ed|ing)|trip(?:ped|ping)|hurt|injur\w*)\b/i;
export function isGuessLine(words: string): boolean {
  return GUESS.test(words);
}

/**
 * The spoken reaction line: Spark writes the words only; the tags are ours.
 * funny → <laugh> [laughs] (the app plays the laugh clip on speaking.emotion
 * "laugh"; spoken normalization removes the bracketed delivery tag).
 */
export function reactionScript(moment: Moment, words: string): string | null {
  const clean = words.replace(AUDIO_TAG, " ").replace(EMOTION_TAG, " ").replace(/\s+/g, " ").trim();
  if (moment === "none" || !clean || isGuessLine(clean)) return null;
  const capped = clean.split(" ").slice(0, 12).join(" ");
  // the face: funny → smileopen (laugh draws as smileopen for now, 11/3), sweet → smile, surprising → surprised
  if (moment === "funny") return `<laugh> [smileopen] [laughs] ${capped}`;
  if (moment === "surprising") return `<surprised> [surprised] ${capped}`;
  return `<warm> [smile] ${capped}`;
}

// ───────────────────────── echo guard (F5-L13) ─────────────────────────

const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * True when the user's "turn" is really the video's sound leaking into the
 * mic (speakers, no earphones): most of its words appear in a line the
 * system-audio transcriber heard in the last few seconds.
 */
export function isVideoEcho(userText: string, recentLines: string[], minOverlap = 0.7): boolean {
  const u = tokens(userText);
  if (u.length < 2) return false;
  for (const line of recentLines) {
    const set = new Set(tokens(line));
    if (!set.size) continue;
    const hit = u.filter((w) => set.has(w)).length;
    if (hit / u.length >= minOverlap) return true;
  }
  return false;
}

/**
 * While the video is mid-line: can the user's turn be decided now from the line's partial transcript, or must
 * it wait for the line to finish? The system-audio transcriber hears the video before the mic's own turn ends,
 * so a real echo already shows in the partial. "wait" only when the partial is still too short to tell.
 * A one-word turn ("wow") is never treated as an echo (same as isVideoEcho).
 */
export function echoNow(userText: string, openLine: string, minOverlap = 0.7): "echo" | "user" | "wait" {
  const u = tokens(userText);
  if (u.length < 2) return "user";
  const open = tokens(openLine);
  if (!open.length) return "wait";
  const set = new Set(open);
  if (u.filter((w) => set.has(w)).length / u.length >= minOverlap) return "echo";
  return open.length >= u.length ? "user" : "wait";
}

// ───────────────────────── speaker chip (F5-L16) ─────────────────────────

export const SPEAKER_WINDOW_MS = 120_000;
export const SPEAKER_SILENCE_MS = 3_000;

/**
 * Show the chip only once two or more voices have been heard recently: one
 * narrator or one YouTuber gets no chip.
 */
export function speakerChipEnabled(labelsSeen: { label: string; at: number }[], now: number): boolean {
  const recent = new Set(labelsSeen.filter((l) => now - l.at <= SPEAKER_WINDOW_MS).map((l) => l.label));
  return recent.size >= 2;
}

/** Pick up to `max` frames: the newest, then older ones about `spacingMs` apart. */
export function pickFrames<T extends { at: number }>(frames: T[], max: number, spacingMs: number): T[] {
  if (!frames.length || max <= 0) return [];
  const sorted = [...frames].sort((a, b) => a.at - b.at);
  const out: T[] = [sorted[sorted.length - 1]];
  let edge = out[0].at - spacingMs;
  for (let i = sorted.length - 2; i >= 0 && out.length < max; i--) {
    if (sorted[i].at <= edge) {
      out.push(sorted[i]);
      edge = sorted[i].at - spacingMs;
    }
  }
  return out.reverse();
}
