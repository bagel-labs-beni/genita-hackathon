/** AU-10 · SE-03 step 4 (D37): a stored RP-1 report also goes out as a feedback mail (reason and surface, no note). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startServer, defaultDeps } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { createAccounts } from "../src/auth/index.ts";
import { reportMailerFromEnv, type ReportMail } from "../src/auth/email.ts";
import { testDb } from "./helpers/db.ts";

test("AU-10: a report is stored and mailed to the feedback address without the user's note", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genita-report-mail-"));
  const env: NodeJS.ProcessEnv = { GENITA_DATA_DIR: dir, GENITA_JWT_SECRET: "j".repeat(40), GENITA_AUTH_RATE_PER_MIN: "1000", GENITA_JUDGE_CODES: "alpha=correct-horse-1" };
  const sent: ReportMail[] = [];
  const config = { ...loadConfig({ MODEL_API_KEY: "m" }), port: 0 };
  const log = () => {};
  const accounts = (await createAccounts(env, log, { loopback: true, db: await testDb(false), reportMail: { kind: "test", async send(r) { sent.push(r); } } }))!;
  const server = await startServer(config, log, defaultDeps(config, log), env, accounts);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  const post = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  const s = await post("/auth/judge", { code: "correct-horse-1" });
  assert.equal(s.status, 200);
  const r = await post("/me/report", { reason: "harmful_answer", surface: "call", note: "my private note" }, s.json.token);
  assert.equal(r.status, 200);
  for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((res) => setTimeout(res, 10));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].reason, "harmful_answer");
  assert.equal(sent[0].surface, "call");
  assert.equal(sent[0].hasNote, true);
  assert.ok(!JSON.stringify(sent).includes("my private note"), "the note stays in the stored report, not in the mail");
});

test("AU-10: the report mailer needs a key, a from and a feedback address; Resend gets reason and surface", async () => {
  assert.equal(reportMailerFromEnv({}, () => {}), null);
  assert.equal(reportMailerFromEnv({ RESEND_API_KEY: "k", GENITA_MAIL_FROM: "a@b.co" }, () => {}), null, "no GENITA_REPORT_TO: off");
  const bodies: any[] = [];
  const m = reportMailerFromEnv({ RESEND_API_KEY: "k", GENITA_MAIL_FROM: "Genita <no-reply@genita.test>", GENITA_REPORT_TO: "feedback@genita.test" }, () => {}, (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  }) as typeof fetch)!;
  await m.send({ at: "2026-11-04T00:00:00Z", userId: "u1", device: "iphone", reason: "other", surface: "settings", hasNote: false, key: "users/u1/reports/x.json" });
  assert.deepEqual(bodies[0].to, ["feedback@genita.test"]);
  assert.match(bodies[0].subject, /other/);
  assert.match(bodies[0].text, /settings/);
});
