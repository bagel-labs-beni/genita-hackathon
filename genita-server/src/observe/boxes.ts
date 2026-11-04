/**
 * Boxes on what the companion sees, outside a find (Chelsea 11/4 P0).
 *
 * "Can you see?" with the rear camera on the fridge got a right spoken answer
 * ("pork down below… kimchi… the fruit is just dessert") but no boxes: boxes
 * only came from the recipe / outfit pipelines. Now, when a turn carried camera
 * frames and it is a seeing question (or the reply talks about what it sees),
 * the nouns of the reply go to SAM on the latest frame, in the background after
 * the reply text is done, and the hits go out as one `observe.boxes`.
 *
 * The shipped apps draw `observe.boxes` for any findId (FindsModel only skips a
 * batch from a find that started before a camera flip), with no sheet, so the
 * findId here is a synthetic `observe-<utteranceId>` that no find card uses.
 *
 *   GENITA_OBSERVE_BOXES=0  kill switch (default on)
 *   time box OBSERVE_TIMEOUT_MS: late, failed or empty → nothing is sent
 */
import type { ServerEvent } from "../protocol.ts";
import type { FindsVendors } from "../finds/vendors.ts";
import { boxItems, instancesOf, type BoxItem, type SamInstance } from "../finds/instances.ts";

export const OBSERVE_TIMEOUT_MS = 4000;
export const MAX_NOUNS = 5;

export function observeBoxesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GENITA_OBSERVE_BOXES !== "0";
}

const SEEING_ASK =
  /\b(?:can you see(?: (?:it|this|that|me|them))?|do you see|you see (?:it|this|that)|what do you see|what can you see|what(?:'s| is) (?:this|that|in here|in there|in it)|what are (?:these|those)|look at (?:this|that|these|those|it)|take a look|see (?:this|that)\??|see it\??|what am i holding|show(?:ing)? you)\b/i;

const SEEING_REPLY =
  /\b(?:i (?:can )?see|i spot|i'm seeing|i notice|looks like|there(?:'s| is| are)|you(?:'ve| have) got|down (?:below|there)|up top|on the (?:left|right|top|bottom)|in (?:the )?(?:back|front|corner))\b/i;

export function isSeeingAsk(text: string): boolean {
  return SEEING_ASK.test(text);
}

/** a seeing question, or a reply that talks about what is in view */
export function shouldObserve(userText: string, reply: string): boolean {
  return isSeeingAsk(userText) || SEEING_REPLY.test(reply);
}

// words in a spoken reply that are not things in the picture
const STOP = new Set(
  (
    "a an the and or but so if then than that this these those there here it its it's i i'm i've i'd i'll me my mine you you're you've your yours " +
    "we our us he she they them their his her him what which who whom whose where when why how yes yeah yep no nope not nothing something anything everything " +
    "oh ooh ah ahh wow hey hmm um uh okay ok well just really very pretty quite kind sort bit lot lots little big small " +
    "can could would should will shall may might must do does did done doing is are was were be been being am have has had having get got getting " +
    "see seeing seen saw look looks looking looked like likes liked love loved seem seems seemed spot notice think know guess bet want need make making made " +
    "go going gone come coming take give put keep let say said tell show try use eat eating cook cooking " +
    "good great nice cool fine sure right left top bottom front back side middle corner below above under over inside outside near next " +
    "down up out in on at of to from for with without into onto about around behind between plus also too maybe probably definitely totally " +
    "some any all both each every few many more most much other another same such own one two three four five first second last " +
    "now today tonight still already again ever never always only even though because while time way thing things stuff bunch couple " +
    "fresh tasty delicious yummy perfect awesome amazing lovely yummy quick easy fun happy glad fridge camera picture photo view frame shot screen " +
    "dessert dinner lunch breakfast snack meal idea ideas option options"
  ).split(/\s+/),
);

/**
 * 2–5 object nouns from the reply, first-mentioned first ("pork down below…
 * pork plus kimchi… the fruit is just dessert" → pork, kimchi, fruit). Cheap
 * and local: no extra model call, nothing added before the spoken reply.
 */
export function replyNouns(reply: string, max = MAX_NOUNS): string[] {
  const out: string[] = [];
  const words = reply.toLowerCase().replace(/[’]/g, "'").match(/[a-z][a-z'-]*/g) ?? [];
  for (const raw of words) {
    const w = raw.replace(/'s$/, "").replace(/^-+|-+$/g, "");
    if (w.length < 3 || STOP.has(w) || STOP.has(raw)) continue;
    if (w.includes("'")) continue;
    if (/(?:ly|ing|ed)$/.test(w) && w.length > 4) continue;
    const singular = w.length > 4 && /[^s]s$/.test(w) ? w.slice(0, -1) : w;
    if (out.includes(w) || out.includes(singular)) continue;
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export type ObserveInput = {
  utteranceId: number;
  /** data URL of the latest camera frame of the turn */
  frame: string;
  /** its index in the turn's frames */
  frameIndex: number;
  nouns: string[];
  vendors: Pick<FindsVendors, "sam" | "samMasks">;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type ObserveBoxesEvent = Extract<ServerEvent, { type: "observe.boxes" }>;

/** SAM per noun on one frame, within the time box. null = send nothing. */
export async function observeBoxes(input: ObserveInput): Promise<ObserveBoxesEvent | null> {
  if (!input.nouns.length || !input.frame) return null;
  const abort = new AbortController();
  const stop = () => abort.abort();
  input.signal?.addEventListener("abort", stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((r) => (timer = setTimeout(() => { abort.abort(); r(null); }, input.timeoutMs ?? OBSERVE_TIMEOUT_MS)));
  try {
    const run = Promise.all(
      input.nouns.map(async (noun) => {
        try {
          return { label: capFirst(noun), instances: instancesOf(await input.vendors.sam(input.frame, noun, abort.signal)) };
        } catch {
          return { label: capFirst(noun), instances: [] as SamInstance[] };
        }
      }),
    );
    const groups = await Promise.race([run, timedOut]);
    if (!groups || abort.signal.aborted) return null;
    const hits = groups.filter((g) => g.instances.length > 0);
    if (!hits.length) return null;
    const frame = hits[0].instances[0].frame;
    const items: BoxItem[] = input.vendors.samMasks
      ? boxItems(hits)
      : hits.map((g) => ({ label: g.label, box: g.instances[0].box }));
    if (!items.length || !frame.w || !frame.h) return null;
    return { type: "observe.boxes", findId: `observe-${input.utteranceId}`, frame: input.frameIndex, w: frame.w, h: frame.h, items };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", stop);
  }
}
