import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { publishProjectSpeechRoute } from "./project-speech-route-publisher.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const DESKTOP_APP_ROOT = path.join(REPO_ROOT, "packages", "desktop-app");
const DEFAULT_DESKTOP_PUBLISH_TIMEOUT_MS = 90_000;
const CLEAN_BOOTSTRAP_DESKTOP_PUBLISH_TIMEOUT_MS = 240_000;
const DESKTOP_SPEECH_WARMUP_GRACE_MS = 180_000;
const DESKTOP_CONFIG_FILENAME = "desktop-config.json";
const STABLE_DESKTOP_VOICE_PUBLISHER_ROOT = path.join(REPO_ROOT, "tmp", "desktop-voice-publisher");
const STABLE_DESKTOP_VOICE_SPEECH_HOME = path.join(STABLE_DESKTOP_VOICE_PUBLISHER_ROOT, "speech-home");
const MANAGED_SPEECH_RUNTIME_MODULE_PATH = path.join(
  REPO_ROOT,
  "packages",
  "frontend",
  "scripts",
  "shared",
  "speech-managed-runtime.mjs",
);

function resolveElectronBinary() {
  const require = createRequire(path.join(DESKTOP_APP_ROOT, "package.json"));
  return require("electron");
}

async function resolveBundledDesktopUvInstallerPath() {
  const runtimeModule = await import(
    `${pathToFileURL(MANAGED_SPEECH_RUNTIME_MODULE_PATH).href}?desktop_voice_publisher=${Date.now()}`
  );
  const managedUvVersion =
    typeof runtimeModule.DEFAULT_MANAGED_UV_VERSION === "string"
      ? runtimeModule.DEFAULT_MANAGED_UV_VERSION.trim()
      : "";
  if (!managedUvVersion) {
    throw new Error("Could not resolve DEFAULT_MANAGED_UV_VERSION for Desktop voice publisher.");
  }
  const installerPath = path.join(
    DESKTOP_APP_ROOT,
    "dist",
    "frontend-scripts",
    "vendor",
    "uv",
    managedUvVersion,
    "install.sh",
  );
  await fs.access(installerPath);
  return installerPath;
}

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function mkdtempWithParent(prefix) {
  await fs.mkdir(path.dirname(prefix), { recursive: true });
  return await fs.mkdtemp(prefix);
}

function buildFixtureHtml(timeoutMs, requireTunnel) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Instafy Desktop Voice Tunnel Harness</title>
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
        let config = null;
        try {
          const configResponse = await fetch("/config", {
            method: "GET",
            cache: "no-store",
            credentials: "same-origin",
            headers: { accept: "application/json" },
          });
          if (!configResponse.ok) {
            throw new Error(\`Config request failed with status \${configResponse.status}.\`);
          }
          config = await configResponse.json();
        } catch (error) {
          await postReport({
            ok: false,
            error: \`Desktop voice tunnel harness could not load its config: \${
              error instanceof Error ? error.message : String(error)
            }\`,
          });
          return;
        }

        const projectId = typeof config?.projectId === "string" ? config.projectId.trim() : "";
        const controllerUrl = typeof config?.controllerUrl === "string" ? config.controllerUrl.trim() : "";
        const controllerAccessToken =
          typeof config?.controllerAccessToken === "string" ? config.controllerAccessToken.trim() : "";
        if (!projectId || !controllerUrl || !controllerAccessToken) {
          await postReport({
            ok: false,
            error: "Desktop voice tunnel harness is missing projectId, controllerUrl, or controllerAccessToken.",
          });
          return;
        }

        const deadline = Date.now() + ${timeoutMs};
        let lastHostStatus = null;
        let readyHostStatus = null;
        let tunnelStartRequested = false;
        let tunnelStartError = null;
        while (Date.now() < deadline) {
          try {
            const bridge = window.instafyDesktop;
            if (
              !bridge ||
              typeof bridge.desktopVoiceHostStatus !== "function" ||
              (${requireTunnel
                ? `typeof bridge.desktopSpeechTunnelStart !== "function" || typeof bridge.desktopSpeechTunnelStatus !== "function"`
                : "false"})
            ) {
              setStatus("Desktop bridge unavailable.");
              await new Promise((resolve) => setTimeout(resolve, 1000));
              continue;
            }

            const hostStatus = readyHostStatus ?? (await bridge.desktopVoiceHostStatus());
            lastHostStatus = hostStatus ?? null;
            setStatus({ hostStatus });
            if (!(hostStatus?.speechService?.reachable && hostStatus?.providerHost?.reachable)) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
              continue;
            }
            if (!readyHostStatus) {
              readyHostStatus = hostStatus;
            }

            if (!${requireTunnel}) {
              await postReport({
                ok: true,
                hostStatus,
                tunnelStatus: null,
              });
              return;
            }

            if (!tunnelStartRequested) {
              tunnelStartRequested = true;
              void bridge
                .desktopSpeechTunnelStart({
                  projectId,
                  controllerUrl,
                  controllerAccessToken,
                  forceRestart: false,
                  waitForReady: false,
                })
                .catch((error) => {
                  tunnelStartError = error instanceof Error ? error.message : String(error);
                });
            }

            const tunnelStatus = await bridge.desktopSpeechTunnelStatus();
            setStatus({ hostStatus, tunnelStatus });
            if (tunnelStatus?.state === "active" && tunnelStatus?.publicUrl) {
              await postReport({
                ok: true,
                hostStatus,
                tunnelStatus,
              });
              return;
            }

            if (tunnelStatus?.state === "error" && tunnelStatus?.lastError) {
              await postReport({
                ok: false,
                error: tunnelStatus.lastError,
                hostStatus,
                tunnelStatus,
              });
              return;
            }

            if (tunnelStartError) {
              await postReport({
                ok: false,
                error: tunnelStartError,
                hostStatus,
                tunnelStatus,
              });
              return;
            }
          } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        await postReport({
          ok: false,
          error: ${requireTunnel ? `"Timed out waiting for Desktop voice tunnel to become active."` : `"Timed out waiting for Desktop voice host to become ready."`},
          hostStatus: lastHostStatus,
        });
      }

      void main();
    </script>
  </body>
</html>`;
}

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function revokeTunnelGrant(input) {
  const controllerUrl = normalizeOptionalString(input?.controllerUrl);
  const controllerAccessToken = normalizeOptionalString(input?.controllerAccessToken);
  const projectId = normalizeOptionalString(input?.projectId);
  const tunnelId = normalizeOptionalString(input?.tunnelId);
  if (!controllerUrl || !controllerAccessToken || !projectId || !tunnelId) {
    return;
  }
  await fetch(
    `${controllerUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(projectId)}/tunnels/${encodeURIComponent(tunnelId)}/revoke`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${controllerAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        metadata: {
          reason: "desktop-voice-publisher:stop",
        },
      }),
    },
  ).catch(() => undefined);
}

async function revokeProjectTunnelGrants(input) {
  const controllerUrl = normalizeOptionalString(input?.controllerUrl);
  const controllerAccessToken = normalizeOptionalString(input?.controllerAccessToken);
  const projectId = normalizeOptionalString(input?.projectId);
  if (!controllerUrl || !controllerAccessToken || !projectId) {
    return;
  }
  try {
    const listResponse = await fetch(
      `${controllerUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(projectId)}/tunnels`,
      {
        headers: {
          authorization: `Bearer ${controllerAccessToken}`,
          accept: "application/json",
        },
      },
    );
    if (!listResponse.ok) {
      return;
    }
    const payload = await listResponse.json().catch(() => null);
    const grants = Array.isArray(payload?.grants) ? payload.grants : [];
    await Promise.allSettled(
      grants
        .filter((grant) => {
          const tunnelId = normalizeOptionalString(grant?.tunnelId);
          const provider = normalizeOptionalString(grant?.provider);
          const status = normalizeOptionalString(grant?.status);
          return (
            tunnelId &&
            provider === "self_hosted" &&
            status &&
            ["issuing", "active", "revoking"].includes(status)
          );
        })
        .map((grant) =>
          revokeTunnelGrant({
            controllerUrl,
            controllerAccessToken,
            projectId,
            tunnelId: grant.tunnelId,
          }),
        ),
    );
  } catch {
    // best-effort cleanup only
  }
}

export async function startDesktopVoiceHarnessServer(input) {
  let resolveReport = null;
  let rejectReport = null;
  const reportPromise = new Promise((resolve, reject) => {
    resolveReport = resolve;
    rejectReport = reject;
  });

  const html = buildFixtureHtml(
    input.publishTimeoutMs ?? DEFAULT_DESKTOP_PUBLISH_TIMEOUT_MS,
    input.requireTunnel !== false,
  );
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const expectedHost = `127.0.0.1:${port}`;
  const noStoreHeaders = {
    "cache-control": "no-store, max-age=0",
    pragma: "no-cache",
  };
  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.host !== expectedHost) {
        response.writeHead(421, noStoreHeaders);
        response.end("misdirected request");
        return;
      }

      const url = new URL(request.url ?? "/", origin);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/studio")) {
        if (url.pathname !== "/studio") {
          response.writeHead(302, { ...noStoreHeaders, location: "/studio" });
          response.end();
          return;
        }
        response.writeHead(200, {
          ...noStoreHeaders,
          "content-type": "text/html; charset=utf-8",
          "referrer-policy": "no-referrer",
        });
        response.end(html);
        return;
      }

      if (request.method === "GET" && url.pathname === "/config") {
        response.writeHead(200, {
          ...noStoreHeaders,
          "content-type": "application/json; charset=utf-8",
          "cross-origin-resource-policy": "same-origin",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        });
        response.end(
          JSON.stringify({
            projectId: input.projectId,
            controllerUrl: input.controllerUrl,
            controllerAccessToken: input.controllerAccessToken,
          }),
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/report") {
        const chunks = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(204);
        response.end();
        resolveReport?.(payload);
        return;
      }

      response.writeHead(404);
      response.end("not found");
    } catch (error) {
      response.writeHead(500);
      response.end("error");
      rejectReport?.(error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    appUrl: `${origin}/studio`,
    reportPromise,
    close: async () => {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function stopChild(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
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

async function waitForSpeechServiceReady(healthUrl, timeoutMs = 60_000) {
  let deadline = Date.now() + timeoutMs;
  let lastPayload = null;
  let lastStatusCode = null;
  let extendedForWarmup = false;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        headers: {
          "cache-control": "no-store",
        },
      });
      lastStatusCode = response.status;
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        lastPayload = payload;
        const transcriptionReady = payload?.transcription?.ready === true;
        const synthesisReady = payload?.synthesis?.ready === true;
        if (transcriptionReady && synthesisReady) {
          return payload;
        }
        const transcriptionWarming =
          payload?.transcription?.warming === true &&
          (typeof payload?.transcription?.lastError !== "string" ||
            payload.transcription.lastError.trim().length === 0);
        if (transcriptionWarming && !extendedForWarmup) {
          deadline = Math.max(deadline, Date.now() + DESKTOP_SPEECH_WARMUP_GRACE_MS);
          extendedForWarmup = true;
        }
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Timed out waiting for Desktop speech service readiness at ${healthUrl}${
      typeof lastStatusCode === "number" ? ` (last status ${lastStatusCode})` : ""
    }${lastPayload ? `: ${JSON.stringify(lastPayload)}` : ""}`,
  );
}

async function writeDesktopConfig(userDataDir, config) {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(
    path.join(userDataDir, DESKTOP_CONFIG_FILENAME),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

function attachLogs(child, prefix = "[desktop-voice-publisher][electron]") {
  child.stdout.on("data", (chunk) => {
    process.stdout.write(`${prefix} ${chunk.toString("utf8")}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`${prefix} ${chunk.toString("utf8")}`);
  });
}

export async function launchDesktopVoicePublisher(input) {
  const requireTunnel = input.requireTunnel !== false;
  const bootstrapClean = input.bootstrapClean === true;
  const publishTimeoutMs = bootstrapClean
    ? CLEAN_BOOTSTRAP_DESKTOP_PUBLISH_TIMEOUT_MS
    : DEFAULT_DESKTOP_PUBLISH_TIMEOUT_MS;
  const managedSpeechHome = STABLE_DESKTOP_VOICE_SPEECH_HOME;
  await fs.mkdir(STABLE_DESKTOP_VOICE_PUBLISHER_ROOT, { recursive: true });
  if (bootstrapClean) {
    await fs.rm(managedSpeechHome, { recursive: true, force: true }).catch(() => undefined);
  }
  let bundledUvInstallerPath = null;
  try {
    bundledUvInstallerPath = await resolveBundledDesktopUvInstallerPath();
  } catch {
    bundledUvInstallerPath = null;
  }
  const harnessServer = await startDesktopVoiceHarnessServer({
    ...input,
    publishTimeoutMs,
    requireTunnel,
  });
  const userDataDir = await mkdtempWithParent(path.join(os.tmpdir(), "instafy-desktop-voice-publisher-"));
  const speechPort = await getFreePort();
  const providerPort = await getFreePort();
  await writeDesktopConfig(userDataDir, {
    desktopVoiceHostEnabled: true,
  });
  const child = spawn(resolveElectronBinary(), [DESKTOP_APP_ROOT, "--allow-multiple-instances"], {
    cwd: DESKTOP_APP_ROOT,
    env: {
      ...process.env,
      INSTAFY_APP_URL: harnessServer.appUrl,
      INSTAFY_DESKTOP_ALLOW_MULTIPLE_INSTANCES: "1",
      INSTAFY_DESKTOP_USER_DATA_DIR: userDataDir,
      ...(bundledUvInstallerPath ? { INSTAFY_SPEECH_BUNDLED_UV_INSTALLER_PATH: bundledUvInstallerPath } : {}),
      ...(managedSpeechHome ? { INSTAFY_SPEECH_HOST_HOME: managedSpeechHome } : {}),
      LOCAL_SPEECH_PORT: String(speechPort),
      LOCAL_PROVIDER_HOST_PORT: String(providerPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  attachLogs(child);

  const exitPromise = new Promise((_, reject) => {
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `Desktop app exited before voice tunnel publisher completed${typeof code === "number" ? ` (code ${code})` : ""}${signal ? ` (${signal})` : ""}.`,
        ),
      );
    });
    child.once("error", reject);
  });

  let report;
  const cleanupPublishedTunnel = async () => {
    await revokeTunnelGrant({
      controllerUrl: input.controllerUrl,
      controllerAccessToken: input.controllerAccessToken,
      projectId: input.projectId,
      tunnelId: report?.tunnelStatus?.tunnelId,
    });
    await revokeProjectTunnelGrants({
      controllerUrl: input.controllerUrl,
      controllerAccessToken: input.controllerAccessToken,
      projectId: input.projectId,
    });
  };
  try {
    report = await Promise.race([
      harnessServer.reportPromise,
      exitPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for Desktop voice tunnel publisher.")), publishTimeoutMs),
      ),
    ]);
  } catch (error) {
    await stopChild(child).catch(() => undefined);
    await cleanupPublishedTunnel().catch(() => undefined);
    await harnessServer.close().catch(() => undefined);
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  if (!report.ok || !report.hostStatus?.speechService?.healthUrl || !report.hostStatus?.providerHost?.healthUrl) {
    await stopChild(child).catch(() => undefined);
    await cleanupPublishedTunnel().catch(() => undefined);
    await harnessServer.close().catch(() => undefined);
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(report.error?.trim() || "Desktop voice tunnel publisher did not return a healthy host report.");
  }

  const publicUrl = report.tunnelStatus?.publicUrl?.trim() || null;
  if (requireTunnel && !publicUrl) {
    await stopChild(child).catch(() => undefined);
    await cleanupPublishedTunnel().catch(() => undefined);
    await harnessServer.close().catch(() => undefined);
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(report.error?.trim() || "Desktop voice tunnel publisher did not return a public URL.");
  }

  if (!requireTunnel) {
    await waitForSpeechServiceReady(
      report.hostStatus.speechService.healthUrl,
      publishTimeoutMs,
    );
  }

  return {
    projectId: input.projectId,
    publicUrl,
    lanBaseUrl:
      normalizeOptionalString(report.hostStatus?.lan?.baseUrl),
    lanAuthToken:
      normalizeOptionalString(report.hostStatus?.lan?.authToken),
    speechAuthToken:
      normalizeOptionalString(report.hostStatus?.speechAuthToken) ??
      normalizeOptionalString(report.hostStatus?.lan?.authToken),
    hostname:
      normalizeOptionalString(report.tunnelStatus?.hostname),
    speechServiceHealthUrl: report.hostStatus.speechService.healthUrl,
    providerHostHealthUrl: report.hostStatus.providerHost.healthUrl,
    stop: async () => {
      await stopChild(child).catch(() => undefined);
      await cleanupPublishedTunnel().catch(() => undefined);
      await harnessServer.close().catch(() => undefined);
      await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export async function publishDesktopSpeechRoute(input) {
  const speechAuthToken =
    normalizeOptionalString(input.speechAuthToken) ??
    normalizeOptionalString(input.lanAuthToken);
  const lanBaseUrl =
    typeof input.publishedLanBaseUrl === "string" && input.publishedLanBaseUrl.trim().length > 0
      ? input.publishedLanBaseUrl
      : input.lanBaseUrl;
  const tunnelBaseUrl =
    typeof input.publicUrl === "string" && input.publicUrl.trim().length > 0
      ? input.publicUrl
      : typeof input.tunnelFallbackUrl === "string" && input.tunnelFallbackUrl.trim().length > 0
        ? input.tunnelFallbackUrl
        : null;
  await publishProjectSpeechRoute({
    controllerUrl: input.controllerUrl,
    controllerAccessToken: input.controllerAccessToken,
    projectId: input.projectId,
    routes: [
      lanBaseUrl
        ? {
            baseUrl: lanBaseUrl,
            authToken: speechAuthToken,
            hostMode: "desktop",
            connectionType: "lan",
          }
        : null,
      tunnelBaseUrl
        ? {
            baseUrl: tunnelBaseUrl,
            authToken: speechAuthToken,
            hostMode: "desktop",
            connectionType: "tunnel",
          }
        : null,
    ].filter(Boolean),
  });
}
