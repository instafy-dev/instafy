import assert from "node:assert/strict";
import test from "node:test";
import { requireHumanInputIndices } from "../dist/personalBrowserHumanInput.js";

test("manual input accepts only bounded unique observed indices, never supplied field values", () => {
  assert.deepEqual(requireHumanInputIndices({ indices: [0, 4] }), [0, 4]);
  for (const invalid of [null, {}, { indices: [] }, { indices: [0, 0] }, { indices: [500] }, { indices: [-1] }, { indices: [1.2] }, { indices: Array.from({ length: 9 }, (_, i) => i) }, { indices: [0], value: "secret-must-not-pass" }, { indices: [0], selector: "input" }]) {
    assert.throws(() => requireHumanInputIndices(invalid));
  }
});
