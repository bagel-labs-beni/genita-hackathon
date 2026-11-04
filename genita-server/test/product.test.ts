import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTurn, isProductAsk } from "../src/finds/intent.ts";
import { completedOpens, groundStyle, isProductPage, matchOpened, runProduct, tasteLines, urlKey, urlShape, cityOf, cleanPrice, hardList, hedgedSearch, httpsOf, shortLabel, shortName, SEARCH_TITLE, PILL_MAX, TWO_SAY, ONE_SAY, searchedLine, type ProductCtx } from "../src/finds/product.ts";
import { allowedUrl, formatPrice, isImageBytes, isPrivateAddress, readPageFacts, type PageFacts } from "../src/finds/fetchPage.ts";
import { webActions, type FindsVendors, type OutputItem } from "../src/finds/vendors.ts";
import { FindsRunner } from "../src/finds/runner.ts";
import { MemoryFindsStore } from "../src/finds/store.ts";
import { likesFromStyle } from "../src/finds/setup.ts";
import { checkServerEvent, type ServerEvent } from "../src/protocol.ts";

// ───────────── intent ─────────────

test("product intent: voice alone starts it; shopping beats the camera; other asks stay chat", () => {
  assert.deepEqual(classifyTurn("Jin, can we look for a jacket for this weekend?", false), { kind: "product" });
  assert.deepEqual(classifyTurn("Find a couple that match my style, and send me the links.", false), { kind: "product" });
  // sweep 11/3 [P1]: "send me the links" alone is not a shopping ask — a web answer with its sources sheet
  // not a product search: a web search card (general.ts, 11/4; was the reply's own sources sheet, #413)
  assert.deepEqual(classifyTurn("What are the best ramen places in Seoul? Send me the links.", false), { kind: "answer" });
  assert.equal(classifyTurn("send me the links", false), null);
  assert.deepEqual(classifyTurn("send me the links", false, true), { kind: "product" }, "right after a product search it still is");
  assert.deepEqual(classifyTurn("Can you send me the links for those sneakers?", false), { kind: "product" });
  assert.deepEqual(classifyTurn("Any product links?", false), { kind: "product" });
  assert.deepEqual(classifyTurn("Send me the links for black heels.", false), { kind: "product" }, "Codex P2");
  assert.deepEqual(classifyTurn("Can you send me the links for earrings?", false), { kind: "product" });
  assert.deepEqual(classifyTurn("can you find me some white sneakers", true), { kind: "product" }, "shopping words win over the camera");
  assert.deepEqual(classifyTurn("Which jacket should I wear, this or that?", true), { kind: "outfit" });
  assert.deepEqual(classifyTurn("What can I make with what's in my fridge?", true), { kind: "recipe" });
  assert.equal(classifyTurn("Can you look for my keys?", false), null);
  assert.equal(classifyTurn("I'm looking for a new job", false), null);
  assert.equal(classifyTurn("I love this jacket", false), null);
  assert.ok(isProductAsk("재킷 좀 찾아줘"));
  // Codex review P2: an outfit question with the camera is not a shopping search
  assert.deepEqual(classifyTurn("Does this jacket match my style?", true), { kind: "outfit" });
  assert.equal(classifyTurn("Does this match my style?", false), null);
  assert.deepEqual(classifyTurn("Can you make them match my style?", false, true), { kind: "product" }, "after a product search it refines");
});

// ───────────── tool trace ─────────────

const OPEN = (url: string, status = "completed"): OutputItem => ({ type: "web_search_call", status, action: { type: "open_page", url } });
const SEARCH: OutputItem = { type: "web_search_call", status: "completed", action: { type: "search", query: "jacket" } };

test("tool trace: a failed open_page is not an open (product and link cards)", () => {
  const out = [SEARCH, OPEN("https://shop.example.com/products/a", "failed"), OPEN("https://shop.example.com/products/b")];
  assert.deepEqual(completedOpens(out), ["https://shop.example.com/products/b"]);
  assert.deepEqual(webActions(out), { searches: 1, opened: ["https://shop.example.com/products/b"] });
});

test("urls: the item must be a page the search opened (www, slash, case, tracking params ignored)", () => {
  const opened = ["https://www.Shop.example.com/products/chore-jacket/?utm_source=x", "https://store.example.org/item?id=42&ref=y"];
  assert.equal(matchOpened("https://shop.example.com/products/chore-jacket", opened), opened[0]);
  assert.equal(matchOpened("https://store.example.org/item?id=42", opened), opened[1]);
  assert.equal(matchOpened("https://store.example.org/item?id=43", opened), null, "another product id is not the opened page");
  assert.equal(matchOpened("https://shop.example.com/products/other", opened), null);
  assert.equal(matchOpened("javascript:alert(1)", opened), null);
  assert.equal(urlKey("ftp://x.com/a"), null);
});

test("urls: product detail pages vs category / search / collection pages", () => {
  for (const u of [
    "https://www.uniqlo.com/eu/en_EE/product/airsense-jacket-465474.html",
    "https://www.cos.com/en-us/men/mens-jackets/product.reversible-quilted-jacket-light-grey.1316463001.html",
    "https://shop.example.com/collections/jackets/products/chore-jacket",
    "https://www.amazon.com/Some-Jacket/dp/B0ABCDEF12",
    "https://www.everlane.com/products/mens-chore-jacket-navy",
  ])
    assert.equal(urlShape(u), "product", u);
  for (const u of [
    "https://shop.example.com/search?q=jacket",
    "https://shop.example.com/collections/jackets",
    "https://shop.example.com/men/jackets",
    "https://shop.example.com/category/outerwear",
    "https://shop.example.com/",
    "https://blog.example.com/blog/best-light-jackets",
  ])
    assert.equal(urlShape(u), "list", u);
  // the page's own markup wins over the URL shape
  assert.equal(isProductPage("https://shop.example.com/men/jackets", { kind: "product" }), true);
  assert.equal(isProductPage("https://shop.example.com/products/x", { kind: "list" }), false);
  assert.equal(isProductPage("https://shop.example.com/products/x", null), true);
  assert.equal(isProductPage("https://shop.example.com/collections/x", null), false);
});

// ───────────── page facts ─────────────

test("page facts: JSON-LD Product gives kind, price and picture; ItemList is a list page", () => {
  const html = `<html><head><meta property="og:image" content="/img/jacket.jpg"><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},{"@type":"Product","name":"Cotton Chore Jacket &amp; more","offers":{"@type":"Offer","price":"68.00","priceCurrency":"USD"}}]}</script></head></html>`;
  const f = readPageFacts(html, "https://shop.example.com/products/chore");
  assert.deepEqual(f, { kind: "product", title: "Cotton Chore Jacket & more", image: "https://shop.example.com/img/jacket.jpg", price: "$68" });
  const meta = readPageFacts(`<meta property="og:type" content="product"><meta property="product:price:amount" content="79.9"><meta property="product:price:currency" content="EUR">`, "https://x.example.com/p/1");
  assert.equal(meta.kind, "product");
  assert.equal(meta.price, "€79.90");
  assert.equal(readPageFacts(`<script type="application/ld+json">{"@type":"ItemList","itemListElement":[]}</script>`, "https://x.example.com/c").kind, "list");
  // Codex review P2: a collection page that embeds Product tiles is still a list
  assert.equal(readPageFacts(`<script type="application/ld+json">[{"@type":"CollectionPage"},{"@type":"Product","name":"A","offers":{"price":"10","priceCurrency":"USD"}}]</script>`, "https://x.example.com/collections/jackets").kind, "list");
  assert.equal(readPageFacts(`<title>hi</title>`, "https://x.example.com/").kind, "unknown");
  assert.equal(readPageFacts(`<meta property="og:image" content="http://insecure.example.com/a.jpg">`, "https://x.example.com/").image, undefined, "https pictures only");
  assert.equal(formatPrice("0", "USD"), undefined);
  assert.equal(formatPrice(129000, "KRW"), "₩129,000");
});

test("fetch guard: public https only; private, metadata and odd hosts are refused", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) assert.ok(!isPrivateAddress(ip), ip);
  // Codex review P1: every spelling of a mapped / compatible / NAT64 / 6to4 private v4
  for (const ip of ["::ffff:7f00:1", "::ffff:a00:1", "0:0:0:0:0:ffff:a9fe:a9fe", "::127.0.0.1", "::7f00:1", "64:ff9b::a00:1", "2002:a00:1::", "fd00:ec2::254", "::ffff:169.254.169.254"]) assert.ok(isPrivateAddress(ip), ip);
  assert.ok(!isPrivateAddress("::ffff:5db8:d822"), "mapped public v4 is public");
  assert.ok(allowedUrl("https://shop.example.com/products/a"));
  for (const u of ["http://shop.example.com/a", "https://user:pw@shop.example.com/", "https://shop.example.com:8443/", "https://127.0.0.1/", "https://localhost/", "https://printer.local/", "file:///etc/passwd"]) assert.equal(allowedUrl(u), null, u);
  assert.ok(isImageBytes(Buffer.from([0xff, 0xd8, 0xff])));
  assert.ok(!isImageBytes(Buffer.from("<svg onload=alert(1)>")));
});

// ───────────── taste ─────────────

test("taste: the reason follows a line from the user's own import, never a made-up one", () => {
  const likes = ["Clean, minimal clothes. Understated colors.", "Two or three options to compare."];
  assert.equal(groundStyle("Clean, minimal clothes. Understated colors.", likes), likes[0]);
  assert.equal(groundStyle("minimal clothes in understated colors", likes), likes[0], "paraphrase → the user's own line");
  assert.equal(groundStyle("Loves neon streetwear", ["Quiet weekends at home."]), "");
  assert.equal(groundStyle("anything", []), "");
  const lines = tasteLines(undefined, "How the user wants to be treated:\n- Support: Clean, minimal clothes.\n- Talk: Short replies.\n- Interests: Design", ["She prefers black and grey", "Lives in Seoul"]);
  assert.deepEqual(lines, ["Clean, minimal clothes.", "Design", "She prefers black and grey"]);
  assert.deepEqual(likesFromStyle({ display: [{ key: "likes", items: [{ text: "maybe likes linen", label: "suggested" }, { text: "Clean, minimal clothes.", label: "explicit" }] }] }), ["Clean, minimal clothes.", "maybe likes linen"]);
  assert.equal(likesFromStyle(null), undefined);
  assert.equal(cityOf("Asia/Seoul"), "Seoul");
  assert.equal(cityOf("America/Los_Angeles"), "Los Angeles");
  assert.equal(cityOf("UTC"), null);
});

// ───────────── pipeline with fake vendors ─────────────

const P1 = "https://www.northline.example.com/products/cotton-chore-jacket-navy";
const P2 = "https://fieldandco.example.com/product/linen-overshirt-123456.html";
const CAT = "https://fieldandco.example.com/collections/jackets";
const INVENTED = "https://madeup.example.com/products/never-opened";

function vendors(o: { items: Array<Record<string, string>>; output: OutputItem[]; facts?: Record<string, PageFacts | null>; noImage?: boolean; text?: string; writeUp?: string }): FindsVendors & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async spark(req) {
      prompts.push(JSON.stringify(req.input));
      if (JSON.stringify(req.input).includes("You already searched and opened")) {
        assert.equal(req.tools, undefined, "the write-up cannot search again");
        return { text: o.writeUp ?? "", output: [] };
      }
      assert.deepEqual(req.tools, [{ type: "web_search" }]);
      const json = JSON.stringify({ label: "Light jacket", title: "Two for the weekend", subtitle: "Light jackets, matched to your style.", style_line: "Clean, minimal clothes. Understated colors.", situation_line: "Mild and dry this weekend, 18°C", items: o.items, say: "Two options. Simple cuts, like you prefer." });
      return { text: o.text ?? `I'll look.${json}`, output: o.output };
    },
    async *sparkStream() {
      yield { type: "done" as const, responseId: null, text: "", status: "completed" };
    },
    async sam() {
      return [];
    },
    async image() {
      throw new Error("no illustrations for products");
    },
    async pageFacts(url) {
      return o.facts?.[url] ?? null;
    },
    async productImage() {
      return o.noImage ? null : Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    },
  };
}

function ctxFor(v: FindsVendors, extra: Partial<ProductCtx> = {}): { ctx: ProductCtx; events: ServerEvent[]; stored: string[] } {
  const events: ServerEvent[] = [];
  const stored: string[] = [];
  const ctx: ProductCtx = {
    findId: "find-p1",
    utteranceId: 5,
    kind: "product",
    question: "Jin, can we look for a jacket for this weekend?",
    frames: [],
    memories: [],
    replyText: Promise.resolve("On it."),
    timeZone: "Asia/Seoul",
    vendors: v,
    emit: (e) => {
      assert.deepEqual(checkServerEvent(e as unknown as Record<string, unknown>), [], JSON.stringify(e));
      events.push(e);
    },
    signal: new AbortController().signal,
    now: () => performance.now(),
    log: () => {},
    images: true,
    putImage: async (slot) => (stored.push(slot), `/v1/finds/find-p1/images/${slot}`),
    likes: ["Clean, minimal clothes. Understated colors."],
    hedge: 1,
    ...extra,
  };
  return { ctx, events, stored };
}

const ITEM1 = { name: "Cotton chore jacket", url: P1, store: "Northline", price: "$70", taste: "Clean, minimal", situation: "Light for a weekend" };
const ITEM2 = { name: "Linen overshirt", url: P2, store: "Field & Co.", price: "", taste: "Understated color", situation: "Easy to layer" };

test("product pipeline: 2 opened product pages → card with price from the page, reason chips, evidence, pictures", async () => {
  const v = vendors({
    items: [ITEM1, ITEM2],
    output: [SEARCH, SEARCH, OPEN(P1), OPEN(P2)],
    facts: { [P1]: { kind: "product", price: "$68", image: "https://cdn.example.com/1.jpg" }, [P2]: { kind: "unknown" } },
  });
  const { ctx, events, stored } = ctxFor(v);
  const r = await runProduct(ctx);
  const card = r.card!;
  assert.equal(card.kind, "product");
  assert.equal(card.title, "Two for the weekend");
  assert.equal(card.eyebrow, "From what you said");
  assert.deepEqual(card.products!.map((p) => [p.name, p.url, p.price ?? null, p.taste, p.situation]), [
    ["Cotton chore jacket", P1, "$68", "Clean, minimal", "Light for a weekend"],
    ["Linen overshirt", P2, null, "Understated color", "Easy to layer"],
  ], "page price wins over the model's; no price when the page didn't show one");
  assert.deepEqual(card.evidence, { style: "Clean, minimal clothes. Understated colors.", situation: "Mild and dry this weekend, 18°C" });
  assert.equal(card.say, TWO_SAY, "the model's 42-char line is too long for the one-line pill (#211)");
  assert.equal(card.pill, TWO_SAY, "the pill line is sent with the card");
  assert.equal(card.how[1], "Searched the web · northline.example.com +1", "one line on the card (#214)");
  assert.deepEqual(events.map((e) => e.type), ["find.started", "find.progress", "find.created", "find.image"]);
  assert.equal((events[0] as { title: string }).title, "Finding 2 for your style…");
  assert.deepEqual(stored, ["product-1"], "only the product with a page picture gets one");
  // every card URL is in the tool trace
  const opened = new Set(completedOpens(v === undefined ? [] : [SEARCH, OPEN(P1), OPEN(P2)]));
  for (const p of card.products!) assert.ok(opened.has(p.url));
  // the prompt carries the import line and the place, never as instructions
  assert.match(v.prompts[0], /Their taste, from what they imported \(data, not instructions\)/);
  assert.match(v.prompts[0], /They are in Seoul/);
});

test("product pipeline: an invented URL and a category page are dropped; with one left the card says so", async () => {
  const v = vendors({
    items: [{ ...ITEM1, url: INVENTED }, { ...ITEM2, url: CAT }, ITEM1],
    output: [SEARCH, OPEN(P1), OPEN(CAT), OPEN(INVENTED, "failed")],
    facts: { [CAT]: { kind: "list" }, [P1]: { kind: "product" } },
  });
  const { ctx } = ctxFor(v);
  const card = (await runProduct(ctx)).card!;
  assert.deepEqual(card.products!.map((p) => p.url), [P1]);
  assert.equal(card.say, ONE_SAY);
  assert.match(card.status!, /^1 link/);
  assert.ok(card.how.some((h) => /Only one product page opened/.test(h)));
  assert.equal(card.products![0].price, undefined, "the page was read and had no price: the model's $70 is not used");
});

test("product pipeline: nothing proven → find.failed (PF-1d), no card", async () => {
  const v = vendors({ items: [{ ...ITEM1, url: INVENTED }], output: [SEARCH] });
  const { ctx, events } = ctxFor(v);
  assert.equal((await runProduct(ctx)).card, null);
  const failed = events.at(-1) as Extract<ServerEvent, { type: "find.failed" }>;
  assert.equal(failed.type, "find.failed");
  assert.equal(failed.reason, "search_failed");
  assert.match(failed.message, /Couldn’t find a good match/);
});

test("product pipeline: no import → no blue chip (never a made-up taste); unread page keeps the model's seen price", async () => {
  const v = vendors({ items: [ITEM1, ITEM2], output: [OPEN(P1), OPEN(P2)], noImage: true });
  const { ctx, events } = ctxFor(v, { likes: undefined, profile: undefined });
  const card = (await runProduct(ctx)).card!;
  assert.deepEqual(card.products!.map((p) => p.taste), ["", ""]);
  assert.equal(card.evidence!.style, "");
  assert.equal(card.products![0].price, "$70", "page not readable: the model's price is kept");
  assert.match(card.how[0], /I don’t know your style yet/);
  assert.ok(!events.some((e) => e.type === "find.image"), "no page picture → none promised");
});

test("product pipeline: refining (\"match my style\") sends the earlier ask along", async () => {
  const v = vendors({ items: [ITEM1, ITEM2], output: [OPEN(P1), OPEN(P2)] });
  const { ctx, events } = ctxFor(v, { question: "Find a couple that match my style, and send me the links.", previous: "can we look for a jacket for this weekend?", recent: ["User: can we look for a jacket for this weekend?", "You: On it."] });
  await runProduct(ctx);
  assert.match(v.prompts[0], /This refines the search you already did for: \\"can we look for a jacket for this weekend\?\\"/);
  assert.match(v.prompts[0], /The conversation just before/);
  assert.equal((events[0] as { detail: string }).detail, "Jacket · searching shops");
});

test("product urls: render fragments and search pages are never products; http is upgraded; prices are tidied", () => {
  assert.ok(hardList("https://www.superdry.com/on/demandware.store/Sites-sd-noram-Site/en_US/__SYSTEM__Page-Render?cid=Mens-PDP-Recommendations"));
  assert.ok(hardList("https://shop.example.com/products/x?q=jacket"));
  assert.ok(!hardList("https://www.quince.com/men/featherless-jacket?color=black&tracker=collection_page"));
  assert.equal(isProductPage("https://shop.example.com/search?q=x", { kind: "product" }), false, "a search page with product markup is still a search page");
  assert.equal(httpsOf("http://jcrew.com/p/mens/BE895"), "https://jcrew.com/p/mens/BE895");
  assert.equal(httpsOf("ftp://x.example.com/a"), null);
  assert.equal(cleanPrice("$ 55.90"), "$55.90");
  assert.equal(cleanPrice("89.0 USD"), "$89");
  assert.equal(cleanPrice("158 USD"), "$158");
  assert.equal(cleanPrice("see site"), undefined);
  assert.equal(cleanPrice("12"), undefined, "no currency → no price");
});

test("product pipeline: the search answer came back without a list → one write-up over the opened pages only", async () => {
  const writeUp = JSON.stringify({ label: "Sweater", style_line: "Clean, minimal clothes. Understated colors.", items: [ITEM1, { ...ITEM2, url: INVENTED }], say: "Two options." });
  const v = vendors({ items: [], text: "I found some strong candidates — now I'll open", output: [SEARCH, OPEN(P1), OPEN(P2)], writeUp });
  const { ctx } = ctxFor(v);
  const card = (await runProduct(ctx)).card!;
  assert.equal(v.prompts.length, 2);
  assert.match(v.prompts[1], new RegExp(P1.replace(/[.?/]/g, "\\$&")));
  assert.deepEqual(card.products!.map((p) => p.url), [P1], "the write-up's other URL was not opened and can't be read → dropped");
});

test("product pipeline: a URL the search didn't open counts only if our own read says it's one product", async () => {
  const v = vendors({ items: [{ ...ITEM1, url: INVENTED }, ITEM2], output: [OPEN(P2)], facts: { [INVENTED]: { kind: "product", price: "$40" } } });
  const card = (await runProduct(ctxFor(v).ctx)).card!;
  assert.deepEqual(card.products!.map((p) => [p.url, p.price ?? null]), [[INVENTED, "$40"], [P2, null]]);
  const v2 = vendors({ items: [{ ...ITEM1, url: INVENTED }, ITEM2], output: [OPEN(P2)], facts: { [INVENTED]: { kind: "unknown" } } });
  assert.deepEqual((await runProduct(ctxFor(v2).ctx)).card!.products!.map((p) => p.url), [P2], "readable but not a product page → not proof");
});

test("product names stay short at a word boundary", () => {
  assert.equal(shortName("Cotton chore jacket"), "Cotton chore jacket");
  assert.equal(shortName("Anna-Kaci Active Men's Lightweight Zip-Up Windbreaker Jacket with High Collar and Elastic Cuffs"), "Anna-Kaci Active Men's Lightweight Zip-Up…");
});

test("hedged search: the first call that lists 2 opened pages wins; the slow one is aborted; all-bad → the best", async () => {
  const good = (tag: string) => ({ text: JSON.stringify({ items: [{ url: P1 }, { url: P2 }], tag }), output: [OPEN(P1), OPEN(P2)] });
  const one = { text: JSON.stringify({ items: [{ url: P1 }] }), output: [OPEN(P1)] };
  let aborted = 0;
  type Search = { text: string; output: OutputItem[] };
  const mk = () => {
    const calls: Array<{ resolve: (r: Search) => void; reject: () => void }> = [];
    const vendor: FindsVendors = {
      spark(_req, signal) {
        return new Promise<Search>((resolve, reject) => {
          let settled = false;
          calls.push({ resolve: (r) => { settled = true; resolve(r); }, reject: () => { settled = true; reject(new Error("vendor down")); } });
          signal?.addEventListener("abort", () => { if (!settled) { aborted++; reject(new Error("aborted")); } }, { once: true });
        });
      },
      async *sparkStream() {}, async sam() { return []; }, async image() { return Buffer.alloc(0); },
    };
    return { vendor, calls };
  };
  const fast = mk();
  const pending = hedgedSearch(fast.vendor, "p", 2, new AbortController().signal);
  fast.calls[1].resolve(good("fast"));
  const r = await pending;
  assert.match(r!.text, /fast/);
  assert.equal(aborted, 1, "the slow call was aborted");

  const partial = mk();
  const bestPending = hedgedSearch(partial.vendor, "p", 2, new AbortController().signal);
  partial.calls[0].resolve(one);
  partial.calls[1].reject();
  assert.equal(await bestPending, one, "a vendor failure in one call: the other's partial result is used");

  const bad = mk();
  const none = hedgedSearch(bad.vendor, "p", 1, new AbortController().signal);
  bad.calls[0].reject();
  assert.equal(await none, null);
});

test("searching lines fit one line at 390 pt: short title, whole-word labels, short failure titles", () => {
  assert.ok(SEARCH_TITLE.length <= 28);
  assert.equal(shortLabel("Simple crewneck sweater"), "Simple crewneck");
  assert.equal(shortLabel("Light jacket"), "Light jacket");
  assert.equal(shortLabel("Featherless quilted utility jacket"), "Featherless");
  // every failure message is "Title. Body" with a title that fits next to Stop/Retry (≤ 28 chars) and a body ≤ 40
  for (const m of ["Couldn’t find a good match. Try a color or a price.", "Something went wrong. Ask me again in a moment.", "Couldn’t find a recipe. Ask me again in a moment.", "Can’t tell them apart. Hold them up one at a time?", "Couldn’t read that link. Check it, or send another one.", "I couldn't look just now. Ask me again?"]) {
    const [title, body] = [m.slice(0, m.indexOf(". ")), m.slice(m.indexOf(". ") + 2)];
    assert.ok(title.length <= 28 && body.length <= 40, m);
  }
});

test("#199: find.started / find.progress carry the import line the search follows", async () => {
  const v = vendors({ items: [ITEM1, ITEM2], output: [OPEN(P1), OPEN(P2)] });
  const { ctx, events } = ctxFor(v, { likes: ["Clean, minimal clothes. Understated colors.", "No loud logos."] });
  await runProduct(ctx);
  const started = events.find((e) => e.type === "find.started") as Extract<ServerEvent, { type: "find.started" }>;
  const progress = events.find((e) => e.type === "find.progress") as Extract<ServerEvent, { type: "find.progress" }>;
  assert.deepEqual(started.evidence, { style: "Clean, minimal clothes. Understated colors.", situation: "" });
  assert.deepEqual(progress.evidence, { style: "Clean, minimal clothes. Understated colors.", situation: "Mild and dry this weekend, 18°C" });
  const bare = ctxFor(vendors({ items: [ITEM1, ITEM2], output: [OPEN(P1), OPEN(P2)] }), { likes: undefined });
  await runProduct(bare.ctx);
  assert.equal((bare.events[0] as { evidence?: unknown }).evidence, undefined, "no import → no evidence field");
});

test("#199: on the Mac (new call, no search yet) 'match my style' refines the jacket asked on the iPhone, not 'Things'", async () => {
  const v = vendors({ items: [ITEM1, ITEM2], output: [OPEN(P1), OPEN(P2)] });
  const events: ServerEvent[] = [];
  const runner = new FindsRunner({ vendors: v, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds", productHedge: 1 }, { emit: (e) => events.push(e), announce: () => {}, log: () => {}, now: () => performance.now() });
  runner.configure({ owner: "acct", memories: [] });
  const recent = ["User: Jin, can we look for a jacket for this weekend?", "You: On it.", "User: Still with me?", "You: Right here."];
  const started = runner.onTurn({ text: "Can you make them match my style?", frames: [], utteranceId: 9, replyText: Promise.resolve(null), recent });
  assert.equal(started?.kind, "product", "a refine phrase counts after a search asked on the other device");
  await runner.settle();
  const s = events.find((e) => e.type === "find.started") as Extract<ServerEvent, { type: "find.started" }>;
  assert.equal(s.detail, "Jacket · searching shops");
  assert.match(v.prompts[0], /This refines the search you already did for: .{1,3}Jin, can we look for a jacket for this weekend/);
  // and without that history it stays an ordinary chat turn
  const fresh = new FindsRunner({ vendors: v, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds" }, { emit: () => {}, announce: () => {}, log: () => {}, now: () => 0 });
  fresh.configure({ owner: "acct", memories: [] });
  assert.equal(fresh.onTurn({ text: "Can you make them match my style?", frames: [], utteranceId: 1, replyText: Promise.resolve(null), recent: [] }), null);
});

test("#211: pill strings are one-liners (≤ 28 chars): searching title, ack, answer", () => {
  for (const s of [SEARCH_TITLE, TWO_SAY, ONE_SAY, "On it."]) assert.ok(s.length <= PILL_MAX, s);
});

test("#214: the 'Searched the web' line fits one card line", () => {
  assert.equal(searchedLine(["quince.com", "target.com"]), "Searched the web · quince.com, target.com");
  assert.equal(searchedLine(["northline.example.com", "fieldandco.example.com"]), "Searched the web · northline.example.com +1");
  assert.equal(searchedLine(["onlyone.example.com"]), "Searched the web · onlyone.example.com");
});

test("S5 speed: the search prompt asks for one product search (GENITA_PRODUCT_ONE_SEARCH=0 brings back two)", async () => {
  const run = async () => {
    const v = vendors({ items: [ITEM1, ITEM2], output: [SEARCH, OPEN(P1), OPEN(P2)], facts: { [P1]: { kind: "product" }, [P2]: { kind: "product" } } });
    await runProduct(ctxFor(v).ctx);
    return v.prompts[0];
  };
  assert.match(await run(), /Be quick: one product search, then open the pages\./);
  process.env.GENITA_PRODUCT_ONE_SEARCH = "0";
  try { assert.match(await run(), /at most 2 product searches/); } finally { delete process.env.GENITA_PRODUCT_ONE_SEARCH; }
});

test("QA 11/3: shoes for an outfit are never slippers / sandals / mules unless asked; the prompt says so", async () => {
  const { offOccasion, productPrompt } = await import("../src/finds/product.ts");
  const ask = "Can you find me some shoes that match my style?";
  for (const p of ["Shearling slipper https://shop.example.com/p/slipper-123", "Leather slide sandal", "Suede mules https://x.com/products/suede-mules", "Classic flip-flops"]) assert.equal(offOccasion(p, ask), true, p);
  for (const p of ["Chelsea boots https://shop.example.com/p/chelsea-boot", "Penny loafers", "Leather sneakers"]) assert.equal(offOccasion(p, ask), false, p);
  assert.equal(offOccasion("Leather slide sandal", "find me sandals for the beach"), false, "asked for");
  assert.equal(offOccasion("Leather slide buckle belt", "find me a black belt"), false, "a belt, not a shoe (Codex P2)");
  assert.equal(offOccasion("Leather slide buckle belt", ask), false);
  assert.match(productPrompt({ question: ask, recent: [], taste: [], city: null, region: "US", today: "Tuesday, November 3" }), /never slippers, sandals, slides, flip-flops or mules unless they asked/);
});

test("AU-79 FD-02: a category page nothing could read never fills a product slot", () => {
  // unread (bot-blocked) or markerless pages with a category slug
  assert.equal(isProductPage("https://shop.example.com/womens-brown-boots", null), false);
  assert.equal(isProductPage("https://shop.example.com/boots-dark-brown/", { kind: "unknown" }), false);
  assert.equal(isProductPage("https://shop.example.com/mens-jackets.html", null), false);
  assert.equal(isProductPage("https://shop.example.com/a/b", { kind: "unknown", title: "Women's Boots | Shop" }), false);
  assert.equal(isProductPage("https://shop.example.com/a/b", { kind: "unknown", title: "Shop 24 results" }), false);
  // one item, by URL shape or slug, still counts
  assert.equal(isProductPage("https://shop.example.com/products/boots-dark-brown", null), true);
  assert.equal(isProductPage("https://shop.example.com/en/highwood-chelsea-boot", null), true);
  assert.equal(isProductPage("https://shop.example.com/a/b", { kind: "unknown", title: "Highwood Chelsea Boot – Dark Brown" }), true);
  assert.equal(isProductPage("https://shop.example.com/collections/x", { kind: "product" }), true, "the page's own markup wins (unchanged)");
  // Codex r1: a product URL with a category word in its title, and a title that names one item after the category
  assert.equal(isProductPage("https://shop.example.com/products/heritage-chelsea-12345", { kind: "unknown", title: "Women's Boots - Heritage Chelsea Boot" }), true);
  assert.equal(isProductPage("https://shop.example.com/a/b", { kind: "unknown", title: "Women's Boots - Heritage Chelsea Boot" }), true);
  assert.equal(isProductPage("https://shop.example.com/a/b", { kind: "unknown", title: "Brown boots collection – Acme" }), false);
});

test("AU-78 FD-02: 'dark brown boots' never shows a black or tan boot while a brown one is there; brown shades and plain names stay", async () => {
  const { askedColors, offColor } = await import("../src/finds/product.ts");
  const brown = askedColors("Can we look for dark brown boots for my trench?");
  assert.deepEqual([...brown], ["brown"]);
  assert.equal(offColor("Black Chelsea Boot", brown), true);
  assert.equal(offColor("Highwood Boot in Tan", brown), true);
  assert.equal(offColor("Espresso Suede Chelsea Boot", brown), false, "a brown shade");
  assert.equal(offColor("Heritage Chelsea Boot", brown), false, "no color named");
  assert.equal(offColor("Black / Brown two-tone boot", brown), false, "names the asked color too");
  // Codex r1: what they rule out or already own is not the color asked for; the latest color change wins
  assert.equal(askedColors("Find boots, but no black ones").size, 0);
  assert.equal(askedColors("Find boots that go with my brown trench").size, 0);
  assert.deepEqual([...askedColors("Another one in brown instead")], ["brown"]);
  assert.deepEqual([...askedColors("Find a couple that match my style", "Find black boots. Another one in brown instead")], ["brown"]);
  assert.equal(askedColors("boots for my trench").size, 0);
  // through the pipeline: the black one goes last, the brown ones take the two slots
  const P3x = "https://shop3.example.com/products/chestnut-boot";
  const v = vendors({
    items: [{ ...ITEM1, name: "Black Chelsea Boot" }, { ...ITEM2, name: "Dark Brown Chelsea Boot" }, { ...ITEM1, url: P3x, name: "Chocolate Suede Boot" }],
    output: [SEARCH, OPEN(P1), OPEN(P2), OPEN(P3x)],
    facts: { [P1]: { kind: "product" }, [P2]: { kind: "product" }, [P3x]: { kind: "product" } },
  });
  const { ctx } = ctxFor(v, { question: "Can we look for dark brown boots for my trench?" });
  const card = (await runProduct(ctx)).card!;
  assert.deepEqual(card.products!.map((p) => p.name), ["Dark Brown Chelsea Boot", "Chocolate Suede Boot"]);
  // Codex r1: a brand with a color word (Red Wing) never sinks the card when it's all there is
  const one = vendors({ items: [{ ...ITEM1, name: "Red Wing Classic Moc" }], output: [SEARCH, OPEN(P1)], facts: { [P1]: { kind: "product" } } });
  const c2 = (await runProduct(ctxFor(one, { question: "Can we look for brown boots?" }).ctx)).card;
  assert.ok(c2, "still a card");
});

test("AU-79 (Codex #602 r2): a plural product name is not a category; the asked color still comes before a proven page", async () => {
  assert.equal(isProductPage("https://shop.example.com/en/highwood-chelsea-boots", { kind: "unknown", title: "Highwood Chelsea Boots – Dark Brown" }), true);
  assert.equal(isProductPage("https://shop.example.com/a/b", { kind: "unknown", title: "Boots | Acme" }), false);
  const B1 = "https://shop1.example.com/en/brown-one", B2 = "https://shop2.example.com/en/brown-two";
  const v = vendors({
    items: [{ ...ITEM1, name: "Black Chelsea Boot" }, { ...ITEM2, url: B1, name: "Dark Brown Chelsea Boot" }, { ...ITEM2, url: B2, name: "Brown Suede Boot" }],
    output: [SEARCH, OPEN(P1), OPEN(B1), OPEN(B2)],
    facts: { [P1]: { kind: "product" }, [B1]: null, [B2]: null },
  });
  const card = (await runProduct(ctxFor(v, { question: "Can we look for dark brown boots?" }).ctx)).card!;
  assert.deepEqual(card.products!.map((p) => p.name), ["Dark Brown Chelsea Boot", "Brown Suede Boot"]);
});
