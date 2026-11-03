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
    return { status: r.status, json: (text ? JSON.parse(text) : null) as Record<string, any>, retryAfter: r.headers.get("retry-after") };
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

  const { user: apple } = await s.accounts.accounts.upsertUser({ provider: "apple", sub: "001.apple", email: "Judge@Example.com", emailVerified: true, displayName: "Judge" });
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

  // an Apple account whose email Apple did not mark verified is never linked
  const { user: unverified } = await s.accounts.accounts.upsertUser({ provider: "apple", sub: "002.apple", email: "maybe@example.com", emailVerified: false });
  await s.start("maybe@example.com");
  const separate = await s.verify("maybe@example.com", s.sent[4].code);
  assert.equal(separate.status, 200);
  assert.notEqual(separate.json.user.id, unverified.id);
  assert.equal(separate.json.user.provider, "email");
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
  for (const bad of ["x<a@evil.com>", "a@evil.com,b@x.com", "\"a\"@x.com", "a b@x.com", "a;b@x.com"]) assert.equal((await s.start(bad)).status, 400, bad);
  assert.equal((await s.call("POST", "/auth/email/start", { email: 42 })).status, 400);
  assert.equal((await s.verify("cap@example.com", "12ab56")).status, 400);
  assert.equal((await s.verify("cap@example.com", "1234567")).status, 400);
});

test("email login: per-address daily cap (10 sends / 24 h)", async (t) => {
  const s = await boot(t);
  for (let i = 0; i < 10; i++) {
    assert.equal((await s.start("day@example.com")).status, 200, `send ${i + 1}`);
    await s.age("day@example.com", 61 * 60); // out of the cooldown and the hour, still inside the day
  }
  assert.equal((await s.start("day@example.com")).status, 429, "11th send within a day");
});

test("email login: parallel starts for one address → one code (cooldown holds under a race)", async (t) => {
  const s = await boot(t);
  const rs = await Promise.all(Array.from({ length: 8 }, () => s.accounts.emailCodes.issue("race@example.com")));
  assert.equal(rs.filter((r) => r.ok).length, 1);
  const rows = await s.accounts.db.query("SELECT count(*)::int AS n FROM email_codes WHERE email = 'race@example.com'");
  assert.equal(rows.rows[0].n, 1);
  const hs = await Promise.all(Array.from({ length: 8 }, () => s.start("race2@example.com")));
  assert.equal(hs.filter((r) => r.status === 200).length, 1, "over HTTP too");
});

test("email login: parallel sends from one IP can't pass the per-IP cap", async (t) => {
  const s = await boot(t, { trustProxy: true });
  // the global 60 / min send cap is lower than the per-IP one: lift the IP cap test past it with two minutes' worth
  const rs = await Promise.all(Array.from({ length: 70 }, (_, i) => s.start(`burst${i}@example.com`, { "x-forwarded-for": "198.51.100.9" })));
  assert.equal(rs.filter((r) => r.status === 200).length, 60, "the global per-minute cap holds under a burst");
  assert.equal(s.sent.length, 60);
});

test("email login: an email account, once made, stays the one this address signs into", async (t) => {
  const s = await boot(t);
  // an Apple account from before email_verified existed (unverified) → email sign-in makes its own account
  const { user: a } = await s.accounts.accounts.upsertUser({ provider: "apple", sub: "003.apple", email: "later@example.com", emailVerified: false });
  await s.start("later@example.com");
  const b = await s.verify("later@example.com", s.sent[0].code);
  assert.equal(b.json.user.provider, "email");
  // the Apple user signs in again and Apple marks the address verified
  await s.accounts.accounts.upsertUser({ provider: "apple", sub: "003.apple", email: "later@example.com", emailVerified: true });
  await s.age("later@example.com", 120);
  await s.start("later@example.com");
  const again = await s.verify("later@example.com", s.sent[1].code);
  assert.equal(again.json.user.id, b.json.user.id, "still the email account, not a switch to the Apple one");
  assert.notEqual(again.json.user.id, a.id);
});

test("email login: the IP is CloudFront's (last X-Forwarded-For entry), a spoofed first entry doesn't reset limits", async (t) => {
  const s = await boot(t, { trustProxy: true });
  // one address, many spoofed first entries: still one viewer IP → the per-IP wrong-code count holds
  await s.start("spoof@example.com", { "x-forwarded-for": "10.9.0.1, 198.51.100.4" });
  const code = s.sent[0].code;
  for (let i = 0; i < 4; i++) await s.verify("spoof@example.com", wrong(code), { "x-forwarded-for": `10.9.${i}.1, 198.51.100.4` });
  const ev = s.events.filter((e) => e.event === "auth.failed");
  assert.ok(ev.length >= 4);
  assert.equal((await s.verify("spoof@example.com", code, { "x-forwarded-for": "10.9.99.1, 198.51.100.4" })).status, 200, "the 5th try is still the code's own");
});

test("email login 11/4: a shared NAT (venue, judges' office) — 50 people sign in from one IP; limits are per address, IP limits are wide", async (t) => {
  const s = await boot(t, { trustProxy: true });
  const ip = { "x-forwarded-for": "203.0.113.7" };
  for (let i = 0; i < 50; i++) assert.equal((await s.start(`p${i}@example.com`, ip)).status, 200, `send ${i + 1}`);
  // a few typos each from the same IP don't lock the room out
  for (let i = 0; i < 50; i++) await s.verify(`p${i}@example.com`, wrong(s.sent[i].code), ip);
  for (let i = 0; i < 50; i++) assert.equal((await s.verify(`p${i}@example.com`, s.sent[i].code, ip)).status, 200, `verify ${i + 1}`);
});

test("email login (Codex P1 #492): wrong codes for an address with no live code don't lock its owner out", async (t) => {
  const s = await boot(t, { trustProxy: true });
  for (let i = 0; i < 15; i++) await s.verify("victim@example.com", String(100000 + i), { "x-forwarded-for": "198.51.100.66" });
  await s.start("victim@example.com", { "x-forwarded-for": "203.0.113.50" });
  assert.equal((await s.verify("victim@example.com", s.sent.at(-1)!.code, { "x-forwarded-for": "203.0.113.50" })).status, 200);
});

test("email login 11/4: per-address limits — resend cooldown and wrong codes across resends; 429 carries Retry-After and 'Try again in N min'", async (t) => {
  const s = await boot(t, { trustProxy: true });
  const ip = { "x-forwarded-for": "203.0.113.9" };
  await s.start("a@example.com", ip);
  const soon = await s.call("POST", "/auth/email/start", { email: "a@example.com" }, ip);
  assert.equal(soon.status, 429);
  assert.ok(soon.json.retryAfterSec >= 1 && soon.json.retryAfterSec <= 60);
  assert.match(soon.json.message, /^Too many tries\. Try again in \d+ min\.$/);
  assert.equal(soon.retryAfter, String(soon.json.retryAfterSec), "Retry-After header");
  // 10 wrong codes for one address in 10 min (two codes of 5) → that address waits, others don't
  for (let round = 0; round < 2; round++) {
    await s.age("a@example.com", 120);
    await s.start("a@example.com", ip);
    for (let i = 0; i < 5; i++) await s.verify("a@example.com", "000000" === s.sent.at(-1)!.code ? "000001" : "000000", ip);
  }
  await s.age("a@example.com", 120);
  await s.start("a@example.com", ip);
  const locked = await s.verify("a@example.com", s.sent.at(-1)!.code, ip);
  assert.equal(locked.status, 429, "11th try for the address in 10 min");
  assert.match(locked.json.message, /Try again in \d+ min/);
  await s.start("b@example.com", ip);
  assert.equal((await s.verify("b@example.com", s.sent.at(-1)!.code, ip)).status, 200, "another address on the same IP is fine");
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
