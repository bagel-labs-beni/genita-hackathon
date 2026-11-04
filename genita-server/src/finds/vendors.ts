/**
 * The vendor calls the finds pipeline makes, behind one interface so tests
 * can fake them. Real implementations reuse the session's Meta clients.
 */
import { metaJson } from "../meta/http.ts";
import { museImageGenerate, samDetect } from "../meta/media.ts";
import { SPARK_MODEL, outputText, sparkStream, type InputMessage, type SparkRequest, type SparkStreamEvent } from "../meta/spark.ts";
import type { SamBox } from "../meta/sam.ts";
import { fetchImage, fetchPageFacts, fetchWikiImageUrl, type PageFacts } from "./fetchPage.ts";

export type OutputItem = { type: string; status?: string; action?: { type?: string; url?: string; query?: string }; content?: Array<{ type: string; text?: string }> };
export type SparkResult = { text: string; output: OutputItem[] };

export interface FindsVendors {
  /** one-shot Responses call; returns text and output items (web_search_call actions) */
  spark(req: SparkRequest, signal?: AbortSignal): Promise<SparkResult>;
  sparkStream(req: SparkRequest, signal?: AbortSignal): AsyncIterable<SparkStreamEvent>;
  sam(imageDataUrl: string, prompt: string, signal?: AbortSignal): Promise<SamBox[]>;
  /** GENITA_SAM_MASKS=1: SAM boxes carry masks + scores; camera boxes go out one per match with a mask */
  samMasks?: boolean;
  /** illustration bytes (PNG/JPEG) */
  image(prompt: string, signal?: AbortSignal): Promise<Buffer>;
  /** F7: read an opened product page (one product? price? og:image) — no AI; null = could not read */
  pageFacts?(url: string, signal?: AbortSignal): Promise<PageFacts | null>;
  /** F7: the product's own picture bytes (JPEG/PNG/WebP), null = none */
  productImage?(url: string, signal?: AbortSignal): Promise<Buffer | null>;
  /** visual everything: Wikipedia's lead picture URL for a title (ingredients, dishes), null = none */
  wikiImage?(title: string, signal?: AbortSignal): Promise<string | null>;
}

/** samMasks: request one_bit masks with every SAM call (GENITA_SAM_MASKS=1). */
export function metaVendors(key: string, opts: { samMasks?: boolean } = {}): FindsVendors {
  return {
    async spark(req, signal) {
      const d = await metaJson<{ id: string; output?: OutputItem[] }>(
        key,
        "/responses",
        {
          model: SPARK_MODEL,
          input: req.input,
          reasoning: { effort: req.effort ?? "minimal" },
          ...(req.instructions ? { instructions: req.instructions } : {}),
          ...(req.tools?.length ? { tools: req.tools } : {}),
          // the pages each search returned (not only the ones it opened), as the streaming call asks (spark.ts)
          ...(req.tools?.some((t) => t.type === "web_search") ? { include: ["web_search_call.action.sources"] } : {}),
          ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
          ...(req.text ? { text: req.text } : {}),
        },
        signal,
      );
      return { text: outputText(d as Parameters<typeof outputText>[0]), output: d.output ?? [] };
    },
    sparkStream: (req, signal) => sparkStream(key, req, { signal, firstEventTimeoutMs: 8000 }),
    sam: (img, prompt, signal) => samDetect(key, img, prompt, signal, { masks: opts.samMasks }),
    samMasks: opts.samMasks === true,
    image: (prompt, signal) => museImageGenerate(key, prompt, "512x512", signal),
    pageFacts: (url, signal) => fetchPageFacts(url, signal),
    productImage: (url, signal) => fetchImage(url, signal),
    wikiImage: (title, signal) => fetchWikiImageUrl(title, signal),
  };
}

export function userMessage(text: string, images: string[] = []): InputMessage[] {
  return [{ role: "user", content: [{ type: "input_text", text }, ...images.map((u) => ({ type: "input_image" as const, image_url: u }))] }];
}

/** web_search actions in a response: how many searches and page opens really happened. */
export function webActions(output: OutputItem[]): { searches: number; opened: string[] } {
  let searches = 0;
  const opened: string[] = [];
  for (const o of output) {
    if (o.type !== "web_search_call") continue;
    if (o.action?.type === "open_page") {
      // a "failed" open is not an open (11/2 probe: COS page failed, the model still cited it)
      if (o.status !== "failed" && o.action.url) opened.push(o.action.url);
    } else searches++;
  }
  return { searches, opened };
}
