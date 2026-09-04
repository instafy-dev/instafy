import type { RuntimeResourceUsage } from "../sdk/instafy";

/**
 * Client-side ring buffer of resource samples per runtime. Status refreshes
 * only carry the latest snapshot, so the trend shown in the runtime menu is
 * accumulated here for the lifetime of the tab. Samples are recorded at the
 * data layer (useRuntimeStatusRefresh) BEFORE the statuses dispatch, so any
 * render triggered by that dispatch already sees the sample it delivered.
 * Module-level on purpose: the menu popover unmounts on close and the history
 * must survive that.
 */

export interface RuntimeResourceSample {
  at: number;
  cpuPct: number | null;
  memPct: number | null;
  memUsedBytes: number | null;
  memLimitBytes: number | null;
  diskPct: number | null;
  diskUsedBytes: number | null;
  diskLimitBytes: number | null;
}

// ~1 hour of trend at the Machines page's 10s poll cadence; still tiny memory
// (360 samples × a few numbers × ≤32 runtimes).
const MAX_SAMPLES = 360;
const MAX_RUNTIMES = 32;

const histories = new Map<string, RuntimeResourceSample[]>();
const lastRecordedStamp = new Map<string, string>();

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function recordRuntimeResourceSample(
  runtimeId: string | null | undefined,
  resources: RuntimeResourceUsage | null | undefined,
): void {
  if (!runtimeId || !resources) {
    return;
  }
  const stamp = resources.updatedAt?.trim() || null;
  if (stamp && lastRecordedStamp.get(runtimeId) === stamp) {
    return;
  }

  const cpuPct = finiteOrNull(resources.cpuPct);
  const memUsedBytes = finiteOrNull(resources.memoryUsedBytes);
  const memLimitBytes = finiteOrNull(resources.memoryLimitBytes);
  const memPct =
    memUsedBytes !== null && memLimitBytes !== null && memLimitBytes > 0
      ? Math.min(100, (memUsedBytes / memLimitBytes) * 100)
      : null;
  const diskUsedBytes = finiteOrNull(resources.diskUsedBytes);
  const diskLimitBytes = finiteOrNull(resources.diskLimitBytes);
  const diskPct =
    diskUsedBytes !== null && diskLimitBytes !== null && diskLimitBytes > 0
      ? Math.min(100, (diskUsedBytes / diskLimitBytes) * 100)
      : null;
  if (cpuPct === null && memPct === null && diskPct === null) {
    return;
  }

  const samples = histories.get(runtimeId) ?? [];
  const last = samples[samples.length - 1] ?? null;
  // Snapshots without a timestamp can repeat across refreshes; skip exact
  // repeats so the trend reflects reported changes, not refresh cadence.
  if (
    !stamp &&
    last &&
    last.cpuPct === cpuPct &&
    last.memUsedBytes === memUsedBytes &&
    last.diskUsedBytes === diskUsedBytes
  ) {
    return;
  }

  // Server stamps and client-clock fallbacks can disagree; clamp instead of
  // dropping so skew never silently discards real samples.
  const parsedStamp = stamp ? Date.parse(stamp) : Number.NaN;
  let at = Number.isFinite(parsedStamp) ? parsedStamp : Date.now();
  if (last && at <= last.at) {
    at = last.at + 1;
  }

  samples.push({
    at,
    cpuPct,
    memPct,
    memUsedBytes,
    memLimitBytes,
    diskPct,
    diskUsedBytes,
    diskLimitBytes,
  });
  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES);
  }
  if (!histories.has(runtimeId) && histories.size >= MAX_RUNTIMES) {
    const oldest = histories.keys().next().value;
    if (oldest !== undefined) {
      histories.delete(oldest);
      lastRecordedStamp.delete(oldest);
    }
  }
  histories.set(runtimeId, samples);
  if (stamp) {
    lastRecordedStamp.set(runtimeId, stamp);
  }
}

export function getRuntimeResourceHistory(
  runtimeId: string | null | undefined,
): RuntimeResourceSample[] {
  if (!runtimeId) {
    return [];
  }
  const samples = histories.get(runtimeId);
  return samples ? [...samples] : [];
}

/** Test-only: clear all accumulated samples. */
export function resetRuntimeResourceHistory(): void {
  histories.clear();
  lastRecordedStamp.clear();
}
