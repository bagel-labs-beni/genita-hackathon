/**
 * Chelsea 11/4: the find trigger decides from BOTH what was said and what the camera / screen shows.
 *
 * The keyword intents (intent.ts, general.ts) stay the fast path. When they say nothing and the line is "open"
 * (no rule says talk only: assessLine), a small Spark call looks at the line, the last two exchanges and the latest
 * camera or screen frame and answers one of none | identify | recipe | outfit | product | general | link. It runs
 * beside the spoken reply (never delays it) and gives up after JUDGE_TIMEOUT_MS (5 s, → none). A kind other than none
 * starts the same runner pipeline as the keyword path. GENITA_FIND_JUDGE=0 turns it off (default on).
 */
import { lastJsonObject, str } from "./parse.ts";
import { userMessage, type FindsVendors } from "./vendors.ts";

export type JudgeKind = "none" | "identify" | "recipe" | "outfit" | "product" | "general" | "link";
export type JudgeResult = { kind: JudgeKind; query?: string; reason: string };
/** `scene`: a text description of the picture instead of the frame (eval script; no live scene feed exists today) */
export type JudgeInput = { text: string; recent: string[]; frame?: string; screen?: boolean; scene?: string };
export type Judge = (input: JudgeInput, signal: AbortSignal) => Promise<JudgeResult>;

/**
 * Brief said ~1.5 s, but live Spark (11/4, n=10, scripts/find-judge-eval.ts) answers in p50 2.4 s / p90 4.4 s on text and
 * p50 4.0 s with a camera frame: at 1.5 s nothing would ever land. The judge runs beside the spoken reply, so a longer
 * deadline only delays the sheet, never speech.
 */
export const JUDGE_TIMEOUT_MS = 5000;
const KINDS = new Set<JudgeKind>(["none", "identify", "recipe", "outfit", "product", "general", "link"]);

export function judgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GENITA_FIND_JUDGE !== "0";
}

export function judgePrompt(i: JudgeInput): string {
  return [
    "You decide whether one turn of a live video call should open a card on the user's screen. Pick exactly one kind:",
    "- none: greetings, feelings, small talk, opinions about something shown (\"how about this?\", \"is this one better?\"), questions about you or about them. When unsure, none.",
    "- identify: they want to know what the object they show is (\"what is this exactly?\").",
    "- recipe: what to cook or eat from food that is shown.",
    "- outfit: choosing between clothes they show or wear.",
    "- product: find or buy something (\"where can I get these?\", \"find me one like this\").",
    "- general: a look-up or information question the web answers (facts, news, places, how-to).",
    "- link: they shared a web address to read.",
    i.recent.length ? `Recent conversation:\n${i.recent.map((l) => l.slice(0, 200)).join("\n")}` : "Recent conversation: (none)",
    i.frame ? `The attached picture is their ${i.screen ? "shared screen" : "camera"} right now.` : i.scene ? `Their camera shows: ${i.scene.slice(0, 200)}` : "No picture.",
    `They just said: "${i.text.slice(0, 300)}"`,
    'Reply with only JSON: {"kind": "none|identify|recipe|outfit|product|general|link", "query": "for product or general: what to search, filling in what the conversation or picture shows (e.g. white leather sneakers like the ones shown)", "reason": "under 10 words"}',
  ].join("\n");
}

export function parseJudge(text: string): JudgeResult {
  const j = lastJsonObject<{ kind?: unknown; query?: unknown; reason?: unknown }>(text);
  const kind = str(j?.kind, 20).toLowerCase() as JudgeKind;
  if (!KINDS.has(kind)) return { kind: "none", reason: "unparsed" };
  const query = str(j?.query, 160);
  return { kind, ...(query && (kind === "product" || kind === "general") ? { query } : {}), reason: str(j?.reason, 80) || kind };
}

/** The real judge: one Spark call (the server's cheap path: effort minimal; 400 tokens, since reasoning spends ~120 before the JSON), the frame attached if any. */
export function sparkJudge(vendors: FindsVendors): Judge {
  return async (i, signal) => {
    const res = await vendors.spark({ input: userMessage(judgePrompt(i), i.frame ? [i.frame] : []), effort: "minimal", maxOutputTokens: 400 }, signal);
    return parseJudge(res.text);
  };
}

/** The judge with a deadline: a slow or failed call is "none" (no card, the spoken reply stands alone). */
export async function judgeWithin(judge: Judge, input: JudgeInput, ms: number, parent?: AbortSignal): Promise<JudgeResult & { ms?: number }> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  parent?.addEventListener("abort", stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<JudgeResult>((resolve) => {
    timer = setTimeout(() => { abort.abort(); resolve({ kind: "none", reason: "timeout" }); }, ms);
  });
  try {
    return await Promise.race([judge(input, abort.signal).catch((): JudgeResult => ({ kind: "none", reason: "error" })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener("abort", stop);
  }
}
