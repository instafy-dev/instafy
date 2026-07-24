import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  GIT_SERVICES_SOURCE_PATHS,
  fingerprintGitServiceFiles,
} from "./gitServicesImageFingerprint.mjs";

test("Git service source fingerprint includes its Compose build definition", () => {
  assert.ok(GIT_SERVICES_SOURCE_PATHS.includes("docker/docker-compose.runtime.yml"));
});

test("Git service source fingerprint is deterministic and content-sensitive", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-services-fingerprint-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.rs"), "fn a() {}\n");
  fs.writeFileSync(path.join(root, "src", "b.rs"), "fn b() {}\n");

  const first = fingerprintGitServiceFiles({
    repoRoot: root,
    relativePaths: ["src/b.rs", "src/a.rs"],
    cargoProfileDevDebug: "0",
  });
  const reordered = fingerprintGitServiceFiles({
    repoRoot: root,
    relativePaths: ["src/a.rs", "src/b.rs"],
    cargoProfileDevDebug: "0",
  });
  assert.equal(first, reordered);

  fs.writeFileSync(path.join(root, "src", "a.rs"), "fn changed() {}\n");
  const changedContent = fingerprintGitServiceFiles({
    repoRoot: root,
    relativePaths: ["src/a.rs", "src/b.rs"],
    cargoProfileDevDebug: "0",
  });
  assert.notEqual(first, changedContent);

  const changedProfile = fingerprintGitServiceFiles({
    repoRoot: root,
    relativePaths: ["src/a.rs", "src/b.rs"],
    cargoProfileDevDebug: "2",
  });
  assert.notEqual(changedContent, changedProfile);

  fs.rmSync(path.join(root, "src", "a.rs"));
  const deletedSource = fingerprintGitServiceFiles({
    repoRoot: root,
    relativePaths: ["src/a.rs", "src/b.rs"],
    cargoProfileDevDebug: "2",
  });
  assert.notEqual(changedProfile, deletedSource);
});
