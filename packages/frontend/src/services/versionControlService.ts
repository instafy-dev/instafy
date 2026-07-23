export interface LinkRepositoryInput {
  organization: string;
  repository: string;
  branch?: string;
  makePrivate?: boolean;
}

export interface VersionControlStatus {
  status: "idle" | "provisioning" | "linked" | "error";
  repoUrl?: string;
  branch?: string;
  lastSyncedAt?: string | null;
  error?: string | null;
}

export interface VersionControlStatusInput {
  organization?: string;
  repository?: string;
  branch?: string;
}

export interface CommitSnapshotInput {
  projectId: string;
  message: string;
  sessionId?: string;
  organization?: string;
  repository?: string;
  branch?: string;
  workflow?: string;
  files: Array<{ path: string; contents: string }>;
}

const FALLBACK_STATUS: VersionControlStatus = {
  status: "idle",
  lastSyncedAt: null,
  repoUrl: undefined,
  branch: undefined,
  error: "Supabase client missing; running in local fallback mode."
};

export async function linkRepository(projectId: string, input: LinkRepositoryInput) {
  void projectId;
  console.warn("[versionControlService] GitHub integration is not available in this runtime.");
  return {
    ...FALLBACK_STATUS,
    status: "linked",
    repoUrl: `https://github.com/${input.organization}/${input.repository}`,
    branch: input.branch ?? "main"
  } satisfies VersionControlStatus;
}

export async function fetchVersionControlStatus(projectId: string, input?: VersionControlStatusInput) {
  void projectId;
  void input;
  console.warn("[versionControlService] GitHub integration is not available in this runtime.");
  return FALLBACK_STATUS;
}

export async function commitSnapshot(input: CommitSnapshotInput) {
  void input;
  console.warn("[versionControlService] GitHub integration is not available in this runtime.");
  return {
    status: "linked" as const,
    lastSyncedAt: new Date().toISOString()
  };
}
