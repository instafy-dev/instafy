import { CHAT_UPLOAD_FILE_NAME_MAX_LENGTH, sanitizeChatUploadFileName } from "../../../conversations/conversationSubmitHelpers";
import { isChatAttachmentUploadError } from "../../../lib/chatAttachments";
import type { WorkspaceFileStaleNotice } from "./workspaceFileStaleNoticeStore";

/**
 * Above this many characters of base plus local text, the two versions go to
 * the agent as attached text files instead of inline in the prompt.
 */
export const MERGE_SNAPSHOT_INLINE_LIMIT = 12_000;

/**
 * When the attached snapshots can't be stored, versions up to this many
 * characters together are sent once more inline, as before attachments.
 */
export const MERGE_SNAPSHOT_INLINE_FALLBACK_LIMIT = 200_000;

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

const BASE_SNAPSHOT_SUFFIX = ".base.txt";
const LOCAL_SNAPSHOT_SUFFIX = ".local.txt";

/**
 * The names the prompt cites are exactly the `fileName`s the message records:
 * the stem keeps the end of the file's name, cut so the longer suffix still
 * fits the recorded length, so the two names always differ.
 */
function snapshotFileNames(path: string): { base: string; local: string } {
  const baseName = path.split("/").pop() || "file";
  const stemLength = CHAT_UPLOAD_FILE_NAME_MAX_LENGTH - LOCAL_SNAPSHOT_SUFFIX.length;
  const safeStem = baseName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-stemLength);
  return {
    base: sanitizeChatUploadFileName(`${safeStem}${BASE_SNAPSHOT_SUFFIX}`),
    local: sanitizeChatUploadFileName(`${safeStem}${LOCAL_SNAPSHOT_SUFFIX}`),
  };
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

/**
 * Sends the merge request for a stale file. Large versions go as two attached
 * snapshots when the server stores attachments (anything but `none`). When the
 * snapshots can't be stored and the versions are small enough, the request is
 * sent once more with them inline. Otherwise the ChatAttachmentUploadError,
 * whose message is plain copy, is thrown for the notice to show; the submit
 * flow does not show it a second time.
 */
export async function sendWorkspaceFileStaleMerge({
  notice,
  chatAttachments,
  submit,
}: {
  notice: Pick<WorkspaceFileStaleNotice, "path" | "baseText" | "localText">;
  chatAttachments: "storage" | "none" | null;
  submit: (prompt: string, options?: { textFiles: File[]; callerReportsAttachmentErrors: true }) => Promise<void>;
}): Promise<void> {
  const request = buildWorkspaceFileStaleMergeRequest(notice, { canAttachFiles: chatAttachments !== "none" });
  if (request.textFiles.length === 0) {
    await submit(request.prompt);
    return;
  }
  try {
    await submit(request.prompt, { textFiles: request.textFiles, callerReportsAttachmentErrors: true });
  } catch (error) {
    const combined = notice.baseText.length + notice.localText.length;
    if (!isChatAttachmentUploadError(error) || combined > MERGE_SNAPSHOT_INLINE_FALLBACK_LIMIT) {
      throw error;
    }
    await submit(buildWorkspaceFileStaleMergeRequest(notice, { canAttachFiles: false }).prompt);
  }
}
