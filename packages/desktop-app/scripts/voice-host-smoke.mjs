import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MANAGED_UV_VERSION,
  resolveManagedSpeechToolchainStatus,
  resolveManagedUvInstallerArtifact,
} from "../../frontend/scripts/shared/speech-managed-runtime.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const START_TIMEOUT_MS = 90_000;
const CLEAN_BOOTSTRAP_TIMEOUT_MS = 420_000;
const DESKTOP_CONFIG_FILENAME = "desktop-config.json";
const managedUvInstallerArtifact = resolveManagedUvInstallerArtifact(
  DEFAULT_MANAGED_UV_VERSION,
  process.platform,
);

function printStep(label, payload) {
  process.stdout.write(`\n[desktop-voice-host-smoke] ${label}\n`);
  if (payload !== undefined) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
}

function resolveElectronBinary() {
  return require("electron");
}

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

function createFixtureHtml({ bootstrapIfNeeded = false } = {}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Instafy Desktop Voice Host Smoke</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <pre id="status">starting</pre>
    <script>
      const statusEl = document.getElementById("status");

      function setStatus(value) {
        statusEl.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      }

      async function postReport(payload) {
        await fetch("/report", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      }

      async function main() {
        const deadline = Date.now() + ${bootstrapIfNeeded ? CLEAN_BOOTSTRAP_TIMEOUT_MS : START_TIMEOUT_MS};
        let lastStatus = null;
        let lastError = null;
        while (Date.now() < deadline) {
          try {
            const bridge = window.instafyDesktop;
            if (!bridge || typeof bridge.desktopVoiceHostStatus !== "function") {
              lastError = "Desktop bridge unavailable in renderer.";
              setStatus(lastError);
            } else {
              const status = await bridge.desktopVoiceHostStatus();
              lastStatus = status ?? null;
              setStatus(status ?? { error: "empty status" });
              if (status?.speechService?.reachable && status?.providerHost?.reachable) {
                await postReport({ ok: true, status });
                return;
              }
            }
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            setStatus({ error: lastError, status: lastStatus });
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        await postReport({
          ok: false,
          error: lastError ?? "Timed out waiting for Desktop voice host to become healthy.",
          status: lastStatus,
        });
      }

      void main();
    </script>
  </body>
</html>`;
}

async function startFixtureServer({ bootstrapIfNeeded = false } = {}) {
  const html = createFixtureHtml({ bootstrapIfNeeded });
  let reportResolver = null;
  let reportRejecter = null;
  const reportPromise = new Promise((resolve, reject) => {
    reportResolver = resolve;
    reportRejecter = reject;
  });

  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && (request.url === "/" || request.url === "/studio")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }

      if (request.method === "POST" && request.url === "/report") {
        const chunks = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(204);
        response.end();
        reportResolver?.(payload);
        return;
      }

      response.writeHead(404);
      response.end("not found");
    } catch (error) {
      response.writeHead(500);
      response.end("error");
      reportRejecter?.(error);
    }
  });

  const port = await getFreePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    appUrl: `http://127.0.0.1:${port}/studio`,
    reportPromise,
    close: async () => {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function attachChildLogs(child) {
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[desktop-voice-host-smoke][electron] ${chunk.toString("utf8")}`);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[desktop-voice-host-smoke][electron] ${chunk.toString("utf8")}`);
  });
}

async function waitForHealthOk(url, timeoutMs = 20_000, predicate = () => true) {
  const deadline = Date.now() + timeoutMs;
  let lastPayload = null;
  let lastStatusCode = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      lastStatusCode = response.status;
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        lastPayload = payload;
        if (predicate(payload)) {
          return payload;
        }
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for ${url}${typeof lastStatusCode === "number" ? ` (last status ${lastStatusCode})` : ""}${lastPayload ? `: ${JSON.stringify(lastPayload)}` : ""}`,
  );
}

async function waitForManagedRuntimeStatus(env, timeoutMs = 20_000, predicate = () => true) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    lastStatus = await resolveManagedSpeechToolchainStatus(env);
    if (predicate(lastStatus)) {
      return lastStatus;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Timed out waiting for managed speech runtime readiness: ${JSON.stringify({
      home: lastStatus?.home ?? null,
      uvCacheDir: lastStatus?.uvCacheDir ?? null,
      modelCacheDir: lastStatus?.huggingfaceHubCache ?? null,
      modelCacheReady: lastStatus?.modelCacheReady ?? null,
    })}`,
  );
}

async function terminatePid(pid) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

async function stopChild(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timeout = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      finish();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      finish();
    });
    child.kill("SIGTERM");
  });
}

async function writeDesktopConfig(userDataDir, config) {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(
    path.join(userDataDir, DESKTOP_CONFIG_FILENAME),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

async function main() {
  if (!managedUvInstallerArtifact) {
    throw new Error(
      `Managed uv ${DEFAULT_MANAGED_UV_VERSION} has no installer trust anchor for ${process.platform}.`,
    );
  }
  const bootstrapIfNeeded = process.argv.includes("--bootstrap-clean");
  const fixtureServer = await startFixtureServer({ bootstrapIfNeeded });
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "instafy-desktop-voice-host-smoke-"));
  const managedSpeechHome = path.join(userDataDir, "speech-host");
  const speechPort = await getFreePort();
  const providerPort = await getFreePort();
  const electronBinary = resolveElectronBinary();
  await writeDesktopConfig(userDataDir, {
    desktopVoiceHostEnabled: true,
  });
  const env = {
    ...process.env,
    INSTAFY_APP_URL: fixtureServer.appUrl,
    INSTAFY_DESKTOP_ALLOW_MULTIPLE_INSTANCES: "1",
    INSTAFY_DESKTOP_USER_DATA_DIR: userDataDir,
    INSTAFY_SPEECH_BUNDLED_UV_INSTALLER_PATH: path.join(
      packageRoot,
      "dist",
      "frontend-scripts",
      "vendor",
      "uv",
      DEFAULT_MANAGED_UV_VERSION,
      managedUvInstallerArtifact.fileName,
    ),
    INSTAFY_SPEECH_HOST_HOME: managedSpeechHome,
    LOCAL_SPEECH_PORT: String(speechPort),
    LOCAL_PROVIDER_HOST_PORT: String(providerPort),
    LOCAL_SPEECH_MANAGED_RUNTIME_ONLY: bootstrapIfNeeded ? "1" : process.env.LOCAL_SPEECH_MANAGED_RUNTIME_ONLY,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronBinary, [packageRoot, "--allow-multiple-instances"], {
    cwd: packageRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  attachChildLogs(child);

  const exitPromise = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => {
      if (typeof code === "number" && code === 0) {
        resolve({ code, signal });
        return;
      }
      reject(
        new Error(
          `Desktop app exited before voice host smoke completed${typeof code === "number" ? ` (code ${code})` : ""}${signal ? ` (${signal})` : ""}.`,
        ),
      );
    });
    child.once("error", reject);
  });

  let reportedStatus = null;
  try {
    const report = await Promise.race([
      fixtureServer.reportPromise,
      exitPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for desktop voice host report.")), START_TIMEOUT_MS),
      ),
    ]);

    if (!report || typeof report !== "object") {
      throw new Error("Desktop voice host smoke did not receive a valid report.");
    }
    if (report.ok !== true || !report.status) {
      throw new Error(
        typeof report.error === "string" && report.error.trim().length > 0
          ? report.error.trim()
          : "Desktop voice host did not become healthy.",
      );
    }

    reportedStatus = report.status;
    const speechHealth = await waitForHealthOk(
      report.status.speechService?.healthUrl,
      bootstrapIfNeeded ? CLEAN_BOOTSTRAP_TIMEOUT_MS : START_TIMEOUT_MS,
      (payload) =>
        bootstrapIfNeeded
          ? payload?.ok === true
          : payload?.transcription?.ready === true,
    );
    const providerHealth = await waitForHealthOk(report.status.providerHost?.healthUrl);
    const managedRuntimeEnv = {
      ...process.env,
      INSTAFY_SPEECH_HOST_HOME: managedSpeechHome,
    };
    const managedRuntimeStatus = bootstrapIfNeeded
      ? await waitForManagedRuntimeStatus(
          managedRuntimeEnv,
          CLEAN_BOOTSTRAP_TIMEOUT_MS,
          (status) => status.modelCacheReady === true,
        )
      : await resolveManagedSpeechToolchainStatus(managedRuntimeEnv);
    if (!bootstrapIfNeeded && !managedRuntimeStatus.modelCacheReady) {
      throw new Error(
        `Desktop voice host warmup completed without populating the managed model cache at ${managedRuntimeStatus.huggingfaceHubCache}.`,
      );
    }
    const finalSpeechHealth =
      bootstrapIfNeeded
        ? await waitForHealthOk(report.status.speechService?.healthUrl)
        : speechHealth;
    if (finalSpeechHealth?.transcription?.lastError) {
      throw new Error(finalSpeechHealth.transcription.lastError);
    }

    printStep("desktop-voice-host", {
      bootstrapIfNeeded,
      managedSpeechHome,
      speechService: {
        state: report.status.speechService?.state ?? null,
        healthUrl: report.status.speechService?.healthUrl ?? null,
        pid: report.status.speechService?.pid ?? null,
      },
      providerHost: {
        state: report.status.providerHost?.state ?? null,
        healthUrl: report.status.providerHost?.healthUrl ?? null,
        pid: report.status.providerHost?.pid ?? null,
      },
    });
    printStep("speech-health", finalSpeechHealth);
    printStep("provider-health", providerHealth);
    printStep("managed-runtime", {
      home: managedRuntimeStatus.home,
      uvCacheDir: managedRuntimeStatus.uvCacheDir,
      modelCacheDir: managedRuntimeStatus.huggingfaceHubCache,
      modelCacheReady: managedRuntimeStatus.modelCacheReady,
    });

    process.stdout.write("\n[desktop-voice-host-smoke] PASS\n");
  } finally {
    await stopChild(child).catch(() => undefined);
    await terminatePid(reportedStatus?.speechService?.pid).catch(() => undefined);
    await terminatePid(reportedStatus?.providerHost?.pid).catch(() => undefined);
    await fixtureServer.close().catch(() => undefined);
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(
    `\n[desktop-voice-host-smoke] FAIL ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
