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
/** Modal Shared Endpoint model id (docs 11/3: `meta/muse-spark-open`; the endpoint's own /v1/models has the exact id) */
export const MODAL_DEFAULT_MODEL = "meta/muse-spark-open";
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

export type Provider = "baseten" | "modal";
/** Where Spark Open is served. Never logged whole: `key` stays in here. */
export type SparkOpenTarget = { provider: Provider; base: string; model: string; name: string; key: string };

/**
 * The configured Spark Open server, or null (off / no key). Pluggable (11/3: the Baseten hackathon model may
 * stay locked until the credit grant lands):
 *   GENITA_SPARK_OPEN_PROVIDER=baseten (default)  BASETEN_API_KEY, model meta-models/muse-spark-open-1026
 *   GENITA_SPARK_OPEN_PROVIDER=modal              MODAL_ENDPOINT_KEY (proxy token "wk-….ws-…"), GENITA_SPARK_OPEN_URL
 *                                                 (the endpoint URL), model meta/muse-spark-open
 *   GENITA_SPARK_OPEN_MODEL overrides the model id; GENITA_SPARK_OPEN=0 turns it all off.
 */
export function sparkOpenTarget(env: NodeJS.ProcessEnv = process.env): SparkOpenTarget | null {
  if (env.GENITA_SPARK_OPEN === "0") return null;
  const provider: Provider = env.GENITA_SPARK_OPEN_PROVIDER?.trim().toLowerCase() === "modal" ? "modal" : "baseten";
  const key = (provider === "modal" ? env.MODAL_ENDPOINT_KEY : env.BASETEN_API_KEY)?.trim();
  let base = provider === "modal" ? (env.GENITA_SPARK_OPEN_URL ?? "").trim().replace(/\/+$/, "") : BASETEN_BASE;
  if (!key || !/^https:\/\//.test(base)) return null;
  if (!/\/v1$/.test(base)) base += "/v1";
  const model = env.GENITA_SPARK_OPEN_MODEL?.trim() || (provider === "modal" ? MODAL_DEFAULT_MODEL : SPARK_OPEN_MODEL);
  return { provider, base, model, name: model.slice(model.lastIndexOf("/") + 1), key };
}

/** The key when Spark Open is configured (not necessarily available yet), else null. */
export function sparkOpenKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return sparkOpenTarget(env)?.key ?? null;
}

// ── availability (11/3): the model may be configured but not yet open to our account ──
export type SparkOpenState = "available" | "not_listed" | "no_key" | "unknown" | "error";
const sig = (t: SparkOpenTarget) => `${t.provider}|${t.base}|${t.model}`;
let probed: { sig: string; status: "available" | "not_listed" | "error"; at: number } | null = null;

/** What the server knows right now (no network): no_key, unknown (not probed yet), available, not_listed, error. */
export function sparkOpenState(env: NodeJS.ProcessEnv = process.env): SparkOpenState {
  const t = sparkOpenTarget(env);
  if (!t) return "no_key";
  return probed && probed.sig === sig(t) ? probed.status : "unknown";
}

/** Tests / ops: set the probe result for the current target without the network. */
export function markSparkOpen(status: "available" | "not_listed" | "error" | null, env: NodeJS.ProcessEnv = process.env): void {
  const t = sparkOpenTarget(env);
  probed = status && t ? { sig: sig(t), status, at: Date.now() } : null;
}

/** Calls go to Spark Open only when the last probe found the model. */
export function activeSparkOpen(env: NodeJS.ProcessEnv = process.env): SparkOpenTarget | null {
  const t = sparkOpenTarget(env);
  return t && probed?.sig === sig(t) && probed.status === "available" ? t : null;
}

/**
 * Is the model there for us? GET /v1/models lists it → available. Not listed (hackathon ids can be hidden)
 * → one tiny completion; a 200 also counts as available. Otherwise not_listed. A network failure keeps the
 * last result (error when there is none). Logs `llm.spark_open` when the status changes; never the key.
 */
export async function probeSparkOpen(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<SparkOpenState> {
  const t = sparkOpenTarget(env);
  if (!t) { probed = null; return "no_key"; }
  // generation paused (ops kill switch): no vendor request at all, not even the probe's tiny call (Codex P2)
  if (getOps().isPaused("spark_open")) return sparkOpenState(env);
  const budget = (ms: number) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));
  const headers = { authorization: `Bearer ${t.key}`, "content-type": "application/json" };
  const before = sparkOpenState(env);
  let status: "available" | "not_listed" | "error";
  let detail: Record<string, unknown> = {};
  try {
    const r = await fetch(t.base + "/models", { headers, signal: budget(10_000) });
    const ids = r.ok ? (((await r.json()) as { data?: Array<{ id?: string }> }).data ?? []).map((m) => m.id) : (await r.body?.cancel().catch(() => {}), []);
    if (ids.includes(t.model)) { status = "available"; detail = { listed: true }; }
    else {
      signal?.throwIfAborted();
      const c = await fetch(t.base + "/chat/completions", {
        method: "POST", headers, signal: budget(60_000),
        body: JSON.stringify({ model: t.model, messages: [{ role: "user", content: "Reply with: ok" }], max_tokens: 64 }),
      });
      await c.body?.cancel().catch(() => {});
      status = c.ok ? "available" : "not_listed";
      detail = { listed: false, models_http: r.status, call_http: c.status };
    }
  } catch (err) {
    status = probed?.sig === sig(t) && probed.status !== "error" ? probed.status : "error";
    detail = { probe_error: errorKind(err) };
  }
  probed = { sig: sig(t), status, at: Date.now() };
  if (status !== before) logLlm("llm.spark_open", { status, provider: t.provider, model: t.name, ...detail });
  return status;
}

let stopProbe: (() => void) | null = null;
/**
 * Boot: probe now, then every 10 min (a later credit grant is picked up without a redeploy). One per process;
 * nothing starts without a configured target in `env`. Returns stop (timer + any in-flight probe request).
 */
export function startSparkOpenProbe(env: NodeJS.ProcessEnv = process.env, everyMs = 10 * 60_000): () => void {
  if (stopProbe) return stopProbe;
  if (!sparkOpenTarget(env)) return () => {};
  const ac = new AbortController();
  const run = () => { if (!ac.signal.aborted) void probeSparkOpen(env, ac.signal).catch(() => {}); };
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  const stop = () => { clearInterval(timer); ac.abort(); if (stopProbe === stop) stopProbe = null; };
  stopProbe = stop;
  run();
  return stop;
}

/** /healthz: state + where, never the key. */
export function sparkOpenStatus(env: NodeJS.ProcessEnv = process.env) {
  const t = sparkOpenTarget(env);
  const provider = t?.provider ?? (env.GENITA_SPARK_OPEN_PROVIDER?.trim().toLowerCase() === "modal" ? "modal" : SPARK_OPEN_PROVIDER);
  return { spark_open: sparkOpenState(env), spark_open_provider: provider, spark_open_model: t?.model ?? (provider === "modal" ? MODAL_DEFAULT_MODEL : SPARK_OPEN_MODEL) };
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
export async function sparkOpenJson<T>(t: SparkOpenTarget, req: StructuredRequest, signal?: AbortSignal): Promise<T> {
  if (getOps().isPaused("spark_open")) throw new SparkOpenError("paused", null);
  const body = {
    model: t.model,
    messages: messages(req),
    max_tokens: Math.max(MIN_MAX_TOKENS, (req.maxOutputTokens ?? 0) * 4),
    response_format: { type: "json_schema", json_schema: { name: req.schemaName, schema: req.schema, strict: true } },
  };
  const t0 = performance.now();
  const done = (ok: boolean, extra: Record<string, unknown> = {}) =>
    logLlm("llm.call", { model: t.name, provider: t.provider, purpose: req.schemaName, ok, ms: Math.round(performance.now() - t0), ...extra });
  try {
    const r = await fetch(t.base + "/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${t.key}`, "content-type": "application/json" },
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
  const target = activeSparkOpen();
  if (!target || !textOnly(req)) return museJson<T>(metaKey, req, withBudget(opts.timeoutMs));
  try {
    return await sparkOpenJson<T>(target, req, withBudget(opts.openTimeoutMs ?? OPEN_TIMEOUT_MS));
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    logLlm("llm.fallback", { from: target.name, to: MUSE_NAME, purpose: req.schemaName, status: err instanceof UpstreamError ? err.status : null });
    return museJson<T>(metaKey, req, withBudget(opts.timeoutMs));
  }
}

/** sparkJson's hop: a Muse Spark API 5xx (or network failure) on a text-only json_schema call → Spark Open once. */
export function openFallbackFor(err: unknown, req: StructuredRequest, signal?: AbortSignal): SparkOpenTarget | null {
  if (signal?.aborted || !textOnly(req)) return null;
  const outage = (err instanceof UpstreamError && err.vendor === "meta" && err.status !== null && err.status >= 500) || (err instanceof TypeError && /fetch failed/i.test(err.message));
  return outage ? activeSparkOpen() : null;
}
