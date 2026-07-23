export const instafyBuildInfo: InstafyBuildInfo = __INSTAFY_BUILD_INFO__;

export function formatInstafyBuildLabel(build: InstafyBuildInfo): string {
  const version = build.packageVersion || "unknown";
  const shortCommit = build.gitCommitShort?.trim();
  return shortCommit ? `v${version} (${shortCommit})` : `v${version}`;
}
