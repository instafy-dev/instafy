import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
} from "react";
import { controllerClient } from "../sdk/instafy";
import type { ControllerProjectConversation } from "../services/runtimeController/conversations";
import {
  extractConversationGoalFromMetadata,
  shouldApplyConversationGoalSnapshot,
} from "./conversationGoals";
import {
  DEFAULT_CONVERSATION_ROUTING_PREFERENCES,
  extractConversationRoutingPreferences,
  type ConversationRoutingPreferences,
} from "./conversationRoutingMetadata";
import {
  extractConversationDelegatedByAgentIdFromMetadata,
  extractConversationLifecycleFromMetadata,
  extractConversationLocalIdFromMetadata,
  extractConversationOriginMessageIdFromMetadata,
  extractConversationOwnerAgentFromMetadata,
  extractConversationTitleFromMetadata,
  isPlainObject,
  parseTimestamp,
  resolveConversationVisibility,
} from "./conversationMetadata";
import {
  isAttachableConversation,
  isEmptyConversationPlaceholder,
  type ConversationState,
  type ConversationsAction,
  type ConversationsState,
} from "./conversationState";
import { isUuid } from "./conversationMessageUtils";
import { controllerConversationHasRemoteMessages } from "./conversationRemoteHistory";

const CONTROLLER_CONVERSATION_BACKFILL_INTERVAL_MS = 30_000;
// A hydration that fails outright (no session token yet, controller hiccup)
// used to sit out the whole backfill interval, so a freshly opened space kept
// showing its local placeholder for up to half a minute. Retry on our own
// schedule instead, backing off so a genuinely unreachable controller is not
// hammered.
const CONTROLLER_CONVERSATION_RETRY_BASE_MS = 1_000;
const CONTROLLER_CONVERSATION_RETRY_MAX_MS = 15_000;
const CONTROLLER_CONVERSATION_RETRY_MAX_ATTEMPTS = 6;
const runtimeControllerEnabled = controllerClient.core.enabled;

type ControllerConversationFetcher = (args: {
  projectId: string;
  limit: number;
  signal?: AbortSignal;
}) => Promise<ControllerProjectConversation[] | null>;

type ControllerConversationMetadataUpdater = (args: {
  conversationId: string;
  metadata: Record<string, unknown>;
}) => Promise<unknown>;

interface ControllerSyncArgs {
  state: ConversationsState;
  currentUserId: string | null;
  controllerProjectMissing: boolean;
  projectAccessPending: boolean;
  projectAccessBlocked: boolean;
  latestStateRef: MutableRefObject<ConversationsState>;
  dispatch: Dispatch<ConversationsAction>;
  controllerConversationSyncEpoch: number;
  bumpControllerConversationSyncEpoch: () => void;
  fetchProjectConversationsFromController: ControllerConversationFetcher;
  updateControllerConversationMetadata: ControllerConversationMetadataUpdater;
}

function conversationsRoutingPreferencesChanged(
  conversation: ConversationState,
  preferences: ConversationRoutingPreferences,
): boolean {
  return (
    conversation.assistantEnabled !== preferences.assistantEnabled ||
    conversation.extraAgentHandles.length !== preferences.extraAgentHandles.length ||
    conversation.extraAgentHandles.some(
      (handle, index) => handle !== preferences.extraAgentHandles[index],
    )
  );
}

export function useConversationControllerSync({
  state,
  currentUserId,
  controllerProjectMissing,
  projectAccessPending,
  projectAccessBlocked,
  latestStateRef,
  dispatch,
  controllerConversationSyncEpoch,
  bumpControllerConversationSyncEpoch,
  fetchProjectConversationsFromController,
  updateControllerConversationMetadata,
}: ControllerSyncArgs) {
  const hydratedScopesRef = useRef<Set<string>>(new Set());
  const completedSyncEpochsRef = useRef<Map<string, number>>(new Map());
  const hydrationFailuresRef = useRef<Map<string, number>>(new Map());
  const hydrationRetryTimerRef = useRef<number | null>(null);
  const cancelHydrationRef = useRef<(() => void) | null>(null);
  const [historyError, setHistoryError] = useState<{ scope: string; message: string } | null>(null);
  const [resolvedScopes, setResolvedScopes] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const hydrationScope = `${state.projectKey}:${currentUserId ?? "anonymous"}`;
  const retryRemoteConversationHistory = useCallback(() => {
    cancelHydrationRef.current?.();
    hydrationFailuresRef.current.delete(hydrationScope);
    completedSyncEpochsRef.current.delete(hydrationScope);
    setHistoryError((current) => current?.scope === hydrationScope ? null : current);
    bumpControllerConversationSyncEpoch();
  }, [bumpControllerConversationSyncEpoch, hydrationScope]);

  useEffect(() => {
    if (!runtimeControllerEnabled) {
      return;
    }
    if (controllerProjectMissing || projectAccessPending || projectAccessBlocked) {
      return;
    }
    if (!isUuid(state.projectKey)) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }

    const handler: EventListener = (event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail ?? null;
      const projectIdFromEvent =
        typeof detail?.projectId === "string" ? detail.projectId : null;
      if (projectIdFromEvent && projectIdFromEvent !== state.projectKey) {
        return;
      }
      bumpControllerConversationSyncEpoch();
    };

    window.addEventListener("instafy:controller-stream-reconnected", handler);
    return () => {
      window.removeEventListener("instafy:controller-stream-reconnected", handler);
    };
  }, [
    bumpControllerConversationSyncEpoch,
    controllerProjectMissing,
    projectAccessBlocked,
    projectAccessPending,
    state.projectKey,
  ]);

  useEffect(() => {
    if (!runtimeControllerEnabled) {
      return;
    }
    if (controllerProjectMissing || projectAccessPending || projectAccessBlocked) {
      return;
    }
    if (!isUuid(state.projectKey)) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }

    const interval = window.setInterval(() => {
      bumpControllerConversationSyncEpoch();
    }, CONTROLLER_CONVERSATION_BACKFILL_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [
    bumpControllerConversationSyncEpoch,
    controllerProjectMissing,
    projectAccessBlocked,
    projectAccessPending,
    state.projectKey,
  ]);

  useEffect(() => {
    if (!runtimeControllerEnabled) {
      return;
    }
    if (controllerProjectMissing || projectAccessPending || projectAccessBlocked) {
      return;
    }
    if (!isUuid(state.projectKey)) {
      return;
    }

    let cancelled = false;
    const abortController = new AbortController();
    let retryDelayTimer: ReturnType<typeof setTimeout> | undefined;
    let finishRetryDelay: (() => void) | undefined;
    const projectId = state.projectKey;
    if (
      completedSyncEpochsRef.current.get(hydrationScope) ===
      controllerConversationSyncEpoch
    ) {
      return;
    }

    const cancelHydration = () => {
      cancelled = true;
      abortController.abort();
      if (retryDelayTimer !== undefined) clearTimeout(retryDelayTimer);
      finishRetryDelay?.();
      if (hydrationRetryTimerRef.current !== null) {
        window.clearTimeout(hydrationRetryTimerRef.current);
        hydrationRetryTimerRef.current = null;
      }
    };
    cancelHydrationRef.current = cancelHydration;

    void (async () => {
      let remoteConversations: Awaited<ReturnType<ControllerConversationFetcher>> = null;
      for (let attempt = 0; attempt < 4 && !cancelled; attempt += 1) {
        try {
          remoteConversations = await fetchProjectConversationsFromController({
            projectId,
            limit: 50,
            signal: abortController.signal,
          });
        } catch {
          if (cancelled) return;
          remoteConversations = null;
        }
        if (cancelled) return;
        if (remoteConversations !== null) {
          break;
        }
        // The first unavailable attempt is already actionable. Subsequent
        // automatic retries must not keep a cold list looking perpetually busy.
        setHistoryError((current) => current?.scope === hydrationScope ? current : {
          scope: hydrationScope,
          message: hydratedScopesRef.current.has(hydrationScope)
            ? "Couldn't refresh conversations. Your saved chats are still shown."
            : "Couldn't load conversations.",
        });
        await new Promise<void>((resolve) => {
          finishRetryDelay = resolve;
          retryDelayTimer = setTimeout(() => {
            retryDelayTimer = undefined;
            finishRetryDelay = undefined;
            resolve();
          }, Math.min(500 * (attempt + 1), 2_000));
        });
      }
      if (cancelled) {
        return;
      }
      if (remoteConversations === null) {
        const failures = (hydrationFailuresRef.current.get(hydrationScope) ?? 0) + 1;
        hydrationFailuresRef.current.set(hydrationScope, failures);
        if (failures > CONTROLLER_CONVERSATION_RETRY_MAX_ATTEMPTS) {
          // Give up on the fast lane; the periodic backfill keeps trying.
          return;
        }
        const delay = Math.min(
          CONTROLLER_CONVERSATION_RETRY_BASE_MS * 2 ** (failures - 1),
          CONTROLLER_CONVERSATION_RETRY_MAX_MS,
        );
        if (hydrationRetryTimerRef.current !== null) {
          window.clearTimeout(hydrationRetryTimerRef.current);
        }
        hydrationRetryTimerRef.current = window.setTimeout(() => {
          hydrationRetryTimerRef.current = null;
          bumpControllerConversationSyncEpoch();
        }, delay);
        return;
      }
      hydrationFailuresRef.current.delete(hydrationScope);
      setHistoryError((current) => current?.scope === hydrationScope ? null : current);

      const latestState = latestStateRef.current;
      if (latestState.projectKey !== projectId) {
        return;
      }

      const isInitialSuccessfulHydration = !hydratedScopesRef.current.has(hydrationScope);
      hydratedScopesRef.current.add(hydrationScope);
      if (remoteConversations.length === 0) {
        completedSyncEpochsRef.current.set(
          hydrationScope,
          controllerConversationSyncEpoch,
        );
        setResolvedScopes((current) => {
          if (current.has(hydrationScope)) {
            return current;
          }
          return new Set([...current, hydrationScope]);
        });
        return;
      }

      const controllerToLocal = new Map<string, string>();
      const conversationByLocalId = new Map<string, ConversationState>();
      const localIds = new Set<string>();
      latestState.conversations.forEach((conversation) => {
        conversationByLocalId.set(conversation.localId, conversation);
        localIds.add(conversation.localId);
        if (conversation.controllerId) {
          controllerToLocal.set(conversation.controllerId, conversation.localId);
        }
      });

      const attachableByLocalId = new Map<string, ConversationState>();
      latestState.conversations.forEach((conversation) => {
        if (!isAttachableConversation(conversation)) {
          return;
        }
        attachableByLocalId.set(conversation.localId, conversation);
      });
      const activeLocalConversation =
        latestState.conversations.find(
          (conversation) => conversation.localId === latestState.activeId,
        ) ?? null;

      let fallbackSequence = latestState.sequence;
      remoteConversations.forEach((remote) => {
        const controllerId = typeof remote?.id === "string" ? remote.id : "";
        if (!isUuid(controllerId)) {
          return;
        }

        const metadata = isPlainObject(remote.metadata) ? remote.metadata : {};
        const hasRemoteMessages = controllerConversationHasRemoteMessages(remote);
        const titleFromMetadata = extractConversationTitleFromMetadata(metadata);
        const localIdFromMetadata = extractConversationLocalIdFromMetadata(metadata);
        const parentConversationIdFromRemote =
          typeof remote.parentConversationId === "string" && isUuid(remote.parentConversationId)
            ? remote.parentConversationId
            : null;
        // A root conversation can carry a kind too: a scheduled thread is a
        // root with thread kind "automation" — it must keep that origin.
        const threadKindFromRemote =
          typeof remote.threadKind === "string" ? remote.threadKind.trim().toLowerCase() || null : null;
        const visibility = resolveConversationVisibility(remote.visibility, metadata);
        const lifecycleStatus = extractConversationLifecycleFromMetadata(
          metadata,
          currentUserId,
        );
        const ownerAgentFromMetadata = extractConversationOwnerAgentFromMetadata(metadata);
        const activeGoalFromMetadata = extractConversationGoalFromMetadata(metadata);
        const originMessageIdFromMetadata =
          extractConversationOriginMessageIdFromMetadata(metadata);
        const delegatedByAgentIdFromMetadata =
          extractConversationDelegatedByAgentIdFromMetadata(metadata);
        const routingPreferencesFromMetadata = extractConversationRoutingPreferences(
          metadata,
          currentUserId,
        );
        const routingPreferences =
          routingPreferencesFromMetadata ?? DEFAULT_CONVERSATION_ROUTING_PREFERENCES;
        const createdByIsSelf = currentUserId !== null && remote.createdBy === currentUserId;

        const syncExistingConversationFromRemote = (
          conversation: ConversationState,
        ) => {
          if (conversation.hasRemoteMessages !== hasRemoteMessages) {
            dispatch({
              type: "SET_REMOTE_HISTORY",
              id: conversation.localId,
              hasMessages: hasRemoteMessages,
            });
          }
          if (titleFromMetadata && conversation.title !== titleFromMetadata) {
            dispatch({
              type: "SET_TITLE",
              id: conversation.localId,
              title: titleFromMetadata,
            });
          }
          if (conversation.visibility !== visibility) {
            dispatch({
              type: "SET_VISIBILITY",
              id: conversation.localId,
              visibility,
            });
          }
          if (conversation.lifecycleStatus !== lifecycleStatus) {
            dispatch({
              type: "SET_LIFECYCLE",
              id: conversation.localId,
              status: lifecycleStatus,
            });
          }
          if (
            routingPreferencesFromMetadata &&
            conversationsRoutingPreferencesChanged(conversation, routingPreferencesFromMetadata)
          ) {
            dispatch({
              type: "SET_ROUTING_PREFERENCES",
              id: conversation.localId,
              assistantEnabled: routingPreferencesFromMetadata.assistantEnabled,
              extraAgentHandles: routingPreferencesFromMetadata.extraAgentHandles,
            });
          }
          if (
            shouldApplyConversationGoalSnapshot(
              conversation.activeGoal,
              activeGoalFromMetadata,
            )
          ) {
            dispatch({
              type: "SET_GOAL",
              id: conversation.localId,
              goal: activeGoalFromMetadata,
            });
          }
          const resolvedParentConversationId =
            parentConversationIdFromRemote ?? conversation.parentConversationId ?? null;
          const resolvedThreadKind =
            threadKindFromRemote ?? conversation.threadKind ?? null;
          if (
            conversation.parentConversationId !== resolvedParentConversationId ||
            conversation.threadKind !== resolvedThreadKind ||
            conversation.ownerAgent?.id !== ownerAgentFromMetadata?.id ||
            conversation.ownerAgent?.handle !== ownerAgentFromMetadata?.handle ||
            conversation.originMessageId !== originMessageIdFromMetadata ||
            conversation.delegatedByAgentId !== delegatedByAgentIdFromMetadata
          ) {
            dispatch({
              type: "SET_THREAD_META",
              id: conversation.localId,
              parentConversationId: resolvedParentConversationId,
              threadKind: resolvedThreadKind,
              ownerAgent: ownerAgentFromMetadata,
              originMessageId: originMessageIdFromMetadata,
              delegatedByAgentId: delegatedByAgentIdFromMetadata,
            });
          }
        };

        const existingLocalId = controllerToLocal.get(controllerId);
        if (existingLocalId) {
          const existingConversation = conversationByLocalId.get(existingLocalId);
          if (existingConversation) {
            syncExistingConversationFromRemote(existingConversation);
          }
          return;
        }

        const desiredLocalId = localIdFromMetadata ?? controllerId;
        const findAttachableMatch = (): ConversationState | null => {
          const candidate = attachableByLocalId.get(desiredLocalId) ?? null;
          if (candidate) {
            return candidate;
          }
          if (localIdFromMetadata) {
            return null;
          }
          if (
            activeLocalConversation &&
            attachableByLocalId.has(activeLocalConversation.localId)
          ) {
            if (!titleFromMetadata || activeLocalConversation.title === titleFromMetadata) {
              return activeLocalConversation;
            }
          }
          if (titleFromMetadata) {
            for (const conversation of attachableByLocalId.values()) {
              if (conversation.title === titleFromMetadata) {
                return conversation;
              }
            }
          }
          if (attachableByLocalId.size === 1) {
            return attachableByLocalId.values().next().value ?? null;
          }
          return null;
        };

        const existingAttachable = createdByIsSelf ? findAttachableMatch() : null;
        if (existingAttachable && !existingAttachable.controllerId) {
          // Dispatch updates React after this batch. Consume the snapshot's
          // placeholder now so another remote row cannot bind to it as well.
          attachableByLocalId.delete(existingAttachable.localId);
          dispatch({ type: "SET_CONTROLLER", id: existingAttachable.localId, controllerId });
          syncExistingConversationFromRemote(existingAttachable);

          if (!localIdFromMetadata) {
            void updateControllerConversationMetadata({
              conversationId: controllerId,
              metadata: {
                ...metadata,
                title: titleFromMetadata ?? existingAttachable.title,
                localId: existingAttachable.localId,
              },
            });
          }
          controllerToLocal.set(controllerId, existingAttachable.localId);
          return;
        }

        let localId = desiredLocalId;
        if (localIds.has(localId)) {
          localId = controllerId;
        }
        localIds.add(localId);

        const fallbackTitle = titleFromMetadata ?? `Conversation ${fallbackSequence}`;
        if (!titleFromMetadata) {
          fallbackSequence += 1;
        }
        const conversation: ConversationState = {
          localId,
          title: fallbackTitle,
          visibility,
          lifecycleStatus,
          controllerId,
          hasRemoteMessages,
          parentConversationId: parentConversationIdFromRemote,
          threadKind: threadKindFromRemote,
          ownerAgent: ownerAgentFromMetadata,
          activeGoal: activeGoalFromMetadata,
          originMessageId: originMessageIdFromMetadata,
          delegatedByAgentId: delegatedByAgentIdFromMetadata,
          messages: [],
          draft: "",
          draftEditorState: null,
          assistantEnabled: routingPreferences.assistantEnabled,
          extraAgentHandles: [...routingPreferences.extraAgentHandles],
          unreadCount: 0,
          createdAt: parseTimestamp(remote.createdAt ?? null),
          pendingRunIds: [],
          awaitingLeaseRunIds: [],
          pendingRunSubmittedAt: {},
          runtimePreference: null,
        };
        dispatch({ type: "CREATE", conversation, select: false });
        controllerToLocal.set(controllerId, conversation.localId);
      });

      const shouldAutoSelectControllerConversation = (() => {
        if (!isInitialSuccessfulHydration) {
          return false;
        }
        if (!activeLocalConversation || !isEmptyConversationPlaceholder(activeLocalConversation)) {
          return false;
        }
        if (latestState.conversations.length !== 1) {
          return false;
        }
        if (typeof window === "undefined") {
          return true;
        }
        try {
          const params = new URLSearchParams(window.location.search);
          const controllerParam = params.get("conversationControllerId");
          return !isUuid(controllerParam ?? "");
        } catch {
          return true;
        }
      })();

      if (shouldAutoSelectControllerConversation) {
        const latestRemote = [...remoteConversations]
          .filter((remote) => isUuid(typeof remote?.id === "string" ? remote.id : ""))
          .map((remote) => ({
            controllerId: remote.id as string,
            createdAt: parseTimestamp(remote.createdAt ?? null),
          }))
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        const candidateLocalId = latestRemote
          ? controllerToLocal.get(latestRemote.controllerId) ?? null
          : null;
        if (
          activeLocalConversation &&
          candidateLocalId &&
          candidateLocalId !== activeLocalConversation.localId
        ) {
          dispatch({ type: "SELECT", id: candidateLocalId });
          if (attachableByLocalId.has(activeLocalConversation.localId)) {
            dispatch({ type: "CLOSE", id: activeLocalConversation.localId });
          }
        }
      }

      completedSyncEpochsRef.current.set(
        hydrationScope,
        controllerConversationSyncEpoch,
      );
      setResolvedScopes((current) => {
        if (current.has(hydrationScope)) {
          return current;
        }
        return new Set([...current, hydrationScope]);
      });
    })();

    return () => {
      cancelHydration();
      if (cancelHydrationRef.current === cancelHydration) cancelHydrationRef.current = null;
    };
  }, [
    bumpControllerConversationSyncEpoch,
    controllerConversationSyncEpoch,
    controllerProjectMissing,
    currentUserId,
    dispatch,
    fetchProjectConversationsFromController,
    hydrationScope,
    latestStateRef,
    projectAccessBlocked,
    projectAccessPending,
    state.projectKey,
    updateControllerConversationMetadata,
  ]);

  return {
    remoteConversationHistoryResolved:
      !runtimeControllerEnabled ||
      !isUuid(state.projectKey) ||
      controllerProjectMissing ||
      projectAccessBlocked ||
      resolvedScopes.has(hydrationScope),
    remoteConversationHistoryError:
      !controllerProjectMissing && !projectAccessPending && !projectAccessBlocked &&
      historyError?.scope === hydrationScope ? historyError.message : null,
    retryRemoteConversationHistory,
  };
}
