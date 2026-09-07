import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { modulePathToImportUrl } from "./module-import-url.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(packageRoot, "release");
const { resolveVerifiedBundledRuntimeAgent } = await import(
  modulePathToImportUrl(path.join(packageRoot, "dist", "bundledRuntimeAgent.js")),
);

const EXPECTED_PERSONAL_BROWSER_CAPABILITY_CONTRACT = {
  schemaVersion: 1,
  browserTransport: "desktop-personal",
  mcpServers: [
    {
      name: "instafy_personal_browser",
      required: true,
      supportsParallelToolCalls: false,
      enabledTools: ["status", "snapshot", "navigate", "click", "type", "press", "scroll"],
    },
  ],
  projectMcpServersAllowed: false,
  localExecutionEnvironmentCount: 0,
};

function findManifests(directory, depth = 0) {
  if (depth > 8 || !fs.existsSync(directory)) return [];
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...findManifests(entryPath, depth + 1));
    } else if (entry.isFile() && entry.name === "runtime-agent-manifest.json") {
      results.push(entryPath);
    }
  }
  return results;
}

const manifests = findManifests(releaseRoot).filter((manifestPath) =>
  manifestPath.split(path.sep).includes("runtime-agent"),
);
if (manifests.length === 0) {
  throw new Error(`No packaged runtime-agent manifest found under ${releaseRoot}.`);
}

let verified = 0;
for (const manifestPath of manifests) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const expectedSourceSha = process.env.GITHUB_SHA?.trim().toLowerCase();
  if (expectedSourceSha && manifest.sourceSha !== expectedSourceSha) {
    throw new Error(
      `Packaged runtime-agent source SHA ${manifest.sourceSha ?? "missing"} does not match ${expectedSourceSha}.`,
    );
  }
  const resourcesPath = path.dirname(path.dirname(manifestPath));
  const executablePath = await resolveVerifiedBundledRuntimeAgent({ resourcesPath });
  const hostPath = path.join(path.dirname(executablePath),
    process.platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host");
  const hostProbe = spawnSync(hostPath, ["--version"], {
    encoding: "utf8", timeout: 20_000, windowsHide: true,
  });
  if (hostProbe.error || hostProbe.status !== 0 ||
      !hostProbe.stdout.trim().startsWith("codex-code-mode-host ")) {
    throw new Error("Packaged code-mode host failed its self-invocation probe.");
  }
  const probe = spawnSync(executablePath, ["--version"], {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  if (probe.error) throw probe.error;
  if (probe.status !== 0 || !probe.stdout.trim().startsWith("runtime-agent ")) {
    throw new Error(
      `Packaged runtime-agent failed its self-invocation probe (status=${probe.status ?? "signal"}).`,
    );
  }
  const capabilityProbe = spawnSync(executablePath, ["personal-browser", "capabilities"], {
    cwd: path.dirname(executablePath),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.platform === "win32" && process.env.SystemRoot
        ? { SystemRoot: process.env.SystemRoot }
        : {}),
    },
    maxBuffer: 64 * 1024,
    timeout: 20_000,
    windowsHide: true,
  });
  if (capabilityProbe.error) throw capabilityProbe.error;
  if (capabilityProbe.status !== 0) {
    throw new Error(
      `Packaged runtime-agent failed its Personal Browser capability probe (status=${
        capabilityProbe.status ?? "signal"
      }).`,
    );
  }
  let capabilityContract;
  try {
    capabilityContract = JSON.parse(capabilityProbe.stdout);
  } catch {
    throw new Error("Packaged runtime-agent returned an invalid Personal Browser capability contract.");
  }
  if (!isDeepStrictEqual(capabilityContract, EXPECTED_PERSONAL_BROWSER_CAPABILITY_CONTRACT)) {
    throw new Error("Packaged runtime-agent returned an unexpected Personal Browser capability contract.");
  }
  verified += 1;
  console.log(`[instafy-desktop] Verified packaged runtime-agent at ${executablePath}.`);
}

console.log(`[instafy-desktop] Verified ${verified} packaged runtime-agent bundle(s).`);
