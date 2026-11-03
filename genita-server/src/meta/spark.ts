/**
 * Muse Spark 1.3 over the Responses API (POST /v1/responses).
 * Streaming events observed 11/2: response.created … response.output_text.delta
 * … response.completed, then `data: [DONE]`. With the web_search tool:
 * response.web_search_call.{in_progress,searching,completed}.
 */
import { META_BASE, UpstreamError, metaHeaders, metaJson } from "./http.ts";
import { getOps } from "../ops/limits.ts";
import { SseParser } from "./sse.ts";
import { openHopTimeoutMs, logLlm, openFallbackFor, sparkOpenJson } from "./sparkOpen.ts";

export const SPARK_MODEL = "muse-spark-1.3";

export type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "input_file"; file_id: string };
export type InputMessage =
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string };
export type FunctionCall = { type: "function_call"; call_id: string; name: string; arguments: string };
export type SparkInputItem = InputMessage | FunctionCall | { type: "function_call_output"; call_id: string; output: string };
export type SparkInput = string | SparkInputItem[];
export type Tool = { type: "web_search" } | Record<string, unknown>;

export type SparkRequest = {
  input: SparkInput;
  instructions?: string;
  tools?: Tool[];
  effort?: "minimal" | "low" | "medium" | "high";
  maxOutputTokens?: number;
  text?: Record<string, unknown>;
};

export type SparkStreamEvent =
  | { type: "text"; delta: string }
  | FunctionCall
  | { type: "tool"; name: string; status: string }
  /** one finished web search: its query and the result pages it returned (not opened) */
  | { type: "sources"; query: string; urls: string[] }
  | { type: "done"; responseId: string | null; text: string; status: string };

function body(req: SparkRequest, stream: boolean) {
  return {
    model: SPARK_MODEL,
    input: req.input,
    stream,
    reasoning: { effort: req.effort ?? "minimal" },
    ...(req.instructions ? { instructions: req.instructions } : {}),
    ...(req.tools?.length ? { tools: req.tools } : {}),
    ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
    ...(req.text ? { text: req.text } : {}),
    // a search's result URLs (11/3 probe: without this the search action has only the query)
    ...(req.tools?.some((t) => t.type === "web_search") ? { include: ["web_search_call.action.sources"] } : {}),
  };
}

type WebSearchItem = { type: "web_search_call"; id?: string; action?: { type?: string; query?: string; queries?: string[]; sources?: Array<{ type?: string; url?: string }> } };

/** A finished search's result pages, or null (an open_page action, or no sources). */
export function searchSources(item: WebSearchItem): { type: "sources"; query: string; urls: string[] } | null {
  const a = item.action;
  if (!a || (a.type && a.type !== "search")) return null;
  const urls = [...new Set((a.sources ?? []).map((s) => s?.url ?? "").filter((u) => /^https?:\/\//i.test(u)))];
  if (!urls.length) return null;
  return { type: "sources", query: String(a.query ?? a.queries?.[0] ?? "").slice(0, 200), urls };
}

/**
 * Streams a reply. Throws UpstreamError on HTTP errors, and if no text or
 * tool event arrives within firstEventTimeoutMs (F4: 8 s, no fake answer).
 */
export async function* sparkStream(
  key: string,
  req: SparkRequest,
  opts: { signal?: AbortSignal; firstEventTimeoutMs?: number } = {},
): AsyncGenerator<SparkStreamEvent> {
  const timeout = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(new Error("spark first-token timeout")), opts.firstEventTimeoutMs ?? 8000);
  try {
    getOps().consumeMeta();
    const r = await fetch(META_BASE + "/responses", { method: "POST", headers: metaHeaders(key), body: JSON.stringify(body(req, true)), signal });
    if (!r.ok || !r.body) throw new UpstreamError("meta", r.status, await r.text().catch(() => ""));
    const parser = new SseParser();
    const dec = new TextDecoder();
    let text = "";
    let responseId: string | null = null;
    const calls = new Set<string>();
    const searches = new Set<string>();
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      for (const ev of parser.feed(dec.decode(chunk, { stream: true }))) {
        if (ev.data === "[DONE]") continue;
        let e: { type?: string; delta?: string; item?: FunctionCall | WebSearchItem; response?: { id?: string; status?: string; output?: Array<FunctionCall | WebSearchItem | { type: "message"; content?: Array<{ type: string; text?: string }> }>; error?: { message?: string } | null } };
        try {
          e = JSON.parse(ev.data);
        } catch {
          continue;
        }
        const type = e.type ?? ev.event;
        if (type === "response.created" && e.response?.id) responseId = e.response.id;
        if (type === "response.output_text.delta" && e.delta) {
          if (e.delta.trim()) clearTimeout(timer);
          text += e.delta;
          yield { type: "text", delta: e.delta };
        } else if (type === "response.output_item.done" && e.item?.type === "function_call") {
          clearTimeout(timer);
          if (!calls.has(e.item.call_id)) { calls.add(e.item.call_id); yield e.item; }
        } else if (type === "response.output_item.done" && e.item?.type === "web_search_call") {
          const found = searchSources(e.item);
          if (found && !searches.has(e.item.id ?? found.query)) { searches.add(e.item.id ?? found.query); yield found; }
        } else if (type.startsWith("response.web_search_call.")) {
          clearTimeout(timer);
          yield { type: "tool", name: "web_search", status: type.split(".").pop() ?? "" };
        } else if (type === "response.failed" || type === "error") {
          throw new UpstreamError("meta", null, e.response?.error?.message ?? ev.data);
        } else if (type === "response.completed" || type === "response.incomplete") {
          // Some completed responses include output only in the terminal
          // object. Recover the missing suffix, never replay existing deltas.
          const finalText = outputText(e.response ?? {});
          if (finalText.startsWith(text) && finalText.length > text.length) {
            const delta = finalText.slice(text.length);
            text = finalText;
            yield { type: "text", delta };
          }
          for (const item of e.response?.output ?? []) {
            if (item.type === "function_call" && !calls.has(item.call_id)) { calls.add(item.call_id); yield item; }
            if (item.type === "web_search_call") {
              const found = searchSources(item);
              if (found && !searches.has(item.id ?? found.query)) { searches.add(item.id ?? found.query); yield found; }
            }
          }
          yield { type: "done", responseId: e.response?.id ?? responseId, text, status: e.response?.status ?? type.split(".")[1] };
          return;
        }
      }
    }
    yield { type: "done", responseId, text, status: "stream_ended" };
  } finally {
    clearTimeout(timer);
  }
}

type ResponseObject = { id?: string; output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> };

export function outputText(d: ResponseObject): string {
  return (d.output ?? [])
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === "output_text" || c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

/** One-shot call returning plain text. */
export async function sparkText(key: string, req: SparkRequest, signal?: AbortSignal): Promise<string> {
  return outputText(await metaJson<ResponseObject>(key, "/responses", body(req, false), signal));
}

/** Structured output via text.format json_schema; returns the parsed object. */
export async function museJson<T>(
  key: string,
  req: Omit<SparkRequest, "text"> & { schemaName: string; schema: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<T> {
  const { schemaName, schema, ...rest } = req;
  const raw = await sparkText(
    key,
    { ...rest, text: { format: { type: "json_schema", name: schemaName, schema, strict: true } } },
    signal,
  );
  const m = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) throw new UpstreamError("meta", null, `spark json: no JSON in reply: ${raw.slice(0, 120)}`);
  return JSON.parse(m[0]) as T;
}

/**
 * sparkJson = museJson (the Muse Spark API json_schema call above) + one Muse Spark Open hop: a Muse Spark
 * API 5xx/504 (or network failure) on a text-only call tries Muse Spark Open on Baseten once when it is
 * configured (meta/sparkOpen.ts); if that fails too, the original error is thrown. museJson alone (no hop)
 * is what sparkOpen.ts falls back to, so the two never bounce.
 */
export async function sparkJson<T>(...args: Parameters<typeof museJson>): Promise<T> {
  const [, req, signal] = args;
  try {
    return await museJson<T>(...args);
  } catch (err) {
    const open = openFallbackFor(err, req, signal);
    if (!open) throw err;
    logLlm("llm.fallback", { from: SPARK_MODEL, to: open.name, purpose: req.schemaName, status: err instanceof UpstreamError ? err.status : null });
    // its own budget even when the caller passed none (Codex P2): an outage must still end in the original error
    const budget = AbortSignal.timeout(openHopTimeoutMs());
    return sparkOpenJson<T>(open, req, signal ? AbortSignal.any([signal, budget]) : budget).catch(() => { throw err; });
  }
}
