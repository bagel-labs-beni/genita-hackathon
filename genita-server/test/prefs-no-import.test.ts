/**
 * Chelsea 11/4: no GPT → R1 ("this is you") and the six preference rows come from D01 + the P answers alone.
 * Its own file (not test/insights.test.ts) so it lands next to the D95 insight-quotes change without a conflict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { FileStore } from "../src/prep/store.ts";
import { createPrepRoutes } from "../src/prep/routes.ts";
import type { PrepDeps } from "../src/prep/pipeline.ts";
import type { PrepRunner } from "../src/prep/runner.ts";
import { Personalize } from "../src/personalize/service.ts";
import { toStyleCard, type StyleCard } from "../src/prep/importProfile.ts";
import { Insights } from "../src/insights/service.ts";

const ev = (source: string, quote: string) => ({ source, quote });
const obs = (o: Record<string, unknown> = {}) => ({
  category: "think",
  claim: "You decide by comparing, not by being told.",
  evidence: [ev("answer", "Think with me")],
  confidence: "high",
  score: 0.9,
  surprise: 0.7,
  use_in_call: "I'll lay out two options and say which one I'd pick.",
  chips: [],
  ...o,
});
const RAW = {
  headline: "You think out loud and want company while you do.",
  observations: [obs(), obs({ category: "talk", claim: "You want someone close, not a tool.", evidence: [ev("answer", "Close companion")], surprise: 0.9, use_in_call: "I'll stay personal and present." })],
  learning: [{ label: "What you're into" }],
  usage: "In our calls: thinking things through together, close and calm.",
};

type Req = { schemaName: string; input: unknown; instructions?: string };
function harness(handler: (req: Req) => unknown | Promise<unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "prefs-no-import-"));
  const store = new FileStore(dir);
  const calls: Req[] = [];
  const json = (async (req: Req) => { calls.push(req); return handler(req); }) as unknown as PrepDeps["spark"];
  const p = new Personalize({ store, json: json! });
  const ins = new Insights({ json: json!, personalize: p, store });
  return { dir, store, p, ins, calls, json, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}
async function http(h: ReturnType<typeof harness>) {
  const d = { metaKey: "k", store: h.store, voices: [], log: () => {}, spark: h.json, personalize: h.p, insights: h.ins } as unknown as PrepDeps;
  const routes = createPrepRoutes(d, {} as PrepRunner);
  const server: Server = createServer((req, res) => void routes.handle(req, res, "u1"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address() as { port: number };
  return { base: `http://127.0.0.1:${a.port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
const f = (text: string) => ({ text, label: "explicit" as const, scope: "any" });
const CARD = toStyleCard({ sections: { tendencies: [f("Asks for options.")], communication: [f("Jokes even in work threads.")], response: [], help: [], support: [], interests: [], likes: [], boundaries: [], approach: [] }, rules: [], to_confirm: [] }, "import");

// Chelsea 11/4: no GPT (N1–N3, nothing picked) or no card at all → R1 and the six rows come from D01 + P answers alone
test("routes: no-import path (N1–N3 empty, Quick: 3 answers) → R1 written from the answers, six rows filled", async (t) => {
  const { preferenceRows } = await import("../src/prep/preferenceRows.ts");
  const quick = { help: "Think with me", relationship: "Close companion", presence: ["Calm"] };
  for (const withSkip of [true, false]) {
    const h = harness((req) => (req.schemaName === "insight_report" ? RAW : { cards: [], topics: [] }));
    t.after(h.cleanup);
    const s = await http(h);
    t.after(s.close);
    if (withSkip) {
      const skip = await fetch(`${s.base}/v1/import/skip`, { method: "POST", body: JSON.stringify({ interests: [], avoid: [], replies: null }) });
      assert.equal(skip.status, 200);
      await h.ins.get("u1", 3000);   // the N1–N3 report (from no picks)
    } else assert.equal(await h.store.getStyle("u1"), null, "no import and no N1–N3 card");
    const post = await fetch(`${s.base}/v1/profile/insights`, { method: "POST", body: JSON.stringify({ answers: quick }) });
    assert.equal(post.status, 202);
    const g = (await (await fetch(`${s.base}/v1/profile/insights?wait=5`)).json()) as { status: string; report: { from: string; settings: Record<string, string>; observations: unknown[] } | null };
    assert.equal(g.status, "ready", `withSkip=${withSkip}`);
    assert.equal(g.report!.from, "answers");
    assert.equal(g.report!.settings.why, "Think with me");
    assert.match(String(h.calls.filter((c) => c.schemaName === "insight_report").at(-1)!.input), /Close companion/, "the P answers are R1's source");
    const card = await h.store.getStyle("u1");
    assert.ok(card, "an (empty) card holds the report");
    const rows = preferenceRows(card, { depth: "quick", answers: quick as never });
    assert.equal(rows.length, 6);
    assert.ok(rows.every((r) => r.items.length > 0 && r.items.every((i) => !/not enough information/i.test(i.text))), JSON.stringify(rows));
  }
});

test("createStyleIfMissing (Codex P1): never overwrites a card that landed first, and a forget since wins", async (t) => {
  const h = harness(() => null);
  t.after(h.cleanup);
  const { skipStyleCard } = await import("../src/prep/importProfile.ts");
  const empty = (skipStyleCard({ interests: [], avoid: [], replies: null }) as { ok: true; card: StyleCard }).card;
  await h.p.replaceStyle("u1", CARD);
  assert.equal(await h.p.createStyleIfMissing("u1", empty, h.p.generation("u1")), false);
  assert.equal((await h.store.getStyle("u1"))!.source, "import", "the import stays");
  const gen = h.p.generation("u2");
  await h.p.forgetAll("u2");
  assert.equal(await h.p.createStyleIfMissing("u2", empty, gen), false, "a forget since the request began wins");
  assert.equal(await h.p.createStyleIfMissing("u3", empty, h.p.generation("u3")), true);
  assert.equal((await h.store.getStyle("u3"))!.source, "skip");
});
