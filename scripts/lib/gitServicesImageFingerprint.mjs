import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const GIT_SERVICES_SOURCE_PATHS = [
  ".dockerignore",
  "docker/docker-compose.runtime.yml",
  "docker/git-services-dev/Dockerfile",
  "packages/git-service",
  "packages/origin-http-server",
  "packages/runtime-contracts",
  "packages/runtime-agent/assets",
  "proto",
];

export function fingerprintGitServiceFiles({
  repoRoot,
  relativePaths,
  cargoProfileDevDebug = "2",
}) {
  const hash = crypto.createHash("sha256");
  hash.update(`CARGO_PROFILE_DEV_DEBUG\0${cargoProfileDevDebug}\0`);

  for (const relativePath of [...new Set(relativePaths)].sort()) {
    const normalized = relativePath.split(path.sep).join("/");
    const absolutePath = path.join(repoRoot, relativePath);
    hash.update(normalized);
    hash.update("\0");
    try {
      hash.update(fs.readFileSync(absolutePath));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      hash.update("<deleted>");
    }
    hash.update("\0");
  }

  return hash.digest("hex");
}

export function computeGitServicesImageFingerprint(
  repoRoot,
  { cargoProfileDevDebug = process.env.CARGO_PROFILE_DEV_DEBUG || "2" } = {},
) {
  const listed = spawnSync(
    "git",
    [
      "ls-files",
      "-co",
      "--exclude-standard",
      "--",
      ...GIT_SERVICES_SOURCE_PATHS,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (listed.status !== 0) {
    throw new Error(
      `unable to fingerprint Git service sources: ${(listed.stderr || "git ls-files failed").trim()}`,
    );
  }

  const relativePaths = listed.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (relativePaths.length === 0) {
    throw new Error("unable to fingerprint Git service sources: no source files found");
  }

  return fingerprintGitServiceFiles({
    repoRoot,
    relativePaths,
    cargoProfileDevDebug,
  });
}
