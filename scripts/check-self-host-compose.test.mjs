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
// the operator sets it, and fall back to MANAGED_AI_MODEL_ID otherwise.
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
