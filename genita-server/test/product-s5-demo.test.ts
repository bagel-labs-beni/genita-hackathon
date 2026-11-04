/**
 * Demo S5 on the Mac (lead 11/4 P0, b9 check `genita-demo/s5-b9`): a camera ask looks again, one department per card,
 * the card's words match what is on it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FindsRunner } from "../src/finds/runner.ts";
import { MemoryFindsStore } from "../src/finds/store.ts";
import { clearProductCache } from "../src/finds/productCache.ts";
import { cardSubtitle, cardTitle, departmentOf, productDepartment, productPrompt } from "../src/finds/product.ts";
import type { FindsVendors, OutputItem } from "../src/finds/vendors.ts";
import type { ServerEvent } from "../src/protocol.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OPEN = (url: string): OutputItem => ({ type: "web_search_call", status: "completed", action: { type: "open_page", url } });
const PROFILE = "How the user wants to be treated:\n- Taste: Clean, minimal clothes; black, camel, dark brown.\n- Taste: Leather accessories.";

function vendors(items: Array<{ name: string; url: string }>) {
  const prompts: string[] = [];
  const v: FindsVendors = {
    async spark(req) {
      const p = JSON.stringify(req.input);
      prompts.push(p);
      await sleep(20);
      return {
        text: JSON.stringify({ label: "Shoes", title: "Two for the trench", subtitle: "Dark brown, matched to your style.", style_line: "Black, camel, dark brown.", situation_line: "", items: items.map((i) => ({ ...i, store: "Shop", price: "", taste: "Clean", situation: "" })), say: "Two, both clean." }),
        output: items.map((i) => OPEN(i.url)),
      };
    },
    async *sparkStream() { yield { type: "done" as const, responseId: null, text: "", status: "completed" }; },
    async sam() { return []; },
    async image() { return Buffer.from([0xff, 0xd8]); },
    async pageFacts() { return { kind: "product" as const }; },
    async productImage() { return Buffer.from([0xff, 0xd8, 0xff]); },
  };
  return { v, prompts };
}

function runner(v: FindsVendors, profile = PROFILE) {
  const events: ServerEvent[] = [];
  const r = new FindsRunner({ vendors: v, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds", productHedge: 1, productCache: true }, { emit: (e) => events.push(e), announce: () => {}, log: () => {}, now: () => performance.now() });
  r.configure({ owner: "acct-s5", memories: [], profile });
  return { r, events };
}

const created = (events: ServerEvent[], id: string) => events.find((e) => e.type === "find.created" && e.findId === id) as Extract<ServerEvent, { type: "find.created" }> | undefined;
const started = (events: ServerEvent[], id: string) => events.find((e) => e.type === "find.started" && e.findId === id) as Extract<ServerEvent, { type: "find.started" }> | undefined;

test("S5-1: the demo line with the camera on looks again (never the saved card); without the camera the cache still answers", async () => {
  clearProductCache();
  const { v, prompts } = vendors([
    { name: "Dark Brown Chelsea Boot", url: "https://shop.example.com/products/dark-brown-chelsea-boot" },
    { name: "Dark Brown Penny Loafer", url: "https://store.example.com/product/dark-brown-loafer-2.html" },
  ]);
  const { r, events } = runner(v);
  await sleep(300); // warm-up fills the cache (black, camel, dark brown)
  const ask = "Can you find me some dark brown shoes that go with this?";
  const cam = r.onTurn({ text: ask, frames: ["data:image/jpeg;base64,AAA"], utteranceId: 2, replyText: Promise.resolve(null) })!;
  await r.settle();
  assert.doesNotMatch(started(events, cam.findId)!.detail, /from earlier/, "a fresh look");
  assert.ok(prompts.some((p) => p.includes("input_image")), "the search saw the camera");
  const plain = r.onTurn({ text: ask, frames: [], utteranceId: 3, replyText: Promise.resolve(null) })!;
  await sleep(5);
  assert.match(started(events, plain.findId)!.detail, /from earlier/, "no camera: the cache answers as before");
  r.close();
});

test("S5-2: one department per card — the account's own words, else the search's first pick; never mixed", async () => {
  assert.equal(departmentOf("- Taste: She loves wrap dresses and heels."), "women");
  assert.equal(departmentOf("- Taste: Avoid dresses, skirts and heels."), undefined, "what they avoid says nothing about who they are (Codex r1)");
  assert.equal(departmentOf("- Taste: Wears womenswear.\n- Taste: Never men's cuts."), "women");
  assert.equal(departmentOf("- Taste: His style is clean menswear."), "men");
  assert.equal(departmentOf(PROFILE), undefined, "nothing said: the camera decides");
  assert.equal(productDepartment("Captain Lace-Up Boot https://www.thursdayboots.com/products/mens-captain-boot-arizona-adobe"), "men");
  assert.equal(productDepartment("Women's Duchess Chelsea Boot"), "women");
  assert.equal(productDepartment("Leather Chelsea Boot"), undefined);
  assert.match(productPrompt({ question: "shoes?", recent: [], taste: [], city: null, region: "US", today: "Tuesday", seeing: true }), /department of the person in the photo/);
  assert.match(productPrompt({ question: "shoes?", recent: [], taste: [], city: null, region: "US", today: "Tuesday", department: "women" }), /women's items only/);

  clearProductCache();
  const { v } = vendors([
    { name: "Women's Duchess Chelsea Boot", url: "https://shop.example.com/products/womens-duchess-chelsea-boot" },
    { name: "Captain Lace-Up Boot", url: "https://www.thursdayboots.com/products/mens-captain-boot-arizona-adobe" },
    { name: "Leather Ankle Boot", url: "https://store.example.com/product/leather-ankle-boot-3.html" },
  ]);
  const { r, events } = runner(v);
  const s = r.onTurn({ text: "Can you find me shoes that go with what I'm wearing right now?", frames: ["data:image/jpeg;base64,AAA"], utteranceId: 2, replyText: Promise.resolve(null) })!;
  await r.settle();
  const names = created(events, s.findId)!.card.products!.map((p) => p.name);
  assert.deepEqual(names, ["Women's Duchess Chelsea Boot", "Leather Ankle Boot"], "the men's boot never joins a women's card");
  r.close();
});

test("S5-3: the card's words match the card — count, thing, color", () => {
  assert.equal(cardTitle("Two for the trench", 1), "One for the trench");
  assert.equal(cardTitle("Both go with the trench", 1), "One for you");
  assert.equal(cardTitle("Two for the trench", 2), "Two for the trench");
  assert.equal(cardTitle("", 1), "One for you");
  assert.equal(cardTitle("A pair of picks", 1), "One for you");
  assert.equal(cardTitle("One for you", 2), "Two for you");
  // light-brown boots under "Dark brown, …" (b9 check): the plain line
  assert.equal(cardSubtitle("Dark brown, matched to your style.", "Shoes", ["Tan Chelsea Boot", "Light Brown Suede Boot"]), "Shoes, matched to your style.");
  assert.equal(cardSubtitle("Dark brown, matched to your style.", "Shoes", ["Espresso Chelsea Boot", "Dark Brown Loafer"]), "Dark brown, matched to your style.");
  assert.equal(cardSubtitle("Clean and simple.", "Shoes", ["Black Boot"]), "Clean and simple.");
});

test("S5-3: the searching line names what was asked ('Shoes'), not the outfit the prefetch came from ('Sweater')", async () => {
  clearProductCache();
  const { v } = vendors([
    { name: "Leather Chelsea Boot", url: "https://shop.example.com/products/leather-chelsea-boot" },
    { name: "Suede Loafer", url: "https://store.example.com/product/suede-loafer-2.html" },
  ]);
  const { r, events } = runner(v, "");
  const s = r.onTurn({ text: "Can you find me shoes that go with what I'm wearing right now?", frames: ["data:image/jpeg;base64,AAA"], utteranceId: 2, replyText: Promise.resolve(null) })!;
  await r.settle();
  assert.match(started(events, s.findId)!.detail, /^Shoes · /);
  r.close();
});
