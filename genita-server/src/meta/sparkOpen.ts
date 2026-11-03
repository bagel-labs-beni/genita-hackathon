/**
 * Muse Spark Open (Meta open weights) served on Baseten Model APIs — 11/3, for the hackathon prize
 * "Best Build on Meta Open Weight Models". OpenAI-compatible Chat Completions:
 *   POST https://inference.baseten.co/v1/chat/completions, `Authorization: Bearer $BASETEN_API_KEY`,
 *   model `meta-models/muse-spark-open-1026` (the hackathon id; the public docs say `meta-models/muse-spark-open`).
 * Baseten docs (11/3): this model ALWAYS reasons (no reasoning_effort) and "accepts json_schema but doesn't
 * enforce the schema" — so the schema also rides in the system prompt, the answer is checked here, and a
 * reply that breaks it is an error (the caller falls back to the Muse Spark API).
 *
 * Routing (see backgroundJson and sparkJson):
 *   - background structured calls (memory extraction, recall keys, call summaries + their safety pass,
 *     after-call profile growth) go to Spark Open FIRST; on failure/timeout → Muse Spark API.
 *   - every Muse Spark API json_schema call that gets a 5xx tries Spark Open once (text-only, no tools).
 *   - live conversation, vision, web_search and Voice Transcribe stay on the Muse Spark API.
 * Config: BASETEN_API_KEY (SSM /genita/server/BASETEN_API_KEY); GENITA_SPARK_OPEN=0 turns it off.
 * Every call is logged as `llm.call` with model + provider + latency (never the key).
 */
import { UpstreamError } from "./http.ts";
import { getOps } from "../ops/limits.ts";
// spark.ts imports this module too; only functions cross the cycle, used at call time
import { museJson, type SparkRequest } from "./spark.ts";

export const SPARK_OPEN_MODEL = "meta-models/muse-spark-open-1026";
/** short name used in logs and /healthz */
export const SPARK_OPEN_NAME = "muse-spark-open-1026";
export const SPARK_OPEN_PROVIDER = "baseten";
export const BASETEN_BASE = "https://inference.baseten.co/v1";
/** the Muse Spark API model name as it appears in fallback logs (meta/spark.ts SPARK_MODEL) */
const MUSE_NAME = "muse-spark-1.3";
/** Spark Open's own budget in the background path; reasoning is always on, so generous */
const OPEN_TIMEOUT_MS = 45_000;
/** sparkJson's 5xx hop to Spark Open never waits longer than this, callers without a signal included (GENITA_SPARK_OPEN_HOP_MS) */
export function openHopTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.GENITA_SPARK_OPEN_HOP_MS);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}
/** reasoning tokens share max_tokens, so never cap a structured answer below this */
const MIN_MAX_TOKENS = 4096;

export type StructuredRequest = Omit<SparkRequest, "text"> & { schemaName: string; schema: Record<string, unknown> };
type Log = (event: string, data: Record<string, unknown>) => void;

const consoleLog: Log = (event, data) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
let llmLog: Log = consoleLog;
/** server.ts hands its logger in at start; null restores the default (JSON lines on stdout). */
export function setLlmLog(log: Log | null): void { llmLog = log ?? consoleLog; }
export function logLlm(event: string, data: Record<string, unknown>): void {
  try { llmLog(event, data); } catch { /* logging never breaks a call */ }
}

/** The Baseten key when Spark Open is on (key present and GENITA_SPARK_OPEN !== "0"), else null. */
export function sparkOpenKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.BASETEN_API_KEY?.trim();
  return key && env.GENITA_SPARK_OPEN !== "0" ? key : null;
}

/** /healthz: configured yes/no, never the key. */
export function sparkOpenStatus(env: NodeJS.ProcessEnv = process.env) {
  return { configured: !!sparkOpenKey(env), model: SPARK_OPEN_MODEL, provider: SPARK_OPEN_PROVIDER };
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** Spark Open gets text only: images, files and tool calls stay on the Muse Spark API. */
export function textOnly(req: Pick<SparkRequest, "input" | "tools">): boolean {
  if (req.tools?.length) return false;
  if (typeof req.input === "string") return true;
  return req.input.every((item) => "role" in item && (typeof item.content === "string" || item.content.every((p) => p.type === "input_text")));
}

function messages(req: StructuredRequest): ChatMessage[] {
  const rule = `Reply with ONLY one JSON value, no prose and no code fence, that matches this JSON Schema exactly (every required field, only the allowed enum values):\n${JSON.stringify(req.schema)}`;
  const out: ChatMessage[] = [{ role: "system", content: req.instructions ? `${req.instructions}\n\n${rule}` : rule }];
  if (typeof req.input === "string") return [...out, { role: "user", content: req.input }];
  for (const item of req.input) {
    if (!("role" in item)) throw new Error("spark open: tool items are not supported");
    const content = typeof item.content === "string" ? item.content
      : item.content.map((p) => { if (p.type !== "input_text") throw new Error("spark open: text input only"); return p.text; }).join("\n");
    out.push({ role: item.role, content });
  }
  return out;
}

/** The JSON in a reply: think blocks and code fences dropped, then the outermost object/array. */
export function extractJson(content: string): unknown {
  const s = content.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const first = s.search(/[[{]/);
  if (first < 0) throw new Error("no JSON");
  const close = s[first] === "{" ? "}" : "]";
  return JSON.parse(s.slice(first, s.lastIndexOf(close) + 1));
}

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[] };

/**
 * The JSON Schema subset our structured calls use: type, required, properties, items, enum. Length and
 * count caps are not checked (every caller trims and filters its own fields). Returns the first problem.
 */
export function schemaProblem(v: unknown, schema: Schema, at = "$"): string | null {
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const typeOf = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  if (types.length && !types.some((t) => t === typeOf || (t === "integer" && Number.isInteger(v)) || (t === "number" && typeOf === "number"))) return `${at}: expected ${types.join("|")}, got ${typeOf}`;
  if (schema.enum && !schema.enum.includes(v)) return `${at}: not in enum`;
  if (typeOf === "object" && schema.properties) {
    const o = v as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in o)) return `${at}.${k}: missing`;
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in o) { const p = schemaProblem(o[k], sub, `${at}.${k}`); if (p) return p; }
    }
  }
  if (typeOf === "array" && schema.items) {
    const a = v as unknown[];
    for (let i = 0; i < a.length; i++) { const p = schemaProblem(a[i], schema.items, `${at}[${i}]`); if (p) return p; }
  }
  return null;
}

type FailKind = "http" | "no_json" | "schema" | "paused";
/** A Spark Open failure. The message is a fixed kind + status / finish reason / schema path: no vendor text. */
export class SparkOpenError extends UpstreamError {
  readonly kind: FailKind;
  constructor(kind: FailKind, status: number | null, detail = "") {
    super("meta", status, `spark open ${kind}${detail ? `: ${detail}` : ""}`);
    this.kind = kind;
  }
}
/** For logs: what failed, never a vendor message (timeouts/aborts and network errors by name only). */
function errorKind(err: unknown): string {
  if (err instanceof SparkOpenError) return err.kind === "schema" || err.kind === "no_json" ? err.message.slice(0, 160) : err.kind;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "timeout";
  return err instanceof Error ? `network:${err.name}` : "unknown";
}

/**
 * One structured call to Muse Spark Open on Baseten. Throws UpstreamError (vendor "meta", it is a Meta
 * model) on HTTP errors, a reply without JSON, or JSON that breaks the schema.
 */
export async function sparkOpenJson<T>(key: string, req: StructuredRequest, signal?: AbortSignal): Promise<T> {
  if (getOps().isPaused("spark_open")) throw new SparkOpenError("paused", null);
  const body = {
    model: SPARK_OPEN_MODEL,
    messages: messages(req),
    max_tokens: Math.max(MIN_MAX_TOKENS, (req.maxOutputTokens ?? 0) * 4),
    response_format: { type: "json_schema", json_schema: { name: req.schemaName, schema: req.schema, strict: true } },
  };
  const t0 = performance.now();
  const done = (ok: boolean, extra: Record<string, unknown> = {}) =>
    logLlm("llm.call", { model: SPARK_OPEN_NAME, provider: SPARK_OPEN_PROVIDER, purpose: req.schemaName, ok, ms: Math.round(performance.now() - t0), ...extra });
  try {
    const r = await fetch(BASETEN_BASE + "/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    // never the response body: an error page can echo the request (Codex P1) — status only
    if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new SparkOpenError("http", r.status); }
    const d = (await r.json()) as { choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>; usage?: { completion_tokens?: number } };
    const content = d.choices?.[0]?.message?.content ?? "";
    let value: unknown;
    // never the reply text either (it can carry what the user said): kind + finish reason / schema path only
    try { value = extractJson(content); } catch { throw new SparkOpenError("no_json", null, d.choices?.[0]?.finish_reason ?? "?"); }
    const problem = schemaProblem(value, req.schema as Schema);
    if (problem) throw new SparkOpenError("schema", null, problem);
    done(true, d.usage?.completion_tokens ? { tokens: d.usage.completion_tokens } : {});
    return value as T;
  } catch (err) {
    done(false, { status: err instanceof UpstreamError ? err.status : null, error: errorKind(err) });
    throw err;
  }
}

/**
 * Background structured call: Spark Open first (own budget), Muse Spark API on any failure with a fresh
 * `timeoutMs` budget. Without Spark Open configured it is exactly the Muse Spark API call.
 */
export async function backgroundJson<T>(
  metaKey: string,
  req: StructuredRequest,
  opts: { timeoutMs: number; openTimeoutMs?: number; signal?: AbortSignal },
): Promise<T> {
  const withBudget = (ms: number) => (opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));
  const key = sparkOpenKey();
  if (!key || !textOnly(req)) return museJson<T>(metaKey, req, withBudget(opts.timeoutMs));
  try {
    return await sparkOpenJson<T>(key, req, withBudget(opts.openTimeoutMs ?? OPEN_TIMEOUT_MS));
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    logLlm("llm.fallback", { from: SPARK_OPEN_NAME, to: MUSE_NAME, purpose: req.schemaName, status: err instanceof UpstreamError ? err.status : null });
    return museJson<T>(metaKey, req, withBudget(opts.timeoutMs));
  }
}

/** sparkJson's hop: a Muse Spark API 5xx (or network failure) on a text-only json_schema call → Spark Open once. */
export function openFallbackFor(err: unknown, req: StructuredRequest, signal?: AbortSignal): string | null {
  if (signal?.aborted || !textOnly(req)) return null;
  const outage = (err instanceof UpstreamError && err.vendor === "meta" && err.status !== null && err.status >= 500) || (err instanceof TypeError && /fetch failed/i.test(err.message));
  return outage ? sparkOpenKey() : null;
}
