import {
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
} from "./core";

export interface ProjectEditorInlineCompletionParams {
  projectId: string;
  path: string;
  prefix: string;
  suffix: string;
  language?: string | null;
  credentialId?: string | null;
  accessToken?: string | null;
  signal?: AbortSignal;
}

export interface ProjectEditorInlineCompletionResult {
  success: boolean;
  completion: string | null;
  provider?: string | null;
  model?: string | null;
  credentialId?: string | null;
  error?: string;
}

export async function requestProjectEditorInlineCompletion(
  params: ProjectEditorInlineCompletionParams,
): Promise<ProjectEditorInlineCompletionResult> {
  if (!runtimeControllerEnabled) {
    return { success: false, completion: null, error: "Runtime controller is not configured." };
  }

  const projectId = params.projectId.trim();
  const path = params.path.trim();
  if (!projectId) {
    return { success: false, completion: null, error: "Missing project id." };
  }
  if (!path) {
    return { success: false, completion: null, error: "Missing file path." };
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, completion: null, error: "Missing controller session token." };
  }

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/projects/${encodeURIComponent(projectId)}/editor/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${resolvedAccessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          path,
          prefix: params.prefix,
          suffix: params.suffix,
          language: params.language ?? null,
          credentialId: params.credentialId ?? null,
        }),
        signal: params.signal,
      },
    );

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to load editor completion",
        requestContext,
      );
      return { success: false, completion: null, error: errorMessage };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return {
      success: true,
      completion: typeof payload.completion === "string" ? payload.completion : null,
      provider: typeof payload.provider === "string" ? payload.provider : null,
      model: typeof payload.model === "string" ? payload.model : null,
      credentialId: typeof payload.credentialId === "string" ? payload.credentialId : null,
      error: typeof payload.error === "string" ? payload.error : undefined,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { success: false, completion: null, error: "Request aborted." };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, completion: null, error: `Unable to load editor completion: ${message}` };
  }
}
