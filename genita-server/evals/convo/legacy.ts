/** Reproduces what origin/main's session.ts does for one chat turn, using the prompt code under --root. */
import { pathToFileURL } from "node:url";
import type { EvalAdapter, EvalCtx } from "./run.ts";
import type { InputMessage } from "../../src/meta/spark.ts";

const GREET_PROMPT = "The call just connected. Greet the user.";

export async function loadLegacy(root: string): Promise<EvalAdapter> {
  const imp = (p: string) => import(pathToFileURL(`${root}/${p}`).href);
  const persona = await imp("src/prompt/persona.ts");
  const call = await imp("src/memory/call.ts");
  const mem = (t: string, i: number) => ({ id: `m${i}`, text: t, kind: "fact", created_at: 0, updated_at: 0, last_used_at: null, follow_up: false, source_session_id: "eval" });
  return {
    request(ctx: EvalCtx) {
      const t = ctx.turn;
      if (t.kind === "silence" || t.kind === "perception") return null; // main has no initiative
      const s = ctx.scenario;
      let instructions: string = persona.buildInstructions({ persona: s.persona, user: s.user, memories: undefined, mode: "chat", language: "English" });
      if (t.kind === "greet") {
        const items = s.opening ? [mem(s.opening, 0)] : [];
        instructions += call.memoryPrompt(items, true);
        return { instructions, input: GREET_PROMPT, maxOutputTokens: 800, effort: "minimal" };
      }
      instructions += call.memoryPrompt((s.memories ?? []).map(mem), false);
      const input: InputMessage[] = [...ctx.history.map((h): InputMessage => (h.role === "user" ? { role: "user", content: h.text } : { role: "assistant", content: h.text })), { role: "user", content: t.text }];
      return { instructions, input, maxOutputTokens: 800, effort: "minimal" };
    },
    post(raw: string, ctx: EvalCtx) {
      const last3 = ctx.history.filter((h) => h.role === "assistant").slice(-3).map((h) => h.text);
      return persona.avoidRepeatedOpener(raw, last3);
    },
  };
}
