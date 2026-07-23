import type { APIRequestContext } from "@playwright/test";

const CLEANUP_REQUEST_TIMEOUT_MS = 30_000;
const PROVIDER_RELEASE_RETRY_DELAYS_MS = [0, 500, 1_500] as const;
const QUIET_POLL_DELAYS_MS = [0, 50, 100, 250, 500, 1_000] as const;
const REQUIRED_QUIET_PASSES = 2;

const ACTIVE_AGENT_JOB_STATUSES = new Set([
  "queued",
  "leased",
  "in_progress",
  "awaiting_approval",
]);
const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "in_progress",
  "awaiting_approval",
]);
const ACTIVE_SEND_QUEUE_STATUSES = new Set(["queued", "failed", "dispatched"]);
const TERMINAL_RUNTIME_STATUSES = new Set(["stopped", "removed"]);

const AGENT_JOB_STATUS_FILTER = "in.(queued,leased,in_progress,awaiting_approval)";
const RUN_STATUS_FILTER = "in.(queued,in_progress,awaiting_approval)";
const SEND_QUEUE_STATUS_FILTER = "in.(queued,failed,dispatched)";
const CLEANUP_REASON = "electron-shared-browser-agent-turn:cleanup";

export type ElectronBrowserCleanupConfig = {
  controllerUrl: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
};

export type ElectronBrowserCleanupTarget = {
  orgId?: string | null;
  projectId?: string | null;
  userId?: string | null;
  session?: {
    accessToken: string;
  } | null;
};

export type ElectronBrowserCleanupFailure = {
  step: string;
  detail: string;
};

type LifecycleCleanupSnapshot = {
  id: string;
  status: string;
};

type RuntimeCleanupSnapshot = {
  runtimeId: string;
  status: string;
};

export class ElectronBrowserCleanupError extends Error {
  readonly failures: ReadonlyArray<ElectronBrowserCleanupFailure>;

  constructor(failures: ElectronBrowserCleanupFailure[]) {
    super(
      [
        "Electron Shared Browser cleanup did not complete safely:",
        ...failures.map(({ step, detail }) => `- ${step}: ${detail}`),
      ].join("\n"),
    );
    this.name = "ElectronBrowserCleanupError";
    this.failures = failures;
  }
}

function cleanupRequestFailureDetail(error: unknown): string {
  // Deliberately omit the request error text. Playwright errors may include
  // headers and bodies; cleanup reporting only needs a safe category.
  return error instanceof Error
    ? `request failed (${error.name || "Error"})`
    : "request failed";
}

function cleanupResponseFailureDetail(status: number): string {
  return `request returned HTTP ${status}`;
}

function waitForCleanupRetry(delayMs: number): Promise<void> {
  return delayMs > 0
    ? new Promise((resolve) => setTimeout(resolve, delayMs))
    : Promise.resolve();
}

function normalizeLifecycleCleanupSnapshot(
  value: unknown,
  acceptedStatuses: ReadonlySet<string>,
): LifecycleCleanupSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
  return id && acceptedStatuses.has(status) ? { id, status } : null;
}

function normalizeRuntimeCleanupSnapshot(value: unknown): RuntimeCleanupSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const runtimeId =
    typeof record.runtimeId === "string"
      ? record.runtimeId.trim()
      : typeof record.id === "string"
        ? record.id.trim()
        : "";
  const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
  return runtimeId && status ? { runtimeId, status } : null;
}

export async function cleanupElectronBrowserStudio(
  request: APIRequestContext,
  config: ElectronBrowserCleanupConfig,
  target: ElectronBrowserCleanupTarget,
  credentialId?: string | null,
): Promise<void> {
  const failures: ElectronBrowserCleanupFailure[] = [];
  const orgId = target.orgId?.trim() ?? "";
  const projectId = target.projectId?.trim() ?? "";
  const userId = target.userId?.trim() ?? "";
  const sessionAccessToken = target.session?.accessToken?.trim() ?? "";
  const normalizedCredentialId = credentialId?.trim() ?? "";
  const serviceHeaders = {
    authorization: `Bearer ${config.supabaseServiceRoleKey}`,
  };
  // Project and organization controller routes authorize against the
  // disposable user's live membership. Preserve that session for same-run
  // teardown; service auth is only the crash-recovery fallback when no
  // process-local session exists.
  const controllerHeaders = sessionAccessToken
    ? { authorization: `Bearer ${sessionAccessToken}` }
    : serviceHeaders;
  const restHeaders = {
    apikey: config.supabaseServiceRoleKey,
    authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    accept: "application/json",
  };

  const fetchRestRows = async (
    step: string,
    url: string,
  ): Promise<Array<Record<string, unknown>> | null> => {
    try {
      const response = await request.get(url, {
        headers: restHeaders,
        timeout: CLEANUP_REQUEST_TIMEOUT_MS,
      });
      if (!response.ok()) {
        failures.push({ step, detail: cleanupResponseFailureDetail(response.status()) });
        return null;
      }
      try {
        const payload = (await response.json()) as unknown;
        if (!Array.isArray(payload)) {
          failures.push({ step, detail: "response was not a JSON array" });
          return null;
        }
        const rows = payload.filter(
          (row): row is Record<string, unknown> =>
            Boolean(row) && typeof row === "object" && !Array.isArray(row),
        );
        if (rows.length !== payload.length) {
          failures.push({ step, detail: "response contained an invalid row" });
          return null;
        }
        return rows;
      } catch {
        failures.push({ step, detail: "response was not valid JSON" });
        return null;
      }
    } catch (error) {
      failures.push({ step, detail: cleanupRequestFailureDetail(error) });
      return null;
    }
  };

  const patchRestRows = async (
    step: string,
    url: string,
    data: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      const response = await request.patch(url, {
        headers: {
          ...restHeaders,
          "content-type": "application/json",
          prefer: "return=minimal",
        },
        data,
        timeout: CLEANUP_REQUEST_TIMEOUT_MS,
      });
      if (response.ok()) {
        return true;
      }
      failures.push({ step, detail: cleanupResponseFailureDetail(response.status()) });
    } catch (error) {
      failures.push({ step, detail: cleanupRequestFailureDetail(error) });
    }
    return false;
  };

  const deleteRestRows = async (step: string, url: string): Promise<boolean> => {
    try {
      const response = await request.delete(url, {
        headers: {
          ...restHeaders,
          prefer: "return=minimal",
        },
        timeout: CLEANUP_REQUEST_TIMEOUT_MS,
      });
      if (response.ok() || response.status() === 404) {
        return true;
      }
      failures.push({ step, detail: cleanupResponseFailureDetail(response.status()) });
    } catch (error) {
      failures.push({ step, detail: cleanupRequestFailureDetail(error) });
    }
    return false;
  };

  // Remove the uploaded auth.json before waiting on jobs or providers. The
  // controller route updates normal references when the id is known; the
  // service-role purge covers a timeout after upload but before id capture.
  if (normalizedCredentialId && sessionAccessToken) {
    try {
      const response = await request.delete(
        `${config.controllerUrl}/me/credentials/${encodeURIComponent(normalizedCredentialId)}`,
        {
          headers: { authorization: `Bearer ${sessionAccessToken}` },
          timeout: CLEANUP_REQUEST_TIMEOUT_MS,
        },
      );
      if (!response.ok() && response.status() !== 404) {
        failures.push({
          step: "credential revoke",
          detail: cleanupResponseFailureDetail(response.status()),
        });
      }
    } catch (error) {
      failures.push({ step: "credential revoke", detail: cleanupRequestFailureDetail(error) });
    }
  } else if (normalizedCredentialId) {
    failures.push({ step: "credential revoke", detail: "user session is unavailable" });
  }

  if (userId) {
    await deleteRestRows(
      "credential purge",
      `${config.supabaseUrl}/rest/v1/user_credentials?user_id=eq.${encodeURIComponent(userId)}`,
    );
  }

  let credentialAbsenceVerified = !userId;
  if (userId) {
    const credentialRows = await fetchRestRows(
      "credential absence verification",
      `${config.supabaseUrl}/rest/v1/user_credentials?user_id=eq.${encodeURIComponent(userId)}&select=id`,
    );
    if (credentialRows) {
      credentialAbsenceVerified = credentialRows.length === 0;
      if (credentialRows.length > 0) {
        failures.push({
          step: "credential absence verification",
          detail: `${credentialRows.length} credential row(s) remain`,
        });
      }
    }
  }

  let quiesceMutationsSucceeded = !projectId;
  let quiesceDiscoverySucceeded = !projectId;
  let quiesceStableEmptyVerified = !projectId;

  const quiesceUrls = projectId
    ? {
        jobs:
          `${config.supabaseUrl}/rest/v1/agent_jobs?project_id=eq.${encodeURIComponent(projectId)}` +
          `&status=${AGENT_JOB_STATUS_FILTER}`,
        runs:
          `${config.supabaseUrl}/rest/v1/runs?project_id=eq.${encodeURIComponent(projectId)}` +
          `&status=${RUN_STATUS_FILTER}`,
        sendQueue:
          `${config.supabaseUrl}/rest/v1/conversation_send_queue?project_id=eq.${encodeURIComponent(projectId)}` +
          `&status=${SEND_QUEUE_STATUS_FILTER}`,
      }
    : null;

  const cancelActiveProjectWork = async (): Promise<boolean> => {
    if (!quiesceUrls) {
      return true;
    }
    const now = new Date().toISOString();
    // Cancel the send queue first so a drain cannot create another job between
    // the job and run mutations. Direct service-role mutations intentionally
    // avoid controller cancellation side effects (queue drains/checkpoints).
    const sendQueueSucceeded = await patchRestRows(
      "send-queue quiesce",
      quiesceUrls.sendQueue,
      { status: "canceled", error_message: CLEANUP_REASON, updated_at: now },
    );
    const jobsSucceeded = await patchRestRows("agent-job quiesce", quiesceUrls.jobs, {
      status: "canceled",
      outcome: "canceled",
      summary: CLEANUP_REASON,
      completed_at: now,
      lease_expires_at: null,
      heartbeat_at: now,
    });
    const runsSucceeded = await patchRestRows("run quiesce", quiesceUrls.runs, {
      status: "canceled",
      last_message: CLEANUP_REASON,
      updated_at: now,
    });
    return sendQueueSucceeded && jobsSucceeded && runsSucceeded;
  };

  if (projectId && quiesceUrls) {
    quiesceMutationsSucceeded = await cancelActiveProjectWork();
    let quietPasses = 0;
    let lastActive: string[] = [];

    for (const delayMs of QUIET_POLL_DELAYS_MS) {
      await waitForCleanupRetry(delayMs);
      const [sendQueueRows, jobRows, runRows] = await Promise.all([
        fetchRestRows(
          "send-queue quiescence verification",
          `${quiesceUrls.sendQueue}&select=id,status`,
        ),
        fetchRestRows(
          "agent-job quiescence verification",
          `${quiesceUrls.jobs}&select=id,status`,
        ),
        fetchRestRows("run quiescence verification", `${quiesceUrls.runs}&select=id,status`),
      ]);

      if (!sendQueueRows || !jobRows || !runRows) {
        quiesceDiscoverySucceeded = false;
        break;
      }

      const normalized = [
        ...sendQueueRows.map((row) => ({
          table: "conversation_send_queue",
          snapshot: normalizeLifecycleCleanupSnapshot(row, ACTIVE_SEND_QUEUE_STATUSES),
        })),
        ...jobRows.map((row) => ({
          table: "agent_jobs",
          snapshot: normalizeLifecycleCleanupSnapshot(row, ACTIVE_AGENT_JOB_STATUSES),
        })),
        ...runRows.map((row) => ({
          table: "runs",
          snapshot: normalizeLifecycleCleanupSnapshot(row, ACTIVE_RUN_STATUSES),
        })),
      ];
      if (normalized.some(({ snapshot }) => snapshot === null)) {
        failures.push({
          step: "project work quiescence verification",
          detail: "response contained an invalid active row",
        });
        quiesceDiscoverySucceeded = false;
        break;
      }

      quiesceDiscoverySucceeded = true;
      lastActive = normalized.map(
        ({ table, snapshot }) =>
          `${table}/${snapshot?.id ?? "unknown"}=${snapshot?.status ?? "unknown"}`,
      );
      if (lastActive.length === 0) {
        quietPasses += 1;
        if (quietPasses >= REQUIRED_QUIET_PASSES) {
          quiesceStableEmptyVerified = true;
          break;
        }
        continue;
      }

      quietPasses = 0;
      quiesceMutationsSucceeded =
        (await cancelActiveProjectWork()) && quiesceMutationsSucceeded;
    }

    if (!quiesceStableEmptyVerified && quiesceDiscoverySucceeded) {
      failures.push({
        step: "project work stable-empty verification",
        detail:
          lastActive.length > 0
            ? `${lastActive.length} active row(s) remain: ${lastActive.join(", ")}`
            : "two consecutive quiet observations were not confirmed",
      });
    }
  }

  const projectWorkQuiesced =
    quiesceMutationsSucceeded &&
    quiesceDiscoverySucceeded &&
    quiesceStableEmptyVerified;

  // Fence runtime creation before provider cleanup. Same-run teardown keeps
  // the disposable user's session for this ownership-sensitive operation;
  // journal recovery falls back to the service role. Once tombstoned, normal
  // callers can no longer ensure another runtime, while the exact service-role
  // stop below can still release an allocation that committed late.
  let projectTombstoneSucceeded = !projectId;
  if (projectId && projectWorkQuiesced) {
    try {
      const response = await request.delete(
        `${config.controllerUrl}/projects/${encodeURIComponent(projectId)}`,
        {
          headers: controllerHeaders,
          timeout: CLEANUP_REQUEST_TIMEOUT_MS,
        },
      );
      if (response.ok() || response.status() === 404) {
        projectTombstoneSucceeded = true;
      } else {
        failures.push({
          step: "project tombstone",
          detail: cleanupResponseFailureDetail(response.status()),
        });
      }
    } catch (error) {
      failures.push({
        step: "project tombstone",
        detail: cleanupRequestFailureDetail(error),
      });
    }
  }

  let runtimeControllerDiscoverySucceeded = !projectId;
  let runtimeDatabaseDiscoverySucceeded = !projectId;
  let everyProviderReleaseSucceeded = true;
  let runtimeStableTerminalVerified = !projectId;
  const controllerRuntimes: RuntimeCleanupSnapshot[] = [];

  if (projectId && projectWorkQuiesced && projectTombstoneSucceeded) {
    const runtimeStatusUrl =
      `${config.controllerUrl}/projects/` +
      `${encodeURIComponent(projectId)}/runtime/status`;
    try {
      const response = await request.get(runtimeStatusUrl, {
        headers: serviceHeaders,
        timeout: CLEANUP_REQUEST_TIMEOUT_MS,
      });
      if (response.ok()) {
        try {
          const payload = (await response.json()) as { runtimes?: unknown };
          if (!Array.isArray(payload.runtimes)) {
            failures.push({
              step: "runtime discovery",
              detail: "response did not contain a runtimes array",
            });
          } else {
            const normalized = payload.runtimes.map(normalizeRuntimeCleanupSnapshot);
            if (normalized.some((runtime) => runtime === null)) {
              failures.push({
                step: "runtime discovery",
                detail: "response contained an invalid runtime row",
              });
            } else {
              controllerRuntimes.push(...(normalized as RuntimeCleanupSnapshot[]));
              runtimeControllerDiscoverySucceeded = true;
            }
          }
        } catch {
          failures.push({ step: "runtime discovery", detail: "response was not valid JSON" });
        }
      } else if (response.status() === 404) {
        runtimeControllerDiscoverySucceeded = true;
      } else {
        failures.push({
          step: "runtime discovery",
          detail: cleanupResponseFailureDetail(response.status()),
        });
      }
    } catch (error) {
      failures.push({ step: "runtime discovery", detail: cleanupRequestFailureDetail(error) });
    }

    const releasedRuntimeIds = new Set<string>();
    let quietPasses = 0;
    let lastPending: RuntimeCleanupSnapshot[] = [];

    for (const delayMs of QUIET_POLL_DELAYS_MS) {
      await waitForCleanupRetry(delayMs);
      const runtimeRows = await fetchRestRows(
        "runtime database discovery",
        `${config.supabaseUrl}/rest/v1/runtimes?project_id=eq.${encodeURIComponent(projectId)}&select=id,status`,
      );
      if (!runtimeRows) {
        runtimeDatabaseDiscoverySucceeded = false;
        break;
      }
      const normalizedDatabaseRuntimes = runtimeRows.map(normalizeRuntimeCleanupSnapshot);
      if (normalizedDatabaseRuntimes.some((runtime) => runtime === null)) {
        failures.push({
          step: "runtime database discovery",
          detail: "response contained an invalid runtime row",
        });
        runtimeDatabaseDiscoverySucceeded = false;
        break;
      }
      runtimeDatabaseDiscoverySucceeded = true;
      const databaseRuntimes = normalizedDatabaseRuntimes as RuntimeCleanupSnapshot[];
      const pendingById = new Map<string, RuntimeCleanupSnapshot>();

      for (const runtime of controllerRuntimes) {
        if (!releasedRuntimeIds.has(runtime.runtimeId)) {
          pendingById.set(runtime.runtimeId, runtime);
        }
      }
      for (const runtime of databaseRuntimes) {
        if (
          !releasedRuntimeIds.has(runtime.runtimeId) ||
          !TERMINAL_RUNTIME_STATUSES.has(runtime.status)
        ) {
          pendingById.set(runtime.runtimeId, runtime);
        }
      }
      lastPending = [...pendingById.values()];

      if (lastPending.length === 0) {
        quietPasses += 1;
        if (quietPasses >= REQUIRED_QUIET_PASSES) {
          runtimeStableTerminalVerified = true;
          break;
        }
        continue;
      }

      quietPasses = 0;
      for (const runtime of lastPending) {
        let providerReleaseConfirmed = false;
        let providerReleaseFailure = "provider release was not confirmed";
        for (const retryDelayMs of PROVIDER_RELEASE_RETRY_DELAYS_MS) {
          await waitForCleanupRetry(retryDelayMs);
          try {
            const response = await request.post(`${config.controllerUrl}/runtime/stop`, {
              headers: {
                ...serviceHeaders,
                "content-type": "application/json",
              },
              data: {
                runtime_id: runtime.runtimeId,
                reason: CLEANUP_REASON,
                expected_project_id: projectId,
                require_provider_release: true,
              },
              timeout: CLEANUP_REQUEST_TIMEOUT_MS,
            });
            if (!response.ok()) {
              providerReleaseFailure = cleanupResponseFailureDetail(response.status());
              continue;
            }
            try {
              const payload = (await response.json()) as {
                provider_release_succeeded?: unknown;
              };
              if (payload.provider_release_succeeded === true) {
                providerReleaseConfirmed = true;
                releasedRuntimeIds.add(runtime.runtimeId);
                break;
              }
              providerReleaseFailure = "response did not confirm provider release";
            } catch {
              providerReleaseFailure = "response was not valid JSON";
            }
          } catch (error) {
            providerReleaseFailure = cleanupRequestFailureDetail(error);
          }
        }
        if (!providerReleaseConfirmed) {
          everyProviderReleaseSucceeded = false;
          failures.push({
            step: `runtime provider release (${runtime.runtimeId})`,
            detail: `${providerReleaseFailure} after ${PROVIDER_RELEASE_RETRY_DELAYS_MS.length} attempts`,
          });
        }
      }

      if (!everyProviderReleaseSucceeded) {
        break;
      }
    }

    if (!runtimeStableTerminalVerified && runtimeDatabaseDiscoverySucceeded) {
      failures.push({
        step: "runtime stable terminal-state verification",
        detail:
          lastPending.length > 0
            ? `${lastPending.length} runtime(s) remain releasable: ${lastPending
                .map((runtime) => `${runtime.runtimeId}=${runtime.status}`)
                .join(", ")}`
            : "two consecutive terminal observations were not confirmed",
      });
    }
  }

  const runtimeReleaseSafe =
    projectWorkQuiesced &&
    projectTombstoneSucceeded &&
    runtimeControllerDiscoverySucceeded &&
    runtimeDatabaseDiscoverySucceeded &&
    everyProviderReleaseSucceeded &&
    runtimeStableTerminalVerified;

  // runs and build_runs do not both have project FKs in every schema path.
  // Remove and verify them explicitly, but only after the post-tombstone
  // discovery/release loop has observed every runtime terminal twice. The run
  // rows remain useful recovery evidence if infrastructure cleanup fails.
  let detachedRunRowsRemoved = !projectId;
  if (projectId && runtimeReleaseSafe && projectTombstoneSucceeded) {
    const runDeleteSucceeded = await deleteRestRows(
      "run row delete",
      `${config.supabaseUrl}/rest/v1/runs?project_id=eq.${encodeURIComponent(projectId)}`,
    );
    const buildRunDeleteSucceeded = await deleteRestRows(
      "build-run row delete",
      `${config.supabaseUrl}/rest/v1/build_runs?project_id=eq.${encodeURIComponent(projectId)}`,
    );
    const [runRows, buildRunRows] = await Promise.all([
      fetchRestRows(
        "run row absence verification",
        `${config.supabaseUrl}/rest/v1/runs?project_id=eq.${encodeURIComponent(projectId)}&select=id`,
      ),
      fetchRestRows(
        "build-run row absence verification",
        `${config.supabaseUrl}/rest/v1/build_runs?project_id=eq.${encodeURIComponent(projectId)}&select=id`,
      ),
    ]);
    if (runRows && runRows.length > 0) {
      failures.push({
        step: "run row absence verification",
        detail: `${runRows.length} run row(s) remain`,
      });
    }
    if (buildRunRows && buildRunRows.length > 0) {
      failures.push({
        step: "build-run row absence verification",
        detail: `${buildRunRows.length} build-run row(s) remain`,
      });
    }
    detachedRunRowsRemoved =
      runDeleteSucceeded &&
      buildRunDeleteSucceeded &&
      Boolean(runRows) &&
      runRows?.length === 0 &&
      Boolean(buildRunRows) &&
      buildRunRows?.length === 0;
  }

  const canDeleteDisposableIdentity =
    runtimeReleaseSafe &&
    projectTombstoneSucceeded &&
    detachedRunRowsRemoved &&
    credentialAbsenceVerified;

  // Preserve org, user, project, and runtime ids as durable retry/manual-
  // recovery handles whenever any safety barrier could not be proven.
  if (!canDeleteDisposableIdentity) {
    if (failures.length === 0) {
      failures.push({
        step: "cleanup safety gate",
        detail: "project quiescence and runtime release could not be verified",
      });
    }
    throw new ElectronBrowserCleanupError(failures);
  }

  if (orgId) {
    try {
      const response = await request.delete(
        `${config.controllerUrl}/orgs/${encodeURIComponent(orgId)}`,
        {
          headers: controllerHeaders,
          timeout: CLEANUP_REQUEST_TIMEOUT_MS,
        },
      );
      if (!response.ok() && response.status() !== 404) {
        failures.push({
          step: "organization delete",
          detail: cleanupResponseFailureDetail(response.status()),
        });
      }
    } catch (error) {
      failures.push({ step: "organization delete", detail: cleanupRequestFailureDetail(error) });
    }
  }

  let organizationAbsenceVerified = !orgId;
  if (orgId) {
    const organizationRows = await fetchRestRows(
      "organization absence verification",
      `${config.supabaseUrl}/rest/v1/organizations?id=eq.${encodeURIComponent(orgId)}&select=id`,
    );
    if (organizationRows) {
      organizationAbsenceVerified = organizationRows.length === 0;
      if (!organizationAbsenceVerified) {
        failures.push({
          step: "organization absence verification",
          detail: "organization row remains",
        });
      }
    }
  }

  let projectAbsenceVerified = !projectId;
  let runtimeTerminalStateVerified = !projectId;
  if (projectId) {
    const projectRows = await fetchRestRows(
      "project absence verification",
      `${config.supabaseUrl}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&select=id`,
    );
    if (projectRows) {
      projectAbsenceVerified = projectRows.length === 0;
      if (!projectAbsenceVerified) {
        failures.push({ step: "project absence verification", detail: "project row remains" });
      }
    }

    const runtimeRows = await fetchRestRows(
      "runtime terminal-state verification",
      `${config.supabaseUrl}/rest/v1/runtimes?project_id=eq.${encodeURIComponent(projectId)}&select=id,status`,
    );
    if (runtimeRows) {
      const normalized = runtimeRows.map(normalizeRuntimeCleanupSnapshot);
      if (normalized.some((runtime) => runtime === null)) {
        failures.push({
          step: "runtime terminal-state verification",
          detail: "response contained an invalid runtime row",
        });
      } else {
        const nonTerminal = (normalized as RuntimeCleanupSnapshot[]).filter(
          (runtime) => !TERMINAL_RUNTIME_STATUSES.has(runtime.status),
        );
        if (nonTerminal.length > 0) {
          failures.push({
            step: "runtime terminal-state verification",
            detail: nonTerminal
              .map((runtime) => `${runtime.runtimeId}=${runtime.status}`)
              .join(", "),
          });
        } else {
          runtimeTerminalStateVerified = true;
        }
      }
    }
  }

  // Delete the user last. Its owner membership is the evidence that lets a
  // later recovery pass distinguish this disposable organization from an
  // unrelated production tenant, so preserve it until both resource rows are
  // authoritatively absent.
  const userDeletionAllowed =
    Boolean(userId) &&
    organizationAbsenceVerified &&
    projectAbsenceVerified &&
    runtimeTerminalStateVerified;
  if (userDeletionAllowed) {
    try {
      const response = await request.delete(
        `${config.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
        {
          headers: restHeaders,
          timeout: CLEANUP_REQUEST_TIMEOUT_MS,
        },
      );
      if (!response.ok() && response.status() !== 404) {
        failures.push({ step: "user delete", detail: cleanupResponseFailureDetail(response.status()) });
      }
    } catch (error) {
      failures.push({ step: "user delete", detail: cleanupRequestFailureDetail(error) });
    }
  }

  if (userDeletionAllowed) {
    try {
      const response = await request.get(
        `${config.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
        {
          headers: restHeaders,
          timeout: CLEANUP_REQUEST_TIMEOUT_MS,
        },
      );
      if (response.ok()) {
        failures.push({ step: "user absence verification", detail: "user still exists" });
      } else if (response.status() !== 404) {
        failures.push({
          step: "user absence verification",
          detail: cleanupResponseFailureDetail(response.status()),
        });
      }
    } catch (error) {
      failures.push({ step: "user absence verification", detail: cleanupRequestFailureDetail(error) });
    }
  }

  if (failures.length > 0) {
    throw new ElectronBrowserCleanupError(failures);
  }
}
