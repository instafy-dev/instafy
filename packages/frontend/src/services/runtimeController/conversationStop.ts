import { readControllerError, resolveControllerRequestContext, runtimeControllerEnabled } from "./core";

export interface ControllerConversationStopResult {
  ok: boolean;
  canceledJobIds: string[];
  canceledRunIds: string[];
  alreadyFinishedJobIds: string[];
}

function ids(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

/** An exact set of jobs, never a conversation-wide interrupt or a retry fallback. */
export async function stopConversationJobs(
  conversationId: string,
  jobIds: readonly string[],
): Promise<ControllerConversationStopResult> {
  if (!runtimeControllerEnabled) throw new Error("Stopping is unavailable. Try again when connected.");
  const context = await resolveControllerRequestContext(null);
  if (!context.accessToken) throw new Error("Sign in again to stop this turn.");
  const response = await fetch(`${context.baseUrl}/conversations/${encodeURIComponent(conversationId)}/stop`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${context.accessToken}` },
    body: JSON.stringify({ jobIds: [...new Set(jobIds)] }),
  });
  if (!response.ok) throw new Error(await readControllerError(response, "Could not request a stop. Try again.", context));
  const result = await response.json() as Partial<ControllerConversationStopResult> | null;
  return {
    ok: result?.ok === true,
    canceledJobIds: ids(result?.canceledJobIds),
    canceledRunIds: ids(result?.canceledRunIds),
    alreadyFinishedJobIds: ids(result?.alreadyFinishedJobIds),
  };
}
