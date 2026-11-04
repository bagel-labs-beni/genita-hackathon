import { test } from "node:test";
import assert from "node:assert/strict";
import { hedged } from "../src/util/hedge.ts";

type Ev = { type: "text" | "tool" | "done"; v: string };
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true });
  });

function lane(name: string, firstMs: number, log: string[], fail = false) {
  return async function* (signal: AbortSignal): AsyncGenerator<Ev> {
    try {
      yield { type: "tool", v: `${name}:tool` };
      await sleep(firstMs, signal);
      if (fail) throw new Error(`${name} failed`);
      yield { type: "text", v: `${name}:a` };
      await sleep(5, signal);
      yield { type: "text", v: `${name}:b` };
      yield { type: "done", v: name };
    } catch (e) {
      if (signal.aborted) log.push(`${name} aborted`);
      throw e;
    }
  };
}
const collect = async (it: AsyncIterable<Ev>) => {
  const out: string[] = [];
  for await (const e of it) out.push(e.v);
  return out;
};
const isText = (e: Ev) => e.type === "text";

test("the lane whose first text arrives first wins; its buffered events come first; others are aborted", async () => {
  const log: string[] = [];
  const lanes = [lane("slow", 60, log), lane("fast", 10, log)];
  const out = await collect(hedged(2, (sig, i) => lanes[i](sig), new AbortController().signal, isText));
  assert.deepEqual(out, ["fast:tool", "fast:a", "fast:b", "fast"]);
  await sleep(5);
  assert.deepEqual(log, ["slow aborted"]);
});

test("n = 1 is a plain pass-through", async () => {
  const out = await collect(hedged(1, (sig) => lane("only", 1, [])(sig), new AbortController().signal, isText));
  assert.deepEqual(out, ["only:tool", "only:a", "only:b", "only"]);
});

test("a failing lane is ignored while another succeeds; all failing rethrows", async () => {
  const log: string[] = [];
  const ok = await collect(hedged(2, (sig, i) => (i === 0 ? lane("bad", 1, log, true) : lane("good", 20, log))(sig), new AbortController().signal, isText));
  assert.deepEqual(ok, ["good:tool", "good:a", "good:b", "good"]);
  await assert.rejects(collect(hedged(2, (sig, i) => lane(`bad${i}`, 1, log, true)(sig), new AbortController().signal, isText)), /failed/);
});

test("aborting the parent aborts every lane", async () => {
  const log: string[] = [];
  const parent = new AbortController();
  const it = hedged(2, (sig, i) => lane(`l${i}`, 200, log)(sig), parent.signal, isText);
  const p = collect(it).catch(() => "rejected");
  await sleep(10);
  parent.abort();
  await p;
  assert.deepEqual(log.sort(), ["l0 aborted", "l1 aborted"]);
});

test("closing the consumer aborts and closes all three independent iterators", async () => {
  const closed: number[] = [];
  const output = hedged(3, async function* (signal, lane): AsyncGenerator<Ev> {
    try {
      if (lane) await sleep(200, signal);
      yield { type: "text", v: "Yes!" };
    } finally { closed.push(lane); }
  }, new AbortController().signal, isText);
  for await (const _event of output) break;
  await sleep(5);
  assert.deepEqual(closed.sort(), [0, 1, 2]);
});

test("a completed tool fallback aborts a stalled tag-only lane after a bounded grace", async () => {
  const parent = new AbortController();
  const deadline = setTimeout(() => parent.abort(new Error("fallback stalled")), 1500);
  let tagAborted = false;
  const started = Date.now();
  try {
    const out = await collect(hedged(2, async function* (signal, lane): AsyncGenerator<Ev> {
      if (!lane) {
        yield { type: "tool", v: "remember" };
        yield { type: "done", v: "complete" };
      } else {
        yield { type: "text", v: "<warm>" };
        try { await sleep(5000, signal); }
        finally { tagAborted = signal.aborted; }
      }
    }, parent.signal, (e) => e.type === "text" && e.v !== "<warm>", (e) => e.type === "tool"));
    assert.deepEqual(out, ["remember", "complete"]);
    assert.ok(Date.now() - started < 1200, "fallback does not wait for the upstream timeout");
    assert.equal(parent.signal.aborted, false);
    assert.equal(tagAborted, true, "the stalled loser was aborted");
  } finally { clearTimeout(deadline); parent.abort(); }
});

test("a text lane arriving within the fallback grace still wins", async () => {
  const out = await collect(hedged(2, async function* (_signal, lane): AsyncGenerator<Ev> {
    if (!lane) yield { type: "tool", v: "recall" };
    else { await sleep(20); yield { type: "text", v: "Yes!" }; }
  }, new AbortController().signal, isText, (e) => e.type === "tool"));
  assert.deepEqual(out, ["Yes!"]);
});
