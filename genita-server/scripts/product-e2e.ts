/**
 * npm run product:e2e [-- --runs=10 --out=<file.json> --record=<events.json>]
 *
 * #119 acceptance on real vendors (Spark web_search + the page reader). Runs the
 * product pipeline for 10 different spoken asks with one imported taste, and
 * checks every card against Spark's own tool trace:
 *   - links: products on the card (target 2) and how many had a completed open_page
 *   - invented URLs: card URLs that are neither completed opens in the trace nor a page
 *     this script can read itself as one product (target 0)
 *   - category pages: card URLs that are not one product (page markup, else URL shape) (target 0)
 *   - grounded taste: evidence.style is one of the imported lines (target 10/10)
 *   - time: ask → find.created, p50 (target ≤ 15 s)
 * Keys from GENITA_ENV_FILE / ~/.config/genita/meta.env, never printed.
 */
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { metaVendors, type FindsVendors, type OutputItem } from "../src/finds/vendors.ts";
import { completedOpens, isProductPage, runProduct, urlKey } from "../src/finds/product.ts";
import { fetchPageFacts } from "../src/finds/fetchPage.ts";
import type { FindCard, ServerEvent } from "../src/protocol.ts";

const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const key = process.env.MODEL_API_KEY;
if (!key) throw new Error("MODEL_API_KEY missing");
const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const runs = Number(arg("runs", "10"));
const out = arg("out", "");
const record = arg("record", ""); // write the first full card's events (app fixture for PF-1)

const LIKES = ["Clean, minimal clothes. Understated colors.", "Mostly black, grey and navy; no loud logos."];
const ASKS = [
  "Jin, can we look for a jacket for this weekend?",
  "Can you find me a light jacket for a trip to Busan next week?",
  "Find me some white sneakers I can wear every day.",
  "I want to buy a simple crewneck sweater for the fall.",
  "Can we look for a tote bag for work?",
  "Find a couple of plain t-shirts that match my style, and send me the links.",
  "Can you look for a rain jacket? It might rain this weekend.",
  "Help me find black jeans with a straight fit.",
  "Can you find a wool coat for winter?",
  "Look for a minimal watch I could wear to a wedding.",
];

const real = metaVendors(key);
const results: Record<string, unknown>[] = [];
for (let i = 0; i < runs; i++) {
  const ask = ASKS[i % ASKS.length];
  let trace: OutputItem[] = [];
  const vendors: FindsVendors = {
    ...real,
    async spark(req, signal) {
      const r = await real.spark(req, signal);
      if (req.tools?.length) trace = [...trace, ...r.output]; // every search call's trace (hedged calls race; a write-up pass has no tools)
      return r;
    },
  };
  const events: { t: number; e: ServerEvent }[] = [];
  const t0 = performance.now();
  const r = await runProduct({
    findId: `e2e-${i}`,
    utteranceId: i,
    kind: "product",
    question: ask,
    frames: [],
    memories: [],
    replyText: Promise.resolve("On it."),
    timeZone: "Asia/Seoul",
    vendors,
    emit: (e) => events.push({ t: performance.now() - t0, e }),
    signal: new AbortController().signal,
    now: () => performance.now(),
    log: (ev, d) => ev.startsWith("product.") && console.error(JSON.stringify({ ev, ...d })),
    images: true,
    putImage: async (slot) => `/v1/finds/e2e-${i}/images/${slot}`,
    likes: LIKES,
    region: "US",
    hedge: Number(arg("hedge", "2")),
  });
  const card: FindCard | null = r.card;
  const opened = new Set(completedOpens(trace).map((u) => urlKey(u)));
  const urls = card?.products?.map((p) => p.url) ?? [];
  const notInTrace = urls.filter((u) => !opened.has(urlKey(u)));
  // not in Spark's trace → must be a page we can read ourselves that says it is one product
  const invented: string[] = [];
  for (const u of notInTrace) if ((await fetchPageFacts(u))?.kind !== "product") invented.push(u);
  const lists: string[] = [];
  for (const u of urls) if (!isProductPage(u, await fetchPageFacts(u))) lists.push(u);
  const createdAt = events.find((x) => x.e.type === "find.created")?.t ?? null;
  const images = events.filter((x) => x.e.type === "find.image").map((x) => (x.e as { status: string }).status);
  const row = {
    i,
    ask,
    links: urls.length,
    invented: invented.length,
    serverVerified: notInTrace.length - invented.length,
    lists: lists.length,
    tasteGrounded: !!card?.evidence?.style && LIKES.includes(card.evidence.style),
    tasteChips: card?.products?.map((p) => p.taste) ?? [],
    situation: card?.evidence?.situation ?? "",
    prices: card?.products?.map((p) => p.price ?? "on site") ?? [],
    images,
    cardMs: createdAt === null ? null : Math.round(createdAt),
    failed: events.find((x) => x.e.type === "find.failed") ? (events.find((x) => x.e.type === "find.failed")!.e as { message: string }).message : null,
    say: card?.say ?? null,
    urls,
    traceOpens: [...opened].length,
  };
  results.push(row);
  if (record && card && urls.length === 2 && !existsSync(record)) {
    writeFileSync(record, JSON.stringify({ kind: "product", ask, events: events.map((x) => ({ t: Math.round(x.t), ...x.e })) }, null, 2));
  }
  console.log(JSON.stringify(row));
}
const ms = results.map((r) => r.cardMs as number | null).filter((v): v is number => v !== null).sort((a, b) => a - b);
const p50 = ms.length ? ms[Math.floor((ms.length - 1) / 2)] : null;
const summary = {
  runs,
  twoLinks: results.filter((r) => r.links === 2).length,
  atLeastOne: results.filter((r) => (r.links as number) >= 1).length,
  inventedUrls: results.reduce((n, r) => n + (r.invented as number), 0),
  listPages: results.reduce((n, r) => n + (r.lists as number), 0),
  tasteGrounded: results.filter((r) => r.tasteGrounded).length,
  cardP50Ms: p50,
  cardMaxMs: ms.at(-1) ?? null,
  imagesReady: results.reduce((n, r) => n + (r.images as string[]).filter((s) => s === "ready").length, 0),
  imagesTotal: results.reduce((n, r) => n + (r.images as string[]).length, 0),
};
console.log(JSON.stringify({ summary }));
if (out) writeFileSync(out, JSON.stringify({ summary, results }, null, 2));
