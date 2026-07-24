import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const { settleDesktopUpdaterDownload } = await import(
  path.join(packageRoot, "dist", "desktopUpdaterDownload.js")
);

test("failed updater downloads settle and expose a durable error state", async () => {
  const state = { phase: "update_available" };
  const failures = [];

  await settleDesktopUpdaterDownload(
    state,
    async () => {
      throw new Error("network unavailable");
    },
    (message) => failures.push(message),
  );

  assert.deepEqual(state, {
    phase: "error",
    lastError: "network unavailable",
  });
  assert.deepEqual(failures, ["network unavailable"]);
});

test("successful updater downloads remain in progress until the native downloaded event", async () => {
  const state = { phase: "update_available", lastError: "old" };
  await settleDesktopUpdaterDownload(state, async () => undefined, () => {
    throw new Error("failure callback should not run");
  });

  assert.deepEqual(state, { phase: "downloading", lastError: undefined });
});
