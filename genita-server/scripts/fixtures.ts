import { statSync } from "node:fs";
import { join, resolve } from "node:path";

/** Resolve optional test media without assuming a developer's directory layout. */
export function fixturePath(...parts: string[]): string {
  const configured = process.env.GENITA_FIXTURES_DIR?.trim();
  if (!configured) throw new Error("Set GENITA_FIXTURES_DIR to your test-media directory, or pass an input file to scripts that accept one. See genita-server/README.md.");
  const root = resolve(configured);
  let isDirectory = false;
  try { isDirectory = statSync(root).isDirectory(); } catch { /* report configuration below */ }
  if (!isDirectory) throw new Error("GENITA_FIXTURES_DIR must point to an existing directory. See genita-server/README.md.");
  return join(root, ...parts);
}
