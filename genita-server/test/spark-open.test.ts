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
  SPARK_OPEN_MODEL, backgroundJson, markSparkOpen, probeSparkOpen, startSparkOpenProbe, setLlmLog, sparkOpenJson, sparkOpenKey, sparkOpenState, sparkOpenStatus, sparkOpenTarget,
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

const T = (key = "test-baseten") => sparkOpenTarget({ BASETEN_API_KEY: key })!;
type Seen = { host: string; path: string; auth: string | null; body: Record<string, unknown> };
type Reply = (s: Seen) => Response | Promise<Response>;

/** Fake fetch for both vendors; BASETEN_API_KEY set unless `key: null`. Restores everything after. */
const restoring = new WeakSet<TestContext>();
function fake(t: TestContext, o: { open?: Reply; meta?: Reply; key?: string | null; flag?: string; state?: "available" | "not_listed" | null } = {}) {
  // originals saved once per test: a second fake() in the same test must not "restore" the first fake (Codex P2)
  if (!restoring.has(t)) {
    restoring.add(t);
    const env = { key: process.env.BASETEN_API_KEY, flag: process.env.GENITA_SPARK_OPEN, hop: process.env.GENITA_SPARK_OPEN_HOP_MS, provider: process.env.GENITA_SPARK_OPEN_PROVIDER, modalKey: process.env.MODAL_ENDPOINT_KEY, url: process.env.GENITA_SPARK_OPEN_URL, model: process.env.GENITA_SPARK_OPEN_MODEL };
    const original = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = original;
      setLlmLog(null);
      markSparkOpen(null);
      for (const [name, v] of [["BASETEN_API_KEY", env.key], ["GENITA_SPARK_OPEN", env.flag], ["GENITA_SPARK_OPEN_HOP_MS", env.hop], ["GENITA_SPARK_OPEN_PROVIDER", env.provider], ["MODAL_ENDPOINT_KEY", env.modalKey], ["GENITA_SPARK_OPEN_URL", env.url], ["GENITA_SPARK_OPEN_MODEL", env.model]] as const) {
        if (v === undefined) delete process.env[name]; else process.env[name] = v;
      }
    });
  }
  // every Spark Open setting starts from the test default, whatever the shell has (Codex P2)
  for (const name of ["GENITA_SPARK_OPEN_MODEL", "GENITA_SPARK_OPEN_PROVIDER", "GENITA_SPARK_OPEN_URL", "MODAL_ENDPOINT_KEY", "GENITA_SPARK_OPEN_HOP_MS"]) delete process.env[name];
  const seen: Seen[] = [];
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  if (o.key === null) delete process.env.BASETEN_API_KEY; else process.env.BASETEN_API_KEY = o.key ?? "test-baseten";
  if (o.flag === undefined) delete process.env.GENITA_SPARK_OPEN; else process.env.GENITA_SPARK_OPEN = o.flag;
  setLlmLog((event, data) => logs.push({ event, data }));
  markSparkOpen(o.state === undefined ? "available" : o.state);
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
    // like real fetch: an abort rejects a pending request. AbortSignal.timeout's timer is unref'd and a real
    // socket would hold the event loop open; a hanging fake must too, or node:test ends the file mid-test (CI)
    const keep = setInterval(() => {}, 1000);
    return Promise.race([reply, new Promise<never>((_, rej) => signal?.addEventListener("abort", () => rej(signal.reason ?? new Error("aborted")), { once: true }))])
      .finally(() => clearInterval(keep));
  }) as typeof fetch;
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
  assert.deepEqual(s, { spark_open: "unknown", spark_open_provider: "baseten", spark_open_model: SPARK_OPEN_MODEL });
  assert.ok(!JSON.stringify(s).includes("secret-value"));
  assert.equal(sparkOpenStatus({}).spark_open, "no_key");
});

test("sparkOpenJson: Baseten chat completions with the hackathon model id, schema in the prompt, think block stripped, logged with latency", async (t) => {
  const f = fake(t, { open: () => openOk({ memories: [{ text: "Likes spicy food", kind: "fact" }] }, "<think>the user said…</think>\n") });
  const out = await sparkOpenJson<{ memories: unknown[] }>(T(), REQ);
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
    await assert.rejects(sparkOpenJson(T(), REQ), UpstreamError, JSON.stringify(bad));
  }
});

test("sparkOpenJson: refuses image input (vision stays on Muse Spark API)", async (t) => {
  const f = fake(t);
  await assert.rejects(sparkOpenJson(T(), { ...REQ, input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA" }] }] }));
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
  assert.deepEqual(f.hosts(), ["api.meta.ai", "api.meta.ai"], "no Spark Open hop: one Muse retry after a short pause (#403, 11/3 outage)");

  f = fake(t, { meta: five });
  await assert.rejects(sparkJson("test-meta", { ...REQ, tools: [{ type: "web_search" }] }));
  assert.deepEqual(f.hosts(), ["api.meta.ai", "api.meta.ai"], "no Spark Open hop: one Muse retry after a short pause (#403, 11/3 outage)");

  f = fake(t, { meta: five, key: null });
  await assert.rejects(sparkJson("test-meta", REQ));
  assert.deepEqual(f.hosts(), ["api.meta.ai", "api.meta.ai"], "no Spark Open hop: one Muse retry after a short pause (#403, 11/3 outage)");

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

test("fake(): two fakes in one test restore the real fetch and env once, at the end", async (t) => {
  const real = globalThis.fetch;
  const key = process.env.BASETEN_API_KEY;
  await t.test("inner", (tt) => { fake(tt); fake(tt, { key: "second" }); assert.notEqual(globalThis.fetch, real); });
  assert.equal(globalThis.fetch, real);
  assert.equal(process.env.BASETEN_API_KEY, key);
});

test("logs and errors never carry the key or vendor/reply text (Codex P1)", async (t) => {
  const f = fake(t, { open: (s) => new Response(`invalid key ${s.auth}`, { status: 401 }) });
  await assert.rejects(sparkOpenJson(T("sk-secret-123"), REQ), (e: unknown) => e instanceof UpstreamError && e.status === 401 && !String(e).includes("sk-secret-123") && !String(e).includes("invalid key"));
  fake(t, { open: () => Response.json({ choices: [{ message: { content: "I have diabetes and live at 12 Main St" }, finish_reason: "stop" }] }) });
  await assert.rejects(sparkOpenJson(T("sk-secret-123"), REQ), (e: unknown) => !String(e).includes("diabetes"));
  fake(t, { open: () => openOk({ memories: [{ text: "I have diabetes", kind: "secret-kind" }] }) });
  await assert.rejects(sparkOpenJson(T("sk-secret-123"), REQ), (e: unknown) => !String(e).includes("diabetes"));
  const all = JSON.stringify(f.logs);
  assert.ok(f.logs.length >= 1 && !all.includes("sk-secret-123") && !all.includes("invalid key") && !all.includes("diabetes"), all);
});

test("sparkJson hop: Spark Open hanging after a Muse 503 still ends in the original error when the caller passed no signal (Codex P2)", async (t) => {
  const f = fake(t, { meta: () => new Response("down", { status: 503 }), open: (s) => new Promise(() => void s) });
  process.env.GENITA_SPARK_OPEN_HOP_MS = "50";
  await assert.rejects(sparkJson("test-meta", REQ), (e: unknown) => e instanceof UpstreamError && e.status === 503);
  assert.deepEqual(f.hosts(), ["api.meta.ai", "inference.baseten.co"]);
  assert.equal(f.logs.find((l) => l.event === "llm.call")?.data.error, "timeout");
});

const modalEnv = { GENITA_SPARK_OPEN_PROVIDER: "modal", MODAL_ENDPOINT_KEY: "wk-1.ws-secret", GENITA_SPARK_OPEN_URL: "https://summer--muse.modal.run/" };
test("provider is pluggable: modal = MODAL_ENDPOINT_KEY + GENITA_SPARK_OPEN_URL, model meta/muse-spark-open; incomplete config = off", () => {
  assert.deepEqual(sparkOpenTarget(modalEnv), { provider: "modal", base: "https://summer--muse.modal.run/v1", model: "meta/muse-spark-open", name: "muse-spark-open", key: "wk-1.ws-secret" });
  assert.equal(sparkOpenTarget({ ...modalEnv, GENITA_SPARK_OPEN_URL: "" }), null);
  assert.equal(sparkOpenTarget({ ...modalEnv, MODAL_ENDPOINT_KEY: "" }), null);
  assert.equal(sparkOpenTarget({ ...modalEnv, BASETEN_API_KEY: "b", GENITA_SPARK_OPEN_PROVIDER: "baseten" })?.base, "https://inference.baseten.co/v1");
  assert.equal(sparkOpenTarget({ ...modalEnv, GENITA_SPARK_OPEN_MODEL: "meta/muse-glimmer-30b-bf16" })?.name, "muse-glimmer-30b-bf16");
  assert.equal(sparkOpenStatus(modalEnv).spark_open_provider, "modal");
});

test("modal provider: background calls go to the Modal endpoint with its proxy token, logged provider=modal", async (t) => {
  const f = fake(t, { key: null, state: null });
  Object.assign(process.env, modalEnv);
  markSparkOpen("available");
  const seen: string[] = [];
  const base = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { seen.push(String(input)); return String(input).includes("modal.run") ? openOk({ memories: [] }) : base(input, init); }) as typeof fetch;
  assert.deepEqual(await backgroundJson("test-meta", REQ, { timeoutMs: 5000 }), { memories: [] });
  assert.deepEqual(seen, ["https://summer--muse.modal.run/v1/chat/completions"]);
  const log = f.logs.find((l) => l.event === "llm.call")!;
  assert.equal(log.data.provider, "modal");
  assert.equal(log.data.model, "muse-spark-open");
  assert.ok(!JSON.stringify(f.logs).includes("ws-secret"));
});

test("availability gate: configured but not_listed / not probed yet → Muse Spark API only, both directions", async (t) => {
  for (const state of ["not_listed", null] as const) {
    const f = fake(t, { state, meta: () => metaOk({ memories: [] }) });
    assert.deepEqual(await backgroundJson("test-meta", REQ, { timeoutMs: 5000 }), { memories: [] });
    assert.deepEqual(f.hosts(), ["api.meta.ai"]);
    const g = fake(t, { state, meta: () => new Response("down", { status: 504 }) });
    await assert.rejects(sparkJson("test-meta", REQ));
    assert.deepEqual(g.hosts(), ["api.meta.ai", "api.meta.ai"], "never Spark Open; the one Muse retry (#403)");
  }
});

test("probe: listed → available; hidden but callable → available; neither → not_listed; no key → no_key without a request; logs on change, never the key", async (t) => {
  const listing = (ids: string[], call: number) => (s: Seen) => (s.path === "/v1/models" ? Response.json({ data: ids.map((id) => ({ id })) }) : new Response(call === 200 ? "{}" : "nope", { status: call }));
  let f = fake(t, { state: null, open: listing(["zai-org/GLM-5.3", SPARK_OPEN_MODEL], 404) });
  assert.equal(await probeSparkOpen(), "available");
  assert.deepEqual(f.seen.map((s) => s.path), ["/v1/models"]);
  assert.equal(f.seen[0].auth, "Bearer test-baseten");
  assert.equal(sparkOpenState(), "available");

  f = fake(t, { state: null, open: listing(["zai-org/GLM-5.3"], 200) });
  assert.equal(await probeSparkOpen(), "available");
  assert.deepEqual(f.seen.map((s) => s.path), ["/v1/models", "/v1/chat/completions"]);
  assert.equal(f.seen[1].body.model, SPARK_OPEN_MODEL);

  f = fake(t, { state: null, open: listing(["zai-org/GLM-5.3"], 404) });
  assert.equal(await probeSparkOpen(), "not_listed");
  const change = f.logs.find((l) => l.event === "llm.spark_open")!;
  assert.deepEqual({ status: change.data.status, provider: change.data.provider, model: change.data.model, call_http: change.data.call_http }, { status: "not_listed", provider: "baseten", model: "muse-spark-open-1026", call_http: 404 });
  assert.ok(!JSON.stringify(f.logs).includes("test-baseten"));

  // the 10-min re-probe picks up a later grant without a redeploy
  f = fake(t, { state: "not_listed", open: listing([SPARK_OPEN_MODEL], 404) });
  assert.equal(await probeSparkOpen(), "available");
  assert.ok(f.logs.some((l) => l.event === "llm.spark_open" && l.data.status === "available"));

  f = fake(t, { key: null, state: null });
  assert.equal(await probeSparkOpen(), "no_key");
  assert.equal(f.seen.length, 0);
});

test("probe: paused generation sends nothing; startSparkOpenProbe uses the env it is given and stops cleanly (Codex P2)", async (t) => {
  const { configureOps } = await import("../src/ops/limits.ts");
  const f = fake(t, { state: null });
  configureOps({ paused: true });
  t.after(() => { configureOps({}); });
  assert.equal(await probeSparkOpen(), "unknown");
  assert.equal(f.seen.length, 0);
  configureOps({});
  // a server started with GENITA_SPARK_OPEN=0 never probes, whatever process.env has
  const stopOff = startSparkOpenProbe({ ...process.env, GENITA_SPARK_OPEN: "0" });
  stopOff();
  assert.equal(f.seen.length, 0);
  const stop = startSparkOpenProbe(process.env, 60_000);
  stop();
  await new Promise((r) => setImmediate(r));
  assert.ok(!f.seen.some((s) => s.path === "/v1/chat/completions"), `stop ends the probe before its paid call: ${f.seen.map((s) => s.path)}`);
});
