import assert from "node:assert/strict";
import test from "node:test";
import { dispatchBrowserTabInput } from "../dist/browserTabInput.js";

test("Select All uses an editor command in the selected tab without a focused host window", async () => {
  const sent = [];
  const contents = {
    debugger: {
      isAttached: () => true,
      sendCommand: async (method, params) => {
        sent.push({ method, params });
      },
    },
    getZoomFactor: () => 1,
  };
  await dispatchBrowserTabInput(
    contents,
    { width: 100, height: 100 },
    { type: "key", key: "SelectAll", shift: false },
    () => true,
  );
  assert.deepEqual(sent[0].params.commands, ["selectAll"]);
  assert.equal(sent[0].params.type, "keyDown");
  assert.equal(sent[1].params.type, "keyUp");
  assert.equal(sent[1].params.commands, undefined);
  sent.length = 0;
  await assert.rejects(
    dispatchBrowserTabInput(
      contents,
      { width: 100, height: 100 },
      { type: "key", key: "SelectAll", shift: false },
      () => false,
    ),
    /ended/,
  );
  assert.deepEqual(sent, []);
});
