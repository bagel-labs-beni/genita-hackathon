/**
 * prompt-100 (11/4): the Mac stage before its first frame. The reply only described what it "saw", the unseen guard
 * dropped every sentence, the plain retry did the same, and the call got "Sorry, I lost you" (the bake-off: an empty
 * reply). Now the retry is told no frame came and answers from their words.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import { turn } from "./helpers/emptyReplies.ts";
import { NO_FRAME_RETRY_LINE } from "../src/convo/guard.ts";

const done = (): SparkStreamEvent => ({ type: "done", responseId: "r", text: "", status: "completed" });
const v1 = process.env.GENITA_CONVO_V1 !== "0";
const answer = (events: Awaited<ReturnType<typeof turn>>["events"]) => events.find((e) => e.type === "reply")?.text;

test("no frame: a reply that only describes what it sees is retried without vision, never empty or 'lost you'", { skip: !v1 }, async () => {
  const requests: SparkRequest[] = [];
  const { events, logs } = await turn({ async *spark(req) {
    requests.push(req);
    const noFrame = (req.instructions ?? "").includes(NO_FRAME_RETRY_LINE);
    yield { type: "text", delta: noFrame ? "Go with the black one, it's the sharper pick for tonight." : "You look amazing in that black dress." };
    yield done();
  } });
  assert.equal(answer(events), "Go with the black one, it's the sharper pick for tonight.");
  assert.ok(requests.at(-1)?.instructions?.includes(NO_FRAME_RETRY_LINE), "the retry carries the no-frame line");
  assert.ok(!requests[0].instructions?.includes(NO_FRAME_RETRY_LINE), "the first try doesn't");
  assert.ok(!logs.some((l) => l.event === "spark.lost_line"));
});

test("a plain empty retry stays the same request (no no-frame line without an unseen drop)", { skip: !v1 }, async () => {
  const requests: SparkRequest[] = [];
  await turn({ async *spark(req) { requests.push(req); if (requests.length > 3) yield { type: "text", delta: "Yes!" }; yield done(); } });
  assert.ok(requests.every((r) => !(r.instructions ?? "").includes(NO_FRAME_RETRY_LINE)));
});
