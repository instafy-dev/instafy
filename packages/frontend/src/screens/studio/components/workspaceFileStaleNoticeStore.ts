export type WorkspaceFileStaleNotice = {
  projectId: string | null;
  path: string;
  label: string;
  baseText: string;
  localText: string;
  detectedAt: number;
  /**
   * `desktop`: a Desktop save kept the user's bytes in the folder but the
   * space has a newer version; Reload first discards the folder's copy.
   */
  variant?: "desktop" | null;
  /** Origin the buffer was read from (the Desktop folder for `desktop`). */
  originId?: string | null;
};

export const WORKSPACE_FILE_STALE_EVENT = "instafy:workspace-file-stale";

let currentWorkspaceFileStaleNotice: WorkspaceFileStaleNotice | null = null;

export function readWorkspaceFileStaleNotice(): WorkspaceFileStaleNotice | null {
  return currentWorkspaceFileStaleNotice;
}

export function writeWorkspaceFileStaleNotice(notice: WorkspaceFileStaleNotice | null) {
  currentWorkspaceFileStaleNotice = notice;
}

/** Store the notice and tell the chat to show its card. */
export function raiseWorkspaceFileStaleNotice(notice: WorkspaceFileStaleNotice) {
  writeWorkspaceFileStaleNotice(notice);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(WORKSPACE_FILE_STALE_EVENT, { detail: notice }));
  }
}
