/**
 * The vendor calls the finds pipeline makes, behind one interface so tests
 * can fake them. Real implementations reuse the session's Meta clients.
 */
import { metaJson } from "../meta/http.ts";
import { museImageGenerate, samDetect } from "../meta/media.ts";
import { SPARK_MODEL, outputText, sparkStream, type InputMessage, type SparkRequest, type SparkStreamEvent } from "../meta/spark.ts";
import type { SamBox } from "../meta/sam.ts";

export type OutputItem = { type: string; action?: { type?: string; url?: string; query?: string }; content?: Array<{ type: string; text?: string }> };
export type SparkResult = { text: string; output: OutputItem[] };

export interface FindsVendors {
  /** one-shot Responses call; returns text and output items (web_search_call actions) */
  spark(req: SparkRequest, signal?: AbortSignal): Promise<SparkResult>;
  sparkStream(req: SparkRequest, signal?: AbortSignal): AsyncIterable<SparkStreamEvent>;
  sam(imageDataUrl: string, prompt: string, signal?: AbortSignal): Promise<SamBox[]>;
  /** illustration bytes (PNG/JPEG) */
  image(prompt: string, signal?: AbortSignal): Promise<Buffer>;
}

export function metaVendors(key: string): FindsVendors {
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
          ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
          ...(req.text ? { text: req.text } : {}),
        },
        signal,
      );
      return { text: outputText(d as Parameters<typeof outputText>[0]), output: d.output ?? [] };
    },
    sparkStream: (req, signal) => sparkStream(key, req, { signal, firstEventTimeoutMs: 8000 }),
    sam: (img, prompt, signal) => samDetect(key, img, prompt, signal),
    image: (prompt, signal) => museImageGenerate(key, prompt, "512x512", signal),
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
    if (o.action?.type === "open_page") opened.push(o.action.url ?? "");
    else searches++;
  }
  return { searches, opened };
}
