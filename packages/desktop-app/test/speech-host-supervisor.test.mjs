import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const supervisorModulePath = path.join(packageRoot, "dist", "speechHostSupervisor.js");
const fixtureScriptPath = path.join(__dirname, "fixtures", "health-service.mjs");
const {
  createDesktopVoiceHostSupervisor,
  ensureDesktopProviderConfig,
  resolveDesktopProviderConfig,
} = await import(supervisorModulePath);

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForHealthy(url, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

test("desktop voice host supervisor starts managed speech and provider services", async () => {
  const userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "instafy-desktop-voice-host-"));
  const speechPort = await getFreePort();
  const providerPort = await getFreePort();
  const logs = [];

  const supervisor = createDesktopVoiceHostSupervisor({
    isPackaged: false,
    appPath: packageRoot,
    currentDir: path.join(packageRoot, "dist"),
    userDataDir,
    env: {
      INSTAFY_DESKTOP_LAN_HOST: "192.168.10.25",
      LOCAL_SPEECH_PORT: String(speechPort),
      LOCAL_PROVIDER_HOST_PORT: String(providerPort),
    },
    runAsElectronNode: false,
    startTimeoutMs: 2_500,
    stopTimeoutMs: 1_500,
    bootstrapImpl: async ({ action, dryRun }) => ({
      ok: true,
      action,
      dryRun,
      status: {
        transcription: {
          ready: true,
          installState: "ready",
        },
      },
    }),
    logger(level, message, payload) {
      logs.push({ level, message, payload });
    },
    serviceOverrides: {
      speechService: {
        scriptPath: fixtureScriptPath,
        args: ["--service", "speech-service", "--port", String(speechPort)],
        healthUrl: `http://127.0.0.1:${speechPort}/health`,
      },
      providerHost: {
        scriptPath: fixtureScriptPath,
        args: ["--service", "provider-host", "--port", String(providerPort)],
        healthUrl: `http://127.0.0.1:${providerPort}/health`,
      },
    },
  });

  const status = await supervisor.ensureRunning();

  assert.equal(status.enabled, true);
  assert.equal(status.speechService.state, "running");
  assert.equal(status.speechService.managed, true);
  assert.equal(status.speechService.reachable, true);
  assert.equal(status.providerHost.state, "running");
  assert.equal(status.providerHost.managed, true);
  assert.equal(status.providerHost.reachable, true);
  assert.equal(status.lan.state, "available");
  assert.equal(status.lan.baseUrl, `http://192.168.10.25:${speechPort}`);
  assert.equal(status.lan.healthUrl, `http://127.0.0.1:${speechPort}/health`);
  assert.equal(status.lan.authRequired, true);
  assert.equal(status.speechAuthToken, status.lan.authToken);
  assert.equal(typeof status.lan.authToken, "string");
  assert.match(status.lan.authToken ?? "", /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(fs.existsSync(status.providerConfigPath), true);
  assert.equal(
    logs.some((entry) => entry.message.includes("speechService:stdout")),
    true,
  );

  await supervisor.stop();

  const stopped = await supervisor.getStatus();
  assert.equal(stopped.speechService.managed, false);
  assert.equal(stopped.providerHost.managed, false);
});

test("desktop voice host supervisor uses an already-running external host instead of spawning duplicates", async () => {
  const userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "instafy-desktop-voice-host-external-"));
  const speechPort = await getFreePort();
  const providerPort = await getFreePort();

  const externalSpeech = spawn(
    process.execPath,
    [fixtureScriptPath, "--service", "external-speech", "--port", String(speechPort)],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  const externalProvider = spawn(
    process.execPath,
    [fixtureScriptPath, "--service", "external-provider", "--port", String(providerPort)],
    { stdio: ["ignore", "ignore", "ignore"] },
  );

  try {
    await waitForHealthy(`http://127.0.0.1:${speechPort}/health`);
    await waitForHealthy(`http://127.0.0.1:${providerPort}/health`);

    const supervisor = createDesktopVoiceHostSupervisor({
      isPackaged: false,
      appPath: packageRoot,
      currentDir: path.join(packageRoot, "dist"),
      userDataDir,
      runAsElectronNode: false,
      startTimeoutMs: 1_500,
      serviceOverrides: {
        speechService: {
          scriptPath: fixtureScriptPath,
          args: ["--service", "managed-speech", "--port", String(speechPort)],
          healthUrl: `http://127.0.0.1:${speechPort}/health`,
        },
        providerHost: {
          scriptPath: fixtureScriptPath,
          args: ["--service", "managed-provider", "--port", String(providerPort)],
          healthUrl: `http://127.0.0.1:${providerPort}/health`,
        },
      },
    });

    const status = await supervisor.ensureRunning();
    assert.equal(status.speechService.state, "external");
    assert.equal(status.speechService.managed, false);
    assert.equal(status.providerHost.state, "external");
    assert.equal(status.providerHost.managed, false);

    await supervisor.stop();
  } finally {
    await stopChild(externalSpeech);
    await stopChild(externalProvider);
  }
});

test("ensureDesktopProviderConfig writes the desktop speech-only provider config", async () => {
  const userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "instafy-desktop-provider-config-"));
  const configPath = ensureDesktopProviderConfig(userDataDir);
  const payload = JSON.parse(await fs.promises.readFile(configPath, "utf8"));
  assert.equal(payload.defaultProviderId, "speech");
  assert.deepEqual(payload.providers.map((entry) => entry.id), ["speech"]);
});

test("Desktop preserves a safe explicitly configured provider composition", async () => {
  const tempRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "instafy-desktop-provider-composition-"),
  );
  const userDataDir = path.join(tempRoot, "user-data");
  const configuredPath = path.join(tempRoot, "provider-host.config.json");
  await fs.promises.writeFile(
    configuredPath,
    `${JSON.stringify({
      defaultProviderId: "custom",
      providers: [{ type: "custom", id: "custom", enabled: true }],
    })}\n`,
  );

  assert.equal(
    resolveDesktopProviderConfig(userDataDir, {
      LOCAL_PROVIDER_HOST_CONFIG: configuredPath,
    }),
    configuredPath,
  );
  assert.equal(fs.existsSync(userDataDir), false);

  const supervisor = createDesktopVoiceHostSupervisor({
    enabled: false,
    isPackaged: false,
    appPath: packageRoot,
    currentDir: path.join(packageRoot, "dist"),
    userDataDir,
    env: {
      LOCAL_PROVIDER_HOST_CONFIG: configuredPath,
    },
    runAsElectronNode: false,
  });
  assert.equal((await supervisor.getStatus()).providerConfigPath, configuredPath);
});

test("Desktop rejects unsafe explicit provider config paths", async () => {
  const tempRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "instafy-desktop-provider-config-safety-"),
  );
  const targetPath = path.join(tempRoot, "provider-host.config.json");
  const symlinkPath = path.join(tempRoot, "provider-host.config.link.json");
  await fs.promises.writeFile(targetPath, "{}\n");
  await fs.promises.symlink(targetPath, symlinkPath);

  assert.throws(
    () =>
      resolveDesktopProviderConfig(tempRoot, {
        LOCAL_PROVIDER_HOST_CONFIG: "relative/provider-host.config.json",
      }),
    /must be an absolute path/u,
  );
  assert.throws(
    () =>
      resolveDesktopProviderConfig(tempRoot, {
        LOCAL_PROVIDER_HOST_CONFIG: path.join(tempRoot, "missing.json"),
      }),
    /existing regular file/u,
  );
  assert.throws(
    () =>
      resolveDesktopProviderConfig(tempRoot, {
        LOCAL_PROVIDER_HOST_CONFIG: symlinkPath,
      }),
    /regular non-symlink file/u,
  );
});

test("desktop voice host supervisor persists a reusable LAN pairing token", async () => {
  const userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "instafy-desktop-lan-token-"));
  const speechPort = await getFreePort();
  const providerPort = await getFreePort();
  const createSupervisor = () =>
    createDesktopVoiceHostSupervisor({
      enabled: false,
      isPackaged: false,
      appPath: packageRoot,
      currentDir: path.join(packageRoot, "dist"),
      userDataDir,
      env: {
        INSTAFY_DESKTOP_LAN_HOST: "192.168.10.25",
      },
      runAsElectronNode: false,
      serviceOverrides: {
        speechService: {
          scriptPath: fixtureScriptPath,
          args: ["--service", "speech-service", "--port", String(speechPort)],
          healthUrl: "http://127.0.0.1:1/health",
        },
        providerHost: {
          scriptPath: fixtureScriptPath,
          args: ["--service", "provider-host", "--port", String(providerPort)],
          healthUrl: "http://127.0.0.1:1/health",
        },
      },
    });

  const first = createSupervisor();
  const second = createSupervisor();

  const firstStatus = await first.getStatus();
  const secondStatus = await second.getStatus();
  assert.equal(firstStatus.lan.state, "available");
  assert.equal(secondStatus.lan.state, "available");
  assert.equal(firstStatus.speechAuthToken, secondStatus.speechAuthToken);
  assert.equal(firstStatus.lan.authToken, secondStatus.lan.authToken);
});

test("desktop voice host supervisor runs the shared bootstrap action and returns refreshed host status", async () => {
  const userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "instafy-desktop-voice-bootstrap-"));
  const speechPort = await getFreePort();
  const providerPort = await getFreePort();

  const supervisor = createDesktopVoiceHostSupervisor({
    isPackaged: false,
    appPath: packageRoot,
    currentDir: path.join(packageRoot, "dist"),
    userDataDir,
    runAsElectronNode: false,
    startTimeoutMs: 2_500,
    serviceOverrides: {
      speechService: {
        scriptPath: fixtureScriptPath,
        args: ["--service", "speech-service", "--port", String(speechPort)],
        healthUrl: `http://127.0.0.1:${speechPort}/health`,
      },
      providerHost: {
        scriptPath: fixtureScriptPath,
        args: ["--service", "provider-host", "--port", String(providerPort)],
        healthUrl: `http://127.0.0.1:${providerPort}/health`,
      },
    },
    bootstrapImpl: async ({ action, dryRun }) => ({
      ok: true,
      action,
      dryRun,
      commandsRun: [
        "download https://astral.sh/uv/0.11.6/install.sh -> /tmp/instafy-desktop-voice-bootstrap/bin/uv",
        "/tmp/instafy-desktop-voice-bootstrap/bin/uv python install 3.12",
        "/tmp/instafy-desktop-voice-bootstrap/bin/uv venv /tmp/instafy-desktop-voice-bootstrap/venv --python 3.12",
        "/tmp/instafy-desktop-voice-bootstrap/bin/uv pip install --python /tmp/instafy-desktop-voice-bootstrap/venv/bin/python3 --upgrade insanely-fast-whisper imageio-ffmpeg",
      ],
      status: {
        nextSteps: ["Desktop host repair completed."],
      },
    }),
  });

  const result = await supervisor.bootstrap("install_transcription", false);

  assert.equal(result.ok, true);
  assert.equal(result.action, "install_transcription");
  assert.deepEqual(result.commandsRun, [
    "download https://astral.sh/uv/0.11.6/install.sh -> /tmp/instafy-desktop-voice-bootstrap/bin/uv",
    "/tmp/instafy-desktop-voice-bootstrap/bin/uv python install 3.12",
    "/tmp/instafy-desktop-voice-bootstrap/bin/uv venv /tmp/instafy-desktop-voice-bootstrap/venv --python 3.12",
    "/tmp/instafy-desktop-voice-bootstrap/bin/uv pip install --python /tmp/instafy-desktop-voice-bootstrap/venv/bin/python3 --upgrade insanely-fast-whisper imageio-ffmpeg",
  ]);
  assert.equal(result.status?.nextSteps?.[0], "Desktop host repair completed.");
  assert.equal(result.hostStatus.speechService.reachable, true);
  assert.equal(result.hostStatus.providerHost.reachable, true);

  await supervisor.stop();
});

test("desktop voice host supervisor auto-installs the managed transcription runtime once when missing", async () => {
  const userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "instafy-desktop-voice-autobootstrap-"));
  const speechPort = await getFreePort();
  const providerPort = await getFreePort();
  const bootstrapCalls = [];

  const supervisor = createDesktopVoiceHostSupervisor({
    isPackaged: false,
    appPath: packageRoot,
    currentDir: path.join(packageRoot, "dist"),
    userDataDir,
    runAsElectronNode: false,
    startTimeoutMs: 2_500,
    serviceOverrides: {
      speechService: {
        scriptPath: fixtureScriptPath,
        args: ["--service", "speech-service", "--port", String(speechPort)],
        healthUrl: `http://127.0.0.1:${speechPort}/health`,
      },
      providerHost: {
        scriptPath: fixtureScriptPath,
        args: ["--service", "provider-host", "--port", String(providerPort)],
        healthUrl: `http://127.0.0.1:${providerPort}/health`,
      },
    },
    bootstrapImpl: async ({ action, dryRun }) => {
      bootstrapCalls.push({ action, dryRun });
      if (action === "check") {
        return {
          ok: true,
          action,
          dryRun,
          status: {
            transcription: {
              ready: false,
              installState: "needs_install",
            },
            nextSteps: ["Instafy Desktop will install the managed transcription runtime."],
          },
        };
      }
      return {
        ok: true,
        action,
        dryRun,
        commandsRun: ["managed install"],
        status: {
          transcription: {
            ready: true,
            installState: "ready",
          },
          nextSteps: ["Instafy Desktop installed the managed transcription runtime."],
        },
      };
    },
  });

  const status = await supervisor.ensureRunning();
  assert.equal(status.speechService.reachable, true);
  assert.equal(status.providerHost.reachable, true);
  assert.deepEqual(
    bootstrapCalls.map((entry) => entry.action),
    ["check", "install_transcription"],
  );
  assert.equal(status.bootstrap.state, "idle");
  assert.match(
    status.bootstrap.detail ?? "",
    /installed the managed transcription runtime/i,
  );

  const again = await supervisor.ensureRunning();
  assert.equal(again.speechService.reachable, true);
  assert.equal(again.providerHost.reachable, true);
  assert.deepEqual(
    bootstrapCalls.map((entry) => entry.action),
    ["check", "install_transcription"],
  );

  await supervisor.stop();
});

test("desktop voice host supervisor stays stopped when Desktop hosting is turned off", async () => {
  const userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "instafy-desktop-voice-disabled-"));
  const supervisor = createDesktopVoiceHostSupervisor({
    enabled: false,
    isPackaged: false,
    appPath: packageRoot,
    currentDir: path.join(packageRoot, "dist"),
    userDataDir,
    runAsElectronNode: false,
    serviceOverrides: {
      speechService: {
        scriptPath: fixtureScriptPath,
        args: ["--service", "speech-service", "--port", String(await getFreePort())],
        healthUrl: "http://127.0.0.1:1/health",
      },
      providerHost: {
        scriptPath: fixtureScriptPath,
        args: ["--service", "provider-host", "--port", String(await getFreePort())],
        healthUrl: "http://127.0.0.1:1/health",
      },
    },
  });

  const status = await supervisor.ensureRunning();

  assert.equal(status.enabled, false);
  assert.equal(status.speechService.state, "stopped");
  assert.equal(status.providerHost.state, "stopped");
  assert.equal(status.speechService.managed, false);
  assert.equal(status.providerHost.managed, false);
});

test("desktop voice host supervisor removes the managed transcription runtime and stops services", async () => {
  const userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "instafy-desktop-voice-remove-"));
  const speechPort = await getFreePort();
  const providerPort = await getFreePort();

  const supervisor = createDesktopVoiceHostSupervisor({
    enabled: false,
    isPackaged: false,
    appPath: packageRoot,
    currentDir: path.join(packageRoot, "dist"),
    userDataDir,
    runAsElectronNode: false,
    startTimeoutMs: 2_500,
    serviceOverrides: {
      speechService: {
        scriptPath: fixtureScriptPath,
        args: ["--service", "speech-service", "--port", String(speechPort)],
        healthUrl: `http://127.0.0.1:${speechPort}/health`,
      },
      providerHost: {
        scriptPath: fixtureScriptPath,
        args: ["--service", "provider-host", "--port", String(providerPort)],
        healthUrl: `http://127.0.0.1:${providerPort}/health`,
      },
    },
    bootstrapImpl: async ({ action, dryRun }) => ({
      ok: true,
      action,
      dryRun,
      commandsRun: action === "remove_transcription" ? ["rm -rf /tmp/instafy-speech-home"] : [],
      status: {
        transcription: {
          ready: false,
          installState: "needs_install",
        },
      },
    }),
  });

  const result = await supervisor.bootstrap("remove_transcription", false);

  assert.equal(result.ok, true);
  assert.equal(result.action, "remove_transcription");
  assert.deepEqual(result.commandsRun, ["rm -rf /tmp/instafy-speech-home"]);
  assert.equal(result.hostStatus.enabled, false);
  assert.equal(result.hostStatus.speechService.managed, false);
  assert.equal(result.hostStatus.providerHost.managed, false);
});
