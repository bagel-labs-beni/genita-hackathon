/**
 * GET /v1/app-config (server-driven config for the apps): public, cached with an ETag,
 * sanitized overrides from GENITA_APP_CONFIG_FILE, barge-in mirrored read-only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { startServer, defaultDeps } from "../src/server.ts";
import { createAppConfigSource, mergeAppConfig, DEFAULT_APP_CONFIG } from "../src/appconfig/appConfig.ts";

async function serve(t: import("node:test").TestContext, env: Record<string, string> = {}) {
  const config = { ...loadConfig({ MODEL_API_KEY: "m", GENITA_BARGE_IN_MIN_MS: "400" }), port: 0, sessionToken: "shared-secret" };
  const log = () => {};
  const server = await startServer(config, log, defaultDeps(config, log), { ...env }, null);
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("app-config: public GET (no token) returns the defaults with an ETag and a short cache", async (t) => {
  const base = await serve(t);
  const r = await fetch(base + "/v1/app-config");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /application\/json/);
  assert.match(r.headers.get("etag") ?? "", /^"[A-Za-z0-9_-]{22}"$/);
  assert.match(r.headers.get("cache-control") ?? "", /max-age=60/);
  const body = await r.json();
  assert.equal(body.schema, 1);
  assert.equal(body.updates.ios.url, "https://testflight.apple.com/join/Ybqh482p");
  assert.equal(body.flags.textChat, false);
  assert.equal(body.flags.watchReactions, true);
  assert.equal(body.flags.proximityHandoff, true, "proximity handoff is on by default (demo kick)");
  assert.equal(body.tuning.bargeInMs, 400);
  assert.equal(body.copy["prep.title"], "Bringing {name} to life");
  assert.equal(body.copy["prep.stage.mouth"], "Mouth");
});

test("app-config: If-None-Match with the current ETag → 304 and no body", async (t) => {
  const base = await serve(t);
  const first = await fetch(base + "/v1/app-config");
  const etag = first.headers.get("etag")!;
  const again = await fetch(base + "/v1/app-config", { headers: { "if-none-match": `W/${etag}` } });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
  const stale = await fetch(base + "/v1/app-config", { headers: { "if-none-match": '"old"' } });
  assert.equal(stale.status, 200);
});

test("app-config: only GET/HEAD", async (t) => {
  const base = await serve(t);
  const r = await fetch(base + "/v1/app-config", { method: "POST", body: "{}" });
  assert.equal(r.status, 405);
  const head = await fetch(base + "/v1/app-config", { method: "HEAD" });
  assert.equal(head.status, 200);
});

test("app-config: matches the shared protocol sample's keys (apps decode the same shape)", async (t) => {
  const base = await serve(t);
  const body = await (await fetch(base + "/v1/app-config")).json();
  const sample = JSON.parse(readFileSync(new URL("../../shared/protocol-samples/http/app-config.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(body).sort(), Object.keys(sample).sort());
  assert.deepEqual(Object.keys(body.updates.ios).sort(), Object.keys(sample.updates.ios).sort());
});

test("app-config: overrides are sanitized key by key; wrong types and non-https URLs are dropped", () => {
  const c = mergeAppConfig(
    {
      updates: { ios: { minBuild: 12, latestBuild: 3.5, url: "http://evil.example" }, mac: "nope" },
      flags: { textChat: true, watchReactions: "yes", "bad key!": true },
      tuning: { prepStallMs: 60000, bargeInMs: 50, nan: Number.NaN },
      copy: { "prep.title": "Waking {name}", long: "x".repeat(501), num: 3 },
      assets: { splashRive: "https://cdn.example/splash.riv", js: "javascript:alert(1)", http: "http://cdn.example/a.riv" },
      extra: { code: "eval()" },
    },
    400,
  );
  assert.equal(c.updates.ios.minBuild, 12);
  assert.equal(c.updates.ios.latestBuild, 0, "non-integer build ignored");
  assert.equal(c.updates.ios.url, DEFAULT_APP_CONFIG.updates.ios.url, "http URL ignored");
  assert.deepEqual(c.updates.mac, DEFAULT_APP_CONFIG.updates.mac);
  assert.equal(c.flags.textChat, true);
  assert.equal(c.flags.watchReactions, true, "string flag ignored");
  assert.equal("bad key!" in c.flags, false);
  assert.equal(c.tuning.prepStallMs, 60000);
  assert.equal(c.tuning.bargeInMs, 400, "barge-in is read-only (server value)");
  assert.equal("nan" in c.tuning, false);
  assert.equal(c.copy["prep.title"], "Waking {name}");
  assert.equal("long" in c.copy, false);
  assert.equal("num" in c.copy, false);
  assert.deepEqual(c.assets, { splashRive: "https://cdn.example/splash.riv" });
  assert.equal("extra" in c, false);
});

test("app-config: the file is re-read when it changes; a broken file keeps the last good config", () => {
  const dir = mkdtempSync(join(tmpdir(), "appcfg-"));
  try {
    const file = join(dir, "app-config.json");
    let clock = 0;
    const logs: string[] = [];
    const src = createAppConfigSource({ file, bargeInMs: 400, now: () => clock, log: (e) => logs.push(e) });
    assert.equal(JSON.parse(src.current().body).flags.textChat, false, "missing file = defaults");

    writeFileSync(file, JSON.stringify({ flags: { textChat: true } }));
    clock += 6_000;
    const v1 = src.current();
    assert.equal(JSON.parse(v1.body).flags.textChat, true);

    writeFileSync(file, "{ not json");
    utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    clock += 6_000;
    const v2 = src.current();
    assert.equal(v2.etag, v1.etag, "broken file keeps the last good config");
    assert.ok(logs.includes("app_config.invalid"));

    writeFileSync(file, JSON.stringify({ flags: { textChat: false } }));
    utimesSync(file, new Date(), new Date(Date.now() + 20_000));
    clock += 1_000;
    assert.equal(src.current().etag, v1.etag, "not re-checked within 5 s");
    clock += 5_000;
    assert.notEqual(src.current().etag, v1.etag);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("app-config: a file that failed to load is retried even if its mtime does not change", () => {
  const dir = mkdtempSync(join(tmpdir(), "appcfg-"));
  try {
    const file = join(dir, "app-config.json");
    const fixed = new Date(Date.now() - 60_000);
    writeFileSync(file, "{ broken");
    utimesSync(file, fixed, fixed);
    let clock = 0;
    const src = createAppConfigSource({ file, bargeInMs: 400, now: () => clock });
    assert.equal(JSON.parse(src.current().body).flags.textChat, false);
    writeFileSync(file, JSON.stringify({ flags: { textChat: true } }));
    utimesSync(file, fixed, fixed); // same mtime as the broken version (e.g. a permission fix, or a copy that keeps times)
    clock += 6_000;
    assert.equal(JSON.parse(src.current().body).flags.textChat, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("app-config: If-None-Match: * → 304 (RFC 9110 §13.1.2)", async (t) => {
  const base = await serve(t);
  const r = await fetch(base + "/v1/app-config", { headers: { "if-none-match": "*" } });
  assert.equal(r.status, 304);
});
