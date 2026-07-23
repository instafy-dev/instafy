import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const loggingModulePath = path.join(packageRoot, "dist", "logging.js");

function runBrokenPipeScenario(streamName) {
  const script = `
    const { desktopLog } = require(${JSON.stringify(loggingModulePath)});
    const target = process[${JSON.stringify(streamName)}];
    let writes = 0;
    target.write = function () {
      writes += 1;
      const error = new Error("broken pipe");
      error.code = "EPIPE";
      throw error;
    };
    desktopLog(${JSON.stringify(streamName === "stdout" ? "info" : "warn")}, "first write breaks");
    desktopLog(${JSON.stringify(streamName === "stdout" ? "info" : "warn")}, "second write should be ignored");
    process.stdout.write = (...args) => require("node:fs").writeSync(1, args.join(""));
    process.stdout.write(JSON.stringify({ ok: true, writes }) + "\\n");
  `;

  return spawnSync(process.execPath, ["-e", script], {
    cwd: packageRoot,
    encoding: "utf8",
  });
}

test("desktopLog ignores stdout EPIPE after the first failure", () => {
  const result = runBrokenPipeScenario("stdout");
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.deepEqual(payload, { ok: true, writes: 1 });
});

test("desktopLog ignores stderr EPIPE after the first failure", () => {
  const result = runBrokenPipeScenario("stderr");
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.deepEqual(payload, { ok: true, writes: 1 });
});
