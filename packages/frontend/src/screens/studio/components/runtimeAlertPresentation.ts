import { parseHostedRuntimeLimitError } from "../../../runtime/hostedRuntimeLimitError";

const RECOVERABLE_RUNTIME_START_STATUSES = new Set([
  "requested",
  "starting",
  "launching",
  "provisioning",
  "pending",
]);

function normalizeStatus(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function statusFromDetail(value: unknown): string | null {
  const detail = normalizeStatus(value);
  if (!detail) {
    return null;
  }
  const match = detail.match(/(?:^|,)\s*status\s*=\s*([^,\s]+)/i);
  return normalizeStatus(match?.[1]);
}

/**
 * A reconnect the team's runtime limit refused. The start did not fail: every
 * cloud runtime the team's plan allows is in use, in another space or in this
 * one, and the request waits for one to stop. It used to read "Workspace
 * startup failed", beside a live line saying the machine was busy. The
 * controller now records the refusal's code; older records carry only the
 * text, which names the limit.
 */
export function isRuntimeLimitWaitAlert(details: Record<string, unknown> | null | undefined): boolean {
  const reconnect = details?.reconnect;
  if (typeof reconnect !== "object" || reconnect === null || Array.isArray(reconnect)) {
    return false;
  }
  const record = reconnect as Record<string, unknown>;
  if (normalizeStatus(record.status) !== "failed") {
    return false;
  }
  if (normalizeStatus(record.code) === "runtime_limit_reached") {
    return true;
  }
  return parseHostedRuntimeLimitError(typeof record.error === "string" ? record.error : null).limitReached;
}

/**
 * Keep the cold-start policy identical wherever runtime alerts are rendered.
 * Unknown states stay visible: only a known in-progress status (or legacy copy
 * that explicitly says it is starting/connecting) is safe to collapse.
 */
export function isRecoverableRuntimeStartAlert(
  details: Record<string, unknown> | null | undefined,
  legacyContent?: string | null,
): boolean {
  const reconnect = details?.reconnect;
  const reconnectStatus =
    typeof reconnect === "object" && reconnect !== null && !Array.isArray(reconnect)
      ? normalizeStatus((reconnect as Record<string, unknown>).status)
      : null;
  if (reconnectStatus) {
    return RECOVERABLE_RUNTIME_START_STATUSES.has(reconnectStatus);
  }

  const runtimeStatus =
    statusFromDetail(details?.detail) ?? normalizeStatus(details?.runtimeStatus);
  if (runtimeStatus) {
    return RECOVERABLE_RUNTIME_START_STATUSES.has(runtimeStatus);
  }

  const normalizedContent = normalizeStatus(legacyContent);
  return Boolean(
    normalizedContent &&
      (normalizedContent.includes("still starting") ||
        normalizedContent.includes("is starting") ||
        normalizedContent.includes("has not connected yet") ||
        normalizedContent.includes("connecting")),
  );
}

/**
 * A persisted runtime alert is demoted to a history line only when a newer
 * workspace start clearly post-dates it. The grace absorbs client/server
 * clock skew on persisted timestamps and keeps the alert that belongs to the
 * very ensure now in progress at full volume.
 */
export const RUNTIME_ALERT_SUPERSEDE_GRACE_MS = 30_000;

export function isRuntimeAlertSupersededByStart(input: {
  alertTimestamp: number | null | undefined;
  workspaceStarting: boolean;
  workspaceStartingSince: number | null;
}): boolean {
  if (!input.workspaceStarting || input.workspaceStartingSince === null) {
    return false;
  }
  if (typeof input.alertTimestamp !== "number" || !Number.isFinite(input.alertTimestamp)) {
    return false;
  }
  return input.alertTimestamp < input.workspaceStartingSince - RUNTIME_ALERT_SUPERSEDE_GRACE_MS;
}

/**
 * Whether the space's machine has to start before the chat's turn can run: a
 * start this page asked for, a queued run while no machine is ready, or a turn
 * on its way with no run yet while none is (its send starts one). Only then
 * does the turn read "Starting…"; on a running machine it reads "Thinking…".
 */
export function resolveWorkspaceStarting(input: {
  waitingForPreferredRuntime: boolean;
  hostedRuntimeEnsuring: boolean;
  runtimeReady: boolean;
  /** The chat's active run, or null while the page has none. */
  activeRunStatus: string | null;
  /** A turn of the chat is on its way or running (the typing row shows). */
  turnPending: boolean;
}): boolean {
  if (input.waitingForPreferredRuntime || input.hostedRuntimeEnsuring) {
    return true;
  }
  if (input.runtimeReady) {
    return false;
  }
  return input.activeRunStatus === "queued" || (input.turnPending && input.activeRunStatus === null);
}

export interface AgentWaitingRuntimeLimit {
  limitReached: boolean;
  blockerProjectLabel: string | null;
  /** The blocking machine's own name, which the waiting line does not use. */
  blockerRuntimeLabel: string | null;
}

export function resolveAgentWaitingActivityCopy(input: {
  displayNames: readonly string[];
  workspaceStarting: boolean;
  queued: boolean;
  runtimeLimit?: AgentWaitingRuntimeLimit | null;
  /**
   * The turn runs on a turn engine, which words its start itself
   * (turnEngineStartingLine). Such a turn never waits on a cloud runtime, so
   * this line also stands in for the runtime-busy notice.
   */
  turnEngineStartingLine?: string | null;
}): { label: string; ariaLabel: string; isRuntimeBusyNotice?: true } {
  const names = input.displayNames.filter((name) => name.trim().length > 0);
  const multiple = names.length > 1;
  const subject = names.join(", ") || "Octo";

  if (input.turnEngineStartingLine) {
    return { label: input.turnEngineStartingLine, ariaLabel: `${subject}: ${input.turnEngineStartingLine}` };
  }

  // The runtime slot wall must out-rank every generic waiting phrase: a
  // message queued behind runtime_limit_reached will not send until a hosted
  // machine is free, and "Starting…" reads as progress where there is none.
  // It opens as the chat's "Waiting for a machine" card does, in the words the
  // controller stores for it (RUNTIME_LIMIT_WAIT_MESSAGE), so the two read as
  // one wait. The controller keeps retrying the launch; after 30 minutes it
  // gives up and fails the message with a reason (runtime/limit_waits.rs),
  // which is the bound this copy promises. It names the blocker's space when
  // the refusal does, and no place otherwise: the machine holding the slot can
  // be in this same space. It does not promise that an idle machine is taken
  // over either: the controller never takes one from this same space, and the
  // takeover can be turned off (RUNTIME_LIMIT_RECLAIM_IDLE_SECONDS).
  if (input.runtimeLimit?.limitReached && (input.workspaceStarting || input.queued)) {
    // A machine's own name is no place to stop it in, so only a space is named.
    const space = input.runtimeLimit.blockerProjectLabel;
    const where = space ? `"${space}"` : "Machines";
    const label = `Waiting for a free hosted machine. Stop one in ${where} and this message sends. It waits up to 30 minutes.`;
    // A notice to read, not a status line: the typing row lets it wrap.
    return { label, ariaLabel: label, isRuntimeBusyNotice: true };
  }

  // Starting the workspace, waiting behind another turn and getting ready
  // used to be three labels inside a second; the row holds one word from the
  // send until the turn's first step, picked by what the turn waits on. Only
  // a machine that has to start first reads "Starting…" (a start that stalls
  // becomes its own notice, useStalledWorkspaceStart). On a running machine
  // the turn is the model at work, also while it waits for its lease or
  // behind another turn: "Thinking…", as the turn's own line reads.
  if (input.workspaceStarting) {
    return {
      label: "Starting…",
      ariaLabel: `${subject} ${multiple ? "are" : "is"} starting`,
    };
  }
  return {
    label: "Thinking…",
    ariaLabel: `${subject} ${multiple ? "are" : "is"} thinking`,
  };
}
