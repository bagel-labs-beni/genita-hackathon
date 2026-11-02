/**
 * Email one-time-code sign-in (POST /auth/email/start + /auth/email/verify) on the real server
 * with PGlite and a capturing mail sender. Also the sender choice per environment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startServer, defaultDeps } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { testDb } from "./helpers/db.ts";
import { createAccounts } from "../src/auth/index.ts";
import { mailSenderFromEnv, type MailSender } from "../src/auth/email.ts";

type Sent = { to: string; code: string };

async function boot(t: import("node:test").TestContext, o: { mail?: MailSender | null; trustProxy?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "genita-email-"));
  const sent: Sent[] = [];
  const capture: MailSender = { kind: "test", async send(to, code) { sent.push({ to, code }); } };
  const env: NodeJS.ProcessEnv = {
    GENITA_DATA_DIR: dir,
    GENITA_JWT_SECRET: "j".repeat(40),
    GENITA_AUTH_RATE_PER_MIN: "100000",
    ...(o.trustProxy ? { GENITA_TRUST_PROXY: "1" } : {}),
  };
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const log = (event: string, data: Record<string, unknown>) => events.push({ event, data });
  const config = { ...loadConfig({ MODEL_API_KEY: "m" }), port: 0 };
  const accounts = (await createAccounts(env, log, { loopback: true, db: await testDb(), mail: o.mail === undefined ? capture : o.mail }))!;
  const server = await startServer(config, log, defaultDeps(config, log), env, accounts);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, json: (text ? JSON.parse(text) : null) as Record<string, any> };
  };
  const start = (email: string, headers?: Record<string, string>) => call("POST", "/auth/email/start", { email }, headers);
  const verify = (email: string, code: string, headers?: Record<string, string>) => call("POST", "/auth/email/verify", { email, code }, headers);
  /** moves every code for `email` back in time (cooldown / hourly cap / expiry without waiting) */
  const age = (email: string, seconds: number) =>
    accounts.db.query(`UPDATE email_codes SET created_at = created_at - make_interval(secs => $2), expires_at = expires_at - make_interval(secs => $2) WHERE email = $1`, [email, seconds]);
  return { call, start, verify, sent, events, accounts, age };
}

const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

test("email login: start mails a 6-digit code, verify signs in with the same session token as Apple", async (t) => {
  const s = await boot(t);
  const r = await s.start("  New.Person@Example.com ");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, expiresInSec: 600, resendAfterSec: 60 });
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].to, "new.person@example.com", "trimmed + lowercased");
  assert.match(s.sent[0].code, /^\d{6}$/);

  const rows = (await s.accounts.db.query("SELECT * FROM email_codes")).rows;
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(s.sent[0].code), "the code itself is never stored, only its keyed hash");

  const v = await s.verify("new.person@example.com", s.sent[0].code);
  assert.equal(v.status, 200);
  assert.equal(typeof v.json.token, "string");
  assert.equal(v.json.isNew, true);
  assert.equal(v.json.user.provider, "email");
  assert.equal(v.json.user.email, "new.person@example.com");
  assert.equal(v.json.consented, false, "CS01 still applies");
  const me = await s.call("GET", "/me", undefined, { authorization: `Bearer ${v.json.token}` });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.id, v.json.user.id);

  assert.equal((await s.verify("new.person@example.com", s.sent[0].code)).status, 401, "a code works once");
  assert.ok(s.events.some((e) => e.event === "auth.signed_in" && e.data.provider === "email"));
  assert.ok(!JSON.stringify(s.events).includes(s.sent[0].code), "the code is never logged");
});

test("email login: same email again → the same account; an Apple account with that verified email is reused", async (t) => {
  const s = await boot(t);
  await s.start("pal@example.com");
  const first = await s.verify("pal@example.com", s.sent[0].code);
  await s.age("pal@example.com", 120);
  await s.start("PAL@example.com");
  const again = await s.verify("pal@example.com", s.sent[1].code);
  assert.equal(again.status, 200);
  assert.equal(again.json.user.id, first.json.user.id);
  assert.equal(again.json.isNew, false);

  const { user: apple } = await s.accounts.accounts.upsertUser({ provider: "apple", sub: "001.apple", email: "Judge@Example.com", displayName: "Judge" });
  await s.start("judge@example.com");
  const linked = await s.verify("judge@example.com", s.sent[2].code);
  assert.equal(linked.status, 200);
  assert.equal(linked.json.user.id, apple.id, "signs into the existing Apple account");
  assert.equal(linked.json.user.provider, "apple");
  assert.equal(linked.json.isNew, false);

  // a dev/judge row is never linked by email (its email was never verified)
  await s.accounts.db.query("INSERT INTO users (provider, provider_sub, email) VALUES ('dev', 'someone', 'dev@example.com')");
  await s.start("dev@example.com");
  const fresh = await s.verify("dev@example.com", s.sent[3].code);
  assert.equal(fresh.json.user.provider, "email");
  assert.equal(fresh.json.isNew, true);
});

test("email login: no user enumeration — start answers the same for a known and an unknown email", async (t) => {
  const s = await boot(t);
  await s.accounts.accounts.upsertUser({ provider: "apple", sub: "001.known", email: "known@example.com" });
  const known = await s.start("known@example.com");
  const unknown = await s.start("unknown@example.com");
  assert.equal(known.status, unknown.status);
  assert.deepEqual(known.json, unknown.json);
  assert.equal(s.sent.length, 2, "a code is mailed either way");
});

test("email login: 5 wrong tries burn the code (then even the right one fails); expired and replaced codes fail", async (t) => {
  const s = await boot(t);
  await s.start("try@example.com");
  const code = s.sent[0].code;
  for (let i = 0; i < 4; i++) {
    const r = await s.verify("try@example.com", wrong(code));
    assert.equal(r.status, 401, `wrong try ${i + 1}`);
    assert.equal(r.json.reason, "code_invalid");
  }
  const fifth = await s.verify("try@example.com", wrong(code));
  assert.equal(fifth.status, 429);
  assert.equal(fifth.json.error, "too_many_attempts");
  const right = await s.verify("try@example.com", code);
  assert.equal(right.status, 429, "the burned code stays dead");

  await s.age("try@example.com", 120);
  await s.start("try@example.com");
  await s.age("try@example.com", 601);
  assert.equal((await s.verify("try@example.com", s.sent[1].code)).status, 401, "expired after 10 minutes");

  await s.start("swap@example.com");
  await s.age("swap@example.com", 120);
  await s.start("swap@example.com");
  assert.equal((await s.verify("swap@example.com", s.sent[2].code)).status, 401, "a newer code replaces the old one");
  assert.equal((await s.verify("swap@example.com", s.sent[3].code)).status, 200);
});

test("email login: per-email cooldown (60 s) and hourly cap (5); bad input → 400", async (t) => {
  const s = await boot(t);
  assert.equal((await s.start("cap@example.com")).status, 200);
  const soon = await s.start("cap@example.com");
  assert.equal(soon.status, 429);
  assert.equal(soon.json.error, "rate_limited");
  assert.ok(soon.json.retryAfterSec > 0 && soon.json.retryAfterSec <= 60);
  for (let i = 0; i < 4; i++) {
    await s.age("cap@example.com", 61);
    assert.equal((await s.start("cap@example.com")).status, 200, `send ${i + 2}`);
  }
  await s.age("cap@example.com", 61);
  assert.equal((await s.start("cap@example.com")).status, 429, "6th send inside the hour");
  assert.equal(s.sent.length, 5);

  assert.equal((await s.start("not-an-email")).status, 400);
  assert.equal((await s.call("POST", "/auth/email/start", { email: 42 })).status, 400);
  assert.equal((await s.verify("cap@example.com", "12ab56")).status, 400);
  assert.equal((await s.verify("cap@example.com", "1234567")).status, 400);
});

test("email login: per-IP limits on sends and on wrong codes", async (t) => {
  const s = await boot(t, { trustProxy: true });
  const ip = { "x-forwarded-for": "203.0.113.7" };
  for (let i = 0; i < 20; i++) assert.equal((await s.start(`p${i}@example.com`, ip)).status, 200, `send ${i + 1}`);
  const over = await s.start("p20@example.com", ip);
  assert.equal(over.status, 429);
  assert.equal((await s.start("p20@example.com", { "x-forwarded-for": "203.0.113.8" })).status, 200, "another IP is not affected");

  // 20 wrong codes from one IP across many emails → the IP is paused even for a right code
  for (let i = 0; i < 20; i++) await s.verify(`p${i}@example.com`, wrong(s.sent[i].code), ip);
  const paused = await s.verify("p20@example.com", s.sent[20].code, ip);
  assert.equal(paused.status, 429);
  assert.equal((await s.verify("p20@example.com", s.sent[20].code, { "x-forwarded-for": "203.0.113.8" })).status, 200);
});

test("email login: a failed send returns 502 and does not burn the cooldown", async (t) => {
  let fail = true;
  const sent: string[] = [];
  const flaky: MailSender = { kind: "test", async send(_to, code) { if (fail) throw new Error("smtp down"); sent.push(code); } };
  const s = await boot(t, { mail: flaky });
  const r = await s.start("flaky@example.com");
  assert.equal(r.status, 502);
  assert.equal(r.json.error, "send_failed");
  fail = false;
  assert.equal((await s.start("flaky@example.com")).status, 200, "retry right away");
  assert.equal((await s.verify("flaky@example.com", sent[0])).status, 200);
});

test("email login: no mail sender (deployed without a key) → 503, nothing stored", async (t) => {
  const s = await boot(t, { mail: null });
  const r = await s.start("off@example.com");
  assert.equal(r.status, 503);
  assert.equal(r.json.error, "email_unavailable");
  assert.equal((await s.accounts.db.query("SELECT count(*)::int AS n FROM email_codes")).rows[0].n, 0);
});

test("email login: /v1/auth/email/* answers like /auth/email/*", async (t) => {
  const s = await boot(t);
  const r = await s.call("POST", "/v1/auth/email/start", { email: "v1@example.com" });
  assert.equal(r.status, 200);
  const v = await s.call("POST", "/v1/auth/email/verify", { email: "v1@example.com", code: s.sent[0].code, device: "mac" });
  assert.equal(v.status, 200);
  assert.equal(typeof v.json.token, "string");
});

test("mail sender: loopback without a key logs the code; deployed without a key = none; with a key = Resend, code never logged", async () => {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const log = (event: string, data: Record<string, unknown>) => events.push({ event, data });

  const dev = mailSenderFromEnv({}, log, { loopback: true });
  assert.equal(dev?.kind, "log");
  await dev!.send("dev@example.com", "123456", 10);
  assert.ok(events.some((e) => e.event === "auth.email_code_dev" && e.data.code === "123456"));

  assert.equal(mailSenderFromEnv({}, log, { loopback: false }), null, "deployed: never the log sender");
  assert.equal(mailSenderFromEnv({ NODE_ENV: "production" }, log, { loopback: true }), null, "production: never the log sender");
  assert.equal(mailSenderFromEnv({ RESEND_API_KEY: "re_test" }, log, { loopback: false }), null, "a key without a From address is off");

  events.length = 0;
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
  }) as unknown as typeof fetch;
  const resend = mailSenderFromEnv({ RESEND_API_KEY: "re_test", GENITA_MAIL_FROM: "Genita <login@example.com>" }, log, { loopback: false }, fakeFetch);
  assert.equal(resend?.kind, "resend");
  await resend!.send("to@example.com", "654321", 10);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer re_test");
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body.to, ["to@example.com"]);
  assert.equal(body.from, "Genita <login@example.com>");
  assert.ok(body.subject.includes("654321") && body.text.includes("654321") && body.html.includes("654321"));
  assert.ok(!JSON.stringify(events).includes("654321"), "Resend path never logs the code");

  const failing = mailSenderFromEnv({ RESEND_API_KEY: "re_test", GENITA_MAIL_FROM: "a@example.com" }, log, { loopback: false }, (async () => new Response("{\"message\":\"to@example.com bounced\"}", { status: 422 })) as unknown as typeof fetch);
  await assert.rejects(failing!.send("to@example.com", "111111", 10), /resend_422/);
});
