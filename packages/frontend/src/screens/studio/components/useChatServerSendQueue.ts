import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { withDefaultInteractiveWorkspaceExpectations } from "../../../conversations/conversationRuntimeExpectations";
import type { SubmitConversationRuntimeOverride } from "../../../conversations/useConversation";
import { CONTROLLER_RUNTIME_IDLE_TTL_SECONDS_DEFAULT } from "../../../services/runtimeController/core";
import {
  CONVERSATION_SEND_QUEUE_EVENT,
  cancelSendQueueEntry,
  dispatchSendQueueEntryNow,
  enqueueSendQueueEntry,
  listSendQueue,
  reorderSendQueueEntry,
  type ControllerSendQueueEntry,
  type ControllerSendQueueEntryStatus,
  type ConversationSendQueueEventDetail,
} from "../../../services/runtimeController/sendQueue";
import type { QueuedChatSendItem } from "./chatSendQueueStorage";

export type ServerQueuedChatSendItem = QueuedChatSendItem & {
  source: "server";
  status: ControllerSendQueueEntryStatus;
  errorMessage: string | null;
};

export type EnqueueServerSendQueuePayload = {
  message: string;
  targetAgentHandles: string[];
  metadata?: Record<string, unknown> | null;
  runtimeOverride?: SubmitConversationRuntimeOverride | null;
  intent?: string | null;
};

export function isServerQueuedChatSendItem(
  item: QueuedChatSendItem,
): item is ServerQueuedChatSendItem {
  return (item as Partial<ServerQueuedChatSendItem>).source === "server";
}

export function reorderServerQueueEntries(
  entries: ControllerSendQueueEntry[],
  entryId: string,
  beforeEntryId: string | null,
): ControllerSendQueueEntry[] {
  const currentIndex = entries.findIndex((entry) => entry.id === entryId);
  if (currentIndex < 0 || beforeEntryId === entryId) {
    return entries;
  }
  const next = entries.filter((entry) => entry.id !== entryId);
  const moving = entries[currentIndex];
  if (beforeEntryId === null) {
    next.push(moving);
  } else {
    const anchorIndex = next.findIndex((entry) => entry.id === beforeEntryId);
    if (anchorIndex < 0) {
      return entries;
    }
    next.splice(anchorIndex, 0, moving);
  }
  return next.every((entry, index) => entry.id === entries[index]?.id) ? entries : next;
}

function sortServerQueueEntriesByPosition(
  entries: ControllerSendQueueEntry[],
): ControllerSendQueueEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftPosition = left.entry.queuePosition ?? Number.MAX_SAFE_INTEGER;
      const rightPosition = right.entry.queuePosition ?? Number.MAX_SAFE_INTEGER;
      return leftPosition - rightPosition || left.index - right.index;
    })
    .map(({ entry }) => entry);
}

export function reconcileServerQueueEntryPositions(
  current: ControllerSendQueueEntry[],
  authoritative: ControllerSendQueueEntry[],
): ControllerSendQueueEntry[] {
  const positions = new Map(
    authoritative.map((entry) => [entry.id, entry.queuePosition] as const),
  );
  return sortServerQueueEntriesByPosition(
    current.map((entry) => {
      const queuePosition = positions.get(entry.id);
      return queuePosition !== undefined && queuePosition !== entry.queuePosition
        ? { ...entry, queuePosition }
        : entry;
    }),
  );
}

// Mirrors the prompt body that useConversationControllerDispatch would have
// POSTed to /conversations/:id/messages so the controller can dispatch the
// queued entry verbatim once the target agents go idle.
export function buildServerSendQueuePromptBody(
  payload: EnqueueServerSendQueuePayload,
): Record<string, unknown> {
  const intent = payload.intent ?? "feature";
  const metadata =
    intent === "terminal_command"
      ? payload.metadata ?? null
      : withDefaultInteractiveWorkspaceExpectations(payload.metadata ?? null);
  const runtimeOverride = payload.runtimeOverride?.runtimeId
    ? payload.runtimeOverride
    : null;
  return {
    sessionId: null,
    promptText: payload.message,
    intent,
    metadata: metadata ?? {},
    idleTtlSeconds: CONTROLLER_RUNTIME_IDLE_TTL_SECONDS_DEFAULT,
    ...(runtimeOverride
      ? {
          runtimeId: runtimeOverride.runtimeId,
          runtimeDisplayName: runtimeOverride.runtimeDisplayName,
          preferRuntime: runtimeOverride.preferRuntime,
        }
      : {}),
  };
}

function normalizeTargetHandlesKey(handles: string[]): string {
  return [...handles].sort().join("\u0000");
}

export function mapServerSendQueueEntryToQueuedItem(
  entry: ControllerSendQueueEntry,
): ServerQueuedChatSendItem | null {
  const promptText =
    typeof entry.message.promptText === "string" ? entry.message.promptText : "";
  if (!promptText.trim()) {
    return null;
  }
  const metadata =
    entry.message.metadata &&
    typeof entry.message.metadata === "object" &&
    !Array.isArray(entry.message.metadata)
      ? (entry.message.metadata as Record<string, unknown>)
      : null;
  const createdAtMs = Date.parse(entry.createdAt);
  const runtimeId =
    typeof entry.message.runtimeId === "string"
      ? entry.message.runtimeId.trim()
      : "";
  const runtimeDisplayName =
    typeof entry.message.runtimeDisplayName === "string"
      ? entry.message.runtimeDisplayName.trim() || null
      : null;
  const preferRuntime =
    typeof entry.message.preferRuntime === "boolean"
      ? entry.message.preferRuntime
      : null;
  const runtimeOverride: SubmitConversationRuntimeOverride | null = runtimeId
    ? { runtimeId, runtimeDisplayName, preferRuntime }
    : null;
  return {
    id: entry.id,
    message: promptText,
    editorState: null,
    createdAt: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
    targetAgentHandles: entry.targetAgentHandles,
    browserPageTarget: null,
    browserLaunchMode: null,
    metadata,
    ...(runtimeOverride ? { runtimeOverride } : {}),
    source: "server",
    status: entry.status,
    errorMessage: entry.errorMessage,
  };
}

export function useChatServerSendQueue({
  conversationControllerId,
  runtimeControllerEnabled,
}: {
  conversationControllerId: string | null;
  runtimeControllerEnabled: boolean;
}) {
  const [serverSendQueueEntries, setServerSendQueueEntries] = useState<
    ControllerSendQueueEntry[]
  >([]);
  const [serverQueueReordering, setServerQueueReordering] = useState(false);
  const [hydratedConversationId, setHydratedConversationId] = useState<string | null>(null);
  const reorderInFlightRef = useRef<symbol | null>(null);
  const refreshEpochRef = useRef(0);
  const queueGenerationRef = useRef(0);
  const conversationControllerIdRef = useRef(conversationControllerId);
  const serverQueueEnabled = runtimeControllerEnabled && Boolean(conversationControllerId);
  const serverQueueHydrated =
    !serverQueueEnabled || hydratedConversationId === conversationControllerId;
  conversationControllerIdRef.current = conversationControllerId;

  // Optimistic mutations resolve asynchronously, so a slow response can land
  // after a conversation switch. Capture the queue generation and the
  // conversation the request targets before the awaited call: commits are
  // discarded when either changed (the queue was reset for another
  // conversation, or reset and rehydrated after switching away and back).
  // Concurrent refreshes must NOT invalidate a fresh commit — the commit is
  // the only guaranteed signal that the mutation happened, while a refresh
  // that started mid-flight may have read a snapshot that predates it.
  // Instead, applying a commit bumps the refresh epoch so refreshes that
  // started earlier cannot clobber the optimistic state.
  const beginQueueMutation = useCallback((conversationId: string) => {
    const generation = queueGenerationRef.current;
    return {
      commit: (
        updater: (previous: ControllerSendQueueEntry[]) => ControllerSendQueueEntry[],
      ) => {
        if (
          queueGenerationRef.current !== generation ||
          conversationControllerIdRef.current !== conversationId
        ) {
          return;
        }
        refreshEpochRef.current += 1;
        setServerSendQueueEntries(updater);
      },
    };
  }, []);

  const refreshServerSendQueue = useCallback(async () => {
    const conversationId = conversationControllerId;
    if (!runtimeControllerEnabled || !conversationId) {
      if (conversationControllerIdRef.current === conversationId) {
        setServerSendQueueEntries([]);
        setHydratedConversationId(null);
      }
      return;
    }
    if (conversationControllerIdRef.current !== conversationId) {
      return;
    }
    const generation = queueGenerationRef.current;
    const epoch = ++refreshEpochRef.current;
    const entries = await listSendQueue({ conversationId });
    const currentQueue =
      queueGenerationRef.current === generation &&
      conversationControllerIdRef.current === conversationId;
    if (entries && currentQueue && refreshEpochRef.current === epoch) {
      setHydratedConversationId(conversationId);
      setServerSendQueueEntries(entries);
    }
  }, [conversationControllerId, runtimeControllerEnabled]);

  useEffect(() => {
    refreshEpochRef.current += 1;
    queueGenerationRef.current += 1;
    reorderInFlightRef.current = null;
    setServerQueueReordering(false);
    setHydratedConversationId(null);
    setServerSendQueueEntries([]);
    if (!serverQueueEnabled) {
      return;
    }
    void refreshServerSendQueue();
  }, [refreshServerSendQueue, serverQueueEnabled]);

  useEffect(() => {
    if (!serverQueueEnabled || typeof window === "undefined") {
      return;
    }
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ConversationSendQueueEventDetail>).detail;
      if (!detail || detail.conversationId !== conversationControllerId) {
        return;
      }
      void refreshServerSendQueue();
    };
    window.addEventListener(CONVERSATION_SEND_QUEUE_EVENT, handler);
    return () => {
      window.removeEventListener(CONVERSATION_SEND_QUEUE_EVENT, handler);
    };
  }, [conversationControllerId, refreshServerSendQueue, serverQueueEnabled]);

  const enqueueServerSendQueueItem = useCallback(
    async (payload: EnqueueServerSendQueuePayload): Promise<boolean> => {
      if (!runtimeControllerEnabled || !conversationControllerId) {
        return false;
      }
      const conversationId = conversationControllerId;
      const mutation = beginQueueMutation(conversationId);
      try {
        const entry = await enqueueSendQueueEntry({
          conversationId,
          message: buildServerSendQueuePromptBody(payload),
          targetAgentHandles: payload.targetAgentHandles,
        });
        if (!entry) {
          return false;
        }
        mutation.commit((previous) => {
          if (previous.some((existing) => existing.id === entry.id)) {
            return previous;
          }
          return [...previous, entry];
        });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[chat] server send queue enqueue failed:", message);
        // The controller may have committed the row before the request failed
        // (e.g. a timeout after the INSERT). Reconcile against the server
        // queue so callers do not re-queue a duplicate through the
        // localStorage fallback.
        const entries = await listSendQueue({ conversationId });
        if (entries) {
          const targetKey = normalizeTargetHandlesKey(payload.targetAgentHandles);
          const committed = entries.some(
            (candidate) =>
              candidate.message.promptText === payload.message &&
              normalizeTargetHandlesKey(candidate.targetAgentHandles) === targetKey,
          );
          if (committed) {
            mutation.commit(() => entries);
            return true;
          }
        }
        return false;
      }
    },
    [beginQueueMutation, conversationControllerId, runtimeControllerEnabled],
  );

  const removeServerSendQueueEntry = useCallback(
    async (entryId: string): Promise<boolean> => {
      if (!runtimeControllerEnabled || !conversationControllerId) {
        return false;
      }
      const conversationId = conversationControllerId;
      const mutation = beginQueueMutation(conversationId);
      try {
        const result = await cancelSendQueueEntry({
          conversationId,
          entryId,
        });
        if (!result?.ok) {
          return false;
        }
        mutation.commit((previous) => previous.filter((entry) => entry.id !== entryId));
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[chat] server send queue cancel failed:", message);
        void refreshServerSendQueue();
        return false;
      }
    },
    [beginQueueMutation, conversationControllerId, refreshServerSendQueue, runtimeControllerEnabled],
  );

  const dispatchServerSendQueueEntryNow = useCallback(
    async (entryId: string): Promise<boolean> => {
      if (!runtimeControllerEnabled || !conversationControllerId) {
        return false;
      }
      const conversationId = conversationControllerId;
      const mutation = beginQueueMutation(conversationId);
      const result = await dispatchSendQueueEntryNow({
        conversationId,
        entryId,
      });
      if (!result) {
        return false;
      }
      if (result.outcome === "queued") {
        mutation.commit((previous) => previous);
        void refreshServerSendQueue();
        return false;
      }
      mutation.commit((previous) => previous.filter((entry) => entry.id !== entryId));
      if (result.outcome !== "dispatched") {
        // The server drain already dispatched the entry, or it was removed
        // elsewhere. Either way it is no longer queued, so treat the send as
        // successful and resync instead of surfacing an error.
        void refreshServerSendQueue();
      }
      return true;
    },
    [beginQueueMutation, conversationControllerId, refreshServerSendQueue, runtimeControllerEnabled],
  );

  const reorderServerSendQueueEntry = useCallback(
    async (entryId: string, beforeEntryId: string | null): Promise<boolean> => {
      if (
        !runtimeControllerEnabled ||
        !conversationControllerId ||
        reorderInFlightRef.current !== null
      ) {
        return false;
      }
      const conversationId = conversationControllerId;
      const mutation = beginQueueMutation(conversationId);
      const reorderToken = Symbol("send-queue-reorder");
      reorderInFlightRef.current = reorderToken;
      setServerQueueReordering(true);
      mutation.commit((previous) =>
        reorderServerQueueEntries(previous, entryId, beforeEntryId),
      );
      try {
        const result = await reorderSendQueueEntry({
          conversationId,
          entryId,
          beforeEntryId,
        });
        if (!result?.ok) {
          mutation.commit(sortServerQueueEntriesByPosition);
          await refreshServerSendQueue();
          return false;
        }
        mutation.commit((previous) =>
          reconcileServerQueueEntryPositions(previous, result.entries),
        );
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[chat] server send queue reorder failed:", message);
        mutation.commit(sortServerQueueEntriesByPosition);
        await refreshServerSendQueue();
        return false;
      } finally {
        if (reorderInFlightRef.current === reorderToken) {
          reorderInFlightRef.current = null;
          setServerQueueReordering(false);
        }
      }
    },
    [
      beginQueueMutation,
      conversationControllerId,
      refreshServerSendQueue,
      runtimeControllerEnabled,
    ],
  );

  const serverSendQueueItems = useMemo(
    () =>
      serverSendQueueEntries
        .map(mapServerSendQueueEntryToQueuedItem)
        .filter((item): item is ServerQueuedChatSendItem => Boolean(item)),
    [serverSendQueueEntries],
  );

  return {
    dispatchServerSendQueueEntryNow,
    enqueueServerSendQueueItem,
    refreshServerSendQueue,
    removeServerSendQueueEntry,
    reorderServerSendQueueEntry,
    serverQueueReordering,
    serverQueueEnabled,
    serverQueueHydrated,
    serverSendQueueItems,
  };
}
