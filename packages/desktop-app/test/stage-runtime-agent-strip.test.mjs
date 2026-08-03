import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(packageRoot, "scripts", "stage-runtime-agent.mjs");
const outputDir = path.join(packageRoot, "build", "runtime-agent");
const symbolsDir = path.join(packageRoot, "build", "runtime-agent-symbols");

function stage(sourceBinary) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      INSTAFY_RUNTIME_AGENT_PREBUILT: sourceBinary,
      INSTAFY_SOURCE_SHA: "a".repeat(40),
    },
  });
}

test("the manifest describes the binary that actually ships", { skip: process.platform !== "darwin" }, () => {
  // A real Mach-O stands in for the runtime agent; strip must run on it and
  // the recorded hash must match the post-strip bytes, or every downstream
  // integrity check compares against a file that was never shipped.
  const result = stage("/bin/echo");
  assert.equal(result.status, 0, result.stderr);

  const shipped = path.join(outputDir, "runtime-agent");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(outputDir, "runtime-agent-manifest.json"), "utf8"),
  );
  const actual = createHash("sha256").update(fs.readFileSync(shipped)).digest("hex");
  assert.equal(manifest.sha256, actual, "manifest hash must match the shipped bytes");
  assert.equal(manifest.sizeBytes, fs.statSync(shipped).size);
});

test("symbols are archived outside the directory that gets bundled", { skip: process.platform !== "darwin" }, () => {
  // extraResources copies build/runtime-agent with a runtime-agent* filter, so
  // symbols kept alongside the binary would ship straight back into the app --
  // defeating the strip and inflating every download.
  stage("/bin/echo");
  assert.ok(fs.existsSync(path.join(symbolsDir, "runtime-agent.unstripped")));
  const bundled = fs.readdirSync(outputDir);
  assert.deepEqual(
    bundled.filter((entry) => entry.includes("unstripped") || entry.endsWith(".dSYM")),
    [],
    "no symbol artefacts may sit in the bundled directory",
  );
});
