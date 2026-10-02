import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COMPOSE_FILE,
  EXAMPLE_ENV_FILE,
  EXPECTED_SERVICES,
} from "./check-self-host-compose.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PROVIDER_COMPOSE_FILE = "docker/docker-compose.runtime.provider.yml";
const composeAvailable =
  spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;

test("self-host validation is bound to the public Compose example", () => {
  assert.equal(COMPOSE_FILE, "docker/docker-compose.runtime.yml");
  assert.equal(EXAMPLE_ENV_FILE, "docker/.env.example");
  assert.deepEqual(EXPECTED_SERVICES, [
    "git-edge",
    "git-shard-0",
    "origin-gateway",
    "proxy",
    "redis",
    "runtime",
  ]);
});

// PROXY_PINNED_MODEL pins managed runs on the sidecar's static credentials to
// the managed model, so both runtime Compose files must pass it through when
// the operator sets it, fall back to MANAGED_AI_MODEL_ID when it is unset, and
// treat an explicitly empty value as no pin.
test(
  "the proxy sidecar takes its pinned model from the environment that runs Compose",
  { skip: !composeAvailable && "Docker Compose v2 unavailable" },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-compose-pin-"));
    try {
      const emptyEnvFile = path.join(root, "empty.env");
      fs.writeFileSync(emptyEnvFile, "");
      fs.mkdirSync(path.join(root, "docker"));
      fs.writeFileSync(path.join(root, "docker", ".env.local"), "");
      // The provider sidecar's env_file. Compose lets `environment:` override
      // it, so a pin placed here never reaches the proxy.
      const sidecarEnvFile = path.join(root, "proxy-credential-lease.env");
      fs.writeFileSync(sidecarEnvFile, "PROXY_PINNED_MODEL=from-sidecar-env-file\n");
      const pinnedModel = (composeFile, overrides) => {
        const result = spawnSync(
          "docker",
          [
            "compose",
            "--project-directory",
            root,
            "--env-file",
            emptyEnvFile,
            "--file",
            path.join(REPO_ROOT, composeFile),
            "config",
            "--format",
            "json",
            "proxy",
          ],
          {
            encoding: "utf8",
            // Only what the Docker CLI needs, so no ambient pin leaks in.
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              ...(process.env.DOCKER_CONFIG
                ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG }
                : {}),
              INSTAFY_ENV_DIR: root,
              PROXY_CREDENTIAL_LEASE_ENV_FILE: sidecarEnvFile,
              RUNTIME_PROXY_IMAGE: "runtime-proxy:fixture",
              RUNTIME_AGENT_IMAGE: "runtime-agent:fixture",
              ...overrides,
            },
            timeout: 30_000,
          },
        );
        assert.equal(result.status, 0, `${composeFile}: ${result.stderr}`);
        return JSON.parse(result.stdout).services.proxy.environment.PROXY_PINNED_MODEL;
      };

      for (const composeFile of [COMPOSE_FILE, PROVIDER_COMPOSE_FILE]) {
        assert.equal(pinnedModel(composeFile, {}), "", `${composeFile}: unset is no pin`);
        assert.equal(
          pinnedModel(composeFile, { PROXY_PINNED_MODEL: "", MANAGED_AI_MODEL_ID: "" }),
          "",
          `${composeFile}: empty is no pin`,
        );
        assert.equal(
          pinnedModel(composeFile, { MANAGED_AI_MODEL_ID: "gpt-6-luna" }),
          "gpt-6-luna",
          `${composeFile}: falls back to MANAGED_AI_MODEL_ID`,
        );
        assert.equal(
          pinnedModel(composeFile, { PROXY_PINNED_MODEL: "", MANAGED_AI_MODEL_ID: "gpt-6-luna" }),
          "",
          `${composeFile}: an explicitly empty PROXY_PINNED_MODEL switches the pin off`,
        );
        assert.equal(
          pinnedModel(composeFile, { PROXY_PINNED_MODEL: "gpt-6-luna" }),
          "gpt-6-luna",
          `${composeFile}: passes PROXY_PINNED_MODEL through`,
        );
        assert.equal(
          pinnedModel(composeFile, {
            PROXY_PINNED_MODEL: "pinned-model",
            MANAGED_AI_MODEL_ID: "managed-model",
          }),
          "pinned-model",
          `${composeFile}: PROXY_PINNED_MODEL wins`,
        );
      }
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  },
);

// A provider launch hands the managed launch metadata to the runtime only as
// the environment of the `docker compose` process (allocator/docker.rs).
// Compose passes a variable into the container only when the runtime
// service's `environment:` lists it, so an allowlisted key this file forgets
// is dropped without a trace. ORIGIN_GIT_REMOTE_URL was dropped that way, and
// hosted workspaces then had no git remote and lived only on the node's disk.
const ALLOCATOR_ALLOWLIST_FILE = "packages/runtime-provider-core/src/allocator/mod.rs";

// Exceptions to "every allowlisted key reaches the runtime container".
const NOT_FORWARDED_TO_RUNTIME = new Map([
  // Compose-level only: Compose reads these itself to size the container
  // (`cpus:` and `mem_limit:`). Nothing inside the container reads them.
  ["RUNTIME_CPU_LIMIT", "compose-level"],
  ["RUNTIME_MEMORY_LIMIT", "compose-level"],
  // Read inside the container, but not forwarded yet. The origin server and
  // browser-webrtc-sender each fall back to the same loopback default
  // (127.0.0.1:9225), and they must move together. Forwarding the URL as an
  // empty value would break WebRTC: the origin treats an empty
  // INSTAFY_BROWSER_WEBRTC_SENDER_URL as invalid instead of unset. Forward
  // both with a shared default before a provider sets either one.
  ["INSTAFY_BROWSER_WEBRTC_SENDER_URL", "not-forwarded-yet"],
  ["INSTAFY_BROWSER_WEBRTC_BIND", "not-forwarded-yet"],
]);

function allocatorManagedEnvAllowlist() {
  const source = fs.readFileSync(path.join(REPO_ROOT, ALLOCATOR_ALLOWLIST_FILE), "utf8");
  const body = source.match(
    /fn is_allowed_managed_runtime_env_key\(key: &str\) -> bool \{\n([\s\S]*?)\n\}\n/,
  )?.[1];
  assert.ok(body, `${ALLOCATOR_ALLOWLIST_FILE}: is_allowed_managed_runtime_env_key not found`);
  const withoutComments = body.replace(/\/\/.*$/gm, "");
  return [...withoutComments.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((match) => match[1]);
}

// The provider Compose file's runtime service as text, plus the variables its
// `environment:` map sets. Parsed by hand so the check needs no Docker.
function providerRuntimeService() {
  const lines = fs
    .readFileSync(path.join(REPO_ROOT, PROVIDER_COMPOSE_FILE), "utf8")
    .split("\n");
  const start = lines.indexOf("  runtime:");
  assert.notEqual(start, -1, `${PROVIDER_COMPOSE_FILE}: runtime service not found`);
  let end = lines.findIndex((line, index) => index > start && /^ {0,2}\S/.test(line));
  if (end === -1) {
    end = lines.length;
  }
  const service = lines.slice(start, end);
  const environmentStart = service.indexOf("    environment:");
  assert.notEqual(environmentStart, -1, `${PROVIDER_COMPOSE_FILE}: runtime environment not found`);
  const environment = new Map();
  for (const line of service.slice(environmentStart + 1)) {
    if (line.trim() === "" || /^\s*#/.test(line)) {
      continue;
    }
    const entry = line.match(/^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!entry) {
      break;
    }
    environment.set(entry[1], entry[2]);
  }
  return { text: service.join("\n"), environment };
}

test("the provider runtime receives every managed launch variable a runtime reads", () => {
  const allowlist = allocatorManagedEnvAllowlist();
  // Guards the source parse itself: an empty or truncated list would pass vacuously.
  for (const key of [
    "RUNTIME_CPU_LIMIT",
    "ORIGIN_GIT_REMOTE_URL",
    "INSTAFY_BROWSER_EGRESS_MAX_CONNECTIONS",
  ]) {
    assert.ok(allowlist.includes(key), `allowlist parse is missing ${key}`);
  }

  const runtime = providerRuntimeService();
  for (const key of allowlist) {
    const exception = NOT_FORWARDED_TO_RUNTIME.get(key);
    if (exception) {
      assert.ok(
        !runtime.environment.has(key),
        `${key} is forwarded now: remove it from NOT_FORWARDED_TO_RUNTIME`,
      );
      if (exception === "compose-level") {
        assert.ok(
          runtime.text.includes(`\${${key}`),
          `${key} is listed as compose-level, but the runtime service never reads it`,
        );
      }
      continue;
    }
    const value = runtime.environment.get(key);
    assert.ok(
      value !== undefined,
      `${PROVIDER_COMPOSE_FILE}: the runtime environment drops the allowlisted ${key}`,
    );
    assert.ok(
      value.startsWith(`\${${key}:-`) || value.startsWith(`\${${key}-`),
      `${PROVIDER_COMPOSE_FILE}: ${key} must pass the launch value through, got ${value}`,
    );
  }
  for (const key of NOT_FORWARDED_TO_RUNTIME.keys()) {
    assert.ok(allowlist.includes(key), `${key} is no longer allowlisted: drop its exception`);
  }
});

// The runtime agent and the origin server both trim the value and treat an
// empty remote as none, so an unset variable keeps today's no-remote behavior.
test("the provider runtime forwards an unset git remote as empty", () => {
  assert.equal(
    providerRuntimeService().environment.get("ORIGIN_GIT_REMOTE_URL"),
    "${ORIGIN_GIT_REMOTE_URL:-}",
  );
});
