/**
 * Demo S5: "Muse Spark vision + tool calling, combining what it sees with imported preferences".
 * A product search asked with the camera on sends the latest camera frame to the same web-search call
 * (and to the write-up fallback), with one data line saying what the photo is. Without a camera nothing changes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runProduct, type ProductCtx } from "../src/finds/product.ts";
import type { FindsVendors, OutputItem } from "../src/finds/vendors.ts";
import type { SparkRequest } from "../src/meta/spark.ts";
import type { ServerEvent } from "../src/protocol.ts";

const P1 = "https://www.northline.example.com/products/leather-chelsea-boot-brown";
const P2 = "https://fieldandco.example.com/product/suede-loafer-123456.html";
const OPEN = (url: string): OutputItem => ({ type: "web_search_call", status: "completed", action: { type: "open_page", url } });
const ITEMS = [
  { name: "Leather chelsea boot", url: P1, store: "Northline", price: "$120", taste: "Warm, earthy", situation: "Goes with black" },
  { name: "Suede loafer", url: P2, store: "Field & Co.", price: "", taste: "Understated", situation: "Dark brown" },
];
const FRAME_OLD = "data:image/jpeg;base64,T0xE";
const FRAME_NOW = "data:image/jpeg;base64,Tk9X";
const CAMERA_LINE = /photo from their camera/;

function vendors(o: { text?: string; output: OutputItem[]; writeUp?: string }): FindsVendors & { reqs: SparkRequest[] } {
  const reqs: SparkRequest[] = [];
  return {
    reqs,
    async spark(req) {
      reqs.push(req);
      if (JSON.stringify(req.input).includes("You already searched and opened")) return { text: o.writeUp ?? "", output: [] };
      const json = JSON.stringify({ label: "Shoes", title: "Two to go with it", style_line: "Warm, earthy colors.", situation_line: "With the black outfit", items: ITEMS, say: "Two, both warm browns." });
      return { text: o.text ?? json, output: o.output };
    },
    async *sparkStream() { yield { type: "done" as const, responseId: null, text: "", status: "completed" }; },
    async sam() { return []; },
    async image() { throw new Error("no illustrations"); },
    async pageFacts() { return { kind: "product" as const }; },
    async productImage() { return null; },
  };
}

function ctxFor(v: FindsVendors, frames: string[]): ProductCtx {
  return {
    findId: "find-v1", utteranceId: 3, kind: "product",
    question: "Can you find me some dark brown shoes that go with this?",
    frames, memories: [], replyText: Promise.resolve("On it."), timeZone: "America/Los_Angeles",
    vendors: v, emit: (_e: ServerEvent) => {}, signal: new AbortController().signal, now: () => performance.now(), log: () => {},
    images: false, putImage: async (slot) => `/v1/finds/find-v1/images/${slot}`,
    likes: ["Warm, earthy colors."], hedge: 1,
  };
}

const imagesOf = (req: SparkRequest): string[] =>
  (Array.isArray(req.input) ? req.input : []).flatMap((m) => ("content" in m && Array.isArray(m.content) ? m.content : []))
    .filter((p): p is { type: "input_image"; image_url: string } => (p as { type?: string }).type === "input_image")
    .map((p) => p.image_url);
const textOf = (req: SparkRequest) => JSON.stringify(req.input);

test("camera on: the search sees the latest frame next to the imported taste", async () => {
  const v = vendors({ output: [OPEN(P1), OPEN(P2)] });
  const card = (await runProduct(ctxFor(v, [FRAME_OLD, FRAME_NOW]))).card!;
  assert.equal(card.products!.length, 2);
  const search = v.reqs[0];
  assert.deepEqual(search.tools, [{ type: "web_search" }], "vision and the web search are one call");
  assert.deepEqual(imagesOf(search), [FRAME_NOW], "only the latest frame");
  assert.match(textOf(search), CAMERA_LINE, "the prompt says what the photo is");
  assert.match(textOf(search), /Warm, earthy colors/, "the import line is still there");
});

test("camera on: the write-up fallback over opened pages sees the same frame", async () => {
  const writeUp = JSON.stringify({ label: "Shoes", style_line: "Warm, earthy colors.", items: ITEMS, say: "Two options." });
  const v = vendors({ text: "Now I'll open", output: [OPEN(P1), OPEN(P2)], writeUp });
  await runProduct(ctxFor(v, [FRAME_NOW]));
  assert.equal(v.reqs.length, 2);
  assert.deepEqual(imagesOf(v.reqs[1]), [FRAME_NOW]);
  assert.match(textOf(v.reqs[1]), CAMERA_LINE);
});

test("no camera: no image and no camera line (voice-only search unchanged)", async () => {
  const v = vendors({ output: [OPEN(P1), OPEN(P2)] });
  await runProduct(ctxFor(v, []));
  assert.deepEqual(imagesOf(v.reqs[0]), []);
  assert.doesNotMatch(textOf(v.reqs[0]), CAMERA_LINE);
});
