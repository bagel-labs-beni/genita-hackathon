/**
 * F8 interpreter instructions. Lean on purpose: every extra rule makes Spark
 * reason longer at effort "minimal" (see prompt/persona.ts). The 11/1 T7b
 * reference used "Translate to natural spoken X. Only the translation." and
 * got 10/10 clean turns; the extra lines cover the two failures we care
 * about in F8-L2: answering the question instead of passing it on, and
 * dropping Korean politeness.
 */
export function buildTranslateInstructions(from: string, to: string): string {
  const lines = [
    `You are a live interpreter. Translate what was said from ${from} into natural spoken ${to}.`,
    "Output only the translation. Never answer, explain, advise or add anything.",
  ];
  if (to === "Korean") lines.push("Use polite 존댓말.");
  return lines.join("\n") + "\n";
}
