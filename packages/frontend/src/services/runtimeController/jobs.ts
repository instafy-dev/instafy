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

export interface ControllerPlanWorkerStatus {
  jobId: string;
  handle: string;
  status: string;
  summary?: string | null;
  lastMessage?: string | null;
  leaseMetrics?: Record<string, unknown> | null;
  /** The job the controller ran this one's agent again as (its result stands for this one's). */
  retriedAs?: string | null;
  /** Why: "turn_continuation" or "rate_limit". */
  retriedFor?: string | null;
  /**
   * The face the controller stamped on this job's agent (metadata.agent.avatarSeed,
   * "hatchling:<n>" for a helper). Optional: a controller from before faces
   * leaves it out.
   */
  avatarSeed?: string | null;
}

export interface ControllerPlanGroupStatus {
  groupId: string;
  workers: ControllerPlanWorkerStatus[];
}

/** A bounded historical lookup; live progress continues through the run feed. */
export async function fetchPlanGroupStatus(groupId: string, signal?: AbortSignal): Promise<ControllerPlanGroupStatus | null> {
  if (!runtimeControllerEnabled) return null;
  const context = await resolveControllerRequestContext(null);
  if (!context.accessToken) return null;
  const response = await fetch(`${context.baseUrl}/agent/plan-groups/${encodeURIComponent(groupId)}/status`, {
    headers: { authorization: `Bearer ${context.accessToken}` }, signal,
  });
  if (!response.ok) throw new Error(await readControllerError(response, "Could not load workstream status.", context));
  const value = await response.json() as ControllerPlanGroupStatus;
  if (value.groupId !== groupId || !Array.isArray(value.workers)) throw new Error("Invalid workstream status response.");
  return { groupId, workers: value.workers.filter(worker => worker && typeof worker.jobId === "string"
    && typeof worker.handle === "string" && typeof worker.status === "string") };
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
