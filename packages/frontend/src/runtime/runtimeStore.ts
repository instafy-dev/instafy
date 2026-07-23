import type { RunRecord, RuntimeState } from "../types";
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
  pendingConversationMessages: ControllerConversationMessage[];
  pendingConversationCreations: ControllerConversationCreated[];
  pendingConversationUpdates: ControllerConversationUpdated[];
  localWorkspace: LocalWorkspacePresence | null;
  desktopOrigin: ControllerOriginSummary | null;
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
  | { type: "removeRun"; runId: string }
  | { type: "markRunLeased"; runId: string }
  | { type: "clearRunLease"; runId: string }
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
    pendingConversationMessages: [],
    pendingConversationCreations: [],
    pendingConversationUpdates: [],
    localWorkspace: null,
    desktopOrigin: null,
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

export function runtimeReducer(
  state: RuntimeStoreState,
  action: RuntimeAction,
): RuntimeStoreState {
  switch (action.type) {
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
    case "upsertRun": {
      const nextRuns = { ...state.runs };
      const existing = nextRuns[action.run.id] ?? null;
      nextRuns[action.run.id] = {
        ...existing,
        ...action.run,
      };
      return {
        ...state,
        runs: nextRuns,
        latestRunIds: {
          ...state.latestRunIds,
          [action.run.runType]: action.run.id,
        },
        leasedRunIds: { ...state.leasedRunIds },
      };
    }
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
        localWorkspace: nextWorkspace,
      };
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
