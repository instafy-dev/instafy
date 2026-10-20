import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { tunnelBrokerPreviewEnv } from "./run-e2e-dev.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// Private previews are off unless configured. The dev launcher configures them
// for the local stack only: the broker it starts and the controller beside it.

test("the local stack's broker and controller share one hook bearer", () => {
  const env = tunnelBrokerPreviewEnv({ TUNNEL_BROKER_HOOK_SECRET: "operator-secret" });
  assert.equal(env.ACL_HOOK_TOKEN, "operator-secret");
  assert.equal(env.TUNNEL_BROKER_HOOK_SECRET, "operator-secret");

  const fromBroker = tunnelBrokerPreviewEnv({ ACL_HOOK_TOKEN: "broker-secret" });
  assert.equal(fromBroker.TUNNEL_BROKER_HOOK_SECRET, "broker-secret");
});

test("the local stack serves previews on preview.localhost through its own Traefik", () => {
  const env = tunnelBrokerPreviewEnv({ TUNNEL_BROKER_HOOK_SECRET: "operator-secret" });
  assert.equal(env.PREVIEW_DOMAIN, "preview.localhost");
  assert.match(env.PREVIEW_BASE_URL, /^http:\/\/preview\.localhost:\d+$/);
  assert.equal(env.PREVIEW_AUTH_ADDRESS, "http://broker:8080");
  assert.match(env.PREVIEW_AUTH_HOOK_URL, /^http:\/\/host\.docker\.internal:\d+\/tunnel-broker\/hooks\/preview-auth$/);
});

test("an empty PREVIEW_DOMAIN leaves the stack without previews", () => {
  assert.deepEqual(tunnelBrokerPreviewEnv({ PREVIEW_DOMAIN: "", TUNNEL_BROKER_HOOK_SECRET: "x" }), {});
});

test("previews are wired only for a broker the launcher starts itself", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "scripts/run-e2e-dev.mjs"), "utf8");
  const start = source.indexOf("async function startTunnelBrokerIngressIfNeeded()");
  const body = source.slice(start, source.indexOf("\nasync function ", start + 1));
  const applied = body.indexOf("tunnelBrokerPreviewEnv(");
  assert.ok(applied > 0, "the launcher applies the preview settings");
  // After the early returns for a skipped or externally configured broker,
  // before the broker's containers are created.
  assert.ok(applied > body.indexOf("RUNTIME_SKIP_TUNNEL_BROKER"));
  assert.ok(applied > body.indexOf("existingBaseUrl.length > 0"));
  assert.ok(applied < body.indexOf('"compose"'));
});
