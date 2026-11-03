import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import WebSocket from "ws";
import { loadConfig } from "../src/config.ts";
import { startServer, defaultDeps } from "../src/server.ts";

function scratch(t: import("node:test").TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "genita-local-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("local defaults: one Meta key, on-disk PGlite, local blobs, loopback, device voice", async (t) => {
  const { applyLocalDefaults } = await import("../src/localMode.ts");
  const root = scratch(t);
  const env = applyLocalDefaults({ MODEL_API_KEY: "fake-key-for-local-check" }, root);
  assert.equal(env.GENITA_DATA_DIR, join(root, ".genita-data"));
  assert.equal(env.GENITA_MEMORY_FILE, join(root, ".genita-data", "memory.json"));
  assert.equal(env.DATABASE_URL, `pglite:${join(root, ".genita-data", "db")}`);
  assert.ok(existsSync(join(root, ".genita-data", "blobs")));
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.PORT, "8787");
  assert.equal(env.GENITA_ENV_FILE, "");
  assert.equal(loadConfig(env).serverTts, false);
});

test("local mode discards inherited cloud/vendor configuration, including an unrecognised vendor", async (t) => {
  const { applyLocalDefaults } = await import("../src/localMode.ts");
  const cloud = {
    GENITA_S3_BUCKET: "bucket", GENITA_S3_CREDS: "imds", GENITA_S3_ENDPOINT: "https://s3.example",
    AWS_ACCESS_KEY_ID: "fake", AWS_SECRET_ACCESS_KEY: "fake", AWS_PROFILE: "cloud",
    GENITA_VOICE_URL: "https://voice.example", GENITA_VOICE_TOKEN: "fake",
    RESEND_API_KEY: "fake", GENITA_MAIL_FROM: "cloud@example.com",
    ELEVENLABS_API_KEY: "fake", FAL_KEY: "fake", OPENAI_API_KEY: "fake", NEW_VENDOR_SECRET: "fake",
    GENITA_PETER_URL: "https://peter.example", APPLE_PRIVATE_KEY: "fake", APPLE_TEAM_ID: "fake",
    GENITA_ENV_FILE: "/personal.env", GENITA_DB_MIGRATE: "0", GENITA_TRUST_PROXY: "1",
    DATABASE_SSL: "1", GENITA_FINDS_DIR: "/personal/finds", GENITA_MEMORY_FILE: "/personal/memory",
  };
  const env = applyLocalDefaults({ ...cloud, MODEL_API_KEY: "meta", NODE_ENV: "production", HOST: "0.0.0.0", PATH: "/bin" }, scratch(t));
  for (const key of Object.keys(cloud)) {
    // GENITA_ENV_FILE is blanked; the memory file is replaced by one inside the local data dir
    if (key === "GENITA_ENV_FILE") assert.equal(env[key], "", key);
    else if (key === "GENITA_MEMORY_FILE") assert.ok(env[key]?.startsWith(env.GENITA_DATA_DIR!) && env[key] !== "/personal/memory", key);
    else assert.equal(env[key], undefined, key);
  }
  assert.equal(env.NODE_ENV, "development", "console email login remains available");
  assert.equal(env.HOST, "127.0.0.1", "inherited deployment settings cannot expose keyless access");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.MODEL_API_KEY, "meta");
});

test("local mode keeps explicit local data/port/database settings and an opted-in GPU", async (t) => {
  const { applyLocalDefaults } = await import("../src/localMode.ts");
  const root = scratch(t);
  const env = applyLocalDefaults({ MODEL_API_KEY: "meta", GENITA_DATA_DIR: join(root, "own"), PORT: "9000",
    DATABASE_URL: "postgres://genita:genita@127.0.0.1:5432/genita", GENITA_SESSION_TOKEN: "local-token",
    GENITA_LOCAL_VOICE: "1", GENITA_VOICE_URL: "http://my-gpu:8000", GENITA_VOICE_TOKEN: "own-gpu-token" }, root);
  assert.equal(env.DATABASE_URL, "postgres://genita:genita@127.0.0.1:5432/genita");
  assert.equal(env.GENITA_DATA_DIR, join(root, "own"));
  assert.equal(env.PORT, "9000");
  assert.equal(env.GENITA_SESSION_TOKEN, "local-token");
  assert.equal(loadConfig(env).voice?.url, "http://my-gpu:8000");
  assert.equal(applyLocalDefaults({ MODEL_API_KEY: "meta", DATABASE_URL: "pglite:memory" }, root).DATABASE_URL, "pglite:memory");
});

test("local mode refuses a remote database rather than opening a developer's cloud DB", async (t) => {
  const { applyLocalDefaults } = await import("../src/localMode.ts");
  assert.throws(() => applyLocalDefaults({ MODEL_API_KEY: "meta", DATABASE_URL: "postgres://u:secret@cloud.example/db" }, scratch(t)), /local DATABASE_URL/);
});

test("local mode without a Meta key throws a one-line copy-.env.example hint", async (t) => {
  const { applyLocalDefaults } = await import("../src/localMode.ts");
  for (const MODEL_API_KEY of [undefined, "", "  "]) {
    assert.throws(() => applyLocalDefaults({ MODEL_API_KEY }, scratch(t)), /^Error: MODEL_API_KEY is not set\. Copy \.env\.example to \.env at the repo root and put your Meta API key in it\.$/);
  }
});

test("env loading: shell > server .env > repo .env; no personal env file", async (t) => {
  const { loadLocalEnv } = await import("../src/localMode.ts");
  const root = scratch(t);
  const { mkdirSync } = await import("node:fs");
  const serverRoot = join(root, "genita-server");
  mkdirSync(serverRoot);
  writeFileSync(join(root, ".env"), 'MODEL_API_KEY="root-key"\nPORT=8788\n');
  assert.equal(loadLocalEnv({}, serverRoot).MODEL_API_KEY, "root-key");
  writeFileSync(join(serverRoot, ".env"), "MODEL_API_KEY=server-key\n");
  assert.equal(loadLocalEnv({}, serverRoot).MODEL_API_KEY, "server-key");
  const env = loadLocalEnv({ MODEL_API_KEY: "shell-key", PORT: "9000" }, serverRoot);
  assert.equal(env.MODEL_API_KEY, "shell-key");
  assert.equal(env.PORT, "9000");
});

test("Origin guard: keyless loopback WS refuses any Origin, apps without Origin are accepted", { timeout: 10_000 }, async (t) => {
  const config = loadConfig({ MODEL_API_KEY: "fake", PORT: "0" });
  // The transport guard needs no model: disable memory's automatic greeting.
  const deps = { ...defaultDeps(config, () => {}), memory: undefined };
  const server = await startServer(config, () => {}, deps, { GENITA_DATA_DIR: scratch(t) });
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/session`;
  for (const origin of ["https://web-page.example", "null", ""]) {
    const ws = new WebSocket(url, { headers: { Origin: origin } });
    sockets.push(ws);
    ws.once("open", () => ws.send(JSON.stringify({ type: "start", persona: { name: "Local", kind: "human" }, mic: false })));
    const result = await Promise.race([
      once(ws, "close").then(([code]) => code),
      once(ws, "message").then(([data]) => JSON.parse(data.toString()).type),
    ]);
    assert.equal(result, 4401);
  }
  const app = new WebSocket(url);
  sockets.push(app);
  const ready = once(app, "message");
  await once(app, "open");
  app.send(JSON.stringify({ type: "start", persona: { name: "Local", kind: "human" }, mic: false }));
  assert.equal(JSON.parse((await ready)[0].toString()).tts, "device");
});

test("Origin guard: keyless loopback HTTP refuses a browser page (no preflight text/plain POST), native calls work", { timeout: 10_000 }, async (t) => {
  const config = loadConfig({ MODEL_API_KEY: "fake", PORT: "0" });
  const deps = { ...defaultDeps(config, () => {}), memory: undefined };
  const server = await startServer(config, () => {}, deps, { GENITA_DATA_DIR: scratch(t) });
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const origin of ["https://web-page.example", "null"]) {
    const r = await fetch(`${base}/v1/import/skip`, { method: "POST", headers: { origin, "content-type": "text/plain" }, body: "{}" });
    assert.equal(r.status, 401, origin);
  }
  const app = await fetch(`${base}/v1/import/prompt`);
  assert.notEqual(app.status, 401, "a native app (no Origin) keeps the keyless dev identity");
});
