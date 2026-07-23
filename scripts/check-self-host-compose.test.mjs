import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSE_FILE,
  EXAMPLE_ENV_FILE,
  EXPECTED_SERVICES,
} from "./check-self-host-compose.mjs";

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
