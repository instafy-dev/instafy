import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { computeHostedReleaseId } from "./release-id.mjs";
import { REQUIRED_FEATURE_MODULE_IDS, verifyHostedWebArtifact } from "./verify-hosted-web-artifact.mjs";

const SHA = "8ddffed21d44e19969ba0715fb879b4dced434b9";

function fixture(mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-web-artifact-"));
  fs.mkdirSync(path.join(root, "assets"));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>Instafy</title>\n");
  fs.writeFileSync(path.join(root, "instafy-build.json"), `${JSON.stringify({ schemaVersion: 2, releaseId: computeHostedReleaseId(SHA) })}\n`);
  fs.writeFileSync(
    path.join(root, "assets", "index-abc123.js"),
    `const build={gitCommit:"${SHA}"};const ids=[${REQUIRED_FEATURE_MODULE_IDS.map((id) => JSON.stringify(id)).join(",")}];\n`,
  );
  mutate(root);
  return root;
}

test("an exact, composed, credential-free artifact passes", () => {
  const result = verifyHostedWebArtifact({ distPath: fixture(), sourceSha: SHA });
  assert.equal(result.releaseId, computeHostedReleaseId(SHA));
  assert.deepEqual(result.files, ["assets/index-abc123.js", "index.html", "instafy-build.json"]);
});

test("metadata must be the exact v3 release of this commit", () => {
  const wrongId = fixture((root) => fs.writeFileSync(path.join(root, "instafy-build.json"), JSON.stringify({ schemaVersion: 2, releaseId: "a".repeat(64) })));
  assert.throws(() => verifyHostedWebArtifact({ distPath: wrongId, sourceSha: SHA }), /exact release metadata/u);
  const extraKey = fixture((root) => fs.writeFileSync(path.join(root, "instafy-build.json"), JSON.stringify({ schemaVersion: 2, releaseId: computeHostedReleaseId(SHA), commit: SHA })));
  assert.throws(() => verifyHostedWebArtifact({ distPath: extraKey, sourceSha: SHA }), /exact release metadata/u);
});

test("a build that fell back to the public manifest is refused", () => {
  const publicOnly = fixture((root) => fs.writeFileSync(path.join(root, "assets", "index-abc123.js"), `const b="${SHA}";const i=["instafy.public-core"];\n`));
  assert.throws(() => verifyHostedWebArtifact({ distPath: publicOnly, sourceSha: SHA }), /lacks feature modules/u);
});

test("maps, environment files, links, workers and private strings are refused", () => {
  const cases = [
    [(root) => fs.writeFileSync(path.join(root, "assets", "index-abc123.js.map"), "{}"), /source map/u],
    [(root) => fs.writeFileSync(path.join(root, ".env.production"), "X=1"), /environment file/u],
    [(root) => fs.symlinkSync("index.html", path.join(root, "link.html")), /symbolic link/u],
    [(root) => fs.writeFileSync(path.join(root, "_worker.js"), "export default {}"), /Pages Functions or a worker/u],
    [(root) => fs.writeFileSync(path.join(root, "leak.txt"), ["/Us", "ers/someone/project"].join("")), /personal filesystem path/u],
    [(root) => fs.writeFileSync(path.join(root, "leak.txt"), ["sb_", "secret_", "x".repeat(20)].join("")), /Supabase secret key/u],
    [(root) => fs.writeFileSync(path.join(root, "leak.txt"), ["packages", "frontend", "hosted", "robot"].join("/")), /private source path/u],
  ];
  for (const [mutate, message] of cases) {
    assert.throws(() => verifyHostedWebArtifact({ distPath: fixture(mutate), sourceSha: SHA }), message);
  }
});

test("the artifact must carry its release commit", () => {
  const noCommit = fixture((root) => fs.writeFileSync(path.join(root, "assets", "index-abc123.js"), `const i=[${REQUIRED_FEATURE_MODULE_IDS.map((id) => JSON.stringify(id)).join(",")}];\n`));
  assert.throws(() => verifyHostedWebArtifact({ distPath: noCommit, sourceSha: SHA }), /release commit/u);
});
