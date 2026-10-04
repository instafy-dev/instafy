import type { ControllerOriginSummary } from "../originTypes";
import { fetchWorkspaceGitStatusFromController } from "./workspaceGit";
import {
  getCachedWorkspaceVersioning,
  knownRecoverySupport,
  storeWorkspaceVersioning,
  VERSIONING_STALE_MS,
  type OriginVersioning,
  type VersioningMode,
  type VersioningOriginMode,
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
 *   `stateless`; anything else, including 404 and errors, means `legacy`.
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

const inFlight = new Map<string, Promise<OriginVersioning | null>>();

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
  if (pending) {
    return pending;
  }

  const run = async (): Promise<OriginVersioning> => {
    let mode = modeForOrigin(originMode);
    let stateless = false;
    if (mode === null) {
      const status = await fetchWorkspaceGitStatusFromController({
        projectId,
        originId,
        limit: 1,
        routing: "default",
        accessToken: params.accessToken ?? null,
      }).catch(() => null);
      stateless = status?.stateless === true;
      mode = stateless ? "stateless" : "legacy";
    }
    return storeWorkspaceVersioning({
      projectId,
      originId,
      originMode,
      mode,
      stateless,
      recovery: cached?.recovery ?? knownRecoverySupport(originId),
      checkedAt: Date.now(),
      stale: false,
    });
  };

  const promise = run().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

/** Test hook: forget probes still on the wire. */
export function resetWorkspaceVersioningProbesForTests(): void {
  inFlight.clear();
}
