/**
 * Muse Spark Open on Baseten (11/3, hackathon "Best Build on Meta Open Weight Models"):
 * background structured calls (memory extraction, recall keys, call summaries + their safety pass,
 * after-call profile growth) always go to Spark Open first, with Muse Spark API as the fallback;
 * Muse Spark API json_schema calls that hit a 5xx try Spark Open once. A fake fetch stands in for
 * both vendors; nothing here touches the network.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  SPARK_OPEN_MODEL, backgroundJson, setLlmLog, sparkOpenJson, sparkOpenKey, sparkOpenStatus,
} from "../src/meta/sparkOpen.ts";
import { sparkJson } from "../src/meta/spark.ts";
import { UpstreamError } from "../src/meta/http.ts";
import { metaExtractor, metaKeyMaker } from "../src/memory/extract.ts";
import { metaSummarizer } from "../src/memory/summaries.ts";
import { Personalize } from "../src/personalize/service.ts";

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["memories"],
  properties: { memories: { type: "array", items: { type: "object", required: ["text", "kind"], properties: { text: { type: "string" }, kind: { type: "string", enum: ["fact", "episode"] } } } } },
};
const REQ = { schemaName: "memoryExtract", schema: SCHEMA, instructions: "Extract.", input: "{\"turns\":[]}", maxOutputTokens: 300 };

type Seen = { host: string; path: string; auth: string | null; body: Record<string, unknown> };
type Reply = (s: Seen) => Response | Promise<Response>;

/** Fake fetch for both vendors; BASETEN_API_KEY set unless `key: null`. Restores everything after. */
function fake(t: TestContext, o: { open?: Reply; meta?: Reply; key?: string | null; flag?: string } = {}) {
  const env = { key: process.env.BASETEN_API_KEY, flag: process.env.GENITA_SPARK_OPEN };
  const original = globalThis.fetch;
  const seen: Seen[] = [];
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  if (o.key === null) delete process.env.BASETEN_API_KEY; else process.env.BASETEN_API_KEY = o.key ?? "test-baseten";
  if (o.flag === undefined) delete process.env.GENITA_SPARK_OPEN; else process.env.GENITA_SPARK_OPEN = o.flag;
  setLlmLog((event, data) => logs.push({ event, data }));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const s: Seen = { host: url.hostname, path: url.pathname, auth: headers.get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) };
    seen.push(s);
    const signal = init?.signal;
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const reply = url.hostname === "inference.baseten.co" ? (o.open ? o.open(s) : openOk({ memories: [] }))
      : url.hostname === "api.meta.ai" ? (o.meta ? o.meta(s) : metaOk({ memories: [] }))
      : Promise.reject(new Error(`unexpected host ${url.hostname}`));
    // like real fetch: an abort rejects a pending request
    return Promise.race([reply, new Promise<never>((_, rej) => signal?.addEventListener("abort", () => rej(signal.reason ?? new Error("aborted")), { once: true }))]);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
    setLlmLog(null);
    if (env.key === undefined) delete process.env.BASETEN_API_KEY; else process.env.BASETEN_API_KEY = env.key;
    if (env.flag === undefined) delete process.env.GENITA_SPARK_OPEN; else process.env.GENITA_SPARK_OPEN = env.flag;
  });
  return { seen, logs, hosts: () => seen.map((s) => s.host) };
}
/** Baseten chat completion; Spark Open always reasons, so content may carry a think block. */
const openOk = (v: unknown, prefix = "") => Response.json({ id: "cmpl-1", model: SPARK_OPEN_MODEL, choices: [{ index: 0, message: { role: "assistant", content: prefix + JSON.stringify(v) }, finish_reason: "stop" }] });
const metaOk = (v: unknown) => Response.json({ id: "resp_1", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(v) }] }] });

test("config: on when the key exists, GENITA_SPARK_OPEN=0 turns it off, status never shows the key", () => {
  assert.equal(sparkOpenKey({ BASETEN_API_KEY: "k" }), "k");
  assert.equal(sparkOpenKey({ BASETEN_API_KEY: "k", GENITA_SPARK_OPEN: "0" }), null);
  assert.equal(sparkOpenKey({}), null);
  assert.equal(sparkOpenKey({ BASETEN_API_KEY: "  " }), null);
  const s = sparkOpenStatus({ BASETEN_API_KEY: "secret-value" });
  assert.deepEqual(s, { configured: true, model: SPARK_OPEN_MODEL, provider: "baseten" });
  assert.ok(!JSON.stringify(s).includes("secret-value"));
  assert.equal(sparkOpenStatus({}).configured, false);
});

test("sparkOpenJson: Baseten chat completions with the hackathon model id, schema in the prompt, think block stripped, logged with latency", async (t) => {
  const f = fake(t, { open: () => openOk({ memories: [{ text: "Likes spicy food", kind: "fact" }] }, "<think>the user said…</think>\n") });
  const out = await sparkOpenJson<{ memories: unknown[] }>("test-baseten", REQ);
  assert.deepEqual(out, { memories: [{ text: "Likes spicy food", kind: "fact" }] });
  const [s] = f.seen;
  assert.equal(s.host, "inference.baseten.co");
  assert.equal(s.path, "/v1/chat/completions");
  assert.equal(s.auth, "Bearer test-baseten");
  assert.equal(s.body.model, "meta-models/muse-spark-open-1026");
  const rf = s.body.response_format as { type: string; json_schema: { name: string; schema: unknown } };
  assert.equal(rf.type, "json_schema");
  assert.equal(rf.json_schema.name, "memoryExtract");
  assert.deepEqual(rf.json_schema.schema, SCHEMA);
  const msgs = s.body.messages as Array<{ role: string; content: string }>;
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].content, /^Extract\./);
  assert.ok(msgs[0].content.includes(JSON.stringify(SCHEMA)), "schema is not enforced by Baseten for this model, so it rides in the prompt");
  assert.deepEqual(msgs[1], { role: "user", content: REQ.input });
  assert.ok((s.body.max_tokens as number) >= 4096, "reasoning is always on and shares max_tokens");
  const log = f.logs.find((l) => l.event === "llm.call");
  assert.ok(log);
  assert.equal(log.data.model, "muse-spark-open-1026");
  assert.equal(log.data.provider, "baseten");
  assert.equal(log.data.purpose, "memoryExtract");
  assert.equal(log.data.ok, true);
  assert.equal(typeof log.data.ms, "number");
  assert.ok(!JSON.stringify(f.logs).includes("test-baseten"), "never logs the key");
});

test("sparkOpenJson: an answer that breaks the schema (missing field, wrong enum, no JSON) is an error", async (t) => {
  for (const bad of [{ nope: 1 }, { memories: [{ text: "x" }] }, { memories: [{ text: "x", kind: "rumor" }] }, "no json here"]) {
    fake(t, { open: () => (typeof bad === "string" ? Response.json({ choices: [{ message: { content: bad } }] }) : openOk(bad)) });
    await assert.rejects(sparkOpenJson("test-baseten", REQ), UpstreamError, JSON.stringify(bad));
  }
});

test("sparkOpenJson: refuses image input (vision stays on Muse Spark API)", async (t) => {
  const f = fake(t);
  await assert.rejects(sparkOpenJson("test-baseten", { ...REQ, input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA" }] }] }));
  assert.equal(f.seen.length, 0);
});

test("backgroundJson: Spark Open first; Muse Spark API is never called when it answers", async (t) => {
  const f = fake(t, { open: () => openOk({ memories: [] }) });
  assert.deepEqual(await backgroundJson("test-meta", REQ, { timeoutMs: 5000 }), { memories: [] });
  assert.deepEqual(f.hosts(), ["inference.baseten.co"]);
});

test("backgroundJson: Spark Open failure (5xx, bad schema, timeout) falls back to Muse Spark API once", async (t) => {
  for (const open of [() => new Response("boom", { status: 503 }), () => openOk({ wrong: true })]) {
    const f = fake(t, { open, meta: () => metaOk({ memories: [{ text: "Has a cat named Miso", kind: "fact" }] }) });
    const out = await backgroundJson<{ memories: unknown[] }>("test-meta", REQ, { timeoutMs: 5000 });
    assert.equal(out.memories.length, 1);
    assert.deepEqual(f.hosts(), ["inference.baseten.co", "api.meta.ai"]);
    assert.ok(f.logs.some((l) => l.event === "llm.fallback" && l.data.from === "muse-spark-open-1026" && l.data.to === "muse-spark-1.3"));
  }
  // timeout: Spark Open hangs past its budget, Muse still answers with its own fresh budget
  const f = fake(t, { open: (s) => new Promise(() => void s) });
  const out = await backgroundJson<{ memories: unknown[] }>("test-meta", REQ, { timeoutMs: 5000, openTimeoutMs: 50 });
  assert.deepEqual(out, { memories: [] });
  assert.deepEqual(f.hosts(), ["inference.baseten.co", "api.meta.ai"]);
});

test("backgroundJson: Muse fallback 5xx does not bounce back to Spark Open", async (t) => {
  const f = fake(t, { open: () => new Response("down", { status: 500 }), meta: () => new Response("down", { status: 504 }) });
  await assert.rejects(backgroundJson("test-meta", REQ, { timeoutMs: 5000 }), (e: unknown) => e instanceof UpstreamError && e.status === 504);
  assert.deepEqual(f.hosts(), ["inference.baseten.co", "api.meta.ai"]);
});

test("backgroundJson: without the key (or with GENITA_SPARK_OPEN=0) it is the plain Muse Spark API call", async (t) => {
  for (const o of [{ key: null }, { flag: "0" }]) {
    const f = fake(t, o);
    assert.deepEqual(await backgroundJson("test-meta", REQ, { timeoutMs: 5000 }), { memories: [] });
    assert.deepEqual(f.hosts(), ["api.meta.ai"]);
  }
});

test("sparkJson: a Muse Spark API 5xx/504 tries Spark Open once and returns its answer", async (t) => {
  for (const status of [500, 502, 504]) {
    const f = fake(t, { meta: () => new Response("upstream timeout", { status }), open: () => openOk({ memories: [] }) });
    assert.deepEqual(await sparkJson("test-meta", REQ), { memories: [] });
    assert.deepEqual(f.hosts(), ["api.meta.ai", "inference.baseten.co"]);
    assert.ok(f.logs.some((l) => l.event === "llm.fallback" && l.data.from === "muse-spark-1.3" && l.data.to === "muse-spark-open-1026" && l.data.status === status));
  }
});

test("sparkJson: no Spark Open retry on 4xx, image input, tools, without the key, or when Spark Open also fails (original error kept)", async (t) => {
  const down = () => new Response("bad", { status: 400 });
  let f = fake(t, { meta: down });
  await assert.rejects(sparkJson("test-meta", REQ), (e: unknown) => e instanceof UpstreamError && e.status === 400);
  assert.deepEqual(f.hosts(), ["api.meta.ai"]);

  const five = () => new Response("down", { status: 503 });
  f = fake(t, { meta: five });
  await assert.rejects(sparkJson("test-meta", { ...REQ, input: [{ role: "user", content: [{ type: "input_image", image_url: "data:x" }] }] }));
  assert.deepEqual(f.hosts(), ["api.meta.ai"]);

  f = fake(t, { meta: five });
  await assert.rejects(sparkJson("test-meta", { ...REQ, tools: [{ type: "web_search" }] }));
  assert.deepEqual(f.hosts(), ["api.meta.ai"]);

  f = fake(t, { meta: five, key: null });
  await assert.rejects(sparkJson("test-meta", REQ));
  assert.deepEqual(f.hosts(), ["api.meta.ai"]);

  f = fake(t, { meta: five, open: () => new Response("also down", { status: 502 }) });
  await assert.rejects(sparkJson("test-meta", REQ), (e: unknown) => e instanceof UpstreamError && e.vendor === "meta" && e.status === 503);
  assert.deepEqual(f.hosts(), ["api.meta.ai", "inference.baseten.co"]);
});

test("routing: memory extraction, recall keys and call summaries (+ safety pass) go to Spark Open", async (t) => {
  const f = fake(t, {
    open: (s) => {
      const name = (s.body.response_format as { json_schema: { name: string } }).json_schema.name;
      if (name === "memoryExtract") return openOk({ memories: [{ text: "Likes spicy food", kind: "fact", sensitive: "none", follow_up: false, keys: ["food", "spicy"] }] });
      if (name === "memoryKeys") return openOk({ keys: ["cat", "pet"] });
      if (name === "callSummary") return openOk({ topics: ["Weekend hiking plans"], mood: "upbeat", open_threads: [], promises: [], asks: [], sensitive: false });
      if (name === "summary_safety") return openOk({ safe: [true, true] });
      return new Response("unexpected", { status: 400 });
    },
  });
  const mems = await metaExtractor("test-meta")([{ user: "I love spicy food", assistant: "Nice!" }]);
  assert.equal(mems[0].text, "Likes spicy food");
  assert.deepEqual(await metaKeyMaker("test-meta")("My cat Miso"), ["cat", "pet"]);
  const sum = await metaSummarizer("test-meta")([{ user: "Going hiking this weekend", assistant: "Fun!" }]);
  assert.deepEqual(sum?.topics, ["Weekend hiking plans"]);
  assert.ok(f.hosts().every((h) => h === "inference.baseten.co"), f.hosts().join(","));
  assert.deepEqual(f.logs.filter((l) => l.event === "llm.call").map((l) => l.data.purpose), ["memoryExtract", "memoryKeys", "callSummary", "summary_safety"]);
});

test("routing: after-call profile growth (endCall) uses the background client; in-call corrections stay on the live client", async (t) => {
  fake(t);
  const live: string[] = [];
  const bg: string[] = [];
  const card = { updatedAt: "2026-11-03T00:00:00Z", source: "skip", rows: [], sections: {} } as unknown as import("../src/prep/importProfile.ts").StyleCard;
  const store = { getStyle: async () => card, putStyle: async () => {}, getCompanion: async () => null } as unknown as ConstructorParameters<typeof Personalize>[0]["store"];
  const p = new Personalize({
    store,
    json: async <T,>(req: { schemaName: string }) => { live.push(req.schemaName); return { updates: [], answered: { item: "", field: "", text: "" } } as T; },
    backgroundJson: async <T,>(req: { schemaName: string }) => { bg.push(req.schemaName); return { updates: [], answered: { item: "", field: "", text: "" } } as T; },
  });
  await p.endCall("u1", [{ role: "user", text: "I always run in the morning" }, { role: "assistant", text: "Nice" }, { role: "user", text: "I run every morning, yes" }], null);
  assert.deepEqual(bg, ["call_profile_updates"]);
  assert.deepEqual(live, []);
  await p.voiceCorrection("u1", "Actually I don't like coffee anymore");
  assert.ok(!bg.includes(live[0] ?? "-"), "voice correction never goes to the background client");
});
