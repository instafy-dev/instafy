import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type JSX,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import {
  getBuiltInAssistantDisplayName,
  getDefaultAssistantHandle,
  isReservedBuiltInAgentHandle,
  listBuiltInAssistantHandles,
} from "../../../assistants/localBuiltInAssistantCatalog";
import type { StatusIntent } from "../../../status/useStatus";
import type { RunRecord } from "../../../types";
import {
  type ControllerAgentProfile,
  controllerClient,
} from "../../../sdk/instafy";
import { AssistantAvatarPopover } from "./AssistantAvatarPopover";
import {
  type AssistantAgentIdentity,
  type AssistantAvatarRenderOptions,
  extractAgentIdentityFromMetadata,
  extractRunIdFromMetadata,
} from "./chatAssistantIdentity";
import type { QueuedChatSendItem } from "./chatSendQueueStorage";
import { formatRuntimeResourcesSummary } from "./chatRuntimeResources";

const { enabled: runtimeControllerEnabled } = controllerClient.core;
const { list: listMyAgents } = controllerClient.agents;

type ShowStatus = (message: string, intent: StatusIntent, durationMs?: number) => void;
type RuntimeLike = { label: string; state: string; resources?: unknown | null };
type RuntimeOptionLike = { label: string; state: string; resources?: unknown | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function useChatAgentRoster({
  activeConversationId,
  activeProjectId,
  agentHandles,
  assistantEnabled,
  currentRuntime,
  currentUserId,
  extraAgentHandles,
  onOpenAgentProfileSettings,
  onRemoveAgentHandle,
  runs,
  runtimeOptionsById,
  preferredRuntimeId,
  setChatSendQueue,
  showStatus,
  stickyMentionedAgentByConversationRef,
}: {
  activeConversationId: string | null;
  activeProjectId: string | null;
  agentHandles: string[];
  assistantEnabled: boolean;
  currentRuntime: RuntimeLike;
  currentUserId: string | null;
  extraAgentHandles: string[];
  onOpenAgentProfileSettings: (handle: string) => void;
  onRemoveAgentHandle: (conversationId: string, handle: string) => void;
  runs: Record<string, RunRecord> | null | undefined;
  runtimeOptionsById: Map<string, RuntimeOptionLike>;
  preferredRuntimeId: string | null;
  setChatSendQueue: Dispatch<SetStateAction<QueuedChatSendItem[]>>;
  showStatus: ShowStatus;
  stickyMentionedAgentByConversationRef: MutableRefObject<Map<string, string>>;
}) {
  const [availableAgents, setAvailableAgents] = useState<ControllerAgentProfile[]>([]);
  const [availableAgentsLoaded, setAvailableAgentsLoaded] = useState(false);

  const preferredRuntimeLabel = useMemo(() => {
    if (!preferredRuntimeId) {
      return null;
    }
    return runtimeOptionsById.get(preferredRuntimeId)?.label ?? null;
  }, [preferredRuntimeId, runtimeOptionsById]);

  const agentByHandle = useMemo(() => {
    const lookup = new Map<string, ControllerAgentProfile>();
    for (const agent of availableAgents) {
      const handle = agent.handle?.trim().toLowerCase();
      if (!handle) {
        continue;
      }
      lookup.set(handle, agent);
    }
    return lookup;
  }, [availableAgents]);

  const mentionableAgentHandles = useMemo(() => {
    const handles = new Set<string>();
    for (const handle of agentHandles) {
      const normalized = handle.trim().toLowerCase();
      if (normalized) {
        handles.add(normalized);
      }
    }
    for (const agent of availableAgents) {
      const normalized = agent.handle?.trim().toLowerCase() ?? "";
      if (normalized) {
        handles.add(normalized);
      }
    }
    for (const handle of listBuiltInAssistantHandles()) {
      handles.add(handle);
    }
    return Array.from(handles);
  }, [agentHandles, availableAgents]);

  const availableCustomAgentHandleSet = useMemo(() => {
    const handles = new Set<string>();
    for (const agent of availableAgents) {
      const normalized = agent.handle?.trim().toLowerCase() ?? "";
      if (!normalized || isReservedBuiltInAgentHandle(normalized)) {
        continue;
      }
      handles.add(normalized);
    }
    return handles;
  }, [availableAgents]);

  const primaryAgentHandleForPopover = useMemo(() => {
    if (assistantEnabled) {
      return getDefaultAssistantHandle();
    }
    return extraAgentHandles[0] ?? null;
  }, [assistantEnabled, extraAgentHandles]);

  const runAgentIdentityByRunId = useMemo(() => {
    const lookup = new Map<string, AssistantAgentIdentity>();
    for (const run of Object.values(runs ?? {})) {
      const runId = typeof run.id === "string" ? run.id.trim() : "";
      if (!runId) {
        continue;
      }
      const metadata = isRecord(run.metadata) ? run.metadata : null;
      const identity = extractAgentIdentityFromMetadata(metadata);
      if (!identity) {
        continue;
      }
      lookup.set(runId, identity);
    }
    return lookup;
  }, [runs]);

  const runAgentHandleByRunId = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const [runId, identity] of runAgentIdentityByRunId.entries()) {
      lookup.set(runId, identity.handle);
    }
    return lookup;
  }, [runAgentIdentityByRunId]);

  const refreshAvailableAgents = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!runtimeControllerEnabled || !currentUserId || !activeProjectId) {
        setAvailableAgents([]);
        setAvailableAgentsLoaded(false);
        return;
      }

      const result = await listMyAgents({ projectId: activeProjectId }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false as const, agents: [], error: message };
      });

      if (result.success) {
        setAvailableAgents(result.agents);
        setAvailableAgentsLoaded(true);
        return;
      }

      if (!options?.silent) {
        showStatus(result.error ?? "Unable to load agents.", "error", 4500);
      }
    },
    [activeProjectId, currentUserId, showStatus],
  );

  useEffect(() => {
    void refreshAvailableAgents({ silent: true });
  }, [refreshAvailableAgents]);

  useEffect(() => {
    if (!runtimeControllerEnabled || !activeConversationId || !availableAgentsLoaded) {
      return;
    }

    const invalidExtraHandles = extraAgentHandles
      .map((handle) => handle.trim().toLowerCase())
      .filter(
        (handle) =>
          Boolean(handle) &&
          !isReservedBuiltInAgentHandle(handle) &&
          !availableCustomAgentHandleSet.has(handle),
      );

    if (invalidExtraHandles.length === 0) {
      return;
    }

    for (const handle of invalidExtraHandles) {
      onRemoveAgentHandle(activeConversationId, handle);
    }

    const stickyHandle = stickyMentionedAgentByConversationRef.current.get(activeConversationId) ?? null;
    if (stickyHandle && !availableCustomAgentHandleSet.has(stickyHandle)) {
      stickyMentionedAgentByConversationRef.current.delete(activeConversationId);
    }

    setChatSendQueue((previous) => {
      let changed = false;
      const next = previous.map((item) => {
        const filtered = (item.targetAgentHandles ?? []).filter((handle) => {
          const normalized = handle.trim().toLowerCase();
          if (!normalized || isReservedBuiltInAgentHandle(normalized)) {
            return true;
          }
          return availableCustomAgentHandleSet.has(normalized);
        });
        if (filtered.length === (item.targetAgentHandles ?? []).length) {
          return item;
        }
        changed = true;
        return { ...item, targetAgentHandles: filtered };
      });
      return changed ? next : previous;
    });
  }, [
    activeConversationId,
    availableAgentsLoaded,
    availableCustomAgentHandleSet,
    extraAgentHandles,
    onRemoveAgentHandle,
    setChatSendQueue,
    stickyMentionedAgentByConversationRef,
  ]);

  const renderAssistantAvatar = useCallback(
    (
      metadata?: Record<string, unknown> | null,
      messageAgentIdentity?: AssistantAgentIdentity | null,
      options?: AssistantAvatarRenderOptions,
    ): JSX.Element => {
      const metadataAgentIdentity = extractAgentIdentityFromMetadata(metadata ?? null);
      const messageRunId = extractRunIdFromMetadata(metadata ?? null);
      const runAgentIdentity = messageRunId ? runAgentIdentityByRunId.get(messageRunId) ?? null : null;
      const resolvedAgentIdentity = messageAgentIdentity ?? metadataAgentIdentity ?? runAgentIdentity;
      const agentHandle =
        resolvedAgentIdentity?.handle ?? primaryAgentHandleForPopover ?? getDefaultAssistantHandle();
      const agent = agentByHandle.get(agentHandle) ?? null;
      const agentAvatarSeed =
        typeof agent?.avatarSeed === "string" && agent.avatarSeed.trim().length > 0
          ? agent.avatarSeed.trim()
          : resolvedAgentIdentity?.avatarSeed ?? agentHandle;
      const displayName =
        getBuiltInAssistantDisplayName(agentHandle) ??
        (agent?.displayName?.trim() ? agent.displayName.trim() : `@${agentHandle}`);
      const pinnedRuntimeId = agent?.runtimeId ?? null;
      const runtimeOption = pinnedRuntimeId ? runtimeOptionsById.get(pinnedRuntimeId) ?? null : null;
      const runtimeLabel = runtimeOption?.label ?? preferredRuntimeLabel ?? currentRuntime.label;
      const runtimeState = runtimeOption?.state ?? currentRuntime.state;
      const resourcesSummary =
        formatRuntimeResourcesSummary(runtimeOption?.resources ?? null) ??
        formatRuntimeResourcesSummary(currentRuntime.resources ?? null);

      return (
        <AssistantAvatarPopover
          metadata={metadata ?? null}
          agentHandle={agentHandle}
          agentId={agent?.id ?? null}
          agentAvatarSeed={agentAvatarSeed}
          displayName={displayName}
          motion={options?.motion}
          scrollReactive={options?.scrollReactive}
          pinnedRuntimeId={pinnedRuntimeId}
          runtimeLabel={runtimeLabel}
          runtimeState={runtimeState}
          resourcesSummary={resourcesSummary}
          onOpenSettings={onOpenAgentProfileSettings}
        />
      );
    },
    [
      agentByHandle,
      currentRuntime.label,
      currentRuntime.resources,
      currentRuntime.state,
      onOpenAgentProfileSettings,
      preferredRuntimeLabel,
      primaryAgentHandleForPopover,
      runAgentIdentityByRunId,
      runtimeOptionsById,
    ],
  );

  return {
    agentByHandle,
    availableAgents,
    mentionableAgentHandles,
    primaryAgentHandleForPopover,
    refreshAvailableAgents,
    renderAssistantAvatar,
    runAgentHandleByRunId,
    runAgentIdentityByRunId,
  };
}
