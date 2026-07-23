export type WorkspaceFileStaleNotice = {
  projectId: string | null;
  path: string;
  label: string;
  baseText: string;
  localText: string;
  detectedAt: number;
};

let currentWorkspaceFileStaleNotice: WorkspaceFileStaleNotice | null = null;

export function readWorkspaceFileStaleNotice(): WorkspaceFileStaleNotice | null {
  return currentWorkspaceFileStaleNotice;
}

export function writeWorkspaceFileStaleNotice(notice: WorkspaceFileStaleNotice | null) {
  currentWorkspaceFileStaleNotice = notice;
}
