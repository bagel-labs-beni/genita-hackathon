/**
 * npm run finds:e2e [-- --runs=5 --kind=recipe|outfit|link|all --no-images --record=<dir>]
 *
 * Real keys, real vendors. Starts the server in-process on loopback and acts
 * like the app: start (mic off) → `text` with 2 camera JPEGs → measures, on
 * the client clock from the moment the text is sent:
 *   first TTS audio (answer first in voice), find.started, first find.items
 *   (IC-1), find.created (card text), last find.items with checking:false
 *   (all 3-tier checks done), find.image per illustration.
 * Fridge truth (PRD 22): eggs, kimchi, tofu, green onions, milk, rice.
 * Keys come from GENITA_ENV_FILE / ~/.config/genita/meta.env, never printed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { loadConfig } from "../src/config.ts";
import { startServer, defaultDeps } from "../src/server.ts";
import { sameIngredient } from "../src/finds/names.ts";

const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const runs = Number(arg("runs", "5"));
const kind = arg("kind", "all");
if (args.includes("--no-images")) process.env.GENITA_FIND_IMAGES = "0";
process.env.GENITA_FINDS_DIR ??= mkdtempSync(join(tmpdir(), "genita-finds-"));

const T4 = join(homedir(), "genita-fixtures/genita-lipsync-test-20261101/suite/t4");
const jpeg = (f: string) => readFileSync(join(T4, f)).toString("base64");
const TRUTH = ["eggs", "kimchi", "tofu", "green onions", "milk", "rice"];

const CASES = {
  recipe: { text: "What can I make with what's in here?", frames: [jpeg("ff_0.2.jpg"), jpeg("ff_1.4.jpg")], memories: [] as string[] },
  outfit: {
    text: "Which one should I wear tonight?",
    frames: [jpeg("of_0.6.jpg"), jpeg("of_2.0.jpg")],
    memories: ["She has dinner with her boyfriend's parents tonight at 7 at a nice restaurant.", "She likes looking put-together but not stiff."],
  },
  link: { text: "Can you read this for me? https://en.wikipedia.org/wiki/Kimchi_fried_rice", frames: [] as string[], memories: [] as string[] },
};

const config = { ...loadConfig(), port: 0, host: "127.0.0.1", sessionToken: null };
const server = await startServer(config, () => {}, defaultDeps(config, (e, d) => e.startsWith("find.") && e !== "find.image" && console.error(JSON.stringify({ e, ...d }))));
const port = (server.address() as { port: number }).port;

type Run = Record<string, unknown>;
async function once(k: keyof typeof CASES, i: number): Promise<Run> {
  const c = CASES[k];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/session`);
  await new Promise((r) => ws.once("open", r));
  const ev: { t: number; m: Record<string, unknown> }[] = [];
  let t0 = 0;
  let firstAudio: number | null = null;
  let finished: () => void = () => {};
  const done = new Promise<void>((r) => (finished = r));
  let pendingImages = -1;
  let checksDone = false;
  let card = false;
  let lineSeen = false;
  const maybeDone = () => {
    if ((k === "recipe" ? checksDone && card && lineSeen : card) && pendingImages <= 0) finished();
  };
  ws.on("message", (data, bin) => {
    const t = performance.now() - t0;
    if (bin) {
      if (firstAudio === null && t0) firstAudio = t;
      return;
    }
    const m = JSON.parse(String(data));
    if (!t0) return;
    ev.push({ t, m });
    if (m.type === "find.created") {
      card = true;
      const cardObj = m.card as { hero?: unknown; steps: { image?: unknown }[] };
      pendingImages = (cardObj.hero ? 1 : 0) + cardObj.steps.filter((s) => s.image).length;
    }
    if (m.type === "find.image") pendingImages--;
    if (m.type === "find.items" && m.checking === false) checksDone = true;
    if (m.type === "reply" && /^I can see|^I can't say/.test(String(m.text))) lineSeen = true;
    if (m.type === "find.failed") finished();
    maybeDone();
  });
  ws.send(JSON.stringify({ type: "start", persona: { name: "Mina", traits: ["warm", "playful"] }, user: { name: "Chelsea", id: "e2e-user", timeZone: "Asia/Seoul" }, memories: c.memories, mic: false, lip: "none" }));
  await new Promise((r) => setTimeout(r, 400));
  t0 = performance.now();
  // fridge: rotate the three test frames in pairs so the 10 runs are not one photo
  const PAIRS = [["ff_0.2.jpg", "ff_1.4.jpg"], ["ff_1.4.jpg", "ff_2.6.jpg"], ["ff_0.2.jpg", "ff_2.6.jpg"]];
  const frames = k === "recipe" ? PAIRS[i % 3].map(jpeg) : c.frames;
  ws.send(JSON.stringify({ type: "text", text: c.text, frames: frames.length ? frames : undefined }));
  await Promise.race([done, new Promise((r) => setTimeout(r, 90_000))]);
  ws.close();
  const at = (type: string, pred: (m: Record<string, unknown>) => boolean = () => true) => {
    const e = ev.find((x) => x.m.type === type && pred(x.m));
    return e ? Math.round(e.t) : null;
  };
  const created = ev.find((x) => x.m.type === "find.created")?.m.card as Record<string, unknown> | undefined;
  const lastItems = [...ev].reverse().find((x) => x.m.type === "find.items")?.m.items as { name: string; tier: string; box?: unknown; hint?: unknown }[] | undefined;
  const replyText = ev.find((x) => x.m.type === "reply")?.m.text;
  const r: Run = {
    kind: k,
    run: i,
    firstAudioMs: firstAudio === null ? null : Math.round(firstAudio),
    startedMs: at("find.started"),
    firstItemsMs: at("find.items"),
    cardMs: at("find.created"),
    checksDoneMs: at("find.items", (m) => m.checking === false),
    imagesMs: ev.filter((x) => x.m.type === "find.image").map((x) => `${x.m.slot}:${x.m.status}:${Math.round(x.t)}`),
    failed: ev.find((x) => x.m.type === "find.failed")?.m.reason ?? null,
    boxesEvents: ev.filter((x) => x.m.type === "observe.boxes").length,
    reply: replyText,
    title: created?.title,
    subtitle: created?.subtitle,
    say: created?.say,
  };
  if (k === "recipe") {
    // #122 / D23 order: short line → boxes → the line naming checked items
    const lineReply = ev.find((x) => x.m.type === "reply" && /^I can see|^I can't say/.test(String(x.m.text)));
    const lineUtt = lineReply?.m.utteranceId;
    r.ackMs = at("reply.delta");
    r.ackText = ev.find((x) => x.m.type === "reply")?.m.text;
    r.firstBoxesMs = at("observe.boxes");
    r.lineStartMs = lineUtt === undefined ? null : at("reply.delta", (m) => m.utteranceId === lineUtt);
    r.line = lineReply?.m.text ?? null;
    r.boxesBeforeLine = r.firstBoxesMs !== null && r.lineStartMs !== null && (r.firstBoxesMs as number) < (r.lineStartMs as number);
    const named = String(r.line ?? "").match(/^I can see (.+?)\. /)?.[1]?.split(/, and |, | and /).map((x) => x.trim()) ?? [];
    r.lineNamed = named;
    r.lineInvented = named.filter((n) => !TRUTH.some((t) => sameIngredient(t, n)));
    // every named item had its box sent before the line began
    const boxedBefore = new Set(ev.filter((x) => x.m.type === "observe.boxes" && x.t <= ((r.lineStartMs as number) ?? 0)).flatMap((x) => (x.m.items as { label: string }[]).map((b) => b.label.toLowerCase())));
    r.namedWithoutBox = named.filter((n) => !boxedBefore.has(n.toLowerCase()));
  }
  if (k === "recipe" && lastItems) {
    const tier = (t: string) => lastItems.filter((x) => x.tier === t).map((x) => x.name);
    r.have = tier("have");
    r.maybe = tier("maybe");
    r.buy = tier("buy");
    r.haveInvented = tier("have").filter((n) => !TRUTH.some((t) => sameIngredient(t, n)));
    r.missedFromHaveOrMaybe = TRUTH.filter((t) => ![...tier("have"), ...tier("maybe")].some((n) => sameIngredient(t, n)));
    r.boxesOnHave = lastItems.filter((x) => x.tier === "have" && x.box).length;
    r.hintsOnMaybe = lastItems.filter((x) => x.tier === "maybe" && x.hint).length;
  }
  if (k === "outfit" && created) {
    r.options = (created.options as { label: string; picked: boolean; box?: unknown }[]).map((o) => `${o.label}${o.picked ? "*" : ""}${o.box ? "[box]" : ""}`);
    r.why = created.why;
    r.how = created.how;
  }
  if (k === "link" && created) r.page = created.page;
  console.log(JSON.stringify(r));
  const rec = arg("record", "");
  if (rec) {
    mkdirSync(rec, { recursive: true });
    writeFileSync(join(rec, `${k}-${i}.json`), JSON.stringify({ question: c.text, firstAudioMs: r.firstAudioMs, events: ev.map((x) => ({ t: Math.round(x.t), ...x.m })) }, null, 1));
  }
  return r;
}

const kinds = (kind === "all" ? ["recipe", "outfit", "link"] : [kind]) as (keyof typeof CASES)[];
const all: Run[] = [];
for (const k of kinds) for (let i = 0; i < (k === "recipe" ? runs : Math.min(runs, 3)); i++) all.push(await once(k, i));
const p50 = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};
for (const k of kinds) {
  const rs = all.filter((r) => r.kind === k);
  const sum: Record<string, unknown> = { kind: k, n: rs.length };
  for (const f of ["firstAudioMs", "startedMs", "firstItemsMs", "cardMs", "checksDoneMs"]) sum[`p50_${f}`] = p50(rs.map((r) => r[f] as number | null));
  if (k === "recipe") {
    sum.runsWithInventedHave = rs.filter((r) => (r.haveInvented as string[] | undefined)?.length).length;
    sum.missedTotal = rs.reduce((a, r) => a + ((r.missedFromHaveOrMaybe as string[] | undefined)?.length ?? 0), 0);
    sum.p50_boxesOnHave = p50(rs.map((r) => r.boxesOnHave as number));
    sum.p50_ackMs = p50(rs.map((r) => r.ackMs as number | null));
    sum.p50_firstBoxesMs = p50(rs.map((r) => r.firstBoxesMs as number | null));
    sum.p50_lineStartMs = p50(rs.map((r) => r.lineStartMs as number | null));
    sum.boxesBeforeLine = rs.filter((r) => r.boxesBeforeLine).length;
    sum.runsWithInventedInLine = rs.filter((r) => (r.lineInvented as string[]).length).length;
    sum.namedWithoutBox = rs.reduce((a, r) => a + (r.namedWithoutBox as string[]).length, 0);
    sum.cardUnder10s = rs.filter((r) => typeof r.cardMs === "number" && (r.cardMs as number) <= 10_000).length;
  }
  console.log("SUMMARY " + JSON.stringify(sum));
}
const out = join(homedir(), "genita-fixtures/genita-finds-e2e");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `run-${Date.now()}.json`), JSON.stringify(all, null, 1));
server.close();
process.exit(0);
