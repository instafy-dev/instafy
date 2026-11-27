import type { RunRecord } from "../types";
import { isRecord } from "../utils/isRecord";

/**
 * The key, on a run's metadata, of the runs and the agents whose turns it
 * waits for. Only the controller writes it (RC/message_turns.rs).
 */
export const MESSAGE_TURNS_KEY = "takesTurns";

const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "awaiting_approval"]);

type RunsById<Fields extends keyof RunRecord> =
  | Readonly<Record<string, Pick<RunRecord, Fields>>>
  | null
  | undefined;

/**
 * The runs and agents a queued turn waits for, in the order the message
 * names them (docs/Local-Engine-Turns.md 11.22): a message that names several
 * agents runs their turns one after another. Empty for a run that is not
 * queued, and for one that waits for none or carries no version 1 stamp.
 */
function earlierTurns(
  run: Pick<RunRecord, "status" | "metadata"> | null | undefined,
): Array<{ runId: string; agent: string }> {
  if (!run || run.status !== "queued") {
    return [];
  }
  const stamp = isRecord(run.metadata) ? run.metadata[MESSAGE_TURNS_KEY] : null;
  if (!isRecord(stamp) || stamp["version"] !== 1 || !Array.isArray(stamp["after"])) {
    return [];
  }
  const turns: Array<{ runId: string; agent: string }> = [];
  for (const entry of stamp["after"]) {
    const runId = isRecord(entry) && typeof entry["runId"] === "string" ? entry["runId"] : "";
    const agent = isRecord(entry) && typeof entry["agent"] === "string" ? entry["agent"].trim() : "";
    if (runId && agent) {
      turns.push({ runId, agent });
    }
  }
  return turns;
}

/**
 * The agent whose turn a queued turn waits for: of the earlier turns of its
 * message whose runs the page has, the latest that has not ended. Null once
 * they have all ended, when the page has none of their runs, and for a turn
 * that waits for none.
 */
function earlierTurnAgent(
  run: Pick<RunRecord, "status" | "metadata"> | null | undefined,
  runs: RunsById<"status">,
): string | null {
  const turns = earlierTurns(run);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const earlier = runs?.[turn.runId];
    if (earlier && ACTIVE_RUN_STATUSES.has(earlier.status)) {
      return turn.agent;
    }
  }
  return null;
}

/**
 * When the last of the earlier turns a queued turn waited for ended, as epoch
 * ms: the latest update of their runs, once none of them is still running.
 * Zero when the turn waits for none, the page has none of their runs, or one
 * of them is still running. A turn's own wait starts no earlier.
 */
export function earlierTurnEndedAtMs(
  run: Pick<RunRecord, "status" | "metadata"> | null | undefined,
  runs: RunsById<"status" | "updatedAt">,
): number {
  let endedAt = 0;
  for (const turn of earlierTurns(run)) {
    const earlier = runs?.[turn.runId];
    if (!earlier) {
      continue;
    }
    if (ACTIVE_RUN_STATUSES.has(earlier.status)) {
      return 0;
    }
    const updatedAt = Date.parse(earlier.updatedAt ?? "");
    if (Number.isFinite(updatedAt)) {
      endedAt = Math.max(endedAt, updatedAt);
    }
  }
  return endedAt;
}

/**
 * Whether a queued turn waits for an earlier agent's turn of its message,
 * which has not ended: it is not stuck, however long that turn takes.
 */
export function waitsForEarlierTurn(
  run: Pick<RunRecord, "status" | "metadata"> | null | undefined,
  runs: RunsById<"status">,
): boolean {
  return earlierTurnAgent(run, runs) !== null;
}

/**
 * What a queued turn reads while it waits for an earlier agent's turn
 * ({@link waitsForEarlierTurn}), or null, so the turn then reads what it
 * would otherwise.
 */
export function earlierTurnWaitingLine(
  run: Pick<RunRecord, "status" | "metadata"> | null | undefined,
  runs: RunsById<"status">,
): string | null {
  const agent = earlierTurnAgent(run, runs);
  return agent ? `Waiting for @${agent} to finish…` : null;
}
