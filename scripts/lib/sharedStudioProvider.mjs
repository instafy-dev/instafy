import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER_ID = "instafy-cloud";
const MAX_REQUEST_BYTES = 256 * 1024;
const FIXED_RUNTIME_ROOT = "/tmp/instafy";
const FIXED_BROWSER_DIR = path.join(FIXED_RUNTIME_ROOT, "playwright");
const CHROMIUM_PID_FILE = path.join(FIXED_BROWSER_DIR, "chromium.pid");
const CDP_PORT = 9223;
const EGRESS_PROXY_PORT = 9226;
const GRACEFUL_STOP_MS = 15_000;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const RUNTIME_DIAGNOSTIC_PATTERNS = [
  ["bootstrap-started", "runtime-agent bootstrap starting"],
  ["configuration-loaded", "runtime agent configuration loaded"],
  ["configuration-failed", "failed to load configuration"],
  ["runtime-registered", "registered runtime"],
  ["runtime-registration-failed", "failed to register runtime"],
  ["profile-restored", "restored browser profile baseline"],
  ["profile-restore-failed", "browser profile restore failed"],
  ["chromium-launch-failed", "failed to launch Chromium after profile restore"],
  ["chromium-cdp-ready", "Headed Chromium ready (CDP)"],
  ["chromium-cdp-not-ready", "Headed Chromium did not become ready"],
  ["chromium-executable-missing", "no Chromium executable found"],
  ["origin-listening", "origin HTTP server listening"],
  ["origin-registration-failed", "origin registration failed; stopping origin server"],
  ["registration-loop-failed", "registration loop failed; retrying after delay"],
  ["agent-task-failed", "runtime agent terminated with error"],
];

// Also embedded in the trusted guardian. It drains output but exports only a
// closed set of observations: never log text, tokens or paths.
export function runtimeDiagnosticCollector(report, patterns = RUNTIME_DIAGNOSTIC_PATTERNS) {
  const seen = new Set();
  let tail = "", bytes = 0;
  const emit = category => { if (!seen.has(category)) { seen.add(category); report(category); } };
  return chunk => {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) { tail = ""; emit("diagnostic-limit-reached"); return; }
    for (let offset = 0; offset < chunk.length; offset += 4096) {
      const text = tail + chunk.subarray(offset, offset + 4096).toString("utf8");
      for (const [category, indicator] of patterns) if (text.includes(indicator)) emit(category);
      tail = text.slice(-256);
    }
  };
}

// Keep a live, trusted process-group leader until every runtime helper is
// killed. This avoids ever signaling a negative PID after the original group
// leader exited and its numeric PID could have been recycled.
const RUNTIME_GUARDIAN = String.raw`
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const command = process.argv[1];
let stopping = false;
let agentExited = false;
let agentStartTicks = null;
let cleanupTimer = null;
let agent = null;
const send = message => { if (process.connected) process.send(message, () => {}); };
const linuxStartTicks = pid => {
  if (process.platform !== "linux") return null;
  try {
    const raw = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/);
    return fields[19] || null;
  } catch { return null; }
};
const killOwnedGroup = () => {
  clearTimeout(cleanupTimer);
  try { process.kill(-process.pid, "SIGKILL"); }
  catch { process.exit(70); }
};
const signalAgent = () => {
  if (agentExited) return;
  if (!agent) { killOwnedGroup(); return; }
  if (process.platform === "linux" && (!agentStartTicks || linuxStartTicks(agent.pid) !== agentStartTicks)) {
    send({ cleanupFailed: true });
    killOwnedGroup();
    return;
  }
  try { agent.kill("SIGTERM"); }
  catch { killOwnedGroup(); }
};
const stop = () => {
  if (stopping) return;
  stopping = true;
  signalAgent();
  if (agentExited) killOwnedGroup();
  else cleanupTimer = setTimeout(killOwnedGroup, ${GRACEFUL_STOP_MS});
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("disconnect", stop);
process.on("message", message => { if (message?.stop === true) stop(); });
agent = spawn(command, [], { stdio: ["ignore", "pipe", "pipe"] });
const collect = (${runtimeDiagnosticCollector.toString()})(category => send({ diagnostic: category }), ${JSON.stringify(RUNTIME_DIAGNOSTIC_PATTERNS)});
agent.stdout.on("data", collect);
agent.stderr.on("data", collect);
agent.once("spawn", () => {
  agentStartTicks = linuxStartTicks(agent.pid);
  send({ agentStarted: true, agentPid: agent.pid });
});
agent.once("error", () => { send({ agentLaunchFailed: true }); killOwnedGroup(); });
agent.once("exit", code => {
  agentExited = true;
  send({ agentExited: true, exitCode: Number.isInteger(code) && code >= 0 && code <= 255 ? code : null });
  killOwnedGroup();
});
setInterval(() => {}, 1000);
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// This is the controller/provider-core allowlist, not a list of variables that
// are blindly copied into the process. Keeping the validation boundary here
// catches a controller regression that accidentally forwards process-launch
// authority to the external provider fixture.
const MANAGED_ENV_KEYS = new Set([
  "RUNTIME_CPU_LIMIT",
  "RUNTIME_MEMORY_LIMIT",
  "ORIGIN_GIT_REMOTE_URL",
  "INSTAFY_ENABLE_BROWSER_SESSION",
  "INSTAFY_BROWSER_VIEWPORT_ONLY",
  "INSTAFY_BROWSER_RENDER_SCALE",
  "INSTAFY_BROWSER_MAX_FRAMEBUFFER_PIXELS",
  "INSTAFY_BROWSER_CDP_SCREENCAST",
  "INSTAFY_BROWSER_WEBRTC_ENABLED",
  "INSTAFY_BROWSER_PREFERRED_VIEWER",
  "INSTAFY_BROWSER_DISPLAY",
  "INSTAFY_VNC_HOST",
  "INSTAFY_VNC_PORT",
  "INSTAFY_VNC_GEOMETRY",
  "INSTAFY_VNC_DEPTH",
  "INSTAFY_BROWSER_PROFILE_PERSIST",
  "INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS",
  "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON",
  "INSTAFY_BROWSER_WEBRTC_SENDER_URL",
  "INSTAFY_BROWSER_WEBRTC_BIND",
  "INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN",
  "INSTAFY_BROWSER_WEBRTC_FPS",
  "INSTAFY_BROWSER_WEBRTC_BITRATE_KBPS",
  "INSTAFY_BROWSER_EGRESS_ISOLATION",
  "INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV",
  "INSTAFY_BROWSER_EGRESS_PROXY_BIND",
  "INSTAFY_BROWSER_EGRESS_ALLOWED_PORTS",
  "INSTAFY_BROWSER_EGRESS_MAX_CONNECTIONS",
]);

const BASE_ENV_KEYS = [
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
];

class ProviderRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requestError(status, message) {
  throw new ProviderRequestError(status, message);
}

function requireUuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) {
    requestError(400, `${label} must be a UUID`);
  }
  return value.toLowerCase();
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    requestError(400, `${label} must be an object`);
  }
  return value;
}

function validateControllerUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("controllerURL must be an absolute URL");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("controllerURL must be a credential-free literal-loopback HTTP origin");
  }
  return url.origin;
}

async function requireExecutable(file, label) {
  if (!path.isAbsolute(file)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new Error(`${label} must be a non-symlink executable file`);
  }
  return realpath(file);
}

async function executableFileIdentity(file) {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat({ bigint: true });
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    return Object.freeze({
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      size: stat.size.toString(),
      modified: stat.mtimeNs.toString(),
      elf: bytesRead === 4 && magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
    });
  } finally {
    await handle?.close();
  }
}

function executableIdentityMatches(left, right) {
  return left.device === right.device && left.inode === right.inode &&
    left.size === right.size && left.modified === right.modified;
}

async function requireOwnedDirectory(directory, label) {
  if (!path.isAbsolute(directory)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  return realpath(directory);
}

function pathIsWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function safeRuntimeView(runtime) {
  if (!runtime) return null;
  return Object.freeze({
    id: runtime.id,
    runtimeId: runtime.id,
    leaseId: runtime.leaseId,
    projectId: runtime.projectId,
    originId: runtime.originId,
    originPort: runtime.originPort,
    originUrl: runtime.originUrl,
    cdpPort: CDP_PORT,
    profileDir: runtime.profileDir,
    pid: runtime.pid,
    status: runtime.status,
  });
}

async function resolveTrustedPlaywright() {
  const repository = await realpath(REPOSITORY_ROOT);
  const frontendRequire = createRequire(path.join(repository, "packages/frontend/package.json"));
  let testPackage;
  try {
    testPackage = frontendRequire.resolve("@playwright/test/package.json");
  } catch {
    throw new Error("the frontend Playwright dependency is required for the Shared Studio fixture");
  }
  const packageRequire = createRequire(testPackage);
  let packageJson;
  try {
    packageJson = packageRequire.resolve("playwright/package.json");
  } catch {
    throw new Error("the Playwright runtime package is required for the Shared Studio fixture");
  }
  const modulePath = await realpath(path.dirname(packageJson));
  const trustedRoot = await realpath(path.dirname(modulePath));
  if (!pathIsWithin(repository, modulePath) || path.relative(trustedRoot, modulePath) !== "playwright") {
    throw new Error("the Shared Studio fixture requires the checkout-installed Playwright package");
  }
  return Object.freeze({ modulePath, trustedRoot });
}

function bearerMatches(header, expected) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      requestError(413, "provider request is too large");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    requestError(400, "provider request must be valid JSON");
  }
}

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  if (!Number.isInteger(port) || port < 1) throw new Error("failed to reserve an origin port");
  return port;
}

async function requireLoopbackPortAvailable(port, label) {
  const server = createTcpServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
    });
  } catch (error) {
    throw new Error(`${label} port ${port} is not exclusively available on loopback`, { cause: error });
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
  }
}

function parseLinuxProcessStat(raw, label) {
  const end = raw.lastIndexOf(")");
  if (end < 0) throw new Error(`${label} has an invalid Linux process record`);
  const fields = raw.slice(end + 1).trim().split(/\s+/);
  const processGroup = Number(fields[2]);
  const startTicks = Number(fields[19]);
  if (!fields[0] || !Number.isSafeInteger(processGroup) || !Number.isSafeInteger(startTicks)) {
    throw new Error(`${label} has an invalid Linux process identity`);
  }
  return Object.freeze({ state: fields[0], processGroup, startTicks });
}

async function linuxProcessIdentity(pid, label) {
  let stat;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    throw new Error(`${label} is not an inspectable live Linux process`, { cause: error });
  }
  const identity = parseLinuxProcessStat(stat, label);
  if (identity.state === "Z") throw new Error(`${label} is a zombie process`);
  return identity;
}

async function readOwnedChromiumPid() {
  let handle;
  try {
    handle = await open(CHROMIUM_PID_FILE, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("Chromium PID file is not an owned regular file");
    }
    const raw = (await handle.readFile("utf8")).trim();
    if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) <= 1 || !Number.isSafeInteger(Number(raw))) {
      throw new Error("Chromium PID file is invalid");
    }
    return Number(raw);
  } catch (error) {
    if (error?.message?.startsWith("Chromium PID file")) throw error;
    throw new Error("Chromium PID file is unavailable or unsafe", { cause: error });
  } finally {
    await handle?.close();
  }
}

export async function fixedBrowserDirectoryIsOwned(fixedRoot, providerRoot) {
  if (!path.isAbsolute(fixedRoot) || !path.isAbsolute(providerRoot)) return false;
  let marker;
  try {
    const [canonicalProviderRoot, rootStat, browserStat] = await Promise.all([
      realpath(providerRoot),
      lstat(fixedRoot),
      lstat(path.join(fixedRoot, "playwright")),
    ]);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (
      !rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      !browserStat.isDirectory() || browserStat.isSymbolicLink() ||
      (uid !== null && (rootStat.uid !== uid || browserStat.uid !== uid))
    ) return false;
    marker = await open(
      path.join(fixedRoot, "studio-e2e-owner.json"),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const markerStat = await marker.stat();
    if (
      !markerStat.isFile() || markerStat.nlink !== 1 || markerStat.size < 2 ||
      markerStat.size > 4_096 || (markerStat.mode & 0o777) !== 0o600 ||
      (uid !== null && markerStat.uid !== uid)
    ) return false;
    const owner = JSON.parse(await marker.readFile("utf8"));
    if (
      !owner || typeof owner !== "object" || Array.isArray(owner) ||
      Object.keys(owner).sort().join(",") !== "root,runId" ||
      typeof owner.runId !== "string" || !UUID.test(owner.runId) ||
      typeof owner.root !== "string" || !path.isAbsolute(owner.root)
    ) return false;
    return await realpath(owner.root) === canonicalProviderRoot;
  } catch {
    return false;
  } finally {
    await marker?.close();
  }
}

export async function clearOwnedBrowserBookkeeping(fixedRoot, providerRoot) {
  if (!(await fixedBrowserDirectoryIsOwned(fixedRoot, providerRoot))) return false;
  await Promise.all([
    rm(path.join(fixedRoot, "playwright", "chromium.pid"), { force: true }),
    rm(path.join(fixedRoot, "playwright", "browser-egress-proxy.pid"), { force: true }),
  ]);
  return true;
}

function validateEnsurePayload(payload, expectedProjectId, stage = () => {}) {
  stage("identity");
  requirePlainObject(payload, "provider request");
  const projectId = requireUuid(payload.project_id, "project_id");
  const runtimeId = requireUuid(payload.runtime_id, "runtime_id");
  const leaseId = requireUuid(payload.lease_id, "lease_id");
  const originId = requireUuid(payload.origin_instance_id, "origin_instance_id");
  if (!expectedProjectId) requestError(503, "fixture project is not configured");
  if (projectId !== expectedProjectId) requestError(409, "provider project mismatch");
  if (payload.provider !== PROVIDER_ID) requestError(409, "provider identity mismatch");
  if (
    typeof payload.runtime_token !== "string" ||
    payload.runtime_token.length < 32 ||
    payload.runtime_token.length > 16 * 1024
  ) {
    requestError(400, "runtime token is missing or invalid");
  }
  if (payload.origin_mode !== "hosted") requestError(400, "hosted origin mode is required");
  if (
    !Array.isArray(payload.origin_protocols) ||
    payload.origin_protocols.length !== 1 ||
    payload.origin_protocols[0] !== "http"
  ) {
    requestError(400, "exact HTTP origin protocol is required");
  }

  stage("metadata");
  const metadata = requirePlainObject(payload.metadata, "managed runtime metadata");
  const allowedTopLevel = new Set([
    "runtimeFlavor",
    "source",
    "runtimeImagePreset",
    "sizeId",
    "env",
    "_instafyManagedRuntimeLaunch",
  ]);
  for (const key of Object.keys(metadata)) {
    if (!allowedTopLevel.has(key)) requestError(400, "unexpected managed runtime metadata");
  }
  if (metadata.runtimeFlavor !== "webdev") requestError(409, "managed webdev flavor is required");
  stage("attestation");
  const attestation = requirePlainObject(
    metadata._instafyManagedRuntimeLaunch,
    "managed runtime launch attestation",
  );
  if (
    attestation.version !== 1 ||
    attestation.flavor !== "webdev" ||
    attestation.generation !== leaseId
  ) {
    requestError(409, "managed runtime generation is not attested");
  }

  stage("managed-environment");
  const managedEnv = requirePlainObject(metadata.env, "managed runtime environment");
  for (const [key, value] of Object.entries(managedEnv)) {
    if (!MANAGED_ENV_KEYS.has(key) || typeof value !== "string") {
      requestError(400, "unexpected managed runtime environment");
    }
  }
  stage("browser-policy");
  for (const [key, expected] of [
    ["INSTAFY_ENABLE_BROWSER_SESSION", "1"],
    ["INSTAFY_BROWSER_VIEWPORT_ONLY", "1"],
    ["INSTAFY_BROWSER_CDP_SCREENCAST", "1"],
    ["INSTAFY_BROWSER_PROFILE_PERSIST", "1"],
    // This value describes the managed runtime image. The native allocator
    // maps it to its independently owned xvfb-run DISPLAY at process launch.
    ["INSTAFY_BROWSER_DISPLAY", ":1"],
  ]) {
    if (managedEnv[key] !== expected) requestError(409, `${key} is not controller-authorized`);
  }
  if (managedEnv.INSTAFY_BROWSER_WEBRTC_ENABLED === "1") {
    requestError(409, "native fixture supports the CDP screencast transport only");
  }
  stage("snapshot-policy");
  const snapshotSeconds = Number(managedEnv.INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS);
  if (!Number.isInteger(snapshotSeconds) || snapshotSeconds < 5 || snapshotSeconds > 3600) {
    requestError(409, "browser profile snapshot interval is invalid");
  }
  stage("validated");
  return { projectId, runtimeId, leaseId, originId, metadata, managedEnv };
}

async function waitForExit(runtime, timeoutMs) {
  if (runtime.exitSettled) return runtime.exitResult;
  let timer;
  try {
    return await Promise.race([
      runtime.exitPromise,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function linuxProcessGroupHasLiveMembers(processGroup) {
  const entries = await readdir("/proc", { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) continue;
    try {
      const identity = parseLinuxProcessStat(
        await readFile(`/proc/${entry.name}/stat`, "utf8"),
        "owned runtime process",
      );
      if (identity.processGroup === processGroup && identity.state !== "Z") return true;
    } catch (error) {
      if (!new Set(["ENOENT", "ESRCH"]).has(error?.code)) throw error;
    }
  }
  return false;
}

async function waitForRuntimeCleanup(runtime, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let groupEmpty = true;
    let cdpReleased = false;
    let egressReleased = false;
    if (process.platform === "linux") {
      groupEmpty = !(await linuxProcessGroupHasLiveMembers(runtime.guardianPid));
    }
    try {
      await requireLoopbackPortAvailable(CDP_PORT, "Chromium CDP");
      cdpReleased = true;
    } catch {}
    try {
      await requireLoopbackPortAvailable(EGRESS_PROXY_PORT, "browser egress proxy");
      egressReleased = true;
    } catch {}
    if (groupEmpty && cdpReleased && egressReleased) {
      // The entrypoint treats any live numeric PID in these fixed files as an
      // existing helper. Remove only these owned bookkeeping entries after the
      // group and sockets prove the previous generation is gone.
      if (runtime.clearFixedBrowserBookkeeping) {
        const cleared = await clearOwnedBrowserBookkeeping(
          FIXED_RUNTIME_ROOT,
          runtime.providerRoot,
        );
        if (!cleared) {
          throw new Error("fixed browser bookkeeping ownership changed before cleanup");
        }
      }
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("owned runtime helpers or fixed browser ports remained live after cleanup");
}

async function stopGuardianAfterFailedLaunch(
  child,
  guardianState,
  exitPromise,
  providerRoot,
  clearFixedBrowserBookkeeping,
) {
  if (!child.pid) return;
  if (!guardianState.exitSettled) {
    if (child.connected) {
      await new Promise(resolve => child.send({ stop: true }, () => resolve()));
    } else {
      child.kill("SIGTERM");
    }
  }
  let timer;
  const exit = guardianState.exitResult ?? await Promise.race([
    exitPromise,
    new Promise(resolve => { timer = setTimeout(() => resolve(null), GRACEFUL_STOP_MS + 2_000); }),
  ]);
  clearTimeout(timer);
  if (!exit) {
    child.kill("SIGKILL");
    throw new Error("failed provider launch left runtime cleanup unconfirmed");
  }
  if (exit.signal !== "SIGKILL" || guardianState.cleanupFailed) {
    throw new Error("failed provider launch did not confirm process-group cleanup");
  }
  await waitForRuntimeCleanup({
    guardianPid: child.pid,
    providerRoot,
    clearFixedBrowserBookkeeping,
  });
}

async function stopRuntime(runtime) {
  if (!runtime || runtime.stopStarted) return runtime?.stopPromise;
  runtime.stopStarted = true;
  runtime.status = "stopping";
  runtime.stopPromise = (async () => {
    // The still-live guardian signals only runtime-agent first, matching Docker
    // stop semantics and allowing the agent's bounded final profile snapshot.
    // It then SIGKILLs its own group while its group-leader PID cannot be reused.
    if (!runtime.exitSettled) {
      await new Promise((resolve, reject) => {
        runtime.child.send({ stop: true }, error => (error ? reject(error) : resolve()));
      });
    }
    const exit = await waitForExit(runtime, GRACEFUL_STOP_MS + 2_000);
    if (!exit) {
      runtime.status = "cleanup-failed";
      // This exact ChildProcess still denotes the guardian. Killing only it is
      // safe, but cannot prove descendant cleanup, so release must fail closed.
      runtime.child.kill("SIGKILL");
      throw new Error("runtime guardian did not confirm bounded process-group cleanup");
    }
    if (exit.signal !== "SIGKILL" || runtime.cleanupFailed) {
      runtime.status = "cleanup-failed";
      throw new Error("runtime guardian exited without confirming process-group cleanup");
    }
    try {
      await waitForRuntimeCleanup(runtime);
    } catch (error) {
      runtime.status = "cleanup-failed";
      throw error;
    }
    runtime.status = "stopped";
  })();
  return runtime.stopPromise;
}

function writeJson(response, status, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
  });
  response.end(payload);
}

/**
 * Start a one-project, one-runtime provider fixture for the signed-in Studio
 * Shared Browser lane. The controller remains the authority: this server only
 * accepts a controller-minted, generation-attested ensure request and turns it
 * into an actual runtime-agent process on the owned CI host.
 */
export async function startStudioProvider({
  root,
  bin,
  agentBinary,
  entrypoint,
  env,
  controllerURL,
  signal,
  onRuntime,
}) {
  const ownedRoot = await requireOwnedDirectory(root, "provider root");
  const ownedBin = await requireOwnedDirectory(bin, "provider bin");
  if (!pathIsWithin(ownedRoot, ownedBin)) throw new Error("provider bin must be inside provider root");
  const resolvedAgent = await requireExecutable(agentBinary, "runtime agent");
  const agentFileIdentity = await executableFileIdentity(resolvedAgent);
  const resolvedEntrypoint = await requireExecutable(entrypoint, "runtime entrypoint");
  if (!pathIsWithin(ownedBin, resolvedEntrypoint)) {
    throw new Error("runtime entrypoint must be an owned file inside provider bin");
  }
  const trustedPlaywright = await resolveTrustedPlaywright();
  const clearFixedBrowserBookkeeping = await fixedBrowserDirectoryIsOwned(
    FIXED_RUNTIME_ROOT,
    ownedRoot,
  );
  const controllerBase = validateControllerUrl(controllerURL);
  if (!env || typeof env !== "object" || typeof env.PATH !== "string" || !env.PATH.trim()) {
    throw new Error("a scrubbed PATH is required");
  }
  if (typeof env.DISPLAY !== "string" || !/^:[0-9]+(?:\.[0-9]+)?$/.test(env.DISPLAY)) {
    throw new Error("an explicit local X display is required");
  }
  if (signal?.aborted) throw signal.reason ?? new Error("provider start was cancelled");

  const token = randomBytes(32).toString("base64url");
  let expectedProjectId = null;
  let current = null;
  let closed = false;
  let closePromise = null;
  let operation = Promise.resolve();
  const diagnosticCategories = new Set();
  const allowedDiagnosticCategories = new Set([
    ...RUNTIME_DIAGNOSTIC_PATTERNS.map(([category]) => category), "diagnostic-limit-reached",
  ]);
  const diagnostics = { ensureRequests: 0, validatedEnsures: 0, launches: 0,
    ensureFailures: 0, lastEnsureStatus: null, validationStage: "not-requested", launchStage: "not-requested", agentExitCode: null };

  const serialize = task => {
    const result = operation.then(task, task);
    operation = result.catch(() => {});
    return result;
  };

  async function launchRuntime(validated) {
    diagnostics.launchStage = "generation-check";
    if (current && current.status !== "stopped" && current.status !== "exited") {
      if (current.id === validated.runtimeId && current.leaseId === validated.leaseId) {
        return current;
      }
      requestError(409, "native fixture already owns another runtime generation");
    }
    if (current) await stopRuntime(current);

    // Chromium creates a ProcessSingleton Unix socket below TMPDIR. Nesting
    // this below both generation UUIDs exceeds Linux's socket-path limit and
    // aborts Chromium. Keep each fresh mode-0700 directory in the same owned
    // fixture root, with ample room for Chromium's generated socket suffix.
    diagnostics.launchStage = "temporary-path-check";
    const temporaryPrefix = path.join(ownedRoot, "t-");
    if (Buffer.byteLength(`${temporaryPrefix}XXXXXX`) > 50) {
      throw new Error("provider root is too long for a Chromium temporary socket directory");
    }
    const temporary = await mkdtemp(temporaryPrefix);
    const runtimeRoot = path.join(ownedRoot, "runtimes", validated.runtimeId, validated.leaseId);
    diagnostics.launchStage = "owned-directories";
    const workspace = path.join(runtimeRoot, "workspace");
    const home = path.join(runtimeRoot, "home");
    const browserControl = path.join(runtimeRoot, "browser-control");
    const profileDir = path.join(runtimeRoot, "profile");
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(browserControl, { recursive: true, mode: 0o700 }),
    ]);
    // These production helpers use fixed loopback ports. A fresh fixture root
    // does not prove that another local process has not already claimed them.
    diagnostics.launchStage = "helper-port-check";
    await requireLoopbackPortAvailable(CDP_PORT, "Chromium CDP");
    await requireLoopbackPortAvailable(EGRESS_PROXY_PORT, "browser egress proxy");
    const originPort = await freeLoopbackPort();
    const childEnv = {};
    for (const key of BASE_ENV_KEYS) {
      if (typeof env[key] === "string" && env[key]) childEnv[key] = env[key];
    }
    Object.assign(childEnv, {
      PATH: `${ownedBin}${path.delimiter}${env.PATH}`,
      HOME: home,
      TMPDIR: temporary,
      CODEX_HOME: path.join(workspace, ".codex"),
      CODEX_DISABLED: "1",
      RUNTIME_REQUIRE_CODEX_BIN: "0",
      RUNTIME_VERSION: "studio-browser-e2e",
      RUNTIME_POLL_INTERVAL_MS: "250",
      RUNTIME_LEASE_MAX_JOBS: "1",
      RUNTIME_LEASE_SECONDS: "120",
      RUNTIME_HEARTBEAT_SECONDS: "30",
      RUNTIME_STRICT_MODE: "1",
      // The fixture provider owns the process tree and is already servicing the
      // controller's release request. Prevent a SIGTERM handler from recursively
      // calling controller stop while that release is waiting for this process.
      INSTAFY_RUNTIME_PARENT_DISPOSITION: "1",
      SPACE_ID: validated.projectId,
      PROJECT_ID: validated.projectId,
      RUNTIME_ID: validated.runtimeId,
      RUNTIME_LEASE_ID: validated.leaseId,
      RUNTIME_PROVIDER: PROVIDER_ID,
      RUNTIME_TYPE: PROVIDER_ID,
      RUNTIME_ACCESS_TOKEN: validated.runtimeToken,
      RUNTIME_METADATA: JSON.stringify(validated.metadata),
      WORKSPACE_DIR: workspace,
      CONTROLLER_BASE_URL: controllerBase,
      CONTROLLER_JWKS_URL: `${controllerBase}/.well-known/jwks.json`,
      ORIGIN_ID: validated.originId,
      ORIGIN_LEASE_ID: validated.leaseId,
      ORIGIN_BIND_HOST: "127.0.0.1",
      ORIGIN_BIND_PORT: String(originPort),
      ORIGIN_ENDPOINT: `http://127.0.0.1:${originPort}`,
      ORIGIN_INTERNAL_TOKEN: validated.runtimeToken,
      ORIGIN_SKIP_AUTH: "0",
      ORIGIN_MODE: "hosted",
      ORIGIN_PROTOCOLS: "http",
      ORIGIN_TUNNEL_ENABLED: "0",
      ORIGIN_ENABLE_PRESENCE_HEARTBEAT: "1",
      ORIGIN_DEVICE_ID: "studio-browser-e2e",
      INSTAFY_RUNTIME_ENTRYPOINT: resolvedEntrypoint,
      NODE_PATH: trustedPlaywright.trustedRoot,
      INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH: trustedPlaywright.modulePath,
      INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT: trustedPlaywright.trustedRoot,
      INSTAFY_PLAYWRIGHT_PROFILE_DIR: profileDir,
      INSTAFY_PLAYWRIGHT_CDP_PORT: String(CDP_PORT),
      INSTAFY_BROWSER_ACTIONS_FILE: "/tmp/instafy/playwright/actions.jsonl",
      INSTAFY_BROWSER_AGENT_CONTROL_FILE: path.join(browserControl, "agent-control.json"),
      INSTAFY_SHARED_BROWSER_APPROVAL_DIR: path.join(browserControl, "approvals"),
      INSTAFY_ENABLE_BROWSER_SESSION: "1",
      INSTAFY_BROWSER_VIEWPORT_ONLY: "1",
      INSTAFY_BROWSER_RENDER_SCALE: validated.managedEnv.INSTAFY_BROWSER_RENDER_SCALE ?? "1",
      INSTAFY_BROWSER_MAX_FRAMEBUFFER_PIXELS:
        validated.managedEnv.INSTAFY_BROWSER_MAX_FRAMEBUFFER_PIXELS ?? "8294400",
      INSTAFY_BROWSER_CDP_SCREENCAST: "1",
      INSTAFY_BROWSER_WEBRTC_ENABLED: "0",
      INSTAFY_BROWSER_PREFERRED_VIEWER: "cdp-screencast",
      INSTAFY_BROWSER_DISPLAY: env.DISPLAY,
      INSTAFY_BROWSER_PROFILE_PERSIST: "1",
      INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS:
        validated.managedEnv.INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS,
      INSTAFY_BROWSER_EGRESS_ISOLATION: "1",
      INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV: "0",
      INSTAFY_BROWSER_EGRESS_PROXY_BIND: `127.0.0.1:${EGRESS_PROXY_PORT}`,
      INSTAFY_BROWSER_EGRESS_ALLOWED_PORTS: "80,443",
      INSTAFY_BROWSER_EGRESS_MAX_CONNECTIONS: "32",
      INSTAFY_BROWSER_ADBLOCK: "0",
      RUST_LOG: "runtime_agent=info,origin_http_server=info",
    });

    diagnostics.launchStage = "guardian-spawn";
    const child = spawn(process.execPath, ["-e", RUNTIME_GUARDIAN, resolvedAgent], {
      cwd: workspace,
      env: childEnv,
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const guardianState = {
      agentPid: null,
      agentExited: false,
      cleanupFailed: false,
      exitSettled: false,
      exitResult: null,
    };
    child.on("message", message => {
      if (allowedDiagnosticCategories.has(message?.diagnostic)) diagnosticCategories.add(message.diagnostic);
      if (message?.agentExited === true && Number.isInteger(message.exitCode) && message.exitCode >= 0 && message.exitCode <= 255)
        diagnostics.agentExitCode = message.exitCode;
      if (message?.agentStarted === true && Number.isSafeInteger(message.agentPid) && message.agentPid > 1) {
        guardianState.agentPid = message.agentPid;
      }
      if (message?.agentExited === true) guardianState.agentExited = true;
      if (message?.cleanupFailed === true) guardianState.cleanupFailed = true;
    });
    const guardianExitPromise = new Promise(resolve => {
      child.once("exit", (code, exitSignal) => {
        guardianState.exitSettled = true;
        guardianState.exitResult = { code, signal: exitSignal };
        resolve(guardianState.exitResult);
      });
    });
    try {
      await new Promise((resolve, reject) => {
        let timer;
        const finish = error => {
          clearTimeout(timer);
          child.removeListener("error", failed);
          child.removeListener("exit", exited);
          child.removeListener("message", message);
          if (error) reject(error);
          else resolve();
        };
        const failed = error => finish(new Error("runtime guardian failed to launch", { cause: error }));
        const exited = () => finish(new Error("runtime guardian exited before launching runtime-agent"));
        const message = value => {
          if (value?.agentLaunchFailed === true) finish(new Error("runtime-agent failed to launch"));
          else if (value?.agentStarted === true) finish();
        };
        child.once("error", failed);
        child.once("exit", exited);
        child.on("message", message);
        timer = setTimeout(() => finish(new Error("runtime guardian did not launch runtime-agent in time")), 5_000);
      });
      if (!guardianState.agentPid || guardianState.agentExited || guardianState.exitSettled) {
        throw new Error("runtime-agent exited during provider launch");
      }
    } catch (error) {
      try {
        await stopGuardianAfterFailedLaunch(
          child,
          guardianState,
          guardianExitPromise,
          ownedRoot,
          clearFixedBrowserBookkeeping,
        );
      } catch (cleanupError) {
        throw new Error("runtime launch failed and owned cleanup could not be confirmed", {
          cause: cleanupError,
        });
      }
      throw error;
    }
    const runtime = {
      id: validated.runtimeId,
      leaseId: validated.leaseId,
      projectId: validated.projectId,
      originId: validated.originId,
      originPort,
      originUrl: `http://127.0.0.1:${originPort}`,
      profileDir,
      providerRoot: ownedRoot,
      clearFixedBrowserBookkeeping,
      pid: guardianState.agentPid,
      guardianPid: child.pid,
      status: "running",
      child,
      exitSettled: guardianState.exitSettled,
      exitResult: guardianState.exitResult,
      cleanupFailed: guardianState.cleanupFailed,
      stopStarted: false,
      stopPromise: null,
      exitPromise: guardianExitPromise,
      agentIdentity: null,
      guardianIdentity: null,
    };
    child.on("message", message => {
      if (message?.agentExited === true) runtime.agentExited = true;
      if (message?.cleanupFailed === true) runtime.cleanupFailed = true;
    });
    void guardianExitPromise.then(result => {
      runtime.exitSettled = true;
      runtime.exitResult = result;
      if (!runtime.stopStarted) {
        runtime.status = result.signal === "SIGKILL" && !runtime.cleanupFailed
          ? "exited"
          : "cleanup-failed";
      }
    });
    if (process.platform === "linux") {
      diagnostics.launchStage = "process-identity";
      runtime.guardianIdentity = await linuxProcessIdentity(runtime.guardianPid, "runtime guardian");
      runtime.agentIdentity = await linuxProcessIdentity(runtime.pid, "runtime-agent");
      if (
        runtime.guardianIdentity.processGroup !== runtime.guardianPid ||
        runtime.agentIdentity.processGroup !== runtime.guardianPid
      ) {
        await stopRuntime(runtime);
        throw new Error("spawned runtime-agent does not have the owned executable/process group identity");
      }
    }
    current = runtime;
    diagnostics.launchStage = "launched";
    diagnostics.launches += 1;
    if (typeof onRuntime === "function") {
      queueMicrotask(() => Promise.resolve(onRuntime(safeRuntimeView(runtime))).catch(() => {}));
    }
    return runtime;
  }

  const server = createServer(async (request, response) => {
    try {
      if (closed) requestError(503, "provider is shutting down");
      if (request.method === "GET" && request.url === "/healthz") {
        writeJson(response, 200, { status: "ok", provider: PROVIDER_ID });
        return;
      }
      if (request.method !== "POST") requestError(404, "provider route not found");
      if (!bearerMatches(request.headers.authorization, token)) {
        requestError(401, "unauthorized");
      }
      const payload = await readJson(request);
      if (request.url === "/runtime/ensure") {
        diagnostics.ensureRequests += 1;
        const validated = validateEnsurePayload(payload, expectedProjectId, stage => { diagnostics.validationStage = stage; });
        diagnostics.validatedEnsures += 1;
        validated.runtimeToken = payload.runtime_token;
        await serialize(() => launchRuntime(validated));
        diagnostics.lastEnsureStatus = 200;
        writeJson(response, 200, { message: "native Shared Browser CI runtime launched" });
        return;
      }
      if (request.url === "/runtime/release") {
        const projectId = requireUuid(payload.project_id, "project_id");
        const runtimeId = requireUuid(payload.runtime_id, "runtime_id");
        const leaseId = requireUuid(payload.lease_id, "lease_id");
        await serialize(async () => {
          if (
            current &&
            current.projectId === projectId &&
            current.id === runtimeId &&
            current.leaseId === leaseId
          ) {
            const released = current;
            await stopRuntime(released);
            if (current === released) current = null;
          }
        });
        writeJson(response, 204);
        return;
      }
      if (request.url === "/runtime/inspect") {
        requireUuid(payload.project_id, "project_id");
        requireUuid(payload.runtime_id, "runtime_id");
        writeJson(response, 200, { oom_killed: null });
        return;
      }
      requestError(404, "provider route not found");
    } catch (error) {
      const status = error instanceof ProviderRequestError ? error.status : 500;
      if (request.url === "/runtime/ensure") {
        diagnostics.ensureFailures += 1;
        diagnostics.lastEnsureStatus = status;
      }
      const message = error instanceof ProviderRequestError ? error.message : "provider operation failed";
      if (!response.headersSent) writeJson(response, status, { error: message });
      else response.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("provider did not bind TCP");

  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    signal?.removeEventListener("abort", abortListener);
    const serverClosed = new Promise(resolve => server.close(() => resolve()));
    closePromise = (async () => {
      let cleanupError;
      try {
        await serialize(async () => {
          const owned = current;
          if (owned) await stopRuntime(owned);
          if (current === owned) current = null;
        });
      } catch (error) {
        cleanupError = error;
      } finally {
        server.closeAllConnections?.();
        await serverClosed;
      }
      if (cleanupError) throw cleanupError;
    })();
    return closePromise;
  };
  const abortListener = () => {
    void close().catch(() => {});
  };
  signal?.addEventListener("abort", abortListener, { once: true });

  return Object.freeze({
    url: `http://127.0.0.1:${address.port}`,
    token,
    setProject(projectId) {
      const normalized = requireUuid(projectId, "projectId");
      if (expectedProjectId && expectedProjectId !== normalized) {
        throw new Error("provider project is already fixed");
      }
      expectedProjectId = normalized;
    },
    currentRuntime() {
      return safeRuntimeView(current);
    },
    diagnostics() {
      return { ...diagnostics, categories: [...diagnosticCategories].sort(),
        hasRuntime: current !== null, agentExited: current?.agentExited === true,
        guardianExited: current?.exitSettled === true };
    },
    assertOwnedRuntime(runtimeId) {
      const normalized = requireUuid(runtimeId, "runtimeId");
      return serialize(async () => {
        const runtime = current;
        if (
          !runtime ||
          runtime.id !== normalized ||
          runtime.status !== "running" ||
          runtime.exitSettled
        ) {
          throw new Error("provider does not own the requested live runtime generation");
        }
        if (process.platform !== "linux" || !runtime.agentIdentity) {
          throw new Error("runtime process ownership proof requires disposable Linux");
        }
        if (
          !runtime.clearFixedBrowserBookkeeping ||
          !(await fixedBrowserDirectoryIsOwned(FIXED_RUNTIME_ROOT, ownedRoot))
        ) {
          throw new Error("fixed browser directory is not owned by this Studio fixture");
        }
        const [guardianIdentity, agentIdentity] = await Promise.all([
          linuxProcessIdentity(runtime.guardianPid, "runtime guardian"),
          linuxProcessIdentity(runtime.pid, "runtime-agent"),
        ]);
        const currentAgentFileIdentity = await executableFileIdentity(resolvedAgent);
        if (
          !agentFileIdentity.elf ||
          !executableIdentityMatches(agentFileIdentity, currentAgentFileIdentity) ||
          guardianIdentity.processGroup !== runtime.guardianPid ||
          guardianIdentity.startTicks !== runtime.guardianIdentity.startTicks ||
          agentIdentity.processGroup !== runtime.guardianPid ||
          agentIdentity.startTicks !== runtime.agentIdentity.startTicks
        ) {
          throw new Error("runtime-agent no longer matches the owned process identity");
        }

        const chromiumPid = await readOwnedChromiumPid();
        const chromiumIdentity = await linuxProcessIdentity(chromiumPid, "Chromium");
        if (
          chromiumIdentity.processGroup !== runtime.guardianPid ||
          chromiumIdentity.startTicks < runtime.agentIdentity.startTicks
        ) {
          throw new Error("Chromium does not belong to the owned runtime process group");
        }
        const args = (await readFile(`/proc/${chromiumPid}/cmdline`))
          .toString("utf8")
          .split("\0")
          .filter(Boolean);
        if (
          !args.includes(`--user-data-dir=${runtime.profileDir}`) ||
          !args.includes(`--remote-debugging-port=${CDP_PORT}`)
        ) {
          throw new Error("Chromium does not own the expected profile and CDP endpoint");
        }
        if (current !== runtime || runtime.status !== "running" || runtime.exitSettled) {
          throw new Error("runtime ownership changed during Chromium verification");
        }
        return Object.freeze({ ...safeRuntimeView(runtime), chromiumPid });
      });
    },
    close,
  });
}
