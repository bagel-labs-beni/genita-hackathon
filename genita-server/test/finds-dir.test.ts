import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { findsDir } from "../src/finds/setup.ts";

// AWS deploy 11/2: the release dir is not writable (EACCES on data/finds/images → rollback)
test("finds dir: GENITA_FINDS_DIR, else GENITA_DATA_DIR/finds, else ./data/finds", () => {
  assert.equal(findsDir({ GENITA_FINDS_DIR: "/x/f", GENITA_DATA_DIR: "/var/lib/genita" }), "/x/f");
  assert.equal(findsDir({ GENITA_DATA_DIR: "/var/lib/genita" }), "/var/lib/genita/finds");
  assert.equal(findsDir({}), join(process.cwd(), "data/finds"));
});
