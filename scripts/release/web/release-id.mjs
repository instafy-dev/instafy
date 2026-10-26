#!/usr/bin/env node
// The hosted web release identity. Served publicly at /instafy-build.json as
// {"schemaVersion":2,"releaseId":...}. One public commit pins every input of
// the hosted build: core source, the vendored robot slice, the performance
// bridge, the hosted manifest, the lockfile and the pinned submodule. The
// digest is compared by the private release train and the client lanes; it is
// never parsed.

import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const RELEASE_ID_PREFIX = "instafy-hosted-frontend:v3";
export const METADATA_SCHEMA_VERSION = 2;

export function computeHostedReleaseId(sourceSha) {
  if (typeof sourceSha !== "string" || !/^[0-9a-f]{40}$/u.test(sourceSha)) {
    throw new Error("The hosted web release commit must be a 40-character lowercase sha");
  }
  return createHash("sha256").update(`${RELEASE_ID_PREFIX}:${sourceSha}`).digest("hex");
}

export function hostedBuildMetadata(sourceSha) {
  return { schemaVersion: METADATA_SCHEMA_VERSION, releaseId: computeHostedReleaseId(sourceSha) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${computeHostedReleaseId(process.argv[2])}\n`);
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
