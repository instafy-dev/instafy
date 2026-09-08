import type { RunRecord } from "../../../types";
import type { RuntimeBrowserSessionAction } from "../../../sdk/instafy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function browserPageOrigin(url: string | null | undefined): string | null {
  try {
    const parsed = new URL(url ?? "");
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.origin : null;
  } catch { return null; }
}

/** Include terminal runs: requesting human input ends the original browser turn. */
export function sharedBrowserConversationRunIds(
  runs: readonly RunRecord[],
  scope: { projectId: string | null; conversationId: string | null; runtimeId: string | null; pageId: string | null },
): ReadonlySet<string> {
  if (!scope.projectId || !scope.conversationId || !scope.runtimeId || !scope.pageId) return new Set();
  return new Set(runs.filter((run) =>
    run.projectId === scope.projectId && run.conversationId === scope.conversationId &&
    run.metadata?.browserTransport === "shared" && run.metadata.browserRuntimeId === scope.runtimeId &&
    run.metadata.browserPageId === scope.pageId,
  ).map((run) => run.id));
}

export function selectSharedBrowserHumanInput(
  actions: RuntimeBrowserSessionAction[], userId: string | null, pageId: string | null, origin: string | null,
  conversationRunIds: ReadonlySet<string> | null,
) {
  if (!userId || !pageId || !origin || !conversationRunIds?.size) return null;
  // A newer request replaces the prior one, including when it belongs to
  // another user. Never resurrect old guidance from the action log.
  let latestRequestIndex = actions.length - 1;
  while (latestRequestIndex >= 0 && actions[latestRequestIndex].type !== "human_input") latestRequestIndex -= 1;
  const request = actions[latestRequestIndex]?.humanInputRequest;
  if (actions.slice(latestRequestIndex + 1).some((action) => action.type === "navigate" || action.type === "nav_result")) return null;
  return request && conversationRunIds.has(request.runId) && request.initiatorUserId === userId && request.browserPageId === pageId && request.origin === origin && request.expiresAtMs > Date.now()
    ? request : null;
}

/** Cancel only one authoritative browser job, never all conversation jobs. */
export function sharedBrowserTakeoverJob(runs: RunRecord[], runtimeId: string | null, pageId: string | null): { jobId: string; runId: string } | null {
  if (!runtimeId || !pageId) return null;
  const matches = runs.filter((run) => {
    const metadata = run.metadata;
    return (run.status === "queued" || run.status === "in_progress" || run.status === "awaiting_approval") &&
      metadata?.browserTransport === "shared" && metadata.browserRuntimeId === runtimeId && metadata.browserPageId === pageId;
  });
  if (matches.length !== 1) return null;
  const run = matches[0];
  const jobId = run.metadata?.jobId;
  return typeof jobId === "string" && UUID.test(jobId) ? { jobId, runId: run.id } : null;
}
