import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { HOSTED_MANIFEST_RELATIVE_PATH, REPOSITORY_ROOT, hostedBuildEnvironment } from "./build-hosted-web.mjs";

test("the hosted build selects the committed hosted manifest by absolute path", () => {
  const env = hostedBuildEnvironment({ PATH: "/bin", INSTAFY_FRONTEND_FEATURE_MANIFEST: "/elsewhere.ts" }, "/repo");
  assert.equal(env.INSTAFY_FRONTEND_FEATURE_MANIFEST, path.join("/repo", HOSTED_MANIFEST_RELATIVE_PATH));
  assert.ok(fs.statSync(path.join(REPOSITORY_ROOT, HOSTED_MANIFEST_RELATIVE_PATH)).isFile());
});

test("the Studio performance transport is forced off and cannot be enabled from the lane", () => {
  const env = hostedBuildEnvironment({ VITE_STUDIO_PERFORMANCE_COLLECTOR_ORIGIN: "https://app.example.invalid", VITE_STUDIO_PERFORMANCE_RELEASE_ID: "a".repeat(64) }, "/repo");
  assert.equal(env.VITE_STUDIO_PERFORMANCE_COLLECTOR_ORIGIN, "");
  assert.equal(env.VITE_STUDIO_PERFORMANCE_RELEASE_ID, "");
  assert.throws(() => hostedBuildEnvironment({ INSTAFY_STUDIO_PERFORMANCE_COLLECTOR_ENABLED: "true" }, "/repo"), /cannot be enabled/u);
  const bridge = fs.readFileSync(path.join(REPOSITORY_ROOT, "packages/frontend/hosted/performance/featureModule.tsx"), "utf8");
  assert.match(bridge, /window.location.origin !== import.meta.env.VITE_STUDIO_PERFORMANCE_COLLECTOR_ORIGIN/u);
});

test("service-role names never reach the browser build", () => {
  assert.throws(() => hostedBuildEnvironment({ [["VITE", "SUPABASE", "SERVICE", "ROLE", "KEY"].join("_")]: "x" }, "/repo"), /forbidden/u);
});

test("the hosted manifest composes public core, the robot slice and the performance bridge in order", () => {
  const manifest = fs.readFileSync(path.join(REPOSITORY_ROOT, HOSTED_MANIFEST_RELATIVE_PATH), "utf8");
  assert.match(
    manifest,
    /APPLICATION_FRONTEND_FEATURE_MODULES = Object\.freeze\(\[\n  PUBLIC_CORE_FRONTEND_FEATURE_MODULE,\n  ROBOT_FRONTEND_FEATURE_MODULE,\n  STUDIO_PERFORMANCE_FEATURE_MODULE,\n\]\);/u,
  );
});
