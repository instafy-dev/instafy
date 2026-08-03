import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(packageRoot, "scripts", "stage-runtime-agent.mjs");
const outputDir = path.join(packageRoot, "build", "runtime-agent");
const symbolsDir = path.join(packageRoot, "build", "runtime-agent-symbols");

// A signed system binary such as /bin/echo would strip to zero bytes saved and
// let these tests pass without proving anything. Compile a real unstripped,
// unsigned Mach-O instead — the same shape as a freshly built runtime agent.
function compileUnstrippedBinary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-strip-"));
  const source = path.join(dir, "agent.c");
  const binary = path.join(dir, "agent");
  fs.writeFileSync(source, 'int helper(int n){return n*2;}\nint main(void){return helper(0);}\n');
  const built = spawnSync("cc", ["-g", "-O0", "-o", binary, source], { encoding: "utf8" });
  if (built.error || built.status !== 0) return null;
  return { dir, binary };
}

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

const fixture = process.platform === "darwin" ? compileUnstrippedBinary() : null;
const skip = process.platform !== "darwin" ? "macOS only" : !fixture ? "no working cc" : false;

test.after(() => {
  if (fixture) fs.rmSync(fixture.dir, { recursive: true, force: true });
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.rmSync(symbolsDir, { recursive: true, force: true });
});

test("the staged binary is stripped and still runs", { skip }, () => {
  const result = stage(fixture.binary);
  assert.equal(result.status, 0, result.stderr);

  const shipped = path.join(outputDir, "runtime-agent");
  const archived = path.join(symbolsDir, "runtime-agent.unstripped");
  assert.ok(
    fs.statSync(shipped).size < fs.statSync(archived).size,
    "the shipped binary must be smaller than the archived unstripped copy",
  );
  assert.equal(spawnSync(shipped).status, 0, "the stripped binary must still execute");
});

test("the manifest describes the binary that actually ships", { skip }, () => {
  // Hash after stripping, not before: the manifest is what signing, packaging
  // and every downstream integrity check compare against, so a pre-strip hash
  // would describe a file that was never shipped.
  stage(fixture.binary);
  const shipped = path.join(outputDir, "runtime-agent");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(outputDir, "runtime-agent-manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.sha256,
    createHash("sha256").update(fs.readFileSync(shipped)).digest("hex"),
  );
  assert.equal(manifest.sizeBytes, fs.statSync(shipped).size);
});

test("symbols are archived outside the directory that gets bundled", { skip }, () => {
  // extraResources copies build/runtime-agent with a runtime-agent* filter, so
  // symbols kept alongside the binary would ship straight back into the app.
  stage(fixture.binary);
  assert.ok(fs.existsSync(path.join(symbolsDir, "runtime-agent.unstripped")));
  assert.deepEqual(
    fs.readdirSync(outputDir).filter((e) => e.includes("unstripped") || e.endsWith(".dSYM")),
    [],
    "no symbol artefacts may sit in the bundled directory",
  );
});
