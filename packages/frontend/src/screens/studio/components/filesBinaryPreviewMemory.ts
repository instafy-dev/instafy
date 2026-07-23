import type { ControllerWorkspaceEntry } from "../../../sdk/instafy";

export type BinaryPreviewMode = "image" | "unsupported";

export interface BinaryPreviewRequest {
  mode: BinaryPreviewMode;
  entry: ControllerWorkspaceEntry;
}

const MAX_REMEMBERED_PREVIEWS = 16;
const binaryPreviewRequestByScope = new Map<string, BinaryPreviewRequest>();

export function buildBinaryPreviewScopeKey(
  ownerId: string | null | undefined,
  projectId: string | null | undefined,
): string | null {
  const normalizedOwnerId = ownerId?.trim() ?? "";
  const normalizedProjectId = projectId?.trim() ?? "";
  if (!normalizedOwnerId || !normalizedProjectId) {
    return null;
  }
  return JSON.stringify([normalizedOwnerId, normalizedProjectId]);
}

function copyPreviewEntry(entry: ControllerWorkspaceEntry): ControllerWorkspaceEntry {
  return {
    name: entry.name,
    path: entry.path,
    kind: entry.kind,
    size: entry.size ?? null,
    modified: entry.modified ?? null,
    mimeType: entry.mimeType ?? null,
  };
}

export function rememberBinaryPreviewRequest(
  scopeKey: string | null,
  mode: BinaryPreviewMode,
  entry: ControllerWorkspaceEntry,
): void {
  if (!scopeKey) {
    return;
  }

  // Refresh insertion order so the small transient cache evicts the least
  // recently selected preview. Only the request descriptor is retained; raw
  // or signed URLs must always be fetched again under current authorization.
  binaryPreviewRequestByScope.delete(scopeKey);
  binaryPreviewRequestByScope.set(scopeKey, {
    mode,
    entry: copyPreviewEntry(entry),
  });

  while (binaryPreviewRequestByScope.size > MAX_REMEMBERED_PREVIEWS) {
    const oldestKey = binaryPreviewRequestByScope.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    binaryPreviewRequestByScope.delete(oldestKey);
  }
}

export function readBinaryPreviewRequest(scopeKey: string | null): BinaryPreviewRequest | null {
  if (!scopeKey) {
    return null;
  }
  const request = binaryPreviewRequestByScope.get(scopeKey);
  if (!request) {
    return null;
  }
  return {
    mode: request.mode,
    entry: copyPreviewEntry(request.entry),
  };
}

export function forgetBinaryPreviewRequest(scopeKey: string | null): void {
  if (scopeKey) {
    binaryPreviewRequestByScope.delete(scopeKey);
  }
}

export function clearRememberedBinaryPreviewRequests(): void {
  binaryPreviewRequestByScope.clear();
}
