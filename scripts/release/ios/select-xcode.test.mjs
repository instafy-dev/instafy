import assert from "node:assert/strict";
import test from "node:test";

import { selectXcode } from "./select-xcode.mjs";

test("selects the newest Xcode of the required major by numeric version", () => {
  const names = ["Xcode.app", "Xcode_16.4.app", "Xcode_26.0.1.app", "Xcode_26.1.1.app", "Xcode_26.10.app", "Xcode_26.3.app", "Xcode_26.3_beta.app", "Xcode_27.0.app"];
  assert.equal(selectXcode(names, 26), "Xcode_26.10.app");
  assert.equal(selectXcode(["Xcode_26.2.app", "Xcode_26.2.1.app"], 26), "Xcode_26.2.1.app");
  assert.throws(() => selectXcode(["Xcode_16.4.app", "Xcode.app"], 26), /no Xcode 26\.x/u);
  assert.throws(() => selectXcode(names, 0), /invalid/u);
});
