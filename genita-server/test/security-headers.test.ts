/**
 * #232: every HTTP answer from genita-server carries HSTS (the API is only served over HTTPS behind CloudFront,
 * which passes origin headers through) and `nosniff`. Edge tracing headers (Via, x-amz-cf-*) are CloudFront's and
 * stay an infra item.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";

test("#232: HTTP answers (200, 404, 401) carry HSTS and nosniff", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "genita-hsts-"));
  const config = { ...loadConfig({ MODEL_API_KEY: "synthetic", PORT: "0" }), port: 0, sessionToken: "hsts-dev-token" };
  const server = await startServer(config, () => {}, undefined, { GENITA_DATA_DIR: dir }, null);
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [path, status] of [["/healthz", 200], ["/no-such-route", 404], ["/v1/events", 401]] as const) {
    const res = await fetch(base + path, { method: path === "/v1/events" ? "POST" : "GET" });
    await res.arrayBuffer();
    assert.equal(res.status, status, path);
    assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains", `${path} (${res.status}) HSTS`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${path} (${res.status}) nosniff`);
  }
});
