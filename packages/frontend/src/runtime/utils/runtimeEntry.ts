import type { ControllerRuntimeStatusEntry } from "../../sdk/instafy";
import { isPersonRuntimeStopReason } from "../unexpectedHostedRuntimeRecovery";

export type RuntimeConnectionState =
  | "connected"
  | "connecting"
  | "disconnected"
  | "unknown";

export function runtimeEntryIsReady(
  entry: ControllerRuntimeStatusEntry | null | undefined,
): boolean {
  if (!entry) {
    return false;
  }
  const status = (entry.status ?? "").toLowerCase();
  const health = (entry.health ?? "").toLowerCase();
  const statusReady =
    status.length === 0 ||
    status === "ready" ||
    status === "running";
  const healthReady = health === "online" || health === "idle";
  return statusReady && healthReady;
}

function parseIsoTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function runtimeEntryIsExpired(
  entry: ControllerRuntimeStatusEntry | null | undefined,
  options?: { nowMs?: number },
): boolean {
  if (!entry) {
    return true;
  }
  const lastSeenAtMs = parseIsoTimestamp(entry.lastSeenAt ?? null);
  if (lastSeenAtMs === null) {
    return false;
  }
  const idleTtlSeconds =
    typeof entry.idleTtlSeconds === "number" && Number.isFinite(entry.idleTtlSeconds)
      ? entry.idleTtlSeconds
      : null;
  if (!idleTtlSeconds || idleTtlSeconds <= 0) {
    return false;
  }
  const nowMs = options?.nowMs ?? Date.now();
  return nowMs - lastSeenAtMs > idleTtlSeconds * 1000;
}

export function runtimeEntryIsDispatchable(
  entry: ControllerRuntimeStatusEntry | null | undefined,
  options?: { nowMs?: number },
): boolean {
  if (!runtimeEntryIsReady(entry)) {
    return false;
  }
  return !runtimeEntryIsExpired(entry, options);
}

const BOOTING_STATUS_SET = new Set([
  "requested",
  "requesting",
  "registering",
  "launching",
  "starting",
]);

const DEFAULT_BOOTING_STALE_MS = 3 * 60 * 1000;

function resolveRuntimeFreshnessTimestampMs(
  entry: ControllerRuntimeStatusEntry | null | undefined,
): number | null {
  if (!entry) {
    return null;
  }
  const candidates = [
    entry.lastSeenAt ?? null,
    entry.createdAt ?? null,
    entry.agentTokenIssuedAt ?? null,
  ];
  for (const candidate of candidates) {
    const timestamp = parseIsoTimestamp(candidate);
    if (timestamp !== null) {
      return timestamp;
    }
  }
  return null;
}

export function runtimeEntryIsStaleBooting(
  entry: ControllerRuntimeStatusEntry | null | undefined,
  options?: { nowMs?: number; staleAfterMs?: number },
): boolean {
  if (!entry) {
    return false;
  }
  const status = (entry.status ?? "").toLowerCase();
  const originStatus = (entry.origin?.status ?? "").toLowerCase();
  const isBootingStatus =
    BOOTING_STATUS_SET.has(status) ||
    BOOTING_STATUS_SET.has(originStatus) ||
    originStatus === "booting";
  if (!isBootingStatus) {
    return false;
  }
  const timestampMs = resolveRuntimeFreshnessTimestampMs(entry);
  if (timestampMs === null) {
    return false;
  }
  const nowMs = options?.nowMs ?? Date.now();
  const idleTtlMs =
    typeof entry.idleTtlSeconds === "number" && Number.isFinite(entry.idleTtlSeconds)
      ? Math.max(0, entry.idleTtlSeconds) * 1000
      : 0;
  const staleAfterMs =
    options?.staleAfterMs ?? Math.max(DEFAULT_BOOTING_STALE_MS, idleTtlMs);
  return nowMs - timestampMs > staleAfterMs;
}

export function runtimeEntryIsBooting(
  entry: ControllerRuntimeStatusEntry,
  options?: { nowMs?: number; staleAfterMs?: number },
): boolean {
  const status = (entry.status ?? "").toLowerCase();
  if (BOOTING_STATUS_SET.has(status)) {
    return !runtimeEntryIsStaleBooting(entry, options);
  }
  const originStatus = (entry.origin?.status ?? "").toLowerCase();
  if (BOOTING_STATUS_SET.has(originStatus) || originStatus === "booting") {
    return !runtimeEntryIsStaleBooting(entry, options);
  }
  return false;
}

function isCloudProvider(entry: ControllerRuntimeStatusEntry): boolean {
  const provider = (entry.provider ?? "").trim().toLowerCase();
  return provider === "instafy-cloud" || provider === "instafy_cloud";
}

export function isSelfHostedRuntime(
  entry: ControllerRuntimeStatusEntry,
): boolean {
  if (entry.isLocal) {
    return true;
  }
  if (!isCloudProvider(entry) && (entry.provider ?? "").trim().length > 0) {
    return true;
  }
  const endpoint =
    entry.origin?.endpoint?.trim() ?? entry.endpointUrl?.trim() ?? "";
  if (endpoint.length === 0) {
    return false;
  }
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0"
    );
  } catch (_error) {
    return false;
  }
}

export function isHostedRuntime(entry: ControllerRuntimeStatusEntry): boolean {
  return !isSelfHostedRuntime(entry);
}

/**
 * When this runtime's current machine was launched. A hosted runtime keeps one
 * runtime row across launches, so its `createdAt` is when the space first had
 * one; the active lease's `launchRequestedAt` is when this machine was asked
 * for. Other runtimes keep their row's creation time.
 */
export function runtimeEntryLaunchedAt(entry: ControllerRuntimeStatusEntry): string | null {
  const hostedLaunch =
    !entry.isLocal && isHostedRuntime(entry) ? (entry.launchRequestedAt ?? null) : null;
  return hostedLaunch ?? entry.createdAt ?? entry.agentTokenIssuedAt ?? entry.lastSeenAt ?? null;
}

/**
 * How long a hosted launch may go without coming up before Studio offers to
 * replace it. The controller replaces one on an explicit retry only after the
 * same five minutes (STALLED_LAUNCH_REPLACE_AFTER_SECONDS).
 */
export const STALLED_LAUNCH_AFTER_MS = 5 * 60_000;

/**
 * When this entry's launch becomes stalled: a hosted runtime still in a
 * booting status that has never been seen, measured from when its lease was
 * requested. Null when it never will, including for a controller that does
 * not report launchRequestedAt.
 */
export function stalledLaunchDeadlineMs(
  entry: ControllerRuntimeStatusEntry | null | undefined,
): number | null {
  if (!entry || entry.isLocal || !isHostedRuntime(entry)) {
    return null;
  }
  if (!BOOTING_STATUS_SET.has((entry.status ?? "").toLowerCase())) {
    return null;
  }
  if (entry.lastSeenAt) {
    return null;
  }
  const requestedAtMs = parseIsoTimestamp(entry.launchRequestedAt ?? null);
  return requestedAtMs === null ? null : requestedAtMs + STALLED_LAUNCH_AFTER_MS;
}

/**
 * The latest launch requested for a hosted runtime in `entries`, on the
 * controller's clock, or null when none reports one.
 */
export function latestHostedLaunchRequestedAtMs(
  entries: readonly (ControllerRuntimeStatusEntry | null | undefined)[],
): number | null {
  let latestMs: number | null = null;
  for (const entry of entries) {
    if (!entry || entry.isLocal || !isHostedRuntime(entry)) {
      continue;
    }
    const requestedAtMs = parseIsoTimestamp(entry.launchRequestedAt ?? null);
    if (requestedAtMs !== null && (latestMs === null || requestedAtMs > latestMs)) {
      latestMs = requestedAtMs;
    }
  }
  return latestMs;
}

/**
 * Whether this hosted runtime reads `requested` (or another booting status)
 * because it is being stopped, not started. A stop leaves the runtime
 * `requested`, offline and never seen, on its old launch while the provider
 * releases the machine, which is a stalled launch by every status field. So
 * it counts as a stop when a person's stop newer than its launch is known:
 * the controller's own marker for one (`stopRequestedAt`, or a person's
 * `stopReason` without a time), or `knownStopAtMs`, the latest person's stop
 * the client knows of in the space (this tab's Stop, or a turn such a stop
 * put back in the queue). A launch requested after that stop is a launch
 * again.
 *
 * The controller marks every stop's release, also of a machine that crashed
 * or never came up, and keeps the mark after a failed release until it
 * retries, which can take 15 minutes. Such a machine must still read as a
 * launch that stalled: the automatic start, or the stalled-launch notice's
 * Try again, is what has the controller retry the release and launch again.
 * A machine a person stopped stays stopped until someone asks for it, so the
 * mark of a person's stop counts for as long as it is there.
 */
export function runtimeEntryIsStopping(
  entry: ControllerRuntimeStatusEntry | null | undefined,
  knownStopAtMs: number | null,
): boolean {
  if (!entry || entry.isLocal || !isHostedRuntime(entry)) {
    return false;
  }
  if (!BOOTING_STATUS_SET.has((entry.status ?? "").toLowerCase())) {
    return false;
  }
  const markerAtMs = isPersonRuntimeStopReason(entry.stopReason)
    ? (parseIsoTimestamp(entry.stopRequestedAt ?? null) ?? Number.POSITIVE_INFINITY)
    : null;
  const stopAtMs = Math.max(markerAtMs ?? Number.NEGATIVE_INFINITY, knownStopAtMs ?? Number.NEGATIVE_INFINITY);
  if (stopAtMs === Number.NEGATIVE_INFINITY) {
    return false;
  }
  const launchRequestedAtMs = parseIsoTimestamp(entry.launchRequestedAt ?? null);
  return launchRequestedAtMs === null || launchRequestedAtMs <= stopAtMs;
}

export function resolveStalledHostedLaunch(
  entry: ControllerRuntimeStatusEntry | null | undefined,
  nowMs: number,
): boolean {
  const deadlineMs = stalledLaunchDeadlineMs(entry);
  return deadlineMs !== null && nowMs >= deadlineMs;
}

function resolveConnectionState(
  entries: ControllerRuntimeStatusEntry[],
): RuntimeConnectionState {
  if (entries.some((entry) => runtimeEntryIsReady(entry))) {
    return "connected";
  }
  if (entries.some((entry) => runtimeEntryIsBooting(entry))) {
    return "connecting";
  }
  if (entries.length > 0) {
    return "disconnected";
  }
  return "unknown";
}

export function resolveHostedConnectionState(
  statuses: ControllerRuntimeStatusEntry[],
): RuntimeConnectionState {
  const hostedEntries = statuses.filter(isHostedRuntime);
  return resolveConnectionState(hostedEntries);
}

export function resolveDesktopConnectionState(
  statuses: ControllerRuntimeStatusEntry[],
): RuntimeConnectionState {
  const desktopEntries = statuses.filter(isSelfHostedRuntime);
  return resolveConnectionState(desktopEntries);
}
