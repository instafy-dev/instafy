#!/usr/bin/env node
// served: print the release id production currently serves (empty on any doubt).
// prove:  poll until production serves exactly RELEASE_ID, then require / and
//         /install to answer; fail otherwise.
//
// env: PUBLIC_APP_URL, RELEASE_ID (prove), GITHUB_RUN_ID

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function appBase(value) {
  let base;
  try {
    base = new URL(String(value ?? ""));
  } catch {
    throw new Error("PUBLIC_APP_URL must be a URL");
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("PUBLIC_APP_URL must be a credential-free HTTPS origin");
  }
  return base;
}

export function releaseIdFrom(metadata) {
  if (
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    JSON.stringify(Object.keys(metadata).sort()) === JSON.stringify(["releaseId", "schemaVersion"]) &&
    metadata.schemaVersion === 2 &&
    /^[0-9a-f]{64}$/u.test(metadata.releaseId ?? "")
  ) {
    return metadata.releaseId;
  }
  return "";
}

export async function servedReleaseId({ base, runId, fetchImpl = fetch }) {
  const url = new URL("/instafy-build.json", base);
  url.searchParams.set("release", String(runId ?? "probe"));
  const response = await fetchImpl(url, { cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(15_000) });
  return response.ok ? releaseIdFrom(await response.json()) : "";
}

export async function proveProduction({ base, releaseId, runId, fetchImpl = fetch, attempts = 24, delayMs = 5_000, log = console.log }) {
  if (!/^[0-9a-f]{64}$/u.test(releaseId ?? "")) throw new Error("RELEASE_ID must be a sha256 hex digest");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if ((await servedReleaseId({ base, runId, fetchImpl })) === releaseId) {
        const [home, install] = await Promise.all([
          fetchImpl(base, { cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(15_000) }),
          fetchImpl(new URL("/install", base), { cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(15_000) }),
        ]);
        if (!home.ok || !install.ok) throw new Error(`smoke failed: home=${home.status}, install=${install.status}`);
        log(`[web-release] Production serves exact release ${releaseId}.`);
        return true;
      }
      log(`Attempt ${attempt}: production has not converged.`);
    } catch (error) {
      log(`Attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("Production did not serve the exact hosted web release");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  try {
    const base = appBase(process.env.PUBLIC_APP_URL);
    if (mode === "served") {
      process.stdout.write(`${await servedReleaseId({ base, runId: process.env.GITHUB_RUN_ID }).catch(() => "")}\n`);
    } else if (mode === "prove") {
      await proveProduction({ base, releaseId: process.env.RELEASE_ID, runId: process.env.GITHUB_RUN_ID });
    } else {
      throw new Error("Usage: prove-production.mjs served|prove");
    }
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
