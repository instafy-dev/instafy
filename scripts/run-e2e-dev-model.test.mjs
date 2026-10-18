import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { isLegacyLauncherModelPin, providerEnv } from "./run-e2e-dev.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// The controller chooses each job's model. A model pinned by the dev launcher
// or a template reaches every runtime through the provider's environment and
// docker compose, and silently overrides the controller wherever a job lacks
// its own model: that is how a retired gpt-5.5 reached the proxy.

test("the dev launcher does not hardcode a model", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "scripts/run-e2e-dev.mjs"), "utf8");
  assert.doesNotMatch(source, /^CODEX_MODEL=\S/m, "the generated .env.local pins no model");
  assert.doesNotMatch(source, /CODEX_MODEL:\s*codexModel/, "compose entries pin no model");
  assert.doesNotMatch(source, /defaultCodexModel/);
});

test("the provider does not pass the launcher's old pin to runtimes", () => {
  assert.equal(providerEnv({ CODEX_MODEL: "gpt-5.5" }).CODEX_MODEL, undefined);
  assert.equal(providerEnv({ CODEX_MODEL: "" }).CODEX_MODEL, undefined);
  // An operator's deliberate pin survives.
  assert.equal(providerEnv({ CODEX_MODEL: "gpt-6-luna" }).CODEX_MODEL, "gpt-6-luna");
  assert.equal(isLegacyLauncherModelPin(" gpt-5.5 "), true);
  assert.equal(isLegacyLauncherModelPin("gpt-5.6-sol"), false);
});

test("docker/.env.example leaves CODEX_MODEL empty", () => {
  const example = fs.readFileSync(path.join(REPO_ROOT, "docker/.env.example"), "utf8");
  const pins = example.split(/\r?\n/).filter((line) => /^CODEX_MODEL=\S/.test(line));
  assert.deepEqual(pins, []);
});
