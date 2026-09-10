import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  AUTH_ONLY_EXCLUDED_CONTAINERS, BROWSER_TEST_EXCLUDED_CONTAINERS,
  parseSupabaseAuthOnly, parseSupabaseBrowserTest, parseSupabaseDatabaseOnly,
} from "./supabaseStartMode.mjs";

export const SERIAL_PULL_CLI_VERSION = "2.92.0";
export const SERIAL_PULL_BUDGET_MS = 10 * 60_000;

// services --output json omits these four images. Keep this inventory coupled to
// the exact CLI: https://github.com/supabase/cli/blob/v2.92.0/pkg/config/templates/Dockerfile
const ANCILLARY_IMAGES = Object.freeze([
  "library/kong:2.8.1", "axllent/mailpit:v1.22.3",
  "darthsim/imgproxy:v3.8.0", "timberio/vector:0.53.0-alpine",
]);
const SERVICE_NAMES = Object.freeze([
  "supabase/postgres", "supabase/gotrue", "postgrest/postgrest",
  "supabase/realtime", "supabase/storage-api", "supabase/edge-runtime",
  "supabase/studio", "supabase/postgres-meta", "supabase/logflare", "supabase/supavisor",
]);
// PG17 cold initialization runs these enabled services' one-shot migrations
// before persistent-service exclusions apply. Do not disable their schemas:
// https://github.com/supabase/cli/blob/v2.92.0/internal/db/start/start.go#L317-L338
const AUTH_SCHEMA_INITIALIZATION_IMAGES = Object.freeze(["realtime", "storage-api"]);

export function parseSupabaseSerialPull(value) {
  if (value == null || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error("SUPABASE_SERIAL_PULL must be unset, false, or true");
}

function assertModes(databaseOnly, authOnly, browserTest) {
  if ([databaseOnly, authOnly, browserTest].some((value) => typeof value !== "boolean")
    || [databaseOnly, authOnly, browserTest].filter(Boolean).length > 1) {
    throw new Error("supabase-serial-start-mode-invalid");
  }
}

export function serialPullImages(output, { databaseOnly = false, authOnly = false, browserTest = false } = {}) {
  assertModes(databaseOnly, authOnly, browserTest);
  let rows;
  try { rows = JSON.parse(output); } catch { throw new Error("supabase-serial-inventory-invalid"); }
  if (!Array.isArray(rows) || rows.length !== SERVICE_NAMES.length) {
    throw new Error("supabase-serial-inventory-invalid");
  }
  const versions = new Map();
  for (const row of rows) {
    if (!row || Object.keys(row).sort().join(",") !== "local,name,remote"
      || !SERVICE_NAMES.includes(row.name) || versions.has(row.name)
      || typeof row.local !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(row.local)
      || row.local === "latest" || row.remote !== "") {
      throw new Error("supabase-serial-inventory-invalid");
    }
    versions.set(row.name, row.local);
  }
  const names = databaseOnly ? [SERVICE_NAMES[0]] : SERVICE_NAMES;
  const images = names.map((name) => `${name}:${versions.get(name)}`);
  if (!databaseOnly) images.push(...ANCILLARY_IMAGES);
  // Same default mapping as v2.92.0 internal/utils/docker.go GetRegistryImageUrl.
  return images.map((ref) => `public.ecr.aws/supabase/${ref.split("/").at(-1)}`)
    .filter((ref) => {
      const name = ref.split("/").at(-1).split(":")[0];
      if (browserTest) return !BROWSER_TEST_EXCLUDED_CONTAINERS.includes(name);
      return !authOnly || !AUTH_ONLY_EXCLUDED_CONTAINERS.includes(name) || AUTH_SCHEMA_INITIALIZATION_IMAGES.includes(name);
    });
}

function optionalStat(target) {
  try { return fs.lstatSync(target); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error("supabase-serial-path-invalid");
  }
}

export function assertSerialPullProject(repoRoot, env) {
  const root = path.resolve(repoRoot);
  if (fs.realpathSync(root) !== root) throw new Error("supabase-serial-path-invalid");
  const directories = [root, path.join(root, "supabase"), path.join(root, "supabase", "supabase")];
  for (const directory of directories) {
    if (!optionalStat(directory)?.isDirectory()) throw new Error("supabase-serial-path-invalid");
    // The CLI loads these files even with a scrubbed process environment. Do not
    // inspect their contents or load a developer's credentials in this opt-in.
    for (const name of [".env", ".env.local", ".env.development", ".env.development.local"]) {
      if (optionalStat(path.join(directory, name))) throw new Error("supabase-serial-requires-clean-local-config");
    }
  }
  const config = optionalStat(path.join(directories[2], "config.toml"));
  if (!config?.isFile() || config.nlink !== 1 || config.size > 1_048_576) {
    throw new Error("supabase-serial-path-invalid");
  }
  const temporary = path.join(directories[2], ".temp");
  const temporaryStat = optionalStat(temporary);
  if (temporaryStat && !temporaryStat.isDirectory()) throw new Error("supabase-serial-path-invalid");
  if (optionalStat(path.join(temporary, "project-ref"))) throw new Error("supabase-serial-requires-unlinked-project");
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if ((key.startsWith("SUPABASE_") && !["SUPABASE_SERIAL_PULL", "SUPABASE_DATABASE_ONLY", "SUPABASE_AUTH_ONLY", "SUPABASE_BROWSER_TEST"].includes(key))
      || ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_AUTH_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"].includes(key)) {
      throw new Error("supabase-serial-unsupported-override");
    }
  }
}

export function serialPullEnvironment(env, temporaryHome) {
  const result = {
    PATH: env.PATH, HOME: temporaryHome, DOCKER_CONFIG: temporaryHome,
    XDG_CONFIG_HOME: temporaryHome, CI: "true", LANG: "C", TZ: "UTC",
    // v2.92.0 internal/utils/access_token.go checks nonempty env BEFORE the OS
    // keychain, then rejects this deliberately invalid value. Empty HOME alone
    // does not isolate keychain access. services therefore cannot authenticate.
    SUPABASE_ACCESS_TOKEN: "disabled-for-local-image-inventory",
  };
  for (const upper of ["HTTP_PROXY", "HTTPS_PROXY"]) {
    const lower = upper.toLowerCase();
    const values = [env[upper], env[lower]].filter((value) => value !== undefined && value !== "");
    if (!values.length) continue;
    let origins;
    try {
      origins = values.map((value) => {
        const url = new URL(value);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password
          || url.pathname !== "/" || url.search || url.hash || value.trim() !== value) throw new Error();
        return url.origin;
      });
    } catch { throw new Error("supabase-serial-proxy-invalid"); }
    if (new Set(origins).size !== 1) throw new Error("supabase-serial-proxy-invalid");
    result[upper] = result[lower] = origins[0];
  }
  return result;
}

function assertCliDiagnostics(stderr) {
  // services returns success even for config-load failures. Accept only the
  // harmless notices observed with the pinned CLI, never arbitrary diagnostics.
  const allowed = [
    /^Using workdir supabase$/,
    /^A new version of Supabase CLI is available: v[0-9]+\.[0-9]+\.[0-9]+ \(currently installed v2\.92\.0\)$/,
    /^We recommend updating regularly for new features and bug fixes: https:\/\/supabase\.com\/docs\/guides\/cli\/getting-started#updating-the-supabase-cli$/,
  ];
  if (String(stderr ?? "").split(/\r?\n/).some((line) => line && !allowed.some((pattern) => pattern.test(line)))) {
    throw new Error("supabase-serial-cli-diagnostic");
  }
}

// Only fixed categories and bounded process metadata may leave a failed Docker
// invocation. Never echo stderr, URLs, paths, arbitrary error messages or tags.
function reportDockerFailure(log, stage, image, result, thrown) {
  const knownNames = [...SERVICE_NAMES, ...ANCILLARY_IMAGES].map((ref) => ref.split("/").at(-1).split(":")[0]);
  const name = typeof image === "string" ? image.split("/").at(-1).split(":")[0] : "unknown";
  const exit = Number.isInteger(result?.status) && result.status >= 0 && result.status <= 255 ? result.status : "unknown";
  const signal = ["SIGKILL", "SIGTERM", "SIGABRT", "SIGSEGV", "SIGINT"].includes(result?.signal) ? result.signal : "none-or-unknown";
  const code = result?.error?.code ?? thrown?.code;
  const error = ["ETIMEDOUT", "ENOBUFS", "ENOENT", "EACCES", "ENOMEM", "EIO"].includes(code) ? code : "none-or-unknown";
  const stderr = result?.stderr;
  const hints = [];
  if (typeof stderr === "string" && Buffer.byteLength(stderr, "utf8") <= 32_768) {
    for (const [hint, pattern] of [
      ["rate-limit", /too many requests|toomanyrequests|(?:status code|http)[: ]+429/i],
      ["registry-auth", /unauthorized|authentication required|pull access denied/i],
      ["manifest-missing", /manifest unknown|manifest not found/i],
      ["platform-missing", /no matching manifest for/i],
      ["proxy-denied", /proxyconnect[^\r\n]*forbidden|proxy authentication required/i],
      ["tls", /x509:|tls handshake|certificate verify failed/i],
      ["dns", /no such host|temporary failure in name resolution/i],
      ["network-timeout", /i\/o timeout|context deadline exceeded|client\.timeout exceeded/i],
      ["network-reset", /connection reset by peer|unexpected eof/i],
      ["disk-full", /no space left on device/i],
      ["daemon-unavailable", /cannot connect to the docker daemon|is the docker daemon running/i],
    ]) if (pattern.test(stderr)) hints.push(hint);
  }
  // Hints describe text reported by Docker, not a verified underlying cause.
  try {
    log(`[supabase-stack] Docker preparation failed stage=${stage} image=${knownNames.includes(name) ? name : "unknown"} exit=${exit} signal=${signal} error=${error} hints=${hints.join(",") || "unclassified"}`);
  } catch { /* Diagnostics must not mask the original preparation failure. */ }
}

// Synchronous calls deliberately allow only one image request at a time. The
// embedded Compose client pulls images concurrently despite Docker's separate
// max-concurrent-downloads layer limit. Cached exact refs use PullPolicyMissing:
// https://github.com/supabase/cli/blob/v2.92.0/internal/utils/config.go
export function prepareSupabaseSerialPull({
  repoRoot, env = process.env,
  databaseOnly = parseSupabaseDatabaseOnly(env.SUPABASE_DATABASE_ONLY),
  authOnly = parseSupabaseAuthOnly(env.SUPABASE_AUTH_ONLY),
  browserTest = parseSupabaseBrowserTest(env.SUPABASE_BROWSER_TEST),
  execute = spawnSync, now = () => performance.now(), log = console.log,
}) {
  assertModes(databaseOnly, authOnly, browserTest);
  if (!parseSupabaseSerialPull(env.SUPABASE_SERIAL_PULL)) return { enabled: false, images: 0, pulled: 0 };
  assertSerialPullProject(repoRoot, env);
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "supabase-serial-pull-"));
  const identity = fs.lstatSync(temporaryHome);
  const started = now();
  try {
    const childEnv = serialPullEnvironment(env, temporaryHome);
    function command(binary, args, budget, stage, { mayBeMissing = false, cli = false } = {}) {
      const remaining = SERIAL_PULL_BUDGET_MS - (now() - started);
      if (!Number.isFinite(remaining) || remaining <= 0 || remaining > SERIAL_PULL_BUDGET_MS) {
        throw new Error("supabase-serial-deadline");
      }
      let result;
      try {
        result = execute(binary, args, {
          cwd: repoRoot, env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
          timeout: Math.max(1, Math.floor(Math.min(budget, remaining))), killSignal: "SIGKILL", maxBuffer: 262_144,
        });
      } catch (error) {
        if (binary === "docker") reportDockerFailure(log, stage, args.at(-1), undefined, error);
        throw new Error(`supabase-serial-${stage}-failed`);
      }
      if (now() - started >= SERIAL_PULL_BUDGET_MS) throw new Error("supabase-serial-deadline");
      if (!result || result.error || result.signal || (result.status !== 0 && !(mayBeMissing && result.status === 1))) {
        if (binary === "docker") reportDockerFailure(log, stage, args.at(-1), result);
        throw new Error(`supabase-serial-${stage}-failed`);
      }
      if (cli) assertCliDiagnostics(result.stderr);
      return result;
    }
    const version = command("pnpm", ["exec", "supabase", "--version"], 30_000, "version", { cli: true });
    if (version.stdout.trim() !== SERIAL_PULL_CLI_VERSION) throw new Error("supabase-serial-cli-version-mismatch");
    const inventory = command("pnpm", ["exec", "supabase", "--workdir", "supabase", "services", "--output", "json"], 30_000, "inventory", { cli: true });
    const images = serialPullImages(inventory.stdout, { databaseOnly, authOnly, browserTest });
    let pulled = 0;
    for (const [index, image] of images.entries()) {
      const inspectArgs = ["image", "inspect", "--format", "{{.Id}}", image];
      let inspected = command("docker", inspectArgs, 15_000, "inspect", { mayBeMissing: true });
      if (inspected.status !== 0) {
        log(`[supabase-stack] Serial image preparation ${index + 1}/${images.length}`);
        command("docker", ["pull", "--quiet", image], 180_000, "pull");
        inspected = command("docker", inspectArgs, 15_000, "readback");
        pulled += 1;
      }
      if (!/^sha256:[a-f0-9]{64}$/.test(inspected.stdout.trim())) throw new Error("supabase-serial-image-readback-invalid");
    }
    log(`[supabase-stack] Serial image preparation complete (${images.length} images, ${pulled} pulled).`);
    return { enabled: true, images: images.length, pulled };
  } finally {
    const current = fs.lstatSync(temporaryHome);
    if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error("supabase-serial-cleanup-identity-mismatch");
    }
    // Only this private directory created by mkdtemp; never the caller's home.
    fs.rmSync(temporaryHome, { recursive: true });
  }
}
