import { test } from "node:test";
import assert from "node:assert/strict";
import { GLOBAL_DISPATCHER, installKeepAlive, warmUp } from "../src/util/keepalive.ts";
import { loadConfig } from "../src/config.ts";

const g = globalThis as unknown as Record<symbol, unknown>;

class FakeAgent {
  opts: unknown;
  constructor(opts: unknown) {
    this.opts = opts;
  }
}

test("keep-alive: swaps the fetch dispatcher for one that keeps idle sockets for idleMs", async () => {
  const before = g[GLOBAL_DISPATCHER];
  try {
    g[GLOBAL_DISPATCHER] = new FakeAgent({});
    assert.equal(await installKeepAlive(60_000), true);
    const now = g[GLOBAL_DISPATCHER] as FakeAgent;
    assert.ok(now instanceof FakeAgent);
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
