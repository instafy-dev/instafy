// Vite replaces __INSTAFY_BUILD_INFO__ at build time (vite.config.ts `define`).
// Test runners and tools that load these modules without that define get a
// neutral fallback instead of a ReferenceError on import.
const FALLBACK_BUILD_INFO: InstafyBuildInfo = {
  app: "instafy-frontend",
  packageVersion: "unknown",
  gitCommit: null,
  gitCommitShort: null,
  gitBranch: null,
  builtAt: "",
  releaseId: "",
};

export function resolveInstafyBuildInfo(candidate: InstafyBuildInfo | undefined): InstafyBuildInfo {
  return candidate ?? FALLBACK_BUILD_INFO;
}

export const instafyBuildInfo: InstafyBuildInfo = resolveInstafyBuildInfo(
  typeof __INSTAFY_BUILD_INFO__ === "undefined" ? undefined : __INSTAFY_BUILD_INFO__,
);

export function formatInstafyBuildLabel(build: InstafyBuildInfo): string {
  const version = build.packageVersion || "unknown";
  const shortCommit = build.gitCommitShort?.trim();
  return shortCommit ? `v${version} (${shortCommit})` : `v${version}`;
}
