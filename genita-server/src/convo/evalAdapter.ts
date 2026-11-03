/**
 * Eval adapter for the conversation harness (PR #325, `npm run eval:convo -- --root <this genita-server>`).
 * Mirrors what session.ts does with GENITA_CONVO_V1 on, per scripted turn: the v1 instructions (+ opener on the
 * greeting, + initiative block on a quiet / camera cue), the memory lane's memoryPrompt exactly as the legacy
 * adapter uses it (so before/after differ only in this engine), then the sentence guard and opener guard.
 * Not imported by the server. Types are structural so this file needs nothing from evals/.
 */
import { avoidRepeatedOpener, buildInstructions, dropRepeatedName, type PersonaCard } from "../prompt/persona.ts";
import { memoryPrompt } from "../memory/call.ts";
import type { Memory } from "../memory/repository.ts";
import type { InputMessage, SparkRequest } from "../meta/spark.ts";
import { SentenceSplitter } from "../text/sentences.ts";
import { parseTaggedSentence } from "../text/tags.ts";
import { fallbackLine, guardSentence, neverSpoken, type GuardClass } from "./guard.ts";
import { noteHook, openerBlock, openerKind, pickOpenerHook, profileHooks } from "./opener.ts";
import { initiativeBlock, initiativeInput, type InitiativeSource } from "./initiative.ts";
import { moodFrom, moodLine, turnHints } from "./rhythm.ts";
import type { PerceptionTriggerKind } from "./types.ts";

type Turn = { kind: "greet" } | { kind: "user"; text: string } | { kind: "silence"; quietMs: number } | { kind: "perception"; hint: string; trigger?: string };
type Scenario = {
  persona: PersonaCard;
  user: { name?: string; profile?: string };
  callNumber: number;
  gapHours?: number;
  memories?: string[];
  opening?: string | null;
  summaries?: { open_threads: string[]; promises: string[]; asks: string[] }[];
};
/** series: consecutive calls of one user (harness --openers); index = which call, used as the day seed */
type Ctx = { scenario: Scenario; history: { role: "user" | "assistant"; text: string }[]; turn: Turn; series?: { id: string; index: number } };
/** #341: what the session persists per user (opener_topics), per eval series */
const recentBySeries = new Map<string, string[]>();

const GREET_PROMPT = "The call just connected. Greet the user.";
const H = 3_600_000;
const mem = (text: string, i: number): Memory => ({ id: `m${i}`, text, kind: "fact", created_at: 0, updated_at: 0, last_used_at: null, follow_up: false, source_session_id: "eval" });
const msgs = (h: Ctx["history"]): InputMessage[] => h.map((x): InputMessage => (x.role === "user" ? { role: "user", content: x.text } : { role: "assistant", content: x.text }));

function threads(s: Scenario): string[] {
  const notes = (s.summaries ?? []).flatMap((n) => [...n.open_threads, ...n.promises]);
  return [...(s.opening ? [s.opening] : []), ...notes, ...(s.memories ?? [])].slice(0, 3);
}

export const adapter = {
  request(ctx: Ctx): SparkRequest | null {
    const s = ctx.scenario;
    const t = ctx.turn;
    const base = { persona: s.persona, user: s.user, memories: undefined, mode: "chat" as const, language: "English", style: "v1" as const };
    if (t.kind === "greet") {
      const o = { hasProfile: !!s.user.profile, sinceLastMs: s.callNumber <= 1 ? null : (s.gapHours ?? 24) * H, hasItem: !!s.opening };
      const kind = openerKind(o);
      const key = ctx.series?.id ?? "";
      const recent = recentBySeries.get(key) ?? [];
      const rotates = kind === "first_known" || kind === "known" || kind === "back_today" || kind === "back_days";
      const hook = rotates ? pickOpenerHook(profileHooks(s.user.profile), recent, (ctx.series?.index ?? [...(s as { id?: string }).id ?? ""].reduce((n, c) => n + c.charCodeAt(0), 0)) + recent.length) : null;
      if (hook && ctx.series) recentBySeries.set(key, noteHook(recent, hook));
      const opener = openerBlock({ ...o, hook, lastHook: recent.at(-1) ?? null, lastMood: (s.summaries?.[0] as { mood?: string | null } | undefined)?.mood ?? null });
      const instructions = buildInstructions({ ...base, opener }) + memoryPrompt(s.opening ? [mem(s.opening, 0)] : [], true);
      return { instructions, input: GREET_PROMPT, maxOutputTokens: 800, effort: "minimal" };
    }
    if (t.kind === "silence" || t.kind === "perception") {
      // the governor's budget is unit-tested; here every scripted cue is one allowed initiative
      const source: InitiativeSource = t.kind === "perception" && t.trigger ? (t.trigger as PerceptionTriggerKind) : "silence";
      const instructions = buildInstructions({ ...base, initiative: initiativeBlock(source, threads(s)) });
      return { instructions, input: [...msgs(ctx.history), { role: "user", content: initiativeInput(source) }], maxOutputTokens: 800, effort: "minimal" };
    }
    // P1 "This turn:" line, as session.v1Extras builds it (closeness, question rhythm, mood, landed, recall)
    const userLines = [...ctx.history.filter((h) => h.role === "user").map((h) => h.text), t.text];
    const turn = turnHints({
      callNumber: s.callNumber,
      lastReply: ctx.history.filter((h) => h.role === "assistant").at(-1)?.text,
      userText: t.text,
      mood: moodLine(moodFrom(userLines)),
      remembers: !!(s.memories?.length || s.summaries?.length || s.opening),
      recentReplies: ctx.history.filter((h) => h.role === "assistant").slice(-3).map((h) => h.text),
      userLines,
    }) ?? undefined;
    const instructions = buildInstructions({ ...base, turn }) + memoryPrompt((s.memories ?? []).map(mem), false);
    return { instructions, input: [...msgs(ctx.history), { role: "user", content: t.text }], maxOutputTokens: 800, effort: "minimal" };
  },

  /** the session's per-sentence path: opener guard on the first, sentence guard on all, never empty */
  post(raw: string, ctx: Ctx): string {
    const userText = ctx.turn.kind === "user" ? ctx.turn.text : "";
    const recent = ctx.history.filter((h) => h.role === "assistant").slice(-3).map((h) => h.text);
    const sp = new SentenceSplitter();
    const parts = [...sp.push(raw), ...sp.flush()];
    const kept: string[] = [];
    let first: { raw: string; cls: GuardClass } | null = null;
    for (const part of parts) {
      let tts = kept.length ? part : avoidRepeatedOpener(part, recent);
      if (tts) tts = dropRepeatedName(tts, ctx.scenario.user.name, [...recent.slice(-2), ...kept]);
      if (!tts) continue;
      if (!parseTaggedSentence(tts).displayText) continue;
      const found = guardSentence(parseTaggedSentence(tts).displayText, { camera: false, userText });
      const cls = found === "narration" && kept.length ? null : found;
      if (cls) { if (!neverSpoken(cls)) first ??= { raw: part, cls }; continue; }
      kept.push(tts);
    }
    if (!kept.length && first) return fallbackLine(first.cls) ?? first.raw;
    return kept.join(" ");
  },
};

export default adapter;
