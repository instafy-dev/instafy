import type { RunRecord } from "../../../types";
import type { RuntimeBrowserSessionAction } from "../../../sdk/instafy";
import { BROWSER_HANDS_BACK_METADATA_KEY } from "./browserRequest";

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

function runTimestamp(run: RunRecord): number {
  return Date.parse(run.updatedAt ?? run.createdAt ?? "") || 0;
}

/**
 * The browser run that Let AI continue continues: the newest Shared Browser
 * run of this conversation on this machine and page that the person started
 * and that has ended (they took over, or it stopped for their input). Studio
 * names it in the continuation's metadata (`browserContinuesRunId`); the
 * runtime carries that run's approvals into the new run only when it is the
 * last run that held the browser, for the same person on the same page.
 */
export function continuedSharedBrowserRunId(
  runs: readonly RunRecord[],
  scope: { conversationId: string | null; runtimeId: string | null; pageId: string | null; userId: string | null },
): string | null {
  if (!scope.conversationId || !scope.runtimeId || !scope.pageId || !scope.userId) return null;
  let newest: RunRecord | null = null;
  for (const run of runs) {
    const metadata = run.metadata;
    if (
      !UUID.test(run.id) ||
      run.conversationId !== scope.conversationId ||
      run.status === "queued" || run.status === "in_progress" || run.status === "awaiting_approval" ||
      metadata?.browserTransport !== "shared" ||
      metadata.browserRuntimeId !== scope.runtimeId ||
      metadata.browserPageId !== scope.pageId ||
      metadata.initiatingUserId !== scope.userId
    ) {
      continue;
    }
    if (!newest || runTimestamp(run) > runTimestamp(newest)) newest = run;
  }
  return newest?.id ?? null;
}

/**
 * How long after a browser turn a message from the chat still goes on in the
 * browser: as long as the runtime keeps that turn's approvals for a run that
 * continues it.
 */
export const SHARED_BROWSER_FOLLOW_UP_WINDOW_MS = 10 * 60_000;

function runStartedAt(run: RunRecord): number {
  return Date.parse(run.createdAt ?? run.updatedAt ?? "") || 0;
}

/** The browser turn a chat message continues, its tab, and until when that applies. */
export type SharedBrowserFollowUp<Page> = { runId: string; page: Page; endsAtMs: number };

/**
 * The browser turn a message from the chat continues in Instafy's browser,
 * and the tab it continues in. Only when the conversation's newest run is
 * this person's Shared Browser run on this browser, it finished successfully
 * within {@link SHARED_BROWSER_FOLLOW_UP_WINDOW_MS}, its tab is still open,
 * and it did not continue a card Octo builds from (`browserHandsBack`): a
 * browser turn has only the browser's tools, so after a building card's
 * browser turn the building turn keeps the chat, as it does with the
 * hand-back. Studio sends such a message as a browser turn in that tab,
 * naming the run it continues (`browserContinuesRunId`), so the runtime
 * carries the run's approvals over and no card or press stands in between;
 * the composer says so while it applies (useSharedBrowserFollowUp). Null
 * otherwise: the message is an ordinary chat turn.
 */
export function sharedBrowserFollowUp<Page extends { id: string }>(
  runs: readonly RunRecord[],
  scope: {
    conversationId: string | null;
    runtimeId: string | null;
    userId: string | null;
    pages: readonly Page[];
    nowMs?: number;
  },
): SharedBrowserFollowUp<Page> | null {
  if (!scope.conversationId || !scope.runtimeId || !scope.userId) return null;
  let newest: RunRecord | null = null;
  for (const run of runs) {
    if (run.conversationId !== scope.conversationId) continue;
    if (!newest || runStartedAt(run) > runStartedAt(newest)) newest = run;
  }
  const metadata = newest?.metadata;
  if (
    !newest || !UUID.test(newest.id) || newest.status !== "success" ||
    metadata?.browserTransport !== "shared" ||
    metadata.browserRuntimeId !== scope.runtimeId ||
    metadata.initiatingUserId !== scope.userId ||
    metadata[BROWSER_HANDS_BACK_METADATA_KEY] === true
  ) {
    return null;
  }
  const endedAt = runTimestamp(newest);
  const endsAtMs = endedAt + SHARED_BROWSER_FOLLOW_UP_WINDOW_MS;
  if (!endedAt || (scope.nowMs ?? Date.now()) > endsAtMs) return null;
  const page = scope.pages.find((candidate) => candidate.id === metadata.browserPageId);
  return page ? { runId: newest.id, page, endsAtMs } : null;
}

function activeSharedBrowserRuns(runs: readonly RunRecord[], runtimeId: string): RunRecord[] {
  return runs.filter((run) => {
    const metadata = run.metadata;
    return (run.status === "queued" || run.status === "in_progress" || run.status === "awaiting_approval") &&
      metadata?.browserTransport === "shared" && metadata.browserRuntimeId === runtimeId;
  });
}

/** The pages this runtime's active browser runs are bound to (the tabs their turns were sent for). */
export function sharedBrowserAgentPageIds(runs: readonly RunRecord[], runtimeId: string | null): string[] {
  if (!runtimeId) return [];
  const pageIds = activeSharedBrowserRuns(runs, runtimeId)
    .map((run) => run.metadata?.browserPageId)
    .filter((pageId): pageId is string => typeof pageId === "string" && pageId.trim().length > 0);
  return Array.from(new Set(pageIds));
}

/**
 * Cancel only one authoritative browser job, never all conversation jobs.
 * The job is the one bound to the page on screen. On a tab the agent opened
 * itself (`openedByAgent`), or on any tab while the browser reports that the
 * agent holds it (`agentHoldsBrowser`), it is the one browser job on that
 * runtime, since the agent's control spans every tab of that browser: Take
 * over stays reachable whichever tab is on screen. That fallback takes only
 * a run that has started, since a queued one cannot hold the browser.
 * Otherwise a person's own tab never falls back to a runtime-wide job.
 */
export function sharedBrowserTakeoverJob(
  runs: RunRecord[],
  runtimeId: string | null,
  pageId: string | null,
  options: { openedByAgent?: boolean; agentHoldsBrowser?: boolean } = {},
): { jobId: string; runId: string } | null {
  if (!runtimeId || !pageId) return null;
  const onRuntime = activeSharedBrowserRuns(runs, runtimeId);
  const onPage = onRuntime.filter((run) => run.metadata?.browserPageId === pageId);
  const runtimeWide = options.openedByAgent === true || options.agentHoldsBrowser === true;
  // Only a run that has started can hold the browser. A run of this
  // conversation still queued behind another conversation's run, which holds
  // the browser now, is never the job Take over stops from a tab it is not
  // bound to.
  const started = onRuntime.filter((run) => run.status !== "queued");
  const matches = onPage.length === 0 && runtimeWide ? started : onPage;
  if (matches.length !== 1) return null;
  const run = matches[0];
  const jobId = run.metadata?.jobId;
  return typeof jobId === "string" && UUID.test(jobId) ? { jobId, runId: run.id } : null;
}
