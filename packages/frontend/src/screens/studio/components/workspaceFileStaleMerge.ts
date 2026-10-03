import type { WorkspaceFileStaleNotice } from "./workspaceFileStaleNoticeStore";

/**
 * Above this many characters of base plus local text, the two versions go to
 * the agent as attached text files instead of inline in the prompt.
 */
export const MERGE_SNAPSHOT_INLINE_LIMIT = 12_000;

export type WorkspaceFileStaleMergeRequest = {
  prompt: string;
  /**
   * The base and local snapshots as `text/plain` files, sent as the
   * message's `kind: "file"` attachments. Empty when the versions are inline.
   */
  textFiles: File[];
};

function codeFenceFor(path: string): string {
  const extension = path.split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
  switch (extension) {
    case "ts":
    case "tsx":
      return "tsx";
    case "js":
    case "jsx":
      return "jsx";
    case "json":
      return "json";
    case "md":
    case "mdx":
      return "md";
    case "toml":
      return "toml";
    case "rs":
      return "rust";
    default:
      return "";
  }
}

function snapshotFileNames(path: string): { base: string; local: string } {
  const baseName = path.split("/").pop() || "file";
  const safeStem = baseName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-96);
  return { base: `${safeStem}.base.txt`, local: `${safeStem}.local.txt` };
}

/**
 * The prompt that asks the agent to merge someone's unsaved edits into the
 * newer workspace version of a file. Large versions travel as two attached
 * snapshots in the conversation's Storage folder, never as files in the
 * workspace. Without attachment storage they stay inline at any size.
 */
export function buildWorkspaceFileStaleMergeRequest(
  notice: Pick<WorkspaceFileStaleNotice, "path" | "baseText" | "localText">,
  options: { canAttachFiles: boolean },
): WorkspaceFileStaleMergeRequest {
  const intro = [
    `A teammate (or another tab) updated the workspace version of \`${notice.path}\` while I have unsaved edits.`,
    "",
    "Please merge my edits into the latest workspace version and keep it clean.",
    "",
  ];
  const closing = [
    "4. Keep your explanation non-technical; summarize what changed.",
    "5. If something is ambiguous, ask me which version to keep (only ask when needed).",
  ];
  const sizeEstimate = notice.baseText.length + notice.localText.length;
  if (options.canAttachFiles && sizeEstimate > MERGE_SNAPSHOT_INLINE_LIMIT) {
    const names = snapshotFileNames(notice.path);
    return {
      prompt: [
        ...intro,
        "Files:",
        `- Target (latest): ${notice.path}`,
        `- Base snapshot (what I started from): the attached file ${names.base}`,
        `- My unsaved edits snapshot: the attached file ${names.local}`,
        "",
        "Instructions:",
        `1. Read the latest content from \`${notice.path}\`.`,
        "2. Read the two attached snapshot files.",
        `3. Produce a merged result and write it back to \`${notice.path}\`.`,
        ...closing,
      ].join("\n"),
      textFiles: [
        new File([notice.baseText], names.base, { type: "text/plain" }),
        new File([notice.localText], names.local, { type: "text/plain" }),
      ],
    };
  }
  const fence = codeFenceFor(notice.path);
  return {
    prompt: [
      ...intro,
      "Instructions:",
      `1. Read the latest content from \`${notice.path}\`.`,
      "2. Use the two versions below to do a 3-way merge (base vs my edits vs latest).",
      `3. Write the merged result back to \`${notice.path}\`.`,
      ...closing,
      "",
      "Base version:",
      "```" + fence,
      notice.baseText,
      "```",
      "",
      "My unsaved edits:",
      "```" + fence,
      notice.localText,
      "```",
    ].join("\n"),
    textFiles: [],
  };
}
