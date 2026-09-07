import { controllerJsonRequest } from "./client";

export interface SharedBrowserProfileStatus {
  enabled: boolean;
  lastSavedAt: string | null;
  savedByRuntimeId: string | null;
}

export type SharedBrowserProfileStatusResult =
  | { success: true; status: SharedBrowserProfileStatus }
  | { success: false; error: string };

/** Read controller-owned save metadata, never the browser's profile contents. */
export async function fetchSharedBrowserProfileStatus(
  projectId: string,
): Promise<SharedBrowserProfileStatusResult> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) return { success: false, error: "Missing project id." };
  const result = await controllerJsonRequest<unknown>({
    path: `/projects/${encodeURIComponent(normalizedProjectId)}/browser-profile/status`,
    fallbackError: "Unable to check Shared Browser saves",
    headers: { "cache-control": "no-cache" },
  });
  if (!result.success) return result;
  const value = result.value as Partial<SharedBrowserProfileStatus> | null;
  if (!value || typeof value !== "object" || typeof value.enabled !== "boolean" ||
      !(value.lastSavedAt === null || (typeof value.lastSavedAt === "string" &&
        value.lastSavedAt.length <= 64 && Number.isFinite(Date.parse(value.lastSavedAt)))) ||
      !(value.savedByRuntimeId === null || (typeof value.savedByRuntimeId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.savedByRuntimeId))) ||
      (value.lastSavedAt === null && value.savedByRuntimeId !== null)) {
    return { success: false, error: "Shared Browser save status is unavailable." };
  }
  return { success: true, status: {
    enabled: value.enabled,
    lastSavedAt: value.lastSavedAt,
    savedByRuntimeId: value.savedByRuntimeId,
  } };
}

export interface ClearSharedBrowserDataResult {
  success: boolean;
  error?: string;
}

/**
 * Clear the project-scoped Shared Browser identity.
 *
 * The controller owns the stop-and-delete ordering so a live runtime cannot
 * upload its old profile again after this request succeeds.
 */
export async function clearSharedBrowserData(
  projectId: string,
  params?: { accessToken?: string | null },
): Promise<ClearSharedBrowserDataResult> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) {
    return { success: false, error: "Missing project id." };
  }

  const result = await controllerJsonRequest<unknown>({
    path: `/projects/${encodeURIComponent(normalizedProjectId)}/browser-profile`,
    method: "DELETE",
    accessToken: params?.accessToken,
    fallbackError: "Unable to clear Shared Browser data",
    allowEmptyResponse: true,
  });
  if (!result.success) {
    return result;
  }
  return { success: true };
}
