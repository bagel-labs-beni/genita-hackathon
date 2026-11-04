import { test } from "node:test";
import assert from "node:assert/strict";
import { runRecipe, type PipelineCtx } from "../src/finds/pipeline.ts";
import { checkServerEvent, type ServerEvent } from "../src/protocol.ts";
import type { FindsVendors } from "../src/finds/vendors.ts";

const RECIPE = `{"dish":"kimchi fried rice","minutes":15,"ingredients":[{"name":"kimchi","optional":false}],"steps":["Fry.","Add rice.","Top with egg."],"sources":[],"ask":[],"say":"Found one."}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// kimchi: SAM box fast, YES slow; lime: SAM box fast, YES says NO; sam errors for "pear"
function vendors(): FindsVendors {
  return {
    async spark(req) {
      const p = JSON.stringify(req.input);
      const yes = p.match(/Is there (.+?) clearly visible/);
      if (yes) { await sleep(60); return { text: yes[1] === "kimchi" ? "YES" : "NO", output: [] }; }
      if (p.includes("Pick one simple dish")) { await sleep(30); return { text: RECIPE, output: [] }; }
      throw new Error("unexpected spark");
    },
    async *sparkStream() {
      yield { type: "text" as const, delta: "kimchi | - | red jar\nlime | 1 | green fruit\npear | 1 | -\n" };
      yield { type: "done" as const, responseId: null, text: "", status: "completed" };
    },
    async sam(_img, prompt) {
      if (prompt.startsWith("pear")) throw new Error("sam 500");
      if (prompt === "kimchi" || prompt === "lime") return [{ x1: 10, y1: 200, x2: 100, y2: 400, w: 480, h: 854, nx1: 10 / 480, ny1: 200 / 854, nx2: 100 / 480, ny2: 400 / 854 }];
      return [];
    },
    async image() { return Buffer.from([0x89, 0x50, 0x4e, 0x47]); },
  };
}

test("seen foods are boxed as soon as SAM finds them, before the YES and the card; a NO takes the box off; SAM outcomes logged", async () => {
  const events: ServerEvent[] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const ctx: PipelineCtx = {
    findId: "f1", utteranceId: 3, kind: "recipe", question: "What can I make?", frames: ["data:image/jpeg;base64,AAA"], memories: [],
    replyText: Promise.resolve(null), vendors: vendors(),
    emit: (e) => { assert.deepEqual(checkServerEvent(e as unknown as Record<string, unknown>), []); events.push(e); },
    signal: new AbortController().signal, now: () => performance.now(), log: (n, f) => logs.push([n, f as Record<string, unknown>]), images: false,
    putImage: async (slot) => `/x/${slot}`,
  };
  await runRecipe(ctx);
  const types = events.map((e) => e.type);
  const firstBoxes = types.indexOf("observe.boxes");
  assert.ok(firstBoxes > 0, "boxes sent");
  assert.ok(firstBoxes < types.indexOf("find.created"), "boxes before the card");
  const first = events[firstBoxes] as Extract<ServerEvent, { type: "observe.boxes" }>;
  // before any YES came back: both camera foods SAM found are up
  const firstHave = events.findIndex((e) => e.type === "find.items" && e.items.some((i) => i.tier === "have"));
  assert.ok(firstHave === -1 || firstBoxes < firstHave);
  assert.ok(first.items.some((i) => i.label === "Kimchi"));
  const last = [...events].reverse().find((e) => e.type === "observe.boxes") as Extract<ServerEvent, { type: "observe.boxes" }>;
  assert.deepEqual(last.items.map((i) => i.label), ["Kimchi"], "lime's NO takes its box off");
  const sam = logs.filter(([n]) => n === "find.sam").map(([, f]) => f);
  assert.ok(sam.some((f) => typeof f.error === "string" && /500/.test(f.error as string)), "a SAM error is logged");
  assert.ok(sam.some((f) => f.n === 1), "a SAM hit is logged with its count");
});
