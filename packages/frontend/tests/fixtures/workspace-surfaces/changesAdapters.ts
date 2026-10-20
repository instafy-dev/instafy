let changesReviewActive = false;
export function setChangesReviewActive(active: boolean) {
  changesReviewActive = active;
}

const diffs: Record<string, string> = {
  "src/welcome.ts": [
    "diff --git a/src/welcome.ts b/src/welcome.ts",
    "index 1111111..2222222 100644",
    "--- a/src/welcome.ts",
    "+++ b/src/welcome.ts",
    "@@ -1,3 +1,4 @@",
    " export function welcome(name: string) {",
    '-  return `Hello ${name}`;',
    '+  const displayName = name.trim() || "there";',
    '+  return `Hello, ${displayName}!`;',
    " }",
  ].join("\n"),
  "README.md": [
    "diff --git a/README.md b/README.md",
    "index 3333333..4444444 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,3 +1,4 @@",
    " # Product workshop",
    " ",
    "-A local workspace.",
    "+A local workspace for reviewing changes.",
    "+Open the Files view to browse its contents.",
  ].join("\n"),
};

export const changesApi = {
  // Preserve Files' unavailable Git-status fallback so its local draft/version
  // scenario cannot accidentally inherit the canned Changes paths.
  fetchStatus: async () => changesReviewActive ? ({
    supported: true,
    dirtyCount: 2,
    dirtyPaths: Object.keys(diffs).map(path => ({ path, code: "M" })),
    pathGroups: [],
    busy: false,
    error: null,
  }) : null,
  fetchHistory: async () => ({ supported: true, entries: [], branch: "review", busy: false, error: null }),
  fetchDiff: async ({ path }: { path: string }) => ({ supported: true, diff: diffs[path] ?? "", error: null, truncated: false }),
  // Mutation buttons stay local and never invoke Git or another transport.
  revertPaths: async () => ({ ok: false, error: "Discard is not connected in this local review." }),
  revertCommit: async () => ({ ok: false, error: "Revert is not connected in this local review." }),
};
