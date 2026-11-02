/**
 * F1-L2 / F1-L3 / F1-L5 / F1-L8 end to end on the real server (startServer)
 * with PGlite (or TEST_DATABASE_URL), file blobs, and a fake Apple.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import WebSocket from "ws";
import { startServer, defaultDeps } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { verifyRs256, JwtError, signHs256 } from "../src/auth/jwt.ts";
import { AppleAuth } from "../src/auth/apple.ts";
import { fakeApple, KID } from "./helpers/fakeApple.ts";
import { tableCounts, testDb } from "./helpers/db.ts";
import { createAccounts } from "../src/auth/index.ts";
import { newPrepState } from "../src/prep/runner.ts";
import { readFileSync } from "node:fs";

/** keys (recursively) — the app decodes shared/protocol-samples/http/*.json, the server must keep the shape */
const shape = (v: unknown): unknown => (v === null ? "null" : typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, shape((v as any)[k])])) : typeof v);
const sample = (n: string) => JSON.parse(readFileSync(new URL(`../../shared/protocol-samples/http/${n}`, import.meta.url), "utf8"));
/** same keys at every level; a null on either side matches anything (optional fields) */
const nullable = (live: unknown, ref: unknown): boolean => {
  if (live === "null" || ref === "null") return true;
  if (live && typeof live === "object" && ref && typeof ref === "object") {
    const lk = Object.keys(live), rk = Object.keys(ref);
    return lk.length === rk.length && rk.every((k) => k in (live as object) && nullable((live as any)[k], (ref as any)[k]));
  }
  return live === ref;
};

const SHARED = "shared-dev-token-0123456789";

async function boot(t: import("node:test").TestContext) {
  const apple = fakeApple();
  const realFetch = globalThis.fetch;
  globalThis.fetch = apple.fetch;
  const dir = mkdtempSync(join(tmpdir(), "genita-auth-"));
  const env: NodeJS.ProcessEnv = {
    GENITA_DATA_DIR: dir,
    GENITA_JWT_SECRET: "j".repeat(40),
    GENITA_PUBLIC_URL: "https://genita-api.example",
    GENITA_AUTH_RATE_PER_MIN: "1000",
    ...apple.env,
  };
  const config = { ...loadConfig({ MODEL_API_KEY: "m", ELEVENLABS_API_KEY: "e" }), port: 0, sessionToken: SHARED };
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const log = (event: string, data: Record<string, unknown>) => events.push({ event, data });
  const accounts = (await createAccounts(env, log, { loopback: true, db: await testDb(false) }))!;
  const server = await startServer(config, log, defaultDeps(config, log), env, accounts);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    globalThis.fetch = realFetch;
    await new Promise((r) => server.close(r));
    await new Promise((r) => setTimeout(r, 50));
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, o: { token?: string; body?: unknown; form?: Record<string, string>; user?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.user) headers["x-genita-user"] = o.user;
    let body: string | undefined;
    if (o.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(o.form).toString();
    } else if (o.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(o.body);
    }
    const r = await realFetch(base + path, { method, headers, body, redirect: "manual" });
    const text = await r.text();
    return { status: r.status, location: r.headers.get("location"), json: (text ? JSON.parse(text) : null) as Record<string, any> };
  };
  const wsClose = (token?: string) =>
    new Promise<{ code: number; opened: boolean }>((resolve) => {
      const ws = new WebSocket(base.replace("http", "ws") + "/v1/session", token ? { headers: { authorization: `Bearer ${token}` } } : {});
      let opened = false;
      ws.on("open", () => {
        opened = true;
        setTimeout(() => ws.close(1000), 100);
      });
      ws.on("close", (code) => resolve({ code, opened }));
      ws.on("error", () => {});
    });
  return { apple, env, call, wsClose, events, dir, accounts };
}

test("Apple identity tokens: forged, expired, other audience, bad nonce, alg confusion → rejected", async () => {
  const apple = fakeApple();
  const a = new AppleAuth({ bundleId: "ai.thebeni.genita", servicesId: "ai.thebeni.genita.web", teamId: null, keyId: null, privateKey: null }, apple.fetch);
  const nonce = "raw-nonce-1";
  const good = apple.idToken({ sub: "001.apple", aud: "ai.thebeni.genita", nonce: apple.nonceHash(nonce), email: "x@privaterelay.appleid.com", email_verified: "true" });
  const ok = await a.verifyIdentityToken(good, { audience: "ai.thebeni.genita", rawNonce: nonce });
  assert.deepEqual(ok, { sub: "001.apple", email: "x@privaterelay.appleid.com", emailVerified: true, aud: "ai.thebeni.genita" });

  const reason = async (tok: string, aud = "ai.thebeni.genita", raw = nonce) => {
    try {
      await a.verifyIdentityToken(tok, { audience: aud, rawNonce: raw });
      return "accepted";
    } catch (e) {
      return e instanceof JwtError ? e.reason : String(e);
    }
  };
  const base = { sub: "001.apple", aud: "ai.thebeni.genita", nonce: apple.nonceHash(nonce) };
  assert.equal(await reason(apple.idToken(base, { key: apple.attackerKey })), "bad_signature");
  assert.equal(await reason(apple.idToken({ ...base, exp: Math.floor(Date.now() / 1000) - 3600 })), "expired");
  assert.equal(await reason(apple.idToken({ ...base, aud: "com.someone.else" })), "bad_audience");
  assert.equal(await reason(good, "ai.thebeni.genita.web"), "bad_audience");
  assert.equal(await reason(apple.idToken({ ...base, iss: "https://evil.example" })), "bad_issuer");
  assert.equal(await reason(good, "ai.thebeni.genita", "other-nonce"), "bad_nonce");
  assert.equal(await reason(apple.idToken({ ...base, sub: "" })), "no_subject");
  assert.equal(await reason(apple.idToken(base, { kid: "NOPE" })), "unknown_kid");
  // HS256 "signed" with the public key text and alg:none must never pass
  assert.equal(await reason(signHs256({ ...base, iss: "https://appleid.apple.com", exp: 9e9 }, "anything")), "bad_alg");
  const none = good.split(".").slice(0, 2).join(".") + ".";
  assert.equal(await reason(none.replace(/^[^.]+/, Buffer.from(JSON.stringify({ alg: "none", kid: KID })).toString("base64url"))), "bad_alg");
  assert.equal(await reason("not-a-jwt"), "malformed");
  // verifyRs256 used directly needs a key for the kid
  assert.throws(() => verifyRs256(good, () => null, { iss: "https://appleid.apple.com", aud: ["ai.thebeni.genita"] }), /unknown_kid/);
});

test("accounts end to end: iPhone sign-in, consent gate, name, Mac web login, logout, delete", async (t) => {
  const { apple, call, wsClose, events, dir, accounts } = await boot(t);

  // ── unauthenticated ──
  assert.equal((await call("GET", "/me")).status, 401);
  assert.equal((await call("GET", "/me", { token: "garbage.not.jwt" })).status, 401);
  assert.equal((await wsClose()).code, 4401, "WS without a token closes 4401");
  assert.equal((await wsClose("x.y.z")).code, 4401, "WS with a bad JWT closes 4401");

  // ── F1-L2 iPhone native ──
  const nonce = randomBytes(16).toString("hex");
  const idToken = apple.idToken({ sub: "001234.abcd.0001", aud: "ai.thebeni.genita", nonce: apple.nonceHash(nonce), email: "chel@privaterelay.appleid.com" });
  const bad = await call("POST", "/auth/apple", { body: { identityToken: apple.idToken({ sub: "001234.abcd.0001", aud: "ai.thebeni.genita.other", nonce: apple.nonceHash(nonce) }), nonce } });
  assert.deepEqual([bad.status, bad.json.reason], [401, "bad_audience"]);
  assert.equal((await call("POST", "/auth/apple", { body: { identityToken: idToken, nonce: "wrong" } })).status, 401);
  assert.equal((await call("POST", "/auth/apple", { body: { identityToken: idToken } })).status, 400);

  const signIn = await call("POST", "/auth/apple", { body: { identityToken: idToken, nonce, authorizationCode: "c-1", fullName: { givenName: "Chelsea", familyName: "Lee" } } });
  assert.equal(signIn.status, 200);
  assert.equal(signIn.json.isNew, true);
  assert.equal(signIn.json.consented, false);
  assert.equal(signIn.json.user.displayName, "Chelsea Lee");
  assert.ok(signIn.json.token.split(".").length === 3);
  assert.ok(new Date(signIn.json.expiresAt).getTime() - Date.now() > 29 * 86400_000, "30-day session");
  assert.ok(nullable(shape(signIn.json), shape(sample("signin.json"))), "sign-in reply matches shared/protocol-samples/http/signin.json");
  const token = signIn.json.token as string;
  const userId = signIn.json.user.id as string;
  assert.ok(apple.requests.some((r) => r.url.endsWith("/auth/token") && r.form.get("client_id") === "ai.thebeni.genita"), "code exchanged for a refresh token");

  // ── F1-L5 /me snapshot ──
  const me = await call("GET", "/me", { token });
  assert.equal(me.status, 200);
  assert.deepEqual(Object.keys(me.json).sort(), ["consented", "conversation", "hasCompanion", "prepStatus", "user"]);
  assert.deepEqual({ ...me.json, user: { ...me.json.user, id: "<id>", createdAt: "<t>" } }, {
    user: { id: "<id>", provider: "apple", email: "chel@privaterelay.appleid.com", displayName: "Chelsea Lee", aiConsentAt: null, createdAt: "<t>" },
    consented: false,
    hasCompanion: false,
    prepStatus: "none",
    conversation: null,
  });

  // ── F1-L8 consent gate: nothing reaches a third-party AI before consent ──
  assert.equal((await call("GET", "/v1/import/prompt", { token })).status, 200, "static prompt is fine");
  const gated = await call("POST", "/v1/import", { token, body: { text: "x".repeat(500) } });
  assert.deepEqual([gated.status, gated.json.error], [403, "consent_required"]);
  assert.equal((await call("GET", "/v1/companion/voices", { token })).status, 403);
  assert.equal((await wsClose(token)).code, 4403, "WS before consent closes 4403");

  const consent = await call("POST", "/me/consent", { token, body: {} });
  assert.equal(consent.status, 200);
  assert.equal(consent.json.consented, true);
  assert.equal((await call("GET", "/v1/companion", { token })).json.error, "no_companion", "past the gate");
  const ws = await wsClose(token);
  assert.equal(ws.opened, true, "WS opens with a consented user's JWT");

  // ── name ──
  assert.deepEqual([(await call("PATCH", "/me", { token, body: { displayName: "   " } })).status], [400]);
  assert.equal((await call("PATCH", "/me", { token, body: { displayName: "Chel" } })).json.user.displayName, "Chel");

  // ── companion in Postgres via the prep store → /me ──
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const store = accounts.prepStore;
  await store.putImage({ id: "img1", userId, mime: "image/jpeg", bytes: 4, check: { passed: true, type: "human", checks: {}, reasons: [] } as any, headBox: null, rightsAck: true, createdAt: new Date().toISOString(), ms: { check: 1, sam: 1 } }, jpeg);
  await store.putCompanion({ id: "comp1", userId, imageId: "img1", type: "human", voiceId: "v1", name: "Jin", createdAt: new Date().toISOString(), prep: newPrepState() });
  const me2 = await call("GET", "/me", { token });
  assert.ok(nullable(shape(me2.json), shape(sample("me.json"))), "/me matches shared/protocol-samples/http/me.json");
  assert.deepEqual([me2.json.hasCompanion, me2.json.prepStatus], [true, "running"]);
  assert.equal((await call("GET", "/v1/companion", { token })).json.name, "Jin");
  assert.ok(existsSync(join(dir, "blobs", "users", userId, "images", "img1")));

  // ── F1-L3 Mac web login: same Apple ID → same account ──
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const start = await call("GET", `/auth/apple/start?challenge=${challenge}&device=mac`);
  assert.equal(start.status, 302);
  const auth = new URL(start.location!);
  assert.equal(auth.origin + auth.pathname, "https://appleid.apple.com/auth/authorize");
  assert.equal(auth.searchParams.get("client_id"), "ai.thebeni.genita.web");
  assert.equal(auth.searchParams.get("redirect_uri"), "https://genita-api.example/auth/apple/callback");
  assert.equal(auth.searchParams.get("response_mode"), "form_post");
  const state = auth.searchParams.get("state")!;
  const webToken = apple.idToken({ sub: "001234.abcd.0001", aud: "ai.thebeni.genita.web", nonce: auth.searchParams.get("nonce") });
  // flip a decoded signature byte: the last base64url char of a 32-byte HMAC carries 2 unused bits, so editing it
  // left the bytes unchanged ~4/64 of the time (flaky "bad_state" assertion)
  const [stateBody, stateSig] = state.split(".");
  const sigBytes = Buffer.from(stateSig, "base64url");
  sigBytes[0] ^= 0x01;
  const tampered = await call("POST", "/auth/apple/callback", { form: { state: `${stateBody}.${sigBytes.toString("base64url")}`, id_token: webToken, code: "c-2" } });
  assert.equal(tampered.location, "genita://auth?error=bad_state");
  const wrongNonce = await call("POST", "/auth/apple/callback", { form: { state, id_token: apple.idToken({ sub: "001234.abcd.0001", aud: "ai.thebeni.genita.web", nonce: "x" }), code: "c-2" } });
  assert.equal(wrongNonce.location, "genita://auth?error=invalid_token");
  assert.equal((await call("POST", "/auth/apple/callback", { form: { error: "user_cancelled_authorize", state } })).location, "genita://auth?error=cancelled");
  const cb = await call("POST", "/auth/apple/callback", { form: { state, id_token: webToken, code: "c-2" } });
  assert.equal(cb.status, 302);
  const back = new URL(cb.location!);
  assert.equal(back.protocol + "//" + back.host, "genita://auth");
  const code = back.searchParams.get("code")!;
  assert.equal((await call("POST", "/auth/exchange", { body: { code, verifier: randomBytes(32).toString("base64url") } })).status, 401, "wrong PKCE verifier");
  const mac = await call("POST", "/auth/exchange", { body: { code, verifier } });
  assert.equal(mac.status, 401, "a code burned by a wrong verifier cannot be retried");
  // fresh round, right verifier
  const cb2 = await call("POST", "/auth/apple/callback", { form: { state, id_token: webToken, code: "c-3" } });
  const code2 = new URL(cb2.location!).searchParams.get("code")!;
  const mac2 = await call("POST", "/auth/exchange", { body: { code: code2, verifier } });
  assert.equal(mac2.status, 200);
  assert.equal(mac2.json.user.id, userId, "Mac web login and iPhone native share one account (same Apple sub)");
  assert.equal(mac2.json.isNew, false);
  assert.equal((await call("POST", "/auth/exchange", { body: { code: code2, verifier } })).status, 401, "one-time code");
  const macToken = mac2.json.token as string;

  // ── logout revokes only that session ──
  assert.equal((await call("POST", "/auth/logout", { token: macToken })).status, 200);
  assert.equal((await call("GET", "/me", { token: macToken })).status, 401);
  assert.equal((await call("GET", "/me", { token })).status, 200, "iPhone session still alive");

  // ── shared dev token still works, mapped to a dev user ──
  assert.equal((await call("GET", "/v1/companion", { token: SHARED, user: "demo" })).json.error, "no_companion");
  assert.equal((await call("GET", "/me", { token: SHARED, user: "demo" })).json.user.provider, "dev");

  // ── F1-L8 delete account ──
  const del = await call("DELETE", "/me", { token });
  assert.deepEqual(del.json, { deleted: true, appleRevoked: true, blobsDeleted: 1 });
  const revoke = apple.requests.find((r) => r.url.endsWith("/auth/revoke"))!;
  // the latest login's refresh token is kept (here the Mac web one) and revoked with its own client_id
  assert.equal(revoke.form.get("token"), "rt-ai.thebeni.genita.web");
  assert.equal(revoke.form.get("client_id"), "ai.thebeni.genita.web");
  assert.equal((await call("GET", "/me", { token })).status, 401);
  assert.equal(existsSync(join(dir, "blobs", "users", userId)), false, "S3/blob objects gone");
  const counts = await tableCounts(accounts.db, userId);
  for (const [tbl, n] of Object.entries(counts)) assert.equal(n, 0, `${tbl} has no rows for the deleted user`);

  const names = events.map((e) => e.event);
  for (const e of ["auth.signed_in", "auth.failed", "consent.accepted", "name.entered", "auth.logged_out", "account.deleted"]) assert.ok(names.includes(e), `logged ${e}`);
  assert.ok(!JSON.stringify(events).includes(token), "tokens never logged");
});
