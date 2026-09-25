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
 * A reconnect the team's machine limit refused. The start did not fail: the
 * one machine the team may run is busy in another space, and the request is
 * waiting for it. It used to read "Workspace startup failed", beside a live
 * line saying the machine was busy. The controller now records the refusal's
 * code; older records carry only the text, which names the limit.
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

export interface AgentWaitingRuntimeLimit {
  limitReached: boolean;
  blockerProjectLabel: string | null;
  blockerRuntimeLabel: string | null;
}

export function resolveAgentWaitingActivityCopy(input: {
  displayNames: readonly string[];
  workspaceStarting: boolean;
  queued: boolean;
  runtimeLimit?: AgentWaitingRuntimeLimit | null;
}): { label: string; ariaLabel: string } {
  const names = input.displayNames.filter((name) => name.trim().length > 0);
  const multiple = names.length > 1;
  const subject = names.join(", ") || "Octo";

  // The runtime slot wall must out-rank every generic waiting phrase: a
  // message queued behind runtime_limit_reached will not send until the
  // blocking runtime stops, and "starting its workspace…" reads as progress
  // where there is none. The controller keeps retrying the launch and takes
  // over the blocking runtime once it has been idle for a couple of minutes;
  // after 30 minutes it gives up and fails the message with a reason
  // (runtime/limit_waits.rs), which is the bound this copy promises.
  if (input.runtimeLimit?.limitReached && (input.workspaceStarting || input.queued)) {
    const blocker =
      input.runtimeLimit.blockerProjectLabel ??
      input.runtimeLimit.blockerRuntimeLabel;
    const where = blocker ? `"${blocker}"` : "another project";
    const label = `Your cloud runtime is busy in ${where}. Stop it there or let it go idle, and this message sends once a runtime is free. It waits up to 30 minutes.`;
    return { label, ariaLabel: label };
  }

  if (input.workspaceStarting) {
    return multiple
      ? {
          label: `${subject} are starting their workspaces…`,
          ariaLabel: `${subject} are starting their workspaces`,
        }
      : {
          label: `${subject} is starting its workspace…`,
          ariaLabel: `${subject} is starting its workspace`,
        };
  }

  if (input.queued) {
    return multiple
      ? {
          label: `${subject} are waiting for their turns…`,
          ariaLabel: `${subject} are waiting for their turns`,
        }
      : {
          label: `${subject} is waiting for its turn…`,
          ariaLabel: `${subject} is waiting for its turn`,
        };
  }

  return multiple
    ? {
        label: `${subject} are getting ready…`,
        ariaLabel: `${subject} are getting ready`,
      }
    : {
        label: `${subject} is getting ready…`,
        ariaLabel: `${subject} is getting ready`,
      };
}
