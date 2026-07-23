import type { ChatMessage } from "../screens/studio/types";

export const GITHUB_IMPORT_FOLLOWUP_EVENT = "instafy:github-import-followup";

const PENDING_GITHUB_IMPORT_FOLLOWUPS_KEY = "__INSTAFY_PENDING_GITHUB_IMPORT_FOLLOWUPS__";

export interface GithubImportFollowupPayload {
  projectId: string;
  repo: string;
  ref?: string | null;
  targetPath?: string | null;
  fileCount?: number | null;
  /** The integration-request message this import resolved, when applicable. */
  sourceMessageId?: string | null;
}

export interface GithubImportFollowupRecord extends GithubImportFollowupPayload {
  id: string;
  createdAt: number;
}

function generateFollowupId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `github-import-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type GithubImportFollowupHost = typeof globalThis & {
  __INSTAFY_PENDING_GITHUB_IMPORT_FOLLOWUPS__?: GithubImportFollowupRecord[];
};

function normalizeRepo(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function makeRecord(payload: GithubImportFollowupPayload): GithubImportFollowupRecord | null {
  const projectId = payload.projectId.trim();
  const repo = normalizeRepo(payload.repo);
  if (!projectId || !repo) {
    return null;
  }
  return {
    id: generateFollowupId(),
    projectId,
    repo,
    ref: payload.ref?.trim() || null,
    targetPath: payload.targetPath?.trim() || null,
    fileCount: typeof payload.fileCount === "number" && Number.isFinite(payload.fileCount) ? payload.fileCount : null,
    sourceMessageId: payload.sourceMessageId?.trim() || null,
    createdAt: Date.now(),
  };
}

function readQueue(target: GithubImportFollowupHost): GithubImportFollowupRecord[] {
  const current = target[PENDING_GITHUB_IMPORT_FOLLOWUPS_KEY];
  return Array.isArray(current) ? [...current] : [];
}

function writeQueue(target: GithubImportFollowupHost, entries: GithubImportFollowupRecord[]) {
  target[PENDING_GITHUB_IMPORT_FOLLOWUPS_KEY] = entries;
}

function resolveHost(): GithubImportFollowupHost {
  return globalThis as GithubImportFollowupHost;
}

export function queueGithubImportFollowup(payload: GithubImportFollowupPayload): GithubImportFollowupRecord | null {
  const record = makeRecord(payload);
  if (!record) {
    return null;
  }
  const runtimeWindow = resolveHost();
  const current = readQueue(runtimeWindow);
  current.push(record);
  writeQueue(runtimeWindow, current);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(GITHUB_IMPORT_FOLLOWUP_EVENT, { detail: { projectId: record.projectId } }));
  }
  return record;
}

export function consumeGithubImportFollowups(projectId: string | null | undefined): GithubImportFollowupRecord[] {
  const normalizedProjectId = projectId?.trim() ?? "";
  if (!normalizedProjectId) {
    return [];
  }
  const runtimeWindow = resolveHost();
  const current = readQueue(runtimeWindow);
  if (current.length === 0) {
    return [];
  }
  const matches = current.filter((entry) => entry.projectId === normalizedProjectId);
  if (matches.length === 0) {
    return [];
  }
  const rest = current.filter((entry) => entry.projectId !== normalizedProjectId);
  writeQueue(runtimeWindow, rest);
  return matches;
}

export function buildGithubImportFollowupMessageFromPayload(
  entry: GithubImportFollowupPayload & {
    id?: string | null;
    createdAt?: number | null;
  },
): ChatMessage {
  const countLabel =
    typeof entry.fileCount === "number" && entry.fileCount >= 0
      ? `${entry.fileCount} ${entry.fileCount === 1 ? "file" : "files"}`
      : "your files";
  const targetSuffix =
    entry.targetPath && entry.targetPath.trim().length > 0
      ? ` into \`${entry.targetPath}\``
      : "";
  return {
    id: `assistant-github-import-${entry.id?.trim() || generateFollowupId()}`,
    role: "assistant",
    content: `Imported ${countLabel} from ${entry.repo}${targetSuffix}. You can ask me to investigate issues, map the architecture, or start a concrete improvement now.`,
    timestamp:
      typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)
        ? entry.createdAt
        : Date.now(),
    metadata: {
      agent: {
        handle: "octo",
      },
      githubImport: {
        id: entry.id,
        projectId: entry.projectId,
        repo: entry.repo,
        ref: entry.ref ?? null,
        targetPath: entry.targetPath ?? null,
        fileCount: entry.fileCount ?? null,
        sourceMessageId: entry.sourceMessageId?.trim() || null,
      },
      ui: {
        suggestedReplies: [
          "Please investigate the GitHub issues of this project we just imported.",
          "Give me a quick architecture summary of this codebase.",
          "Recommend the top 3 next actions and start with the first one.",
        ],
      },
    },
  };
}

export function buildGithubImportFollowupMessage(entry: GithubImportFollowupRecord): ChatMessage {
  return buildGithubImportFollowupMessageFromPayload(entry);
}
