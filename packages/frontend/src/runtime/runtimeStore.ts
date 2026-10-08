import { compareRunInterruptions, readRunInterruptionIdentity } from "../conversations/runInterruption";
import { ACTIVE_CONVERSATION_RUN_STATUSES } from "../conversations/runLiveness";
import type { RunRecord, RunRecordPatch, RuntimeState } from "../types";
import {
  cloneRuntimeState,
  createDefaultRuntimeState,
} from "./defaults";
import type {
  ControllerConversationMessage,
  ControllerConversationCreated,
  ControllerConversationUpdated,
  ControllerOriginSummary,
  ControllerRuntimeStatusEntry,
  ControllerTunnelGrant,
  LocalWorkspacePresence,
} from "../sdk/instafy";

export interface AgentTokenSnapshot {
  issuedAt: string | null;
  expiresAt: string | null;
  ttlSeconds: number | null;
  scopes: string[] | null;
  updatedAt: string;
}

export interface RuntimeStoreState {
  runtime: RuntimeState;
  runs: Record<string, RunRecord>;
  latestRunIds: Partial<Record<RunRecord["runType"], string>>;
  leasedRunIds: Record<string, true>;
  internalConversationIds: Record<string, true>;
  pendingConversationMessages: ControllerConversationMessage[];
  pendingConversationCreations: ControllerConversationCreated[];
  pendingConversationUpdates: ControllerConversationUpdated[];
  localWorkspace: LocalWorkspacePresence | null;
  desktopOrigin: ControllerOriginSummary | null;
  /**
   * The project `desktopOrigin` was fetched for; null when unknown. During a
   * project switch the store still holds the previous project's summary for
   * a commit, and this tells the two apart.
   */
  desktopOriginProjectId: string | null;
  runtimeStatuses: ControllerRuntimeStatusEntry[];
  preferredRuntimeId: string | null;
  sessionRuntimeId: string | null;
  agentTokens: Record<string, AgentTokenSnapshot>;
  tunnelGrants: Record<string, ControllerTunnelGrant>;
}

export type RuntimeAction =
  | { type: "setRuntime"; runtime: RuntimeState }
  | { type: "updateRuntime"; updater: (current: RuntimeState) => RuntimeState }
  | {
      type: "setRunsState";
      runs: Record<string, RunRecord>;
      latestRunIds: RuntimeStoreState["latestRunIds"];
    }
  | { type: "upsertRun"; run: RunRecord }
  | { type: "patchRun"; patch: RunRecordPatch }
  | { type: "removeRun"; runId: string }
  | { type: "markRunLeased"; runId: string }
  | { type: "clearRunLease"; runId: string }
  | { type: "setInternalConversationIds"; conversationIds: string[] }
  | { type: "pushConversationMessage"; message: ControllerConversationMessage }
  | { type: "clearConversationMessages"; messageIds: string[] }
  | { type: "pushConversationCreation"; creation: ControllerConversationCreated }
  | { type: "clearConversationCreations"; conversationIds: string[] }
  | { type: "pushConversationUpdate"; update: ControllerConversationUpdated }
  | { type: "clearConversationUpdates"; conversationIds: string[] }
  | { type: "setLocalWorkspace"; workspace: LocalWorkspacePresence | null }
  | {
      type: "setRuntimeStatuses";
      statuses: ControllerRuntimeStatusEntry[];
      preferredRuntimeId: string | null;
    }
  | {
      type: "applyOriginSummary";
      summary: ControllerOriginSummary | null;
      derivedPresence: LocalWorkspacePresence | null;
      /** The project the summary belongs to. */
      projectId?: string | null;
    }
  | {
      /**
       * An origin.* stream event. Only the current default origin's presence
       * is taken from it; events from any other origin of the project leave
       * the state unchanged.
       */
      type: "applyOriginEvent";
      summary: ControllerOriginSummary;
      derivedPresence: LocalWorkspacePresence | null;
    }
  | {
      /**
       * One hydration pass: the local workspace and the default origin,
       * applied together so no render sees one without the other.
       */
      type: "applyOriginHydration";
      workspace: LocalWorkspacePresence | null;
      summary: ControllerOriginSummary | null;
      derivedPresence: LocalWorkspacePresence | null;
      projectId: string;
    }
  | { type: "setSessionRuntime"; runtimeId: string | null }
  | { type: "upsertAgentToken"; runtimeId: string; snapshot: AgentTokenSnapshot }
  | { type: "upsertTunnelGrant"; grant: ControllerTunnelGrant };

export function createInitialRuntimeStoreState(): RuntimeStoreState {
  return {
    runtime: cloneRuntimeState(createDefaultRuntimeState()),
    runs: {},
    latestRunIds: {},
    leasedRunIds: {},
    internalConversationIds: {},
    pendingConversationMessages: [],
    pendingConversationCreations: [],
    pendingConversationUpdates: [],
    localWorkspace: null,
    desktopOrigin: null,
    desktopOriginProjectId: null,
    runtimeStatuses: [],
    preferredRuntimeId: null,
    sessionRuntimeId: null,
    agentTokens: {},
    tunnelGrants: {},
  };
}

export function cloneRunsMap(
  source: Record<string, RunRecord>,
): Record<string, RunRecord> {
  const entries = Object.entries(source);
  const next: Record<string, RunRecord> = {};
  for (const [id, run] of entries) {
    next[id] = { ...run };
  }
  return next;
}

function sanitizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sanitizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : null;
}

function buildAgentTokenSnapshot(
  base: AgentTokenSnapshot | null | undefined,
  update: {
    issuedAt?: string | null;
    expiresAt?: string | null;
    ttlSeconds?: number | null;
    scopes?: string[] | null;
  },
): AgentTokenSnapshot {
  return {
    issuedAt: update.issuedAt ?? base?.issuedAt ?? null,
    expiresAt: update.expiresAt ?? base?.expiresAt ?? null,
    ttlSeconds: update.ttlSeconds ?? base?.ttlSeconds ?? null,
    scopes: update.scopes ?? base?.scopes ?? null,
    updatedAt: new Date().toISOString(),
  };
}

export function extractAgentTokenSnapshotFromEntry(
  entry: ControllerRuntimeStatusEntry,
  existing: AgentTokenSnapshot | null | undefined,
): AgentTokenSnapshot | null {
  const issuedAt = sanitizeString(entry.agentTokenIssuedAt);
  const expiresAt = sanitizeString(entry.agentTokenExpiresAt);
  const ttlSeconds = sanitizeNumber(entry.agentTokenTtl);
  const scopes = sanitizeStringArray(entry.agentTokenScopes);

  const hasScopes = Boolean(scopes && scopes.length > 0);
  if (
    issuedAt !== null ||
    expiresAt !== null ||
    ttlSeconds !== null ||
    hasScopes
  ) {
    return buildAgentTokenSnapshot(existing, {
      issuedAt,
      expiresAt,
      ttlSeconds,
      scopes,
    });
  }
  return null;
}

export function extractAgentTokenSnapshotFromEvent(
  data: Record<string, unknown> | null | undefined,
  existing: AgentTokenSnapshot | null | undefined,
): AgentTokenSnapshot | null {
  if (!data) {
    return null;
  }
  const issuedAt = sanitizeString(data["agentTokenIssuedAt"]);
  const expiresAt = sanitizeString(data["agentTokenExpiresAt"]);
  const ttlSeconds = sanitizeNumber(
    data["agentTokenTtl"] ?? data["agentTokenTtlSeconds"],
  );
  const scopes = sanitizeStringArray(data["agentTokenScopes"]);
  const hasScopes = Boolean(scopes && scopes.length > 0);
  if (
    issuedAt !== null ||
    expiresAt !== null ||
    ttlSeconds !== null ||
    hasScopes
  ) {
    return buildAgentTokenSnapshot(existing, {
      issuedAt,
      expiresAt,
      ttlSeconds,
      scopes,
    });
  }
  return null;
}

function applyAgentTokenSnapshot(
  entry: ControllerRuntimeStatusEntry,
  snapshot: AgentTokenSnapshot | null | undefined,
): ControllerRuntimeStatusEntry {
  if (!snapshot) {
    return { ...entry };
  }
  return {
    ...entry,
    agentTokenIssuedAt: snapshot.issuedAt,
    agentTokenExpiresAt: snapshot.expiresAt,
    agentTokenTtl: snapshot.ttlSeconds,
    agentTokenScopes: snapshot.scopes ?? null,
  };
}

function mergeWorkspacePresenceWithOrigin(
  workspace: LocalWorkspacePresence | null,
  originPresence: LocalWorkspacePresence | null,
): LocalWorkspacePresence | null {
  if (!originPresence) {
    return workspace;
  }
  if (!workspace) {
    return originPresence;
  }

  const originStatus = originPresence.status;
  const nextStatus =
    originStatus === "offline"
      ? "offline"
      : workspace.status === "offline" || workspace.status === "expired"
        ? workspace.status
        : originPresence.status ?? workspace.status;

  const mergedMetadata =
    workspace.metadata || originPresence.metadata
      ? {
          ...(workspace.metadata ?? {}),
          ...(originPresence.metadata ?? {}),
        }
      : workspace.metadata ?? null;

  return {
    ...workspace,
    status: nextStatus,
    presenceStatus:
      originPresence.presenceStatus ?? workspace.presenceStatus ?? null,
    lastHeartbeat: originPresence.lastHeartbeat ?? workspace.lastHeartbeat,
    region: originPresence.region ?? workspace.region ?? null,
    latencyMs: originPresence.latencyMs ?? workspace.latencyMs ?? null,
    metadata: mergedMetadata ?? null,
  };
}

function runRecordTime(run: RunRecord | null): number | null {
  const time = run?.updatedAt ? Date.parse(run.updatedAt) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

/**
 * Whether `incoming` would move the run back in its lifecycle: a finished run
 * (any status the chat does not show as working) to a live status, or a run a
 * machine had picked up back to the queue.
 */
function isRunLifecycleRegression(incoming: RunRecord, stored: RunRecord): boolean {
  if (!ACTIVE_CONVERSATION_RUN_STATUSES.has(stored.status)) {
    return ACTIVE_CONVERSATION_RUN_STATUSES.has(incoming.status);
  }
  return stored.status !== "queued" && incoming.status === "queued";
}

/**
 * Whether a stop's announcement must not replace the record the store holds,
 * decided by the stop it records rather than by times; null when `write` is
 * no such announcement, or when only times can decide.
 *
 * `write` is what the write itself carries: the whole record, or a sparse
 * patch before it merges over the stored record. A merged patch shows the
 * stored stop, so a patch that names none, such as a run event projected to
 * its status and progress for a viewer who cannot see the run's machine,
 * would read as a late announcement of that stop and be refused whatever its
 * time.
 *
 * Times cannot decide here: the database stamps `runs.updated_at` with the
 * start of the transaction that writes it, so a stop that put the turn back
 * in the queue can carry an earlier time than a progress update that
 * committed just before it. A stop the store has not seen therefore applies
 * to a live run whatever its time. The same stop is refused once the run
 * moved on from it: a machine picked the turn up again, which keeps the
 * stop's record as history, or the turn finished. So is the record of a stop
 * that came before the one the store holds. A finished run that names no
 * such stop is left to the times.
 */
function stopAnnouncementIsStale(write: RunRecordPatch, stored: RunRecord): boolean | null {
  const stop =
    write.status === "queued" && write.progressStage === "requeued"
      ? readRunInterruptionIdentity(write)
      : null;
  if (!stop) {
    return null;
  }
  const storedStop = readRunInterruptionIdentity(stored);
  const order = storedStop ? compareRunInterruptions(stop, storedStop) : null;
  if (order === 0) {
    return stored.status !== "queued";
  }
  if (order !== null && order < 0) {
    return true;
  }
  return ACTIVE_CONVERSATION_RUN_STATUSES.has(stored.status) ? false : null;
}

/**
 * Whether `incoming` is a stale record that must not replace the one the
 * store holds. Every run write lands here: live events, their sparse patches,
 * GET /runs hydration and the reconcile after a reconnect. Run events can
 * arrive out of order: the controller stamps a stop's announcement with the
 * time the stop put the turn back in the queue, and it answers only after the
 * machine is released, so the lease that picked the turn up again (stamped
 * when it is sent) can arrive first. A stop's announcement is decided by the
 * stop it records (stopAnnouncementIsStale), read from `write`, what the
 * write carries before a patch merges over the stored record.
 *
 * Otherwise times decide, but not alone: live events carry the controller's
 * clock when it sends them, while hydration, the run events other viewers get
 * and the stop's announcement carry the database's `runs.updated_at`, and the
 * two can be a few milliseconds apart. So an older record still applies when
 * it moves the run forward, keeps its status (a progress tick) or finishes
 * it, and only a step back that is also older is refused. Equal times apply,
 * and so does a record without a readable time on either side.
 */
function isStaleRunRecord(
  incoming: RunRecord,
  stored: RunRecord | null,
  write: RunRecordPatch = incoming,
): boolean {
  if (stored === null) {
    return false;
  }
  const stale = stopAnnouncementIsStale(write, stored);
  if (stale !== null) {
    return stale;
  }
  const incomingAt = runRecordTime(incoming);
  const storedAt = runRecordTime(stored);
  return (
    incomingAt !== null &&
    storedAt !== null &&
    incomingAt < storedAt &&
    isRunLifecycleRegression(incoming, stored)
  );
}

/**
 * Stores `run` unless it is stale (isStaleRunRecord). `write` is what the
 * write carried: `run` itself, or the patch `run` merges over the stored
 * record.
 */
function storeRunRecord(
  state: RuntimeStoreState,
  run: RunRecord,
  write: RunRecordPatch = run,
): RuntimeStoreState {
  const existing = state.runs[run.id] ?? null;
  if (isStaleRunRecord(run, existing, write)) {
    return state;
  }
  const nextRuns = { ...state.runs };
  nextRuns[run.id] = {
    ...existing,
    ...run,
  };
  return {
    ...state,
    runs: nextRuns,
    latestRunIds: {
      ...state.latestRunIds,
      [run.runType]: run.id,
    },
    leasedRunIds: { ...state.leasedRunIds },
  };
}

export function runtimeReducer(
  state: RuntimeStoreState,
  action: RuntimeAction,
): RuntimeStoreState {
  switch (action.type) {
    case "setInternalConversationIds":
      return {
        ...state,
        internalConversationIds: Object.fromEntries(action.conversationIds.map((id) => [id, true])),
      };
    case "setRuntime":
      return {
        ...state,
        runtime: cloneRuntimeState(action.runtime),
      };
    case "updateRuntime": {
      const next = action.updater(cloneRuntimeState(state.runtime));
      return {
        ...state,
        runtime: cloneRuntimeState(next),
      };
    }
    case "setRunsState":
      return {
        ...state,
        runs: cloneRunsMap(action.runs),
        latestRunIds: { ...action.latestRunIds },
        leasedRunIds: {},
        pendingConversationMessages: state.pendingConversationMessages,
      };
    case "patchRun": {
      const existing = state.runs[action.patch.id];
      const run: RunRecord = {
        ...(existing ?? {
          projectId: null,
          sessionId: null,
          conversationId: null,
          promptId: null,
          runType: "prompt",
          status: "queued",
          progress: 0,
          progressStage: null,
          previewUrl: null,
          lastMessage: null,
          metadata: null,
          createdAt: null,
          updatedAt: null,
        }),
        ...action.patch,
      };
      if (action.patch.metadata) {
        run.metadata = { ...existing?.metadata, ...action.patch.metadata };
      }
      return storeRunRecord(state, run, action.patch);
    }
    case "upsertRun":
      return storeRunRecord(state, action.run);
    case "removeRun": {
      const target = state.runs[action.runId];
      if (!target) {
        return state;
      }
      const nextRuns = { ...state.runs };
      delete nextRuns[action.runId];
      const nextLatest = { ...state.latestRunIds };
      if (nextLatest[target.runType] === action.runId) {
        delete nextLatest[target.runType];
      }
      const remainingLeases = { ...state.leasedRunIds };
      delete remainingLeases[action.runId];
      return {
        ...state,
        runs: nextRuns,
        latestRunIds: nextLatest,
        leasedRunIds: remainingLeases,
      };
    }
    case "markRunLeased": {
      if (!action.runId) {
        return state;
      }
      if (state.leasedRunIds[action.runId]) {
        return state;
      }
      return {
        ...state,
        leasedRunIds: {
          ...state.leasedRunIds,
          [action.runId]: true,
        },
      };
    }
    case "clearRunLease": {
      if (!(action.runId in state.leasedRunIds)) {
        return state;
      }
      const rest = { ...state.leasedRunIds };
      delete rest[action.runId];
      return {
        ...state,
        leasedRunIds: rest,
      };
    }
    case "pushConversationMessage": {
      return {
        ...state,
        pendingConversationMessages: [
          ...state.pendingConversationMessages,
          action.message,
        ],
      };
    }
    case "clearConversationMessages": {
      if (action.messageIds.length === 0) {
        return {
          ...state,
          pendingConversationMessages: [],
        };
      }
      const ids = new Set(action.messageIds);
      return {
        ...state,
        pendingConversationMessages: state.pendingConversationMessages.filter(
          (message) => !ids.has(message.id),
        ),
      };
    }
    case "pushConversationCreation": {
      return {
        ...state,
        pendingConversationCreations: [
          ...state.pendingConversationCreations,
          action.creation,
        ],
      };
    }
    case "clearConversationCreations": {
      if (action.conversationIds.length === 0) {
        return {
          ...state,
          pendingConversationCreations: [],
        };
      }
      const ids = new Set(action.conversationIds);
      return {
        ...state,
        pendingConversationCreations: state.pendingConversationCreations.filter(
          (creation) => !ids.has(creation.conversationId),
        ),
      };
    }
    case "pushConversationUpdate": {
      return {
        ...state,
        pendingConversationUpdates: [
          ...state.pendingConversationUpdates,
          action.update,
        ],
      };
    }
    case "clearConversationUpdates": {
      if (action.conversationIds.length === 0) {
        return {
          ...state,
          pendingConversationUpdates: [],
        };
      }
      const ids = new Set(action.conversationIds);
      return {
        ...state,
        pendingConversationUpdates: state.pendingConversationUpdates.filter(
          (update) => !ids.has(update.conversationId),
        ),
      };
    }
    case "setLocalWorkspace": {
      return {
        ...state,
        localWorkspace: action.workspace,
      };
    }
    case "applyOriginSummary": {
      const nextOrigin = action.summary;
      let nextWorkspace = state.localWorkspace;
      if (nextOrigin && action.derivedPresence) {
        nextWorkspace = mergeWorkspacePresenceWithOrigin(
          state.localWorkspace,
          action.derivedPresence,
        );
      }
      return {
        ...state,
        desktopOrigin: nextOrigin,
        desktopOriginProjectId: nextOrigin ? (action.projectId ?? null) : null,
        localWorkspace: nextWorkspace,
      };
    }
    case "applyOriginEvent": {
      const current = state.desktopOrigin;
      if (!current || current.originId !== action.summary.originId) {
        return state;
      }
      // Event payloads carry no runtimeId, so keep the resolved summary and
      // take only presence from the event.
      return {
        ...state,
        desktopOrigin: {
          ...current,
          presence: action.summary.presence ?? current.presence,
        },
        localWorkspace: mergeWorkspacePresenceWithOrigin(
          state.localWorkspace,
          action.derivedPresence,
        ),
      };
    }
    case "applyOriginHydration": {
      const withWorkspace = runtimeReducer(state, {
        type: "setLocalWorkspace",
        workspace: action.workspace,
      });
      return runtimeReducer(withWorkspace, {
        type: "applyOriginSummary",
        summary: action.summary,
        derivedPresence: action.derivedPresence,
        projectId: action.projectId,
      });
    }
    case "setRuntimeStatuses": {
      const nextAgentTokens = { ...state.agentTokens };
      const statusesWithTokens = action.statuses.map((entry) => {
        const existingSnapshot = nextAgentTokens[entry.runtimeId];
        const snapshotFromEntry = extractAgentTokenSnapshotFromEntry(
          entry,
          existingSnapshot,
        );
        if (snapshotFromEntry) {
          nextAgentTokens[entry.runtimeId] = snapshotFromEntry;
        }
        const snapshotToApply = nextAgentTokens[entry.runtimeId];
        return applyAgentTokenSnapshot(entry, snapshotToApply);
      });
      const retainedRuntimeIds = new Set(
        statusesWithTokens
          .map((entry) => entry.runtimeId)
          .filter((runtimeId): runtimeId is string => Boolean(runtimeId)),
      );
      for (const runtimeId of Object.keys(nextAgentTokens)) {
        if (!retainedRuntimeIds.has(runtimeId)) {
          delete nextAgentTokens[runtimeId];
        }
      }
      const nextTunnelGrants = Object.fromEntries(
        Object.entries(state.tunnelGrants).filter(([runtimeId]) =>
          retainedRuntimeIds.has(runtimeId),
        ),
      );
      return {
        ...state,
        runtimeStatuses: statusesWithTokens,
        preferredRuntimeId: action.preferredRuntimeId,
        agentTokens: nextAgentTokens,
        tunnelGrants: nextTunnelGrants,
      };
    }
    case "setSessionRuntime": {
      if (state.sessionRuntimeId === action.runtimeId) {
        return state;
      }
      return {
        ...state,
        sessionRuntimeId: action.runtimeId,
      };
    }
    case "upsertAgentToken": {
      const nextAgentTokens = {
        ...state.agentTokens,
        [action.runtimeId]: action.snapshot,
      };
      const nextStatuses = state.runtimeStatuses.map((entry) => {
        if (entry.runtimeId !== action.runtimeId) {
          return entry;
        }
        return applyAgentTokenSnapshot(entry, action.snapshot);
      });
      return {
        ...state,
        agentTokens: nextAgentTokens,
        runtimeStatuses: nextStatuses,
      };
    }
    case "upsertTunnelGrant": {
      const runtimeId = action.grant.runtimeId;
      if (!runtimeId) {
        return state;
      }
      return {
        ...state,
        tunnelGrants: {
          ...state.tunnelGrants,
          [runtimeId]: action.grant,
        },
      };
    }
    default:
      return state;
  }
}
