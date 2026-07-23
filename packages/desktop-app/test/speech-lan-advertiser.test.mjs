import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const advertiserModulePath = path.join(packageRoot, "dist", "speechLanAdvertiser.js");
const { createDesktopSpeechLanAdvertiser } = await import(advertiserModulePath);

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
    return true;
  };
  return child;
}

test("desktop speech LAN advertiser starts dns-sd with the expected Instafy speech service metadata", async () => {
  const calls = [];
  const advertiser = createDesktopSpeechLanAdvertiser({
    platform: "darwin",
    spawnImpl(command, args) {
      calls.push({ command, args });
      return createFakeChild();
    },
  });

  const status = await advertiser.ensureRunning({
    serviceName: "Instafy Taylor",
    port: 8796,
    tokenHint: "abcd…wxyz",
    authRequired: true,
  });

  assert.equal(status.state, "advertising");
  assert.deepEqual(calls, [
    {
      command: "dns-sd",
      args: [
        "-R",
        "Instafy Taylor",
        "_instafy-speech._tcp",
        "local.",
        "8796",
        "token_hint=abcd…wxyz",
        "host_mode=desktop",
        "auth_required=1",
      ],
    },
  ]);
});

test("desktop speech LAN advertiser reports unsupported outside macOS", async () => {
  const advertiser = createDesktopSpeechLanAdvertiser({
    platform: "linux",
  });

  const status = await advertiser.ensureRunning({
    serviceName: "Instafy Linux",
    port: 8796,
    tokenHint: "abcd…wxyz",
    authRequired: true,
  });

  assert.equal(status.state, "unsupported");
  assert.match(status.lastError ?? "", /requires macOS/i);
});
