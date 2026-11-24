import type { RunRecord } from "../types";

/**
 * The key, on a run's metadata, of the run and the agent whose turn it waits
 * for. Only the controller writes it (RC/message_turns.rs).
 */
export const MESSAGE_TURNS_KEY = "takesTurns";

const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "awaiting_approval"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The agent whose turn a queued turn waits for, while that turn has not
 * ended (docs/Local-Engine-Turns.md 11.22): a message that names several
 * agents runs their turns one after another, in the order it names them.
 * Null once that turn has ended, when the page does not have its run, and for
 * any turn that waits for none.
 */
function earlierTurnAgent(
  run: Pick<RunRecord, "status" | "metadata"> | null | undefined,
  runs: Readonly<Record<string, Pick<RunRecord, "status">>> | null | undefined,
): string | null {
  if (!run || run.status !== "queued") {
    return null;
  }
  const stamp = isRecord(run.metadata) ? run.metadata[MESSAGE_TURNS_KEY] : null;
  if (!isRecord(stamp) || stamp["version"] !== 1) {
    return null;
  }
  const afterRunId = typeof stamp["afterRunId"] === "string" ? stamp["afterRunId"] : "";
  const afterAgent = typeof stamp["afterAgent"] === "string" ? stamp["afterAgent"].trim() : "";
  if (!afterRunId || !afterAgent) {
    return null;
  }
  const earlier = runs?.[afterRunId];
  return earlier && ACTIVE_RUN_STATUSES.has(earlier.status) ? afterAgent : null;
}

/**
 * Whether a queued turn waits for the turn of the agent named before it,
 * which has not ended: it is not stuck, however long that turn takes.
 */
export function waitsForEarlierTurn(
  run: Pick<RunRecord, "status" | "metadata"> | null | undefined,
  runs: Readonly<Record<string, Pick<RunRecord, "status">>> | null | undefined,
): boolean {
  return earlierTurnAgent(run, runs) !== null;
}

/**
 * What a queued turn reads while it waits for the turn of the agent named
 * before it ({@link waitsForEarlierTurn}), or null, so the turn then reads
 * what it would otherwise.
 */
export function earlierTurnWaitingLine(
  run: Pick<RunRecord, "status" | "metadata"> | null | undefined,
  runs: Readonly<Record<string, Pick<RunRecord, "status">>> | null | undefined,
): string | null {
  const agent = earlierTurnAgent(run, runs);
  return agent ? `Waiting for @${agent} to finish…` : null;
}
