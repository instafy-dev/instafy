import { controllerJsonRequest } from "./client";

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
