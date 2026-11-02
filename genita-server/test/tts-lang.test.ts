import { test } from "node:test";
import assert from "node:assert/strict";
import { isMostlyHangul } from "../src/text/language.ts";

test("isMostlyHangul flags Korean speech and not English with a Korean word", () => {
  assert.equal(isMostlyHangul("실례합니다, 여기서 시청 가려면 어떻게 가요?"), true);
  assert.equal(isMostlyHangul("I love kimchi jjigae"), false);
  assert.equal(isMostlyHangul("I had 김치 for lunch today with my friends"), false);
  assert.equal(isMostlyHangul("음 그거 good idea 같아"), true);
  assert.equal(isMostlyHangul(""), false);
});
