#!/usr/bin/env node
// Chooses where a docker-container Buildx builder pulls its BuildKit image
// from. dockerd pulls that image itself, outside BuildKit's registry mirror,
// so a Docker Hub rate limit or stall failed "Set up Docker Buildx" before any
// build started. The digest stays exactly the one the workflow pins:
//
//   BUILDKIT_IMAGE=moby/buildkit@sha256:<64 hex> node scripts/resolve-buildkit-image.mjs
//
// writes `image=ghcr.io/instafy-dev/dockerhub/moby/buildkit@sha256:<64 hex>` to
// GITHUB_OUTPUT when GHCR serves that digest (and every child manifest)
// anonymously, else `image=moby/buildkit@sha256:<64 hex>`. Registry trouble
// never fails the step; only an invalid BUILDKIT_IMAGE does.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveBuildkitImage } from "./lib/dockerHubImageMirror.mjs";

async function main() {
  const image = await resolveBuildkitImage(process.env.BUILDKIT_IMAGE ?? "");
  console.log(`BuildKit image: ${image}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `image=${image}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    // A request abandoned at the budget must not hold the step open.
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
