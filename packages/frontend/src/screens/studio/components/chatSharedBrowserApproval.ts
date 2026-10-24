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

function runTimestamp(run: RunRecord): number {
  return Date.parse(run.updatedAt ?? run.createdAt ?? "") || 0;
}

/**
 * The newest running Instafy's browser run of these runs that the viewer
 * started, with the machine and page it works on; null otherwise.
 * `initiatingUserId` is set by the controller from the run's first job, never
 * by the caller, and is the id the runtime binds the run's prompts to. This is
 * only a gate for what the chat polls: the origin still answers a prompt only
 * to the person who started the run.
 */
export function selectChatSharedBrowserApprovalTarget(
  runs: readonly RunRecord[],
  userId: string | null,
): ChatSharedBrowserApprovalTarget | null {
  if (!userId) return null;
  let newest: { run: RunRecord; metadata: Record<string, unknown> } | null = null;
  for (const run of runs) {
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
      continue;
    }
    if (!newest || runTimestamp(run) > runTimestamp(newest.run)) {
      newest = { run, metadata };
    }
  }
  if (!newest) return null;
  return {
    runId: newest.run.id,
    runtimeId: (newest.metadata.browserRuntimeId as string).toLowerCase(),
    browserPageId: newest.metadata.browserPageId as string,
    runMetadata: newest.metadata,
  };
}
