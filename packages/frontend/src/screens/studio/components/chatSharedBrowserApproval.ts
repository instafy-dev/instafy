import { isRunActivelyProgressing } from "../../../conversations/runLiveness";
import type { RunRecord } from "../../../types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// The runtime's own bound for a browser page id (one CDP target id).
const PAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/** The running Instafy's browser job whose prompts the chat polls for. */
export type ChatSharedBrowserApprovalTarget = {
  runId: string;
  /** Lowercased: the origin compares the grant's runtime claim exactly. */
  runtimeId: string;
  /** The job's own page, the one its prompts are bound to (not the tab on screen). */
  browserPageId: string;
  runMetadata: Record<string, unknown>;
};

/** A running Instafy's browser job of the person's, with the chat it works for. */
export type SpaceSharedBrowserApprovalTarget = ChatSharedBrowserApprovalTarget & {
  /** The chat's controller id, lowercased. */
  conversationId: string;
};

function runTimestamp(run: RunRecord): number {
  return Date.parse(run.updatedAt ?? run.createdAt ?? "") || 0;
}

/**
 * The run, with the machine and page it works on, when it is a running
 * Instafy's browser run the viewer started; null otherwise.
 * `initiatingUserId` is set by the controller from the run's first job, never
 * by the caller, and is the id the runtime binds the run's prompts to.
 */
function approvalTargetOf(run: RunRecord, userId: string): ChatSharedBrowserApprovalTarget | null {
  const metadata = run.metadata;
  if (
    run.status !== "in_progress" ||
    !UUID_PATTERN.test(run.id) ||
    !metadata ||
    metadata.browserTransport !== "shared" ||
    metadata.initiatingUserId !== userId ||
    typeof metadata.browserRuntimeId !== "string" ||
    !UUID_PATTERN.test(metadata.browserRuntimeId) ||
    typeof metadata.browserPageId !== "string" ||
    !PAGE_ID_PATTERN.test(metadata.browserPageId)
  ) {
    return null;
  }
  return {
    runId: run.id,
    runtimeId: metadata.browserRuntimeId.toLowerCase(),
    browserPageId: metadata.browserPageId,
    runMetadata: metadata,
  };
}

/**
 * The newest running Instafy's browser run of these runs that the viewer
 * started, with the machine and page it works on; null otherwise. This is
 * only a gate for what the chat polls: the origin still answers a prompt only
 * to the person who started the run.
 */
export function selectChatSharedBrowserApprovalTarget(
  runs: readonly RunRecord[],
  userId: string | null,
): ChatSharedBrowserApprovalTarget | null {
  if (!userId) return null;
  let newest: { run: RunRecord; target: ChatSharedBrowserApprovalTarget } | null = null;
  for (const run of runs) {
    const target = approvalTargetOf(run, userId);
    if (target && (!newest || runTimestamp(run) > runTimestamp(newest.run))) {
      newest = { run, target };
    }
  }
  return newest?.target ?? null;
}

/**
 * The browser runs of the space whose prompts can reach the viewer outside
 * their chat: on each machine, the newest running Instafy's browser run the
 * viewer started, unless it works for `chatOnScreen` (that chat polls its own
 * run). Only the run that holds a machine's browser can ask there, and a run
 * that starts takes it over, so one read a machine covers every chat. Runs of
 * another space, without a chat, or no longer live are left out.
 */
export function selectSpaceSharedBrowserApprovalTargets(
  runs: readonly RunRecord[],
  options: { userId: string | null; projectId: string | null; chatOnScreen: string | null; nowMs?: number },
): SpaceSharedBrowserApprovalTarget[] {
  const { userId, projectId } = options;
  if (!userId || !projectId) return [];
  const nowMs = options.nowMs ?? Date.now();
  const newestByMachine = new Map<string, { run: RunRecord; target: SpaceSharedBrowserApprovalTarget }>();
  for (const run of runs) {
    const target = run.projectId === projectId && isRunActivelyProgressing(run, nowMs) ? approvalTargetOf(run, userId) : null;
    const conversationId = run.conversationId?.trim().toLowerCase() ?? "";
    if (!target || !UUID_PATTERN.test(conversationId)) continue;
    const newest = newestByMachine.get(target.runtimeId);
    if (!newest || runTimestamp(run) > runTimestamp(newest.run)) {
      newestByMachine.set(target.runtimeId, { run, target: { ...target, conversationId } });
    }
  }
  const onScreen = options.chatOnScreen?.trim().toLowerCase() ?? "";
  return [...newestByMachine.values()]
    .map(({ target }) => target)
    .filter((target) => target.conversationId !== onScreen);
}
