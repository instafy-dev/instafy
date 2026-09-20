#!/usr/bin/env node
// Builds the hosted web frontend for exactly SOURCE_SHA: the public frontend
// package with the hosted feature manifest (public core, vendored robot slice,
// performance bridge), then writes the served release metadata. The Studio
// performance transport stays disabled in this lane: enabling it is a reviewed
// code change, not a variable.
//
// env: SOURCE_SHA (required), RELEASE_ID (optional; must match when present)

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hostedBuildMetadata } from "./release-id.mjs";

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const HOSTED_MANIFEST_RELATIVE_PATH = "packages/frontend/hosted/hostedFrontendFeatureManifest.ts";
export const DIST_RELATIVE_PATH = "packages/frontend/dist";

export function hostedBuildEnvironment(baseEnv, repositoryRoot = REPOSITORY_ROOT) {
  for (const name of Object.keys(baseEnv)) {
    if (/^VITE_.*SERVICE_ROLE/iu.test(name)) {
      throw new Error(`${name} is forbidden in a browser build`);
    }
  }
  if (baseEnv.INSTAFY_STUDIO_PERFORMANCE_COLLECTOR_ENABLED === "true") {
    throw new Error("The Studio performance collector cannot be enabled from the hosted web lane");
  }
  return {
    ...baseEnv,
    INSTAFY_FRONTEND_FEATURE_MANIFEST: path.join(repositoryRoot, HOSTED_MANIFEST_RELATIVE_PATH),
    VITE_STUDIO_PERFORMANCE_COLLECTOR_ORIGIN: "",
    VITE_STUDIO_PERFORMANCE_RELEASE_ID: "",
  };
}

export function buildHostedWeb({ env = process.env, repositoryRoot = REPOSITORY_ROOT, run = spawnSync } = {}) {
  const sourceSha = String(env.SOURCE_SHA ?? "");
  const metadata = hostedBuildMetadata(sourceSha);
  if (env.RELEASE_ID && env.RELEASE_ID !== metadata.releaseId) {
    throw new Error("RELEASE_ID does not match the release commit");
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  if (head !== sourceSha) {
    throw new Error("The checked-out source is not the release commit");
  }
  const buildEnv = hostedBuildEnvironment(env, repositoryRoot);
  if (!fs.statSync(buildEnv.INSTAFY_FRONTEND_FEATURE_MANIFEST).isFile()) {
    throw new Error("The hosted feature manifest is missing");
  }
  const dist = path.join(repositoryRoot, DIST_RELATIVE_PATH);
  fs.rmSync(dist, { recursive: true, force: true });
  const result = run("pnpm", ["--filter", "@instafy/frontend", "build"], {
    cwd: repositoryRoot,
    env: buildEnv,
    stdio: "inherit",
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("The hosted web build failed");
  }
  fs.writeFileSync(path.join(dist, "instafy-build.json"), `${JSON.stringify(metadata)}\n`);
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const metadata = buildHostedWeb();
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `release_id=${metadata.releaseId}\n`);
    }
    console.log(`[web-release] Built hosted web release ${metadata.releaseId}.`);
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
