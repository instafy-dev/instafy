import type { ControllerRuntimeStatusEntry } from "../../sdk/instafy";

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
