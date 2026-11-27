import { useCallback, useRef } from "react";
import {
  CONTROLLER_RUNTIME_IDLE_TTL_SECONDS_DEFAULT,
  controllerClient,
} from "../sdk/instafy";
import { runtimeEntryIsReady } from "../runtime/utils/runtimeEntry";
import { getDefaultRuntimeMetadata } from "../runtime/utils/webdevRuntime";
import { ControllerApiError } from "../services/runtimeController/core";
import { generateUUID, isUUID } from "../utils/uuid";
import { mapControllerMessageToChat } from "./conversationMessageUtils";
import { createConversationTaskQueue } from "./conversationTaskQueue";
import { createConversationRoutingMetadataPatch } from "./conversationRoutingMetadata";
import { createConversationThreadMetadataPatch } from "./conversationMetadata";
import { createConversationGoalMetadataPatch } from "./conversationGoals";
import { createConversationMessage } from "./conversationSubmitHelpers";
import { withDefaultInteractiveWorkspaceExpectations } from "./conversationRuntimeExpectations";
import {
  isSkillModeAmbientDispatchMetadata,
  markPendingAgentEvaluationRun,
  readGroupParticipationPreflightStatus,
} from "./groupParticipation";
import type { ConversationState } from "./conversationState";
import type {
  SubmitConversationRuntimeOverride,
  UseConversationSubmitFlowArgs,
} from "./conversationSubmitTypes";
import { describeTurnEngineSendRefusal } from "./runFailurePresentation";
import type { TurnEngineSendRefusal } from "./turnEngineSendRefusal";

const runtimeControllerEnabled = controllerClient.core.enabled;

export interface ConversationDispatchResult {
  ok: boolean;
  errorMessage?: string;
  turnEngineRefusal?: TurnEngineSendRefusal;
}

/**
 * The controller's refusal of a send because a turn it would start runs on a
 * turn engine that cannot take it (docs/Local-Engine-Turns.md 11.6), as that
 * engine words it, or null for any other error.
 */
export function readTurnEngineSendRefusal(error: unknown): TurnEngineSendRefusal | null {
  if (!(error instanceof ControllerApiError) || !error.code) {
    return null;
  }
  const refusal = describeTurnEngineSendRefusal({ code: error.code, details: error.details });
  return refusal ? { ...refusal, code: error.code } : null;
}
const {
  createBlank: createBlankControllerConversation,
  recordMessage: recordControllerConversationMessage,
  sendMessage: sendControllerConversationMessage,
} = controllerClient.conversations;
const { ensure: ensureRuntime, fetchStatus: fetchRuntimeStatus } = controllerClient.runtimes;

type RuntimeDispatchOverride = SubmitConversationRuntimeOverride | null;

function resolveControllerConversationIdFromRoute(
  projectId: string,
  conversationId: string,
  allowControllerOnlyActiveRoute = false,
): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const routeProjectId = params.get("projectId")?.trim() ?? "";
    const routeLocalId = params.get("conversationId")?.trim() ?? "";
    const routeControllerId = params.get("conversationControllerId")?.trim() ?? "";
    const targetsRouteConversation =
      conversationId === routeControllerId ||
      (routeLocalId.length > 0 && conversationId === routeLocalId) ||
      (routeLocalId.length === 0 && allowControllerOnlyActiveRoute);
    if (
      routeProjectId !== projectId ||
      !isUUID(routeControllerId) ||
      !targetsRouteConversation
    ) {
      return null;
    }
    return routeControllerId;
  } catch {
    return null;
  }
}

type UseConversationControllerDispatchArgs = Pick<
  UseConversationSubmitFlowArgs,
  | "conversations"
  | "activeConversation"
  | "activeProjectId"
  | "currentUserId"
  | "preferredRuntimeId"
  | "runtimeStatuses"
  | "effectiveRuntimeId"
  | "effectiveRuntimeSource"
  | "showStatus"
  | "createConversation"
  | "selectConversation"
  | "markConversationRead"
  | "setConversationDraft"
  | "setConversationControllerId"
  | "appendMessages"
  | "linkRunToConversation"
  | "beginConversationDispatch"
  | "endConversationDispatch"
>;

/**
 * Whether a send shows the typing row while it is on its way to the
 * controller: only one that starts the agent. A silent skill-mode evaluation
 * never shows one, a group chat's message whose answer the controller decides
 * may get none (Octo can stay silent), and a terminal command is no AI turn.
 */
export function sendShowsTypingWhileDispatching(
  metadata: Record<string, unknown> | null,
  intent?: string,
): boolean {
  if (intent === "terminal_command" || isSkillModeAmbientDispatchMetadata(metadata)) {
    return false;
  }
  const participation = readGroupParticipationPreflightStatus(metadata);
  return participation !== "controller_deferred" && participation !== "controller_coverage";
}

export function useConversationControllerDispatch({
  conversations,
  activeConversation,
  activeProjectId,
  currentUserId,
  preferredRuntimeId,
  runtimeStatuses,
  effectiveRuntimeId,
  effectiveRuntimeSource,
  showStatus,
  createConversation,
  selectConversation,
  markConversationRead,
  setConversationDraft,
  setConversationControllerId,
  appendMessages,
  linkRunToConversation,
  beginConversationDispatch,
  endConversationDispatch,
}: UseConversationControllerDispatchArgs) {
  const inFlightControllerConversationIdRef = useRef<Map<string, Promise<string | null>>>(
    new Map(),
  );
  const recordMessageQueueRef = useRef(createConversationTaskQueue());
  // Run ids dispatched as skill-mode ambient agent evaluations. Marked before
  // LINK_RUN so the submitter's awaiting-lease window never flashes a typing
  // indicator for a silent-until-speaking run.
  const pendingAgentEvaluationRunIdsRef = useRef<Set<string>>(new Set());

  const resolveProjectId = useCallback((): string | null => {
    if (activeProjectId && isUUID(activeProjectId)) {
      return activeProjectId;
    }
    if (typeof window !== "undefined") {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_ACTIVE_PROJECT_ID__?: string | null;
      };
      const fromWindow = runtimeWindow.__INSTAFY_ACTIVE_PROJECT_ID__;
      if (fromWindow && isUUID(fromWindow)) {
        return fromWindow;
      }
      try {
        const params = new URLSearchParams(window.location.search);
        const fromUrl = params.get("projectId");
        if (fromUrl && isUUID(fromUrl.trim())) {
          return fromUrl.trim();
        }
      } catch {
        // ignore malformed URL
      }
    }
    return null;
  }, [activeProjectId]);

  const resolveRuntimeTarget = useCallback(
    (conversation: ConversationState) => {
      const statuses = runtimeStatuses ?? [];
      if (effectiveRuntimeSource === "session" && effectiveRuntimeId) {
        const status = statuses.find((entry) => entry.runtimeId === effectiveRuntimeId) ?? null;
        if (status && runtimeEntryIsReady(status)) {
          const displayName = status.displayName ?? status.runtimeId ?? null;
          return {
            runtimeId: effectiveRuntimeId,
            preferRuntime: false,
            runtimeDisplayName: displayName,
          };
        }
      }
      if (preferredRuntimeId) {
        const status = statuses.find((entry) => entry.runtimeId === preferredRuntimeId) ?? null;
        const displayName = status?.displayName ?? status?.runtimeId ?? null;
        return {
          runtimeId: preferredRuntimeId,
          preferRuntime: true,
          runtimeDisplayName: displayName,
        };
      }
      const preference = conversation.runtimePreference;
      if (preference?.runtimeId) {
        const status = statuses.find((entry) => entry.runtimeId === preference.runtimeId) ?? null;
        if (status && runtimeEntryIsReady(status)) {
          const displayName =
            status.displayName ?? preference.displayName ?? status.runtimeId ?? null;
          return {
            runtimeId: preference.runtimeId,
            preferRuntime: true,
            runtimeDisplayName: displayName,
          };
        }
      }
      const autoCloudRuntime =
        statuses.find((entry) => runtimeEntryIsReady(entry) && entry.isLocal === false) ?? null;
      const autoRuntime =
        autoCloudRuntime ?? statuses.find((entry) => runtimeEntryIsReady(entry)) ?? null;
      if (autoRuntime?.runtimeId) {
        return {
          runtimeId: autoRuntime.runtimeId,
          preferRuntime: false,
          runtimeDisplayName: autoRuntime.displayName ?? autoRuntime.runtimeId ?? null,
        };
      }
      return {
        runtimeId: null,
        preferRuntime: null,
        runtimeDisplayName: null,
      };
    },
    [effectiveRuntimeId, effectiveRuntimeSource, preferredRuntimeId, runtimeStatuses],
  );

  const ensureConversation = useCallback((): ConversationState => {
    if (activeConversation) {
      return activeConversation;
    }
    return createConversation({ select: true });
  }, [activeConversation, createConversation]);

  const handleCreateConversation = useCallback(() => {
    const conversation = createConversation({
      messages: [createConversationMessage("assistant", "How can I help with your project?")],
      select: true,
    });
    selectConversation(conversation.localId);
    markConversationRead(conversation.localId);
  }, [createConversation, markConversationRead, selectConversation]);

  const handleInputChange = useCallback(
    (conversationId: string | null, value: string, editorState: string | null = null) => {
      const targetId = conversationId ?? ensureConversation().localId;
      setConversationDraft(targetId, value, editorState);
    },
    [ensureConversation, setConversationDraft],
  );

  const ensureControllerConversationId = useCallback(
    async (projectId: string, conversation: ConversationState): Promise<string | null> => {
      let controllerId = conversation.controllerId ?? null;
      if (!controllerId) {
        const inFlight =
          inFlightControllerConversationIdRef.current.get(conversation.localId) ?? null;
        if (inFlight) {
          controllerId = await inFlight.catch(() => null);
          if (controllerId) {
            setConversationControllerId(conversation.localId, controllerId);
          }
        }
      }

      if (controllerId) {
        return controllerId;
      }

      const conversationMetadata: Record<string, unknown> = {
        title: conversation.title,
        localId: conversation.localId,
        visibility: conversation.visibility,
        ...createConversationRoutingMetadataPatch(currentUserId, {
          assistantEnabled: conversation.assistantEnabled,
          extraAgentHandles: conversation.extraAgentHandles,
        }),
        ...createConversationThreadMetadataPatch({
          ownerAgentId: conversation.ownerAgent?.id ?? null,
          ownerAgentHandle: conversation.ownerAgent?.handle ?? null,
          originMessageId: conversation.originMessageId,
          delegatedByAgentId: conversation.delegatedByAgentId,
        }),
        ...createConversationGoalMetadataPatch(conversation.activeGoal),
      };

      const createPromise = createBlankControllerConversation({
        projectId,
        metadata: conversationMetadata,
        parentConversationId: conversation.parentConversationId ?? undefined,
        threadKind: conversation.threadKind ?? undefined,
      });
      const controllerIdPromise = createPromise
        .then((payload) => payload?.conversationId ?? null)
        .catch(() => null);
      inFlightControllerConversationIdRef.current.set(
        conversation.localId,
        controllerIdPromise,
      );

      let createResponse: Awaited<typeof createPromise> = null;
      try {
        createResponse = await createPromise;
      } finally {
        inFlightControllerConversationIdRef.current.delete(conversation.localId);
      }

      controllerId = createResponse?.conversationId ?? null;
      if (controllerId) {
        setConversationControllerId(conversation.localId, controllerId);
      }
      return controllerId;
    },
    [currentUserId, setConversationControllerId],
  );

  const sendPromptToController = useCallback(
    async (
      conversationId: string,
      prompt: string,
      metadata: Record<string, unknown> | null,
      runtimeOverride?: RuntimeDispatchOverride,
      conversationOverride?: ConversationState | null,
      intent?: string,
      expectedLaneIdle = false,
      requirements?: {
        requireRun?: boolean;
        assertCurrent?: () => void;
        /** The caller says what became of a refused send: no error row. */
        callerReportsErrors?: boolean;
      },
    ) => {
      const projectId = resolveProjectId();
      if (!projectId) {
        showStatus("Select or create a project before chatting.", "error", 4000);
        return {
          ok: false,
          errorMessage: "Select or create a project before chatting.",
        };
      }
      const conversation =
        conversationOverride ?? conversations.find((entry) => entry.localId === conversationId) ?? null;
      if (!conversation) {
        return {
          ok: false,
          errorMessage: "Conversation unavailable. Try again shortly.",
        };
      }
      const resolvedRuntime = resolveRuntimeTarget(conversation);
      const runtimeId =
        runtimeOverride && "runtimeId" in runtimeOverride
          ? runtimeOverride.runtimeId
          : resolvedRuntime.runtimeId;
      const preferRuntime =
        runtimeOverride && "preferRuntime" in runtimeOverride
          ? runtimeOverride.preferRuntime
          : resolvedRuntime.preferRuntime;
      const runtimeDisplayName =
        runtimeOverride && "runtimeDisplayName" in runtimeOverride
          ? runtimeOverride.runtimeDisplayName
          : resolvedRuntime.runtimeDisplayName;
      const runtimeIdleTtlSeconds = CONTROLLER_RUNTIME_IDLE_TTL_SECONDS_DEFAULT;

      // The typing row shows from the press of Send: checking the machine,
      // starting a stopped one and the send itself can take seconds before
      // the controller answers with the turn's run, which carries the row
      // from there (LINK_RUN lands before this mark ends).
      const dispatchToken = sendShowsTypingWhileDispatching(metadata, intent) ? generateUUID() : null;
      if (dispatchToken) {
        beginConversationDispatch?.(conversation.localId, dispatchToken);
      }
      try {
        if (runtimeControllerEnabled && runtimeId && preferRuntime) {
          let preferredEntry =
            runtimeStatuses.find((entry) => entry.runtimeId === runtimeId) ?? null;
          if (!preferredEntry) {
            const snapshot = await fetchRuntimeStatus({
              projectId,
              quietOnAbort: true,
            }).catch(() => null);
            preferredEntry =
              snapshot?.runtimes.find((entry) => entry.runtimeId === runtimeId) ?? null;
          }

          const provider = (preferredEntry?.provider ?? "").trim().toLowerCase();
          const isCloudProvider = provider === "instafy-cloud" || provider === "instafy_cloud";
          const canEnsure = isCloudProvider || preferredEntry?.isLocal === false;

          if (canEnsure && !runtimeEntryIsReady(preferredEntry)) {
            await ensureRuntime({
              projectId,
              runtimeId,
              provider: preferredEntry?.provider ?? "instafy-cloud",
              displayName: runtimeDisplayName ?? preferredEntry?.displayName ?? undefined,
              idleTtlSeconds: runtimeIdleTtlSeconds,
              metadata: getDefaultRuntimeMetadata("chat:recover-preferred"),
            }).catch(() => null);
          }
        }
        const resolveIds = (many: unknown, one: unknown) => {
          const ids = Array.isArray(many)
            ? many.filter(
                (entry): entry is string => typeof entry === "string" && entry.length > 0,
              )
            : [];
          if (ids.length > 0) {
            return ids;
          }
          return typeof one === "string" && one.length > 0 ? [one] : [];
        };
        const resolveRunIds = (response: {
          runId?: string | null;
          runIds?: string[] | null;
        }) => resolveIds(response.runIds, response.runId);

        const controllerId = await ensureControllerConversationId(projectId, conversation);
        if (!controllerId) {
          throw new Error("Controller unavailable. Try again shortly.");
        }

        const dispatchMetadata =
          intent === "terminal_command"
            ? metadata
            : withDefaultInteractiveWorkspaceExpectations(metadata);

        requirements?.assertCurrent?.();
        const response = await sendControllerConversationMessage({
          conversationId: controllerId,
          projectId,
          promptText: prompt,
          intent,
          metadata: dispatchMetadata,
          idleTtlSeconds: runtimeIdleTtlSeconds,
          runtimeId,
          runtimeDisplayName,
          preferRuntime,
          expectedLaneIdle,
        });
        if (!response) {
          throw new Error("Controller unavailable. Try again shortly.");
        }
        // A prompt the controller put in the conversation's send queue, behind
        // a run that took the lane first, is sent: it runs next.
        if (requirements?.requireRun && resolveRunIds(response).length === 0 && response.status !== "queued") {
          throw new Error("The controller did not start a browser turn. Your manual input remains on the page; try again when ready.");
        }
        const isAgentEvaluationDispatch = isSkillModeAmbientDispatchMetadata(metadata);
        resolveRunIds(response).forEach((runId) => {
          if (isAgentEvaluationDispatch) {
            markPendingAgentEvaluationRun(
              pendingAgentEvaluationRunIdsRef.current,
              runId,
            );
          }
          linkRunToConversation(runId, conversation.localId);
        });
        // The runs this prompt started (none when the controller only
        // recorded it or put it in its send queue). Failed-run retries use
        // them to tell which prompt a failure belongs to.
        return {
          ok: true,
          runIds: resolveRunIds(response),
          jobIds: resolveIds(response.jobIds, response.jobId),
        };
      } catch (error) {
        // A turn engine's refusal shows its engine's sentence, never the
        // controller's raw text, which can name the plumbing
        // (docs/Local-Engine-Turns.md 5.5, 11.6).
        const turnEngineRefusal = readTurnEngineSendRefusal(error);
        const message = turnEngineRefusal
          ? turnEngineRefusal.sentence
          : error instanceof Error
            ? error.message
            : String(error);
        const conversationState =
          conversations.find((entry) => entry.localId === conversationId) ?? null;
        const latestMessage =
          conversationState && conversationState.messages.length > 0
            ? conversationState.messages[conversationState.messages.length - 1]
            : null;
        const duplicateRecentError =
          latestMessage?.role === "assistant" &&
          latestMessage.messageType === "error" &&
          latestMessage.content === message &&
          Date.now() - latestMessage.timestamp < 15_000;

        if (!duplicateRecentError && !requirements?.callerReportsErrors) {
          appendMessages(conversationId, [
            {
              ...createConversationMessage("assistant", message, null, {
                messageType: "error",
              }),
              messageType: "error",
            },
          ]);
        }
        return turnEngineRefusal
          ? { ok: false, errorMessage: message, turnEngineRefusal }
          : { ok: false, errorMessage: message };
      } finally {
        if (dispatchToken) {
          endConversationDispatch?.(conversation.localId, dispatchToken);
        }
      }
    },
    [
      appendMessages,
      beginConversationDispatch,
      conversations,
      endConversationDispatch,
      ensureControllerConversationId,
      linkRunToConversation,
      resolveProjectId,
      resolveRuntimeTarget,
      runtimeStatuses,
      showStatus,
    ],
  );

  const recordMessageToController = useCallback(
    async (
      conversationId: string,
      content: string,
      metadata: Record<string, unknown> | null = null,
      role: "assistant" | "user" = "user",
      conversationOverride?: ConversationState | null,
    ) => {
      const projectId = resolveProjectId();
      if (!projectId) {
        showStatus("Select or create a project before chatting.", "error", 4000);
        return null;
      }
      try {
        const normalizedConversationId = conversationId.trim();
        const overrideMatches =
          conversationOverride &&
          (conversationOverride.localId === normalizedConversationId ||
            conversationOverride.controllerId === normalizedConversationId);
        const activeMatches =
          activeConversation &&
          (activeConversation.localId === normalizedConversationId ||
            activeConversation.controllerId === normalizedConversationId);
        const conversation =
          (overrideMatches ? conversationOverride : null) ??
          conversations.find(
            (entry) =>
              entry.localId === normalizedConversationId ||
              entry.controllerId === normalizedConversationId,
          ) ??
          (activeMatches ? activeConversation : null);
        const isActiveLocalConversation = Boolean(
          conversation &&
            activeConversation &&
            conversation.localId === activeConversation.localId,
        );
        const routeControllerId = resolveControllerConversationIdFromRoute(
          projectId,
          normalizedConversationId,
          isActiveLocalConversation && !conversation?.controllerId,
        );
        const canUseRouteControllerId = Boolean(
          routeControllerId &&
            (!conversation?.controllerId || conversation.controllerId === routeControllerId),
        );
        const shouldAttachValidatedRoute = Boolean(
          canUseRouteControllerId &&
            routeControllerId &&
            conversation &&
            !conversation.controllerId,
        );
        const controllerId = canUseRouteControllerId
          ? routeControllerId
          : conversation
            ? await ensureControllerConversationId(projectId, conversation)
            : null;
        if (!controllerId) {
          throw new Error("Conversation is still syncing. Try again shortly.");
        }
        return await recordMessageQueueRef.current.enqueue(controllerId, async () => {
          const result = await recordControllerConversationMessage({
            conversationId: controllerId,
            projectId,
            content,
            metadata,
            role,
          });
          if (!result) {
            throw new Error("Unable to send message. Try again shortly.");
          }
          if (shouldAttachValidatedRoute && conversation) {
            setConversationControllerId(conversation.localId, controllerId);
          }
          const mapped = mapControllerMessageToChat(result);
          if (role === "assistant" && mapped.role !== "assistant") {
            return { ...mapped, role };
          }
          return mapped;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(`Message error: ${message}`, "error", 4000);
        return null;
      }
    },
    [
      activeConversation,
      conversations,
      ensureControllerConversationId,
      resolveProjectId,
      setConversationControllerId,
      showStatus,
    ],
  );

  return {
    resolveProjectId,
    ensureConversation,
    handleCreateConversation,
    handleInputChange,
    ensureControllerConversationId,
    sendPromptToController,
    recordMessageToController,
    pendingAgentEvaluationRunIdsRef,
  };
}
