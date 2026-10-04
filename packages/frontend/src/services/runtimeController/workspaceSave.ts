import { runtimeControllerEnabled } from "./core";
import {
  parseOriginErrorText,
  parsePublishReport,
  type OriginError,
  type OriginPublishReport,
  type OriginRejectedPath,
} from "./originErrors";
import { withWorkspaceWriteLease, type WorkspaceWriteStage } from "./originRequest";
import {
  noteApplyVersioningSignals,
  postOriginApply,
  type OriginApplyExpected,
  type OriginApplyFile,
} from "./workspaceApply";
import { normalizeWorkspaceRelativePath } from "./workspaceUtils";

/** Lease refusals (usually the agent saving) are retried once after this delay. */
export const WORKSPACE_SAVE_LEASE_RETRY_DELAY_MS = 1_500;

export interface WorkspaceSaveRequest {
  projectId: string;
  /** Origin that served the buffer; the save never moves to another origin. */
  originId?: string | null;
  files?: OriginApplyFile[];
  deletes?: string[];
  /** Commit the buffer was read at (stateless gateway). Required there for directory deletes. */
  baseRev?: string | null;
  /** Blob ids the paths must still hold (`null`: must not exist yet). */
  expected?: OriginApplyExpected | null;
  /** Apply commit message; the gateway writes "Update <path>" when absent. */
  commitMessage?: string | null;
  /** Message for the `/git/sync` step on origins that do not commit on apply. */
  syncMessage?: string | null;
  runtimeId?: string | null;
  accessToken?: string | null;
  leaseSeconds?: number;
  /** Delay before the one retry after a lease refusal; 0 disables it. */
  leaseConflictRetryDelayMs?: number;
}

export interface WorkspaceSaveSuccess {
  ok: true;
  originId: string;
  originMode: string;
  /** `main` after the save, when the origin reports it. */
  rev: string | null;
  baseRev: string | null;
  /** True when a commit was made, false when nothing changed, null when the origin does not say. */
  committed: boolean | null;
  /** Paths that reached the saved version (or already matched it). */
  saved: string[];
  /** Paths kept out because they changed in the space meanwhile (Desktop publish). */
  conflicted: string[];
  /** Paths the origin refused to publish, with the reason. */
  rejected: OriginRejectedPath[];
  /** Where kept-aside work went, when any was kept. */
  recoveryRef: string | null;
  /** `apply`: the apply committed; `sync`: a `/git/sync` published it. */
  via: "apply" | "sync";
  report: OriginPublishReport | null;
}

export interface WorkspaceSaveFailure {
  ok: false;
  stage: "input" | WorkspaceWriteStage | "apply" | "sync";
  error: OriginError;
  originId: string | null;
  originMode: string | null;
  /**
   * The apply landed before the failure (for example a Desktop folder was
   * written but `/git/sync` refused). The edit is on the origin, not lost.
   */
  applied: boolean;
  appliedRev: string | null;
}

export type WorkspaceSaveResult = WorkspaceSaveSuccess | WorkspaceSaveFailure;

/** The subject the stateless gateway writes by default, mirrored for `/git/sync`. */
export function defaultWorkspaceSaveMessage(paths: { files: string[]; deletes: string[] }): string {
  const total = paths.files.length + paths.deletes.length;
  if (total === 1) {
    return paths.files.length === 1 ? `Update ${paths.files[0]}` : `Delete ${paths.deletes[0]}`;
  }
  return `Update ${total} files`;
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter((path) => path.length > 0)));
}

function deriveCommitted(
  payloadCommitted: unknown,
  report: OriginPublishReport | null,
): boolean | null {
  if (typeof payloadCommitted === "boolean") {
    return payloadCommitted;
  }
  if (report?.gitSyncStatus === "unchanged") {
    return false;
  }
  if (report?.gitSyncStatus === "published" || report?.gitSyncStatus === "partial") {
    return true;
  }
  return null;
}

/**
 * Save edits as a version, whatever the origin (decision D4):
 * acquire a lease, mint one write token, apply; when the apply answer says
 * `committed: true` the save is done, otherwise run `/git/sync {paths}` on
 * the same origin with the same lease. This works on the stateless gateway,
 * the stateful gateway and every Desktop origin version, so saving never
 * depends on a cached mode. No `idempotencyKey` is ever sent.
 */
export async function saveWorkspaceChanges(request: WorkspaceSaveRequest): Promise<WorkspaceSaveResult> {
  const failure = (
    stage: WorkspaceSaveFailure["stage"],
    error: OriginError,
    extra?: Partial<Omit<WorkspaceSaveFailure, "ok" | "stage" | "error">>,
  ): WorkspaceSaveFailure => ({
    ok: false,
    stage,
    error,
    originId: extra?.originId ?? null,
    originMode: extra?.originMode ?? null,
    applied: extra?.applied ?? false,
    appliedRev: extra?.appliedRev ?? null,
  });

  const projectId = request.projectId?.trim() ?? "";
  const files = request.files ?? [];
  const deletes = request.deletes ?? [];
  if (!runtimeControllerEnabled || !projectId || (files.length === 0 && deletes.length === 0)) {
    return failure("input", {
      status: 0,
      code: "invalid_request",
      message: !runtimeControllerEnabled
        ? "runtime controller disabled"
        : !projectId
          ? "projectId is required"
          : "no changes supplied",
      routeUnavailable: false,
    });
  }

  const filePaths = uniquePaths(files.map((file) => normalizeWorkspaceRelativePath(file.path)));
  const deletePaths = uniquePaths(deletes.map((path) => normalizeWorkspaceRelativePath(path)));
  const allPaths = uniquePaths([...filePaths, ...deletePaths]);
  const syncMessage =
    request.syncMessage?.trim() ||
    request.commitMessage?.trim() ||
    defaultWorkspaceSaveMessage({ files: filePaths, deletes: deletePaths });

  type Step =
    | { kind: "apply_failed"; error: OriginError }
    | { kind: "sync_failed"; error: OriginError; appliedRev: string | null }
    | { kind: "done"; success: Omit<WorkspaceSaveSuccess, "ok" | "originId" | "originMode"> };

  const outcome = await withWorkspaceWriteLease<Step>(
    {
      projectId,
      originId: request.originId ?? null,
      runtimeId: request.runtimeId ?? null,
      accessToken: request.accessToken ?? null,
      leaseSeconds: request.leaseSeconds,
      leaseConflictRetryDelayMs:
        request.leaseConflictRetryDelayMs ?? WORKSPACE_SAVE_LEASE_RETRY_DELAY_MS,
    },
    async (context) => {
      const applied = await postOriginApply((init) => context.fetch("apply", init), {
        projectId,
        leaseId: context.leaseId,
        files,
        deletes,
        baseRev: request.baseRev,
        expected: request.expected,
        commitMessage: request.commitMessage,
      });
      noteApplyVersioningSignals(context.originId, applied);
      if (!applied.ok) {
        return { kind: "apply_failed", error: applied.error };
      }
      if (applied.committed === true) {
        return {
          kind: "done",
          success: {
            rev: applied.rev,
            baseRev: applied.baseRev,
            committed: true,
            saved: allPaths,
            conflicted: [],
            rejected: [],
            recoveryRef: null,
            via: "apply",
            report: null,
          },
        };
      }

      const response = await context.fetch("git/sync", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ paths: allPaths, message: syncMessage }),
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        return {
          kind: "sync_failed",
          error: parseOriginErrorText(response.status, text, response.headers),
          appliedRev: applied.rev,
        };
      }
      let payload: Record<string, unknown> | null = null;
      try {
        const parsed = text ? (JSON.parse(text) as unknown) : null;
        payload =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
      } catch (_error) {
        payload = null;
      }
      const report = parsePublishReport(payload);
      const conflicted = report?.conflictedPaths ?? [];
      const rejected = report?.rejectedPaths ?? [];
      const leftOut = new Set([...conflicted, ...rejected.map((entry) => entry.path)]);
      const rev =
        typeof payload?.rev === "string" && payload.rev.length > 0 ? payload.rev : applied.rev;
      const baseRev =
        typeof payload?.baseRev === "string" && payload.baseRev.length > 0
          ? payload.baseRev
          : applied.baseRev;
      return {
        kind: "done",
        success: {
          rev,
          baseRev,
          committed: deriveCommitted(payload?.committed, report),
          saved: allPaths.filter((path) => !leftOut.has(path)),
          conflicted,
          rejected,
          recoveryRef: report?.recoveryRef ?? null,
          via: "sync",
          report,
        },
      };
    },
  );

  if (!outcome.ok) {
    return failure(outcome.stage, outcome.error, {
      originId: outcome.originId,
      originMode: outcome.originMode,
    });
  }
  const step = outcome.value;
  if (step.kind === "apply_failed") {
    return failure("apply", step.error, {
      originId: outcome.originId,
      originMode: outcome.originMode,
    });
  }
  if (step.kind === "sync_failed") {
    return failure("sync", step.error, {
      originId: outcome.originId,
      originMode: outcome.originMode,
      applied: true,
      appliedRev: step.appliedRev,
    });
  }
  return {
    ok: true,
    originId: outcome.originId,
    originMode: outcome.originMode,
    ...step.success,
  };
}
