import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const supervisorModulePath = path.join(packageRoot, "dist", "speechTunnelSupervisor.js");
const { createDesktopSpeechTunnelSupervisor } = await import(supervisorModulePath);

test("desktop speech tunnel supervisor starts and reports an active tunnel", async () => {
  let exitResolver = null;
  const handle = {
    pid: 4242,
    process: { exitCode: null },
    projectId: "project-123",
    tunnelId: "tunnel-123",
    publicUrl: "https://speech.example.com",
    hostname: "speech.example.com",
    localPort: 8796,
    readyPath: "/health",
    stop: async () => {
      handle.process.exitCode = 0;
      exitResolver?.({ code: 0, signal: null });
    },
    exited: new Promise((resolve) => {
      exitResolver = resolve;
    }),
  };

  let ensureVoiceHostCalls = 0;
  const supervisor = createDesktopSpeechTunnelSupervisor({
    ensureVoiceHostRunning: async () => {
      ensureVoiceHostCalls += 1;
    },
    startTunnelImpl: async () => handle,
  });

  const status = await supervisor.ensureRunning({
    projectId: "project-123",
    controllerUrl: "http://127.0.0.1:8788",
    controllerAccessToken: "access-token",
  });

  assert.equal(ensureVoiceHostCalls, 1);
  assert.equal(status.state, "active");
  assert.equal(status.managed, true);
  assert.equal(status.publicUrl, "https://speech.example.com");

  await supervisor.stop();
  const stopped = await supervisor.getStatus();
  assert.equal(stopped.state, "idle");
  assert.equal(stopped.managed, false);
});

test("desktop speech tunnel supervisor surfaces startup failures without throwing", async () => {
  const supervisor = createDesktopSpeechTunnelSupervisor({
    startTunnelImpl: async () => {
      throw new Error("Tunnel grant failed.");
    },
  });

  const status = await supervisor.ensureRunning({
    projectId: "project-123",
    controllerUrl: "http://127.0.0.1:8788",
    controllerAccessToken: "access-token",
  });

  assert.equal(status.state, "error");
  assert.equal(status.managed, false);
  assert.equal(status.lastError, "Tunnel grant failed.");
});

test("desktop speech tunnel supervisor uses LOCAL_SPEECH_PORT when no override is provided", async () => {
  const previousPort = process.env.LOCAL_SPEECH_PORT;
  process.env.LOCAL_SPEECH_PORT = "45678";
  try {
    const supervisor = createDesktopSpeechTunnelSupervisor();
    const status = await supervisor.getStatus();
    assert.equal(status.localPort, 45678);
  } finally {
    if (typeof previousPort === "string") {
      process.env.LOCAL_SPEECH_PORT = previousPort;
    } else {
      delete process.env.LOCAL_SPEECH_PORT;
    }
  }
});
