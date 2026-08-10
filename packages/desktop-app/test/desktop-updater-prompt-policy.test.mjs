import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { shouldPromptForUpdate, nextDeclinedVersion } = await import(
  path.join(packageRoot, "dist", "desktopUpdaterPromptPolicy.js")
);

const idle = {
  phase: "idle",
  suppressAvailablePrompt: false,
  promptInFlight: false,
  declinedVersion: null,
};

test("a declined version never prompts again", () => {
  // The reason this exists: the check interval dropped from 6 hours to 30
  // minutes. Without a sticky decline that converts one polite prompt into a
  // nag every 30 minutes, forever.
  const declined = { ...idle, declinedVersion: "0.2.4" };
  assert.equal(shouldPromptForUpdate("0.2.4", declined), false);
  // A different version is a new decision.
  assert.equal(shouldPromptForUpdate("0.2.5", declined), true);
});

test("declining records the version; accepting clears it", () => {
  assert.equal(nextDeclinedVersion("0.2.4", false, null), "0.2.4");
  assert.equal(nextDeclinedVersion("0.2.4", true, "0.2.4"), null);
});

test("an already-downloaded update leaves the conversation to the install prompt", () => {
  assert.equal(shouldPromptForUpdate("0.2.4", { ...idle, phase: "downloaded" }), false);
});

test("background checks and in-flight dialogs do not stack prompts", () => {
  assert.equal(shouldPromptForUpdate("0.2.4", { ...idle, suppressAvailablePrompt: true }), false);
  assert.equal(shouldPromptForUpdate("0.2.4", { ...idle, promptInFlight: true }), false);
});

test("an ordinary available update on an idle app prompts", () => {
  assert.equal(shouldPromptForUpdate("0.2.4", idle), true);
});
