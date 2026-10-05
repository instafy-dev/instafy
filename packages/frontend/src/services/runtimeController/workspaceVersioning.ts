import type { ControllerOriginSummary } from "../originTypes";
import { fetchWorkspaceGitStatusFromController, type WorkspaceGitStatus } from "./workspaceGit";
import {
  getCachedWorkspaceVersioning,
  knownRecoverySupport,
  storeWorkspaceVersioning,
  versioningSignalSnapshot,
  versioningSignalsChangedSince,
  versioningSignalsContradict,
  VERSIONING_STALE_MS,
  type OriginVersioning,
  type VersioningMode,
  type VersioningOriginMode,
  type VersioningSignalSnapshot,
} from "./workspaceVersioningCache";

export {
  getCachedWorkspaceVersioning,
  noteVersioningSignal,
  readLastVersioningMode,
  subscribeWorkspaceVersioning,
  VERSIONING_STALE_MS,
} from "./workspaceVersioningCache";
export type {
  OriginVersioning,
  RecoverySupport,
  VersioningMode,
  VersioningOriginMode,
  VersioningSignal,
} from "./workspaceVersioningCache";

/**
 * Capability probe: decide how the project's default origin keeps versions
 * without any new backend field (decision D5).
 *
 * - Desktop and EFS origins are `desktop`; no request is made.
 * - Hosted origins get one `GET /git/status?limit=1` pinned to the summary's
 *   origin (no `preferHosted`, no `preferRuntime`). `stateless: true` means
 *   `stateless`; any other answer, including a 404, means `legacy`. A probe
 *   that gets no answer (no token, a network or server error) stores
 *   nothing: the previous entry, stale or not, stays as it was.
 * - Any other origin mode is `legacy`.
 *
 * Saves never depend on the result (decision D4); it only chooses chrome and
 * routing.
 */

export interface ProbeWorkspaceVersioningParams {
  projectId: string;
  origin: Pick<ControllerOriginSummary, "originId" | "mode"> | null;
  accessToken?: string | null;
  /** Probe even when a fresh entry is cached (History drawer opened). */
  force?: boolean;
  /** Reuse a cached entry younger than this (default 60 s). */
  maxAgeMs?: number;
}

type PendingProbe = {
  promise: Promise<OriginVersioning | null>;
  seq: number;
  /** Signal counts when the probe started. */
  signals: VersioningSignalSnapshot;
};

const inFlight = new Map<string, PendingProbe>();
/** The newest probe started per key; an older probe never overwrites its answer. */
const latestProbe = new Map<string, number>();
let probeSeq = 0;

export function versioningOriginMode(mode: string | null | undefined): VersioningOriginMode {
  const normalized = (mode ?? "").trim().toLowerCase();
  return normalized === "hosted" || normalized === "desktop" || normalized === "efs"
    ? normalized
    : "unknown";
}

function modeForOrigin(originMode: VersioningOriginMode): VersioningMode | null {
  if (originMode === "desktop" || originMode === "efs") {
    return "desktop";
  }
  return originMode === "hosted" ? null : "legacy";
}

/**
 * The status call got an answer from the origin: a status (busy included) or
 * a 404 (`supported: false`). No token, a network or server error, or an
 * error reported in place of a status is no answer.
 */
function isStatusAnswer(status: WorkspaceGitStatus | null): boolean {
  if (!status) {
    return false;
  }
  return status.supported === false || !status.error;
}

/** True when a cached entry can be used without probing again. */
export function isWorkspaceVersioningFresh(
  entry: OriginVersioning | null,
  originMode: VersioningOriginMode,
  maxAgeMs = VERSIONING_STALE_MS,
  now = Date.now(),
): entry is OriginVersioning {
  return (
    entry !== null &&
    !entry.stale &&
    entry.originMode === originMode &&
    now - entry.checkedAt < maxAgeMs
  );
}

export async function probeWorkspaceVersioning(
  params: ProbeWorkspaceVersioningParams,
): Promise<OriginVersioning | null> {
  const projectId = params.projectId?.trim();
  const originId = params.origin?.originId?.trim();
  if (!projectId || !originId) {
    return null;
  }
  const originMode = versioningOriginMode(params.origin?.mode);
  const cached = getCachedWorkspaceVersioning(projectId, originId);
  if (!params.force && isWorkspaceVersioningFresh(cached, originMode, params.maxAgeMs)) {
    return cached;
  }

  const key = `${projectId}:${originId}:${originMode}`;
  const pending = inFlight.get(key);
  // Join a probe on the wire only when no signal arrived since it started:
  // its answer may be older than the response that contradicted the cache.
  if (pending && !versioningSignalsChangedSince(originId, pending.signals)) {
    return pending.promise;
  }

  const seq = ++probeSeq;
  latestProbe.set(key, seq);
  const signals = versioningSignalSnapshot(originId);

  const run = async (): Promise<OriginVersioning | null> => {
    let mode = modeForOrigin(originMode);
    let stateless = false;
    if (mode === null) {
      const status = await fetchWorkspaceGitStatusFromController({
        projectId,
        originId,
        limit: 1,
        routing: "default",
        accessToken: params.accessToken ?? null,
        // This probe stores its own answer; it is not an outside signal.
        noteVersioningSignals: false,
      }).catch(() => null);
      stateless = status?.stateless === true;
      if (!stateless && !isStatusAnswer(status)) {
        // No answer: never store a mode as fresh. The entry stays as it was.
        return getCachedWorkspaceVersioning(projectId, originId);
      }
      mode = stateless ? "stateless" : "legacy";
    }
    if (latestProbe.get(key) !== seq) {
      // A newer probe started (a signal arrived meanwhile): its answer wins.
      const newer = inFlight.get(key);
      return newer && newer.seq !== seq
        ? newer.promise
        : getCachedWorkspaceVersioning(projectId, originId);
    }
    const current = getCachedWorkspaceVersioning(projectId, originId);
    return storeWorkspaceVersioning({
      projectId,
      originId,
      originMode,
      mode,
      stateless,
      recovery: current?.recovery ?? cached?.recovery ?? knownRecoverySupport(originId),
      checkedAt: Date.now(),
      // A signal that arrived while this probe was on the wire and disagrees
      // with its answer keeps the entry stale, so it is probed again.
      stale: versioningSignalsContradict(originId, signals, mode),
    });
  };

  const promise = run().finally(() => {
    if (inFlight.get(key)?.seq === seq) {
      inFlight.delete(key);
    }
  });
  inFlight.set(key, { promise, seq, signals });
  return promise;
}

/** Test hook: forget probes still on the wire. */
export function resetWorkspaceVersioningProbesForTests(): void {
  inFlight.clear();
  latestProbe.clear();
}
