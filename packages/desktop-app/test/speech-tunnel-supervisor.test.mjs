import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const supervisorModulePath = path.join(packageRoot, "dist", "speechTunnelSupervisor.js");
const { createDesktopSpeechTunnelSupervisor } = await import(supervisorModulePath);

function createTunnelHandle({
  projectId = "project-123",
  tunnelId,
  publicUrl,
  pid,
}) {
  let exitResolver = null;
  let stopCalls = 0;
  const handle = {
    pid,
    process: { exitCode: null },
    projectId,
    tunnelId,
    publicUrl,
    hostname: new URL(publicUrl).hostname,
    localPort: 8796,
    readyPath: "/health",
    stop: async () => {
      stopCalls += 1;
      handle.process.exitCode = 0;
      exitResolver?.({ code: 0, signal: null });
    },
    exited: new Promise((resolve) => {
      exitResolver = resolve;
    }),
    get stopCalls() {
      return stopCalls;
    },
  };
  return handle;
}

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
  assert.equal(status.controllerUrl, "http://127.0.0.1:8788");
  assert.equal(status.controllerCredentialMode, "fixed");
  assert.match(status.controllerBindingId, /^[0-9a-f-]{36}$/i);
  assert.equal(Object.hasOwn(status, "controllerAccessToken"), false);

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

test("desktop speech tunnel supervisor reuses only the exact controller binding", async () => {
  const handles = [
    createTunnelHandle({
      tunnelId: "tunnel-a",
      publicUrl: "https://speech-a.example.com",
      pid: 4101,
    }),
    createTunnelHandle({
      tunnelId: "tunnel-b",
      publicUrl: "https://speech-b.example.com",
      pid: 4102,
    }),
    createTunnelHandle({
      tunnelId: "tunnel-c",
      publicUrl: "https://speech-c.example.com",
      pid: 4103,
    }),
    createTunnelHandle({
      tunnelId: "tunnel-d",
      publicUrl: "https://speech-d.example.com",
      pid: 4104,
    }),
  ];
  const starts = [];
  const supervisor = createDesktopSpeechTunnelSupervisor({
    startTunnelImpl: async (options) => {
      starts.push(options);
      return handles[starts.length - 1];
    },
  });

  const initial = await supervisor.ensureRunning({
    projectId: "project-123",
    controllerUrl: "https://controller-a.example.com",
    controllerAccessToken: "token-a",
    controllerCredentialMode: "ambient",
  });
  const reused = await supervisor.ensureRunning({
    projectId: "project-123",
    controllerUrl: "https://controller-a.example.com",
    controllerAccessToken: "token-a",
    controllerCredentialMode: "ambient",
  });
  const movedController = await supervisor.ensureRunning({
    projectId: "project-123",
    controllerUrl: "https://controller-b.example.com",
    controllerAccessToken: "token-a",
    controllerCredentialMode: "ambient",
  });
  const rotatedToken = await supervisor.ensureRunning({
    projectId: "project-123",
    controllerUrl: "https://controller-b.example.com",
    controllerAccessToken: "token-c",
    controllerCredentialMode: "ambient",
  });
  const changedCredentialMode = await supervisor.ensureRunning({
    projectId: "project-123",
    controllerUrl: "https://controller-b.example.com",
    controllerAccessToken: "token-c",
    controllerCredentialMode: "fixed",
  });

  assert.equal(starts.length, 4);
  assert.equal(reused.controllerBindingId, initial.controllerBindingId);
  assert.equal(handles[0].stopCalls, 1);
  assert.equal(handles[1].stopCalls, 1);
  assert.equal(movedController.controllerUrl, "https://controller-b.example.com");
  assert.equal(movedController.controllerCredentialMode, "ambient");
  assert.notEqual(movedController.controllerBindingId, initial.controllerBindingId);
  assert.equal(rotatedToken.controllerUrl, "https://controller-b.example.com");
  assert.notEqual(rotatedToken.controllerBindingId, movedController.controllerBindingId);
  assert.equal(starts[2].controllerAccessToken, "token-c");
  assert.equal(Object.hasOwn(rotatedToken, "controllerAccessToken"), false);
  assert.equal(handles[2].stopCalls, 1);
  assert.equal(changedCredentialMode.controllerCredentialMode, "fixed");
  assert.notEqual(changedCredentialMode.controllerBindingId, rotatedToken.controllerBindingId);

  await supervisor.stop();
});

test("desktop speech tunnel supervisor does not coalesce concurrent different bindings", async () => {
  const firstHandle = createTunnelHandle({
    tunnelId: "tunnel-a",
    publicUrl: "https://speech-a.example.com",
    pid: 4201,
  });
  const secondHandle = createTunnelHandle({
    tunnelId: "tunnel-b",
    publicUrl: "https://speech-b.example.com",
    pid: 4202,
  });
  let releaseFirstStart = null;
  const firstStartGate = new Promise((resolve) => {
    releaseFirstStart = resolve;
  });
  const starts = [];
  const supervisor = createDesktopSpeechTunnelSupervisor({
    startTunnelImpl: async (options) => {
      starts.push(options);
      if (starts.length === 1) {
        await firstStartGate;
        return firstHandle;
      }
      return secondHandle;
    },
  });

  const firstStart = supervisor.ensureRunning({
    projectId: "project-123",
    controllerUrl: "https://controller-a.example.com",
    controllerAccessToken: "token-a",
    controllerCredentialMode: "fixed",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const secondStart = supervisor.ensureRunning({
    projectId: "project-123",
    controllerUrl: "https://controller-b.example.com",
    controllerAccessToken: "token-b",
    controllerCredentialMode: "fixed",
  });
  releaseFirstStart();

  const [firstStatus, secondStatus] = await Promise.all([firstStart, secondStart]);
  assert.equal(firstStatus.controllerUrl, "https://controller-a.example.com");
  assert.equal(secondStatus.controllerUrl, "https://controller-b.example.com");
  assert.equal(secondStatus.publicUrl, "https://speech-b.example.com");
  assert.equal(starts.length, 2);
  assert.equal(firstHandle.stopCalls, 1);

  await supervisor.stop();
});

test("desktop speech tunnel supervisor queues a new start until an old handle finishes stopping", async () => {
  const oldHandle = createTunnelHandle({
    tunnelId: "tunnel-old",
    publicUrl: "https://speech-old.example.com",
    pid: 4251,
  });
  const newHandle = createTunnelHandle({
    tunnelId: "tunnel-new",
    publicUrl: "https://speech-new.example.com",
    pid: 4252,
  });
  let markOldStopInvoked = null;
  let releaseOldStop = null;
  let oldStopCalls = 0;
  const oldStopInvoked = new Promise((resolve) => {
    markOldStopInvoked = resolve;
  });
  const oldStopGate = new Promise((resolve) => {
    releaseOldStop = resolve;
  });
  oldHandle.stop = async () => {
    oldStopCalls += 1;
    markOldStopInvoked();
    await oldStopGate;
    oldHandle.process.exitCode = 0;
  };
  const starts = [];
  const supervisor = createDesktopSpeechTunnelSupervisor({
    startTunnelImpl: async (options) => {
      starts.push(options);
      return starts.length === 1 ? oldHandle : newHandle;
    },
  });

  await supervisor.ensureRunning({
    projectId: "project-old",
    controllerUrl: "https://controller.example.com",
    controllerAccessToken: "token-old",
    controllerCredentialMode: "fixed",
  });
  const pendingStop = supervisor.stop();
  await oldStopInvoked;

  const pendingNewStart = supervisor.ensureRunning({
    projectId: "project-new",
    controllerUrl: "https://controller.example.com",
    controllerAccessToken: "token-new",
    controllerCredentialMode: "fixed",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts.length, 1);
  assert.equal(newHandle.stopCalls, 0);

  releaseOldStop();
  await pendingStop;
  const newStartResult = await pendingNewStart;
  const finalStatus = await supervisor.getStatus();

  assert.equal(oldStopCalls, 1);
  assert.equal(starts.length, 2);
  assert.equal(newHandle.stopCalls, 0);
  assert.equal(newStartResult.state, "active");
  assert.equal(newStartResult.projectId, "project-new");
  assert.equal(newStartResult.publicUrl, "https://speech-new.example.com");
  assert.equal(finalStatus.state, "active");
  assert.equal(finalStatus.managed, true);
  assert.equal(finalStatus.projectId, "project-new");
  assert.equal(finalStatus.publicUrl, "https://speech-new.example.com");
  assert.equal(finalStatus.controllerBindingId, newStartResult.controllerBindingId);

  await supervisor.stop();
  assert.equal(newHandle.stopCalls, 1);
});

test("desktop speech tunnel supervisor stops a handle that resolves after stop", async () => {
  const lateHandle = createTunnelHandle({
    tunnelId: "tunnel-late",
    publicUrl: "https://speech-late.example.com",
    pid: 4301,
  });
  let markStartInvoked = null;
  let releaseStart = null;
  const startInvoked = new Promise((resolve) => {
    markStartInvoked = resolve;
  });
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  const supervisor = createDesktopSpeechTunnelSupervisor({
    startTunnelImpl: async () => {
      markStartInvoked();
      await startGate;
      return lateHandle;
    },
  });

  const pendingStart = supervisor.ensureRunning({
    projectId: "project-123",
    controllerUrl: "https://controller.example.com",
    controllerAccessToken: "token-a",
    controllerCredentialMode: "fixed",
  });
  await startInvoked;

  await supervisor.stop();
  const stoppedBeforeResolution = await supervisor.getStatus();
  assert.equal(stoppedBeforeResolution.state, "idle");
  assert.equal(stoppedBeforeResolution.managed, false);

  releaseStart();
  const lateStartResult = await pendingStart;
  const finalStatus = await supervisor.getStatus();

  assert.equal(lateHandle.stopCalls, 1);
  assert.equal(lateHandle.process.exitCode, 0);
  assert.equal(lateStartResult.state, "idle");
  assert.equal(lateStartResult.managed, false);
  assert.equal(lateStartResult.publicUrl, undefined);
  assert.equal(lateStartResult.controllerBindingId, undefined);
  assert.equal(finalStatus.state, "idle");
  assert.equal(finalStatus.managed, false);
  assert.equal(finalStatus.publicUrl, undefined);
  assert.equal(finalStatus.controllerBindingId, undefined);
});
