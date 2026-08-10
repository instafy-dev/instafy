import {
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
} from "./core";

export interface ControllerJobCancelResult {
  ok: boolean;
  canceledRunIds: string[];
  canceledJobIds: string[];
}

function normalizeCanceledIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

async function postControllerJobCancel(params: {
  path: string;
  reason?: string | null;
  fallbackError: string;
}): Promise<ControllerJobCancelResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(null);
  const sessionToken = requestContext.accessToken;

  if (!sessionToken) {
    console.warn("[runtime-controller] No access token available; skipping job cancel.");
    return null;
  }

  const body = {
    reason: params.reason ?? undefined,
  };

  const response = await fetch(`${requestContext.baseUrl}${params.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await readControllerError(
      response,
      params.fallbackError,
      requestContext,
    );
    throw new Error(message);
  }

  const data = (await response.json()) as {
    ok?: unknown;
    canceledRunIds?: unknown;
    canceledJobIds?: unknown;
  } | null;
  return {
    ok: data?.ok === true,
    canceledRunIds: normalizeCanceledIds(data?.canceledRunIds),
    canceledJobIds: normalizeCanceledIds(data?.canceledJobIds),
  };
}

export async function cancelAgentJob(
  jobId: string,
  reason?: string,
): Promise<ControllerJobCancelResult | null> {
  return postControllerJobCancel({
    path: `/jobs/${encodeURIComponent(jobId)}/cancel`,
    reason: reason ?? null,
    fallbackError: "agent job cancel failed",
  });
}

export async function cancelPlanGroup(
  groupId: string,
  reason?: string,
): Promise<ControllerJobCancelResult | null> {
  return postControllerJobCancel({
    path: `/jobs/plan-groups/${encodeURIComponent(groupId)}/cancel`,
    reason: reason ?? null,
    fallbackError: "plan group cancel failed",
  });
}
