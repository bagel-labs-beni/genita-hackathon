import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanName, nameKey, sameIngredient, isStaple } from "../src/finds/names.ts";
import { Candidates, tierOf, toWire, recipeSummary } from "../src/finds/tiers.ts";
import { parseSeenLine, LineSplitter, lastJsonObject, isYes, findUrl } from "../src/finds/parse.ts";
import { classifyTurn } from "../src/finds/intent.ts";
import { confirmItem, runRecipe, runOutfit, runLink, toNormBox, type PipelineCtx } from "../src/finds/pipeline.ts";
import { MemoryFindsStore, FileFindsStore, UNDO_MS } from "../src/finds/store.ts";
import { checkServerEvent, type FindCard, type ServerEvent } from "../src/protocol.ts";
import type { FindsVendors } from "../src/finds/vendors.ts";
import type { SamBox } from "../src/meta/sam.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ───────────── names ─────────────

test("names: clean, key and synonyms", () => {
  assert.equal(cleanName("1 cup diced Kimchi"), "diced kimchi");
  assert.equal(nameKey("1 cup diced Kimchi"), "kimchi");
  assert.equal(nameKey("Green Onions"), "green onion");
  assert.equal(nameKey("scallions"), "green onion");
  assert.equal(nameKey("대파"), "green onion");
  assert.equal(nameKey("Eggs"), "egg");
  assert.equal(nameKey("tomatoes"), "tomato");
  assert.equal(nameKey("extra firm tofu"), "tofu");
});

test("names: PRD 22 merge — green onion absorbs onion; cooked rice absorbs rice; coconut milk is not milk", () => {
  assert.ok(sameIngredient("onion", "green onions"));
  assert.ok(sameIngredient("rice", "cooked rice"));
  assert.ok(sameIngredient("scallion", "green onions"));
  assert.ok(sameIngredient("firm tofu", "tofu"));
  assert.ok(!sameIngredient("coconut milk", "milk"));
  assert.ok(!sameIngredient("soy sauce", "fish sauce"));
  assert.ok(!sameIngredient("rice noodles", "noodles"));
  assert.ok(isStaple("Salt"));
  assert.ok(!isStaple("kimchi"));
});

// ───────────── tiers ─────────────

const box = { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 };

test("tiers: have needs YES + name box; YES without box is maybe; recipe-only NO is buy; seen NO is dropped", () => {
  const c = new Candidates();
  const eggs = c.add("eggs", { camera: true, count: 6 })!;
  const kimchi = c.add("kimchi", { camera: true, look: "red jar" })!;
  const lime = c.add("limes", { camera: true })!;
  const rice = c.add("cooked rice", { recipe: true })!;
  assert.equal(tierOf(eggs), "checking");
  Object.assign(eggs, { yes: true, box, samDone: true });
  Object.assign(kimchi, { yes: true, box: null, hint: box, samDone: true });
  Object.assign(lime, { yes: false, samDone: true });
  Object.assign(rice, { yes: false, samDone: true });
  assert.equal(tierOf(eggs), "have");
  assert.equal(tierOf(kimchi), "maybe");
  assert.equal(tierOf(lime), null);
  assert.equal(tierOf(rice), "buy");
  const wire = toWire(c.all());
  assert.deepEqual(
    wire.map((i) => [i.name, i.tier]),
    [
      ["eggs", "have"],
      ["kimchi", "maybe"],
      ["cooked rice", "buy"],
    ],
  );
  assert.equal(wire[0].count, 6);
  assert.deepEqual(wire[0].box, box);
  assert.deepEqual(wire[1].hint, box);
  assert.equal(wire[1].box, undefined);
  assert.equal(wire[2].count, undefined);
});

test("tiers: seen by the first look + SAM box but re-check NO → maybe, not buy", () => {
  const c = new Candidates();
  const kimchi = c.add("kimchi", { camera: true, look: "red jar" })!;
  c.add("kimchi", { recipe: true });
  Object.assign(kimchi, { yes: false, box: null, hint: box, samDone: true });
  assert.equal(tierOf(kimchi), "maybe");
  const lime = c.add("limes", { camera: true, look: "green fruit" })!;
  Object.assign(lime, { yes: false, box: null, hint: box, samDone: true });
  assert.equal(tierOf(lime), null, "a look-alike box alone does not keep a non-recipe item");
});

test("tiers: YES without any SAM box is never 'have' (no invented confident item)", () => {
  const c = new Candidates();
  const onion = c.add("onion", { recipe: true })!;
  Object.assign(onion, { yes: true, box: null, samDone: true });
  assert.equal(tierOf(onion), "maybe");
});

test("candidates: recipe names merge into what the camera saw; staples skipped; cap", () => {
  const c = new Candidates();
  c.add("green onions", { camera: true });
  assert.equal(c.add("onion", { recipe: true }), null);
  assert.equal(c.add("1 tsp salt", { recipe: true }), null);
  assert.equal(c.add("sesame oil", { recipe: true, optional: true })!.optional, true);
  const g = c.all()[0];
  assert.equal(g.inRecipe, true);
  assert.deepEqual(g.aliases, ["onion"]);
  assert.equal(toWire(c.all()).find((i) => i.name === "green onions")?.from, "both");
  for (let i = 0; i < 20; i++) c.add(`thing${i}`, { recipe: true });
  assert.equal(c.all().length, 12);
});

test("recipe summary lines", () => {
  const items = [
    { id: "1", name: "eggs", tier: "have" as const, from: "camera" as const },
    { id: "2", name: "kimchi", tier: "maybe" as const, from: "both" as const },
    { id: "3", name: "cooked rice", tier: "buy" as const, from: "recipe" as const },
    { id: "4", name: "sesame oil", tier: "buy" as const, from: "recipe" as const, optional: true },
  ];
  assert.deepEqual(recipeSummary(items, 15), { subtitle: "About 15 min · You have 2, need cooked rice", status: "Need cooked rice" });
  assert.deepEqual(recipeSummary(items.slice(0, 2), null), { subtitle: "You have 2, nothing to buy", status: "You have it all" });
});

test("confirm 맞아?: yes → have; no → buy (recipe) or gone (camera only)", () => {
  const card = { items: [
    { id: "a", name: "kimchi", tier: "maybe", from: "both", hint: box },
    { id: "b", name: "jar", tier: "maybe", from: "camera" },
  ], subtitle: "About 15 min · You have 2, nothing to buy" } as unknown as FindCard;
  confirmItem(card, "a", true);
  assert.equal(card.items[0].tier, "have");
  assert.equal(card.items[0].confirmed, "yes");
  assert.equal(card.items[0].hint, undefined);
  confirmItem(card, "b", false);
  assert.equal(card.items.length, 1);
  assert.match(card.subtitle, /^About 15 min · You have 1/);
  const c2 = { items: [{ id: "c", name: "rice", tier: "maybe", from: "recipe" }], subtitle: "" } as unknown as FindCard;
  confirmItem(c2, "c", false);
  assert.equal(c2.items[0].tier, "buy");
});

// ───────────── parsing / intent ─────────────

test("seen lines parse", () => {
  assert.deepEqual(parseSeenLine("eggs | 6 | top shelf left in gray carton"), { name: "eggs", count: 6, look: "top shelf left in gray carton" });
  assert.deepEqual(parseSeenLine("- kimchi | - | glass jar, red-orange"), { name: "kimchi", count: null, look: "glass jar, red-orange" });
  assert.deepEqual(parseSeenLine("tofu | clear tub"), { name: "tofu", count: null, look: "clear tub" });
  assert.deepEqual(parseSeenLine("milk"), { name: "milk", count: null, look: null });
  assert.equal(parseSeenLine("NONE"), null);
  const s = new LineSplitter();
  assert.deepEqual(s.push("eggs | 6 | a\nkim"), ["eggs | 6 | a"]);
  assert.deepEqual(s.push("chi | - | b\n"), ["kimchi | - | b"]);
  assert.deepEqual(s.flush(), []);
});

test("lastJsonObject skips the preamble and nested braces", () => {
  assert.deepEqual(lastJsonObject('I\'ll search the web.{"dish":"x","sources":[{"url":"u"}]}'), { dish: "x", sources: [{ url: "u" }] });
  assert.equal(lastJsonObject("no json here"), null);
  assert.equal(isYes("YES"), true);
  assert.equal(isYes("No."), false);
  assert.equal(isYes("maybe"), null);
  assert.equal(findUrl("read this https://a.com/x?y=1."), "https://a.com/x?y=1");
});

test("intent: link wins; camera + cooking → recipe; camera + clothes → outfit; else none", () => {
  assert.deepEqual(classifyTurn("What can I make with what's in here?", true), { kind: "recipe" });
  assert.deepEqual(classifyTurn("냉장고에 있는 걸로 뭐 해 먹지?", true), { kind: "recipe" });
  assert.deepEqual(classifyTurn("Which one should I wear tonight?", true), { kind: "outfit" });
  assert.deepEqual(classifyTurn("뭐 입을까?", true), { kind: "outfit" });
  assert.deepEqual(classifyTurn("look at https://x.com/a", false), { kind: "link", url: "https://x.com/a" });
  assert.equal(classifyTurn("What can I make for dinner?", false), null);
  assert.equal(classifyTurn("Do you like my cat?", true), null);
});

test("toNormBox clamps and rejects empty boxes", () => {
  const b = (x1: number, y1: number, x2: number, y2: number): SamBox => ({ x1, y1, x2, y2, w: 100, h: 200, nx1: x1 / 100, ny1: y1 / 200, nx2: x2 / 100, ny2: y2 / 200 });
  assert.deepEqual(toNormBox(b(10, 20, 50, 100)), { x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 });
  assert.equal(toNormBox(b(10, 20, 10, 100)), null);
  assert.equal(toNormBox({ ...b(1, 1, 2, 2), nx1: null }), null);
});

// ───────────── pipelines with fake vendors ─────────────

const FRIDGE: Record<string, { yes: boolean; box: boolean }> = {
  eggs: { yes: true, box: true },
  kimchi: { yes: true, box: false },
  tofu: { yes: true, box: true },
  "green onions": { yes: true, box: true },
  "cooked rice": { yes: true, box: true },
  limes: { yes: false, box: false },
  onion: { yes: true, box: false },
  "sesame oil": { yes: false, box: false },
};

function fakeVendors(opts: { seen?: string; recipe?: string; outfit?: string; link?: { text: string; opened: boolean }; imageFail?: boolean } = {}): FindsVendors & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async spark(req) {
      const prompt = typeof req.input === "string" ? req.input : JSON.stringify(req.input);
      if (prompt.includes("clearly visible in this photo")) {
        const name = prompt.match(/Is there (.+?) clearly visible/)![1];
        calls.push(`yes:${name}`);
        return { text: FRIDGE[name]?.yes ? "YES" : "NO", output: [] };
      }
      if (prompt.includes("Pick one simple dish")) {
        calls.push("recipe");
        return { text: opts.recipe ?? "", output: [{ type: "web_search_call", action: { type: "search" } }] };
      }
      if (prompt.includes("clothes they are choosing")) {
        calls.push("outfit");
        return { text: opts.outfit ?? "", output: [] };
      }
      if (prompt.includes("Open this exact link")) {
        calls.push("link");
        return { text: opts.link?.text ?? "", output: opts.link?.opened ? [{ type: "web_search_call", action: { type: "open_page", url: "u" } }] : [{ type: "web_search_call", action: { type: "search" } }] };
      }
      throw new Error("unexpected spark " + prompt.slice(0, 80));
    },
    async *sparkStream() {
      for (const line of (opts.seen ?? "").split(/(?<=\n)/)) yield { type: "text" as const, delta: line };
      yield { type: "done" as const, responseId: null, text: "", status: "completed" };
    },
    async sam(_img, prompt) {
      calls.push(`sam:${prompt}`);
      const hit = FRIDGE[prompt]?.box || /^(red jar|navy coat|camel blazer)$/.test(prompt);
      return hit ? [{ x1: 10, y1: 20, x2: 50, y2: 100, w: 480, h: 854, nx1: 10 / 480, ny1: 20 / 854, nx2: 50 / 480, ny2: 100 / 854 }] : [];
    },
    async image() {
      if (opts.imageFail) throw new Error("muse down");
      return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    },
  };
}

function ctxFor(kind: PipelineCtx["kind"], vendors: FindsVendors, extra: Partial<PipelineCtx> = {}): { ctx: PipelineCtx; events: ServerEvent[] } {
  const events: ServerEvent[] = [];
  const ctx: PipelineCtx = {
    findId: "find-1234",
    utteranceId: 3,
    kind,
    question: "What can I make?",
    frames: ["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"],
    memories: [],
    replyText: Promise.resolve("Wear the navy one."),
    vendors,
    emit: (e) => {
      assert.deepEqual(checkServerEvent(e as unknown as Record<string, unknown>), [], JSON.stringify(e));
      events.push(e);
    },
    signal: new AbortController().signal,
    now: () => performance.now(),
    log: () => {},
    images: true,
    putImage: async (slot) => `/v1/finds/find-1234/images/${slot}`,
    ...extra,
  };
  return { ctx, events };
}

const RECIPE_JSON = `I'll search.{"dish":"kimchi fried rice","minutes":15,"ingredients":[{"name":"kimchi","optional":false},{"name":"cooked rice","optional":false},{"name":"onion","optional":false},{"name":"sesame oil","optional":true},{"name":"salt","optional":false}],"steps":["Fry the kimchi.","Add the rice.","Top with egg."],"sources":[{"title":"Kimchi fried rice","url":"https://www.maangchi.com/recipe/kimchi-bokkeumbap"}],"ask":["No rice. Noodles?","How spicy is it?"],"say":"Found one. You're one pan away."}`;

test("recipe pipeline: IC-1 list first, card, 3 tiers, onion merged, staples skipped, pictures", async () => {
  const v = fakeVendors({ seen: "eggs | 6 | gray carton\nkimchi | - | red jar\nlimes | 2 | green fruit\n", recipe: RECIPE_JSON });
  const { ctx, events } = ctxFor("recipe", v);
  const r = await runRecipe(ctx);
  const types = events.map((e) => e.type);
  assert.equal(types[0], "find.started");
  const firstItems = events.find((e) => e.type === "find.items") as Extract<ServerEvent, { type: "find.items" }>;
  assert.ok(firstItems.items.every((i) => i.tier === "checking"));
  assert.ok(types.indexOf("find.created") < types.lastIndexOf("find.items"));
  const last = [...events].reverse().find((e) => e.type === "find.items") as Extract<ServerEvent, { type: "find.items" }>;
  assert.equal(last.checking, false);
  const tiers = Object.fromEntries(last.items.map((i) => [i.name, i.tier]));
  // no green onions in this fridge, so the recipe's onion is checked on its own: YES without a box → maybe, never have
  assert.deepEqual(tiers, { eggs: "have", "cooked rice": "have", kimchi: "maybe", onion: "maybe", "sesame oil": "buy" });
  assert.ok(!("limes" in tiers), "seen item Spark rejects is dropped");
  assert.ok(!v.calls.some((c) => c.includes("salt")));
  assert.equal(last.items.find((i) => i.name === "kimchi")!.hint !== undefined, true);
  assert.equal(last.items.find((i) => i.name === "sesame oil")!.optional, true);
  assert.equal(last.status, "You have it all");
  const card = r.card!;
  assert.equal(card.title, "Kimchi fried rice");
  assert.equal(card.sources[0].domain, "maangchi.com");
  assert.equal(card.steps.length, 3);
  assert.equal(card.steps[0].source, "maangchi.com");
  assert.equal(card.say, "Found one. You're one pan away.");
  assert.ok(card.how.some((h) => /illustrations I made/.test(h)));
  assert.equal(events.filter((e) => e.type === "find.image").length, 4);
  assert.ok(events.some((e) => e.type === "observe.boxes"));
});

test("recipe pipeline: onion from the recipe merges into green onions (PRD 22)", async () => {
  const v = fakeVendors({ seen: "green onions | - | bundle\n", recipe: RECIPE_JSON });
  const { ctx } = ctxFor("recipe", v, { images: false });
  const r = await runRecipe(ctx);
  assert.ok(!v.calls.includes("yes:onion"));
  assert.ok(!r.card!.items.some((i) => i.name === "onion"));
  assert.equal(r.card!.items.find((i) => i.name === "green onions")!.from, "both");
  assert.equal(r.card!.hero, undefined);
});

test("recipe pipeline: nothing seen → find.failed unclear (IC-4), no card, no list made up", async () => {
  const v = fakeVendors({ seen: "NONE", recipe: RECIPE_JSON });
  const { ctx, events } = ctxFor("recipe", v);
  const r = await runRecipe(ctx);
  assert.equal(r.card, null);
  const f = events.find((e) => e.type === "find.failed") as Extract<ServerEvent, { type: "find.failed" }>;
  assert.equal(f.reason, "unclear");
  assert.ok(!events.some((e) => e.type === "find.created"));
});

test("recipe pipeline: a failed illustration is reported, the card text stays", async () => {
  const v = fakeVendors({ seen: "eggs | 6 | carton\n", recipe: RECIPE_JSON, imageFail: true });
  const { ctx, events } = ctxFor("recipe", v);
  const r = await runRecipe(ctx);
  assert.ok(r.card);
  const imgs = events.filter((e) => e.type === "find.image") as Extract<ServerEvent, { type: "find.image" }>[];
  assert.equal(imgs.length, 4);
  assert.ok(imgs.every((e) => e.status === "failed"));
});

test("outfit pipeline: agrees with the spoken pick, taste reason, SAM box per option", async () => {
  const v = fakeVendors({
    outfit: '{"pick":0,"title":"Wear the navy one.","taste":"For dinner at 7, which you mentioned","options":[{"label":"Navy coat","frame":1},{"label":"Camel blazer","frame":0}],"why":["The navy coat reads like dinner.","The camel blazer looks like office."],"ask":["What shoes?","Warm enough?"],"say":"Navy. The camel one says office."}',
  });
  const { ctx, events } = ctxFor("outfit", v, { memories: ["Dinner at 7 with his parents."] });
  const r = await runOutfit(ctx);
  const card = r.card!;
  assert.equal(card.title, "Wear the navy one.");
  assert.equal(card.subtitle, "For dinner at 7, which you mentioned");
  assert.deepEqual(card.options.map((o) => [o.label, o.picked, !!o.box]), [
    ["Navy coat", true, true],
    ["Camel blazer", false, true],
  ]);
  assert.ok(card.how.includes("No web search for this one."));
  assert.ok(events.some((e) => e.type === "observe.boxes"));
});

test("outfit pipeline: unreadable answer → find.failed, no card", async () => {
  const v = fakeVendors({ outfit: "I can't tell." });
  const { ctx, events } = ctxFor("outfit", v);
  assert.equal((await runOutfit(ctx)).card, null);
  assert.ok(events.some((e) => e.type === "find.failed"));
});

test("link pipeline: opened only when the tool trace shows open_page (r03 #13/#14)", async () => {
  const json = '{"opened":true,"title":"Carry-on packing guide","takeaways":["Roll soft clothes.","Liquids in one pouch.","Wear heavy shoes."],"ask":["What about shoes?","Is this for Europe?"],"say":"Three things from your link."}';
  const ok = ctxFor("link", fakeVendors({ link: { text: json, opened: true } }), { url: "https://travel.example.com/carry-on", frames: [] });
  const a = (await runLink(ok.ctx)).card!;
  assert.deepEqual(a.page, { url: "https://travel.example.com/carry-on", opened: true });
  assert.equal(a.subtitle, "travel.example.com · 3 takeaways");
  const bad = ctxFor("link", fakeVendors({ link: { text: json, opened: false } }), { url: "https://travel.example.com/carry-on", frames: [] });
  const b = (await runLink(bad.ctx)).card!;
  assert.equal(b.page!.opened, false, "model said opened but no open_page action");
  assert.match(b.how[0], /Couldn't open the page/);
});

// ───────────── store ─────────────

function card(id: string, createdAt: string, saved = false): FindCard {
  return { id, kind: "recipe", createdAt, eyebrow: "", title: id, subtitle: "", items: [], steps: [], options: [], why: [], ask: [], sources: [], how: [], saved };
}

test("store: saved first then newest; delete + undo; owner isolation; account deletion", async () => {
  let now = 1000;
  const s = new MemoryFindsStore(() => now);
  await s.put("alice", card("find-0001", "2026-11-02T10:00:00Z"));
  await s.put("alice", card("find-0002", "2026-11-02T11:00:00Z"));
  await s.put("alice", card("find-0003", "2026-11-02T09:00:00Z"));
  await s.put("bob", card("find-0004", "2026-11-02T12:00:00Z"));
  await s.setSaved("alice", "find-0003", true);
  assert.deepEqual((await s.list("alice")).map((c) => c.id), ["find-0003", "find-0002", "find-0001"]);
  assert.equal(await s.get("bob", "find-0001"), null);
  assert.equal(await s.remove("bob", "find-0001"), false);
  assert.equal(await s.remove("alice", "find-0002"), true);
  assert.deepEqual((await s.list("alice")).map((c) => c.id), ["find-0003", "find-0001"]);
  assert.equal(await s.restore("alice", "find-0002"), true);
  assert.equal((await s.list("alice")).length, 3);
  await s.remove("alice", "find-0002");
  now += UNDO_MS + 1;
  // PROTOCOL: Undo is 24 h. It used to work until the next purge ran (Codex review 11/2): no longer.
  assert.equal(await s.restore("alice", "find-0002"), false, "no restore after the undo window, purge or not");
  assert.equal((await s.list("alice")).length, 2);
  assert.equal(await s.restore("alice", "find-0002"), false, "purged after the undo window");
  // re-put keeps saved
  await s.put("alice", card("find-0003", "2026-11-02T09:00:00Z"));
  assert.equal((await s.get("alice", "find-0003"))!.saved, true);
  assert.equal(await s.removeOwner("alice"), 2);
  assert.deepEqual(await s.list("alice"), []);
  assert.equal((await s.list("bob")).length, 1);
});

test("file store persists cards and images across restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finds-test-"));
  const a = new FileFindsStore(dir);
  await a.put("alice", card("find-0001", "2026-11-02T10:00:00Z"));
  await a.putImage("find-0001", "hero", Buffer.from([0x89, 0x50, 1, 2]));
  const b = new FileFindsStore(dir);
  assert.equal((await b.list("alice"))[0].id, "find-0001");
  const img = await b.getImage("find-0001", "hero");
  assert.equal(img!.mime, "image/png");
  assert.equal(await b.getImage("../etc", "hero"), null);
  await b.removeOwner("alice");
  assert.equal(await new FileFindsStore(dir).getImage("find-0001", "hero"), null);
});

test("outfit: the card is asked again only when the spoken answer names the other option", async () => {
  const { disagrees } = await import("../src/finds/pipeline.ts");
  const j = { pick: 0, options: [{ label: "Beige trench" }, { label: "Denim jacket" }] };
  assert.equal(disagrees(j, "Go with the trench, it's perfect."), false);
  assert.equal(disagrees(j, "I'd go with the denim one tonight."), true);
  assert.equal(disagrees(j, "Both look great!"), false);
});

test("recipe titles become sentence case", async () => {
  const { sentenceCase } = await import("../src/finds/pipeline.ts");
  assert.equal(sentenceCase("Kimchi Fried Rice with Tofu and Egg"), "Kimchi fried rice with tofu and egg");
  assert.equal(sentenceCase("kimchi fried rice"), "Kimchi fried rice");
  assert.equal(sentenceCase("Pad Thai"), "Pad thai");
});

test("recipe pipeline: a stalled first-look stream gets one plain retry; a second failure is an error, not 'unclear'", async () => {
  const v = fakeVendors({ recipe: RECIPE_JSON });
  let streamCalls = 0;
  v.sparkStream = async function* () {
    streamCalls++;
    throw new Error("spark first-token timeout");
  };
  const spark = v.spark.bind(v);
  v.spark = async (req, signal) => {
    if (JSON.stringify(req.input).includes("List every food item")) return { text: "eggs | 6 | carton\n", output: [] };
    return spark(req, signal);
  };
  const { ctx } = ctxFor("recipe", v, { images: false });
  const r = await runRecipe(ctx);
  assert.equal(streamCalls, 1);
  assert.ok(r.card!.items.some((i) => i.name === "eggs"));
  v.spark = async () => {
    throw new Error("down");
  };
  const bad = ctxFor("recipe", v, { images: false });
  await runRecipe(bad.ctx);
  const f = bad.events.find((e) => e.type === "find.failed") as Extract<ServerEvent, { type: "find.failed" }>;
  assert.equal(f.reason, "error");
});

test("store: Undo works inside 24 h only, even when /restore is called directly", async () => {
  const { MemoryFindsStore, UNDO_MS } = await import("../src/finds/store.ts");
  let t = 1_000_000;
  const store = new MemoryFindsStore(() => t);
  const card = { id: "card-0001", kind: "recipe", createdAt: "x", eyebrow: "", title: "T", subtitle: "", items: [], steps: [], options: [], why: [], ask: [], sources: [], how: [] } as any;
  await store.put("o", card);
  assert.equal(await store.remove("o", "card-0001"), true);
  t += UNDO_MS - 1;
  assert.equal(await store.restore("o", "card-0001"), true, "inside the window");
  assert.equal(await store.remove("o", "card-0001"), true);
  t += UNDO_MS + 1;
  assert.equal(await store.restore("o", "card-0001"), false, "window over");
});
