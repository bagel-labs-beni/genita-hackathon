import { test } from "node:test";
import assert from "node:assert/strict";
import { GLOBAL_DISPATCHER, installKeepAlive, makePrewarm, warmUp } from "../src/util/keepalive.ts";
import { loadConfig } from "../src/config.ts";

const g = globalThis as unknown as Record<symbol, unknown>;

class FakeAgent {
  opts: unknown;
  constructor(opts: unknown) {
    this.opts = opts;
  }
  dispatch() {
    return true;
  }
}

test("keep-alive: swaps the fetch dispatcher for one that keeps idle sockets for idleMs", async () => {
  const before = g[GLOBAL_DISPATCHER];
  try {
    g[GLOBAL_DISPATCHER] = new (class Agent extends FakeAgent {})({});
    assert.equal(await installKeepAlive(60_000), true);
    const now = g[GLOBAL_DISPATCHER] as FakeAgent;
    assert.ok(now instanceof FakeAgent && now.constructor.name === "Agent");
    assert.deepEqual(now.opts, { keepAliveTimeout: 60_000, keepAliveMaxTimeout: 60_000 });
    // a second call is a no-op (same agent)
    assert.equal(await installKeepAlive(60_000), true);
    assert.equal(g[GLOBAL_DISPATCHER], now);
  } finally {
    g[GLOBAL_DISPATCHER] = before;
  }
});

test("keep-alive: 0 turns it off; a runtime without a dispatcher is left alone", async () => {
  const before = g[GLOBAL_DISPATCHER];
  try {
    g[GLOBAL_DISPATCHER] = new FakeAgent({});
    const agent = g[GLOBAL_DISPATCHER];
    assert.equal(await installKeepAlive(0), false);
    assert.equal(g[GLOBAL_DISPATCHER], agent);
    g[GLOBAL_DISPATCHER] = undefined;
    assert.equal(await installKeepAlive(60_000, async () => {}), false);
    assert.equal(g[GLOBAL_DISPATCHER], undefined);
  } finally {
    g[GLOBAL_DISPATCHER] = before;
  }
});

test("keep-alive: a dispatcher someone else installed (not undici's Agent) is never replaced", async () => {
  const before = g[GLOBAL_DISPATCHER];
  try {
    const custom = { dispatch() { return true; } };
    g[GLOBAL_DISPATCHER] = custom;
    assert.equal(await installKeepAlive(60_000), false);
    assert.equal(g[GLOBAL_DISPATCHER], custom);
    class Agent { dispatch() { return true; } }
    class Interceptor extends Agent {}
    const wrapped = new Interceptor();
    g[GLOBAL_DISPATCHER] = wrapped;
    assert.equal(await installKeepAlive(60_000), false);
    assert.equal(g[GLOBAL_DISPATCHER], wrapped);
  } finally {
    g[GLOBAL_DISPATCHER] = before;
  }
});

test("warmUp: opens n parallel GETs with the given headers and swallows failures", async () => {
  const calls: { url: string; auth: string | undefined }[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: (init?.headers as Record<string, string>)?.authorization });
    if (calls.length === 2) throw new Error("refused");
    return new Response("{}");
  }) as unknown as typeof fetch;
  warmUp("https://api.example/v1/models", 3, { authorization: "Bearer k" }, fake);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.url === "https://api.example/v1/models" && c.auth === "Bearer k"));
});

test("config: Spark hedge defaults to 3 lanes and keep-alive to 60 s; both overridable", () => {
  const d = loadConfig({ MODEL_API_KEY: "k" });
  assert.equal(d.sparkHedge, 3);
  assert.equal(d.httpKeepAliveMs, 60_000);
  const o = loadConfig({ MODEL_API_KEY: "k", GENITA_SPARK_HEDGE: "2", GENITA_HTTP_KEEPALIVE_MS: "0" });
  assert.equal(o.sparkHedge, 2);
  assert.equal(o.httpKeepAliveMs, 0);
});

test("prewarm: one Meta socket per Spark lane, the voice only when asked, at most once per cooldown for the whole server", () => {
  const urls: string[] = [];
  let clock = 0;
  const fake = (async (url: string) => {
    urls.push(url);
    return new Response("{}");
  }) as unknown as typeof fetch;
  const prewarm = makePrewarm({ metaUrl: "https://meta/v1/models", metaHeaders: {}, lanes: 3, voiceUrl: "https://voice/healthz", cooldownMs: 20_000, now: () => clock, doFetch: fake });
  prewarm({ voice: false });
  assert.deepEqual(urls, ["https://meta/v1/models", "https://meta/v1/models", "https://meta/v1/models"]);
  const count = (host: string) => urls.filter((u) => u.includes(host)).length;
  clock = 5_000;
  prewarm({ voice: true }); // a server-voice call 5 s later: Meta is warm already, the voice is not
  assert.deepEqual([count("meta"), count("voice")], [3, 1]);
  clock = 12_000;
  prewarm({ voice: true }); // within the cooldown: nothing
  assert.deepEqual([count("meta"), count("voice")], [3, 1]);
  clock = 25_000;
  prewarm({ voice: true });
  assert.deepEqual([count("meta"), count("voice")], [6, 2]);
});

test("prewarm (server wiring): only the Meta API and the configured Meta voice service are contacted", async () => {
  const { defaultDeps } = await import("../src/server.ts");
  const original = globalThis.fetch;
  const hosts: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    hosts.push(new URL(String(url)).host);
    return new Response("{}");
  }) as typeof fetch;
  try {
    const config = loadConfig({ MODEL_API_KEY: "k", GENITA_VOICE_URL: "https://voice.test", GENITA_VOICE_TOKEN: "t" });
    defaultDeps(config, () => {}).prewarm!({ voice: true });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual([...new Set(hosts)].sort(), ["api.meta.ai", "voice.test"]);
    assert.equal(hosts.filter((h) => h === "api.meta.ai").length, config.sparkHedge);
  } finally {
    globalThis.fetch = original;
  }
});
