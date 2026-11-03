/**
 * Offline mode of the convo eval (#346): no key, no vendor call.
 *   npm run eval:convo -- --offline [fixtures.json]      score recorded transcripts, exit 1 if a fixture verdict changed
 *   npm run eval:convo -- --rubric <report.json>         score a live run's transcripts with the same rubric
 * A live run (`--root …`) also writes rubric.md next to report.md, so live and offline speak the same numbers.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesExpectation, rubricMd, scoreTranscript, type Line, type Scored, type Transcript } from "./rubric.ts";
import type { Scenario } from "./scenarios.ts";

export const DEFAULT_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "transcripts.json");

export function loadFixtures(path = DEFAULT_FIXTURES): Transcript[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { transcripts?: Transcript[] } | Transcript[];
  const list = Array.isArray(raw) ? raw : raw.transcripts ?? [];
  if (!list.length) throw new Error(`no transcripts in ${path}`);
  return list;
}

export type OfflineResult = { scored: Scored[]; checks: { id: string; ok: boolean; why: string }[]; errored: string[]; md: string; ok: boolean };

export function runOffline(transcripts: Transcript[], label = "fixtures"): OfflineResult {
  // a run that broke on a vendor error is not a clean call: listed, never scored or counted as a pass (Codex #499 P2)
  const errored = transcripts.filter((t) => t.error);
  const ok = transcripts.filter((t) => !t.error);
  const scored = ok.map(scoreTranscript);
  const checks = ok.map((t, i) => ({ id: t.id, ...matchesExpectation(t, scored[i]) }));
  const skipped = errored.length ? `\n## Not scored (run errored)\n\n${errored.map((t) => `- ${t.id}: ${t.error}`).join("\n")}\n` : "";
  return { scored, checks, errored: errored.map((t) => t.id), md: rubricMd(label, scored, checks) + skipped, ok: checks.every((c) => c.ok) };
}

/** shape of a live report's step (run.ts) — only what the rubric needs */
type ReportStep = { turn: { kind: string; text?: string; quietMs?: number; hint?: string }; text: string | null; quiet: boolean; error?: string };
type ReportLike = { label: string; scenarios: { id: string; runs: { steps: ReportStep[]; prior?: { role: "user" | "assistant"; text: string }[] }[] }[] };

/** live report → transcripts (one per run), persona / crisis from the scenario list */
export function fromReport(report: ReportLike, scenarios: Scenario[]): Transcript[] {
  const out: Transcript[] = [];
  for (const s of report.scenarios) {
    const sc = scenarios.find((x) => x.id === s.id);
    s.runs.forEach((run, k) => {
      const lines: Line[] = [];
      const err = run.steps.find((st) => st.error)?.error;
      for (const h of run.prior ?? []) lines.push(h.role === "user" ? { role: "user", text: h.text } : { role: "companion", text: h.text.replace(/<[^>]*>|\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim() });
      for (const st of run.steps) {
        if (st.error) break;
        if (st.turn.kind === "user") lines.push({ role: "user", text: st.turn.text ?? "" });
        else if (st.turn.kind === "greet") lines.push({ role: "event", text: "greet" });
        else if (st.turn.kind === "silence") lines.push({ role: "event", text: `silence ${Math.round((st.turn.quietMs ?? 0) / 1000)}s` });
        else lines.push({ role: "event", text: `perception: ${st.turn.hint ?? ""}` });
        lines.push(st.quiet ? { role: "companion", text: "", quiet: true } : { role: "companion", text: st.text ?? "" });
      }
      out.push({
        id: `${s.id}#${k + 1}`,
        persona: { name: sc?.persona.name ?? "Companion", kind: sc?.persona.kind },
        user: { name: sc?.user.name },
        crisis: sc?.expect.crisis ?? false,
        camera: false, // scripted calls send no frames
        lines,
        ...(err ? { error: err } : {}),
      });
    });
  }
  return out;
}
