import { useCallback, useMemo, useRef } from "react";
import {
  controllerClient,
} from "../sdk/instafy";
import { runtimeEntryIsDispatchable, runtimeEntryIsReady } from "../runtime/utils/runtimeEntry";
import { generateUUID } from "../utils/uuid";
import { LOCAL_CAPABILITY_DEFINITIONS } from "../capabilities/localCapabilityCatalog";
import { resolveSingleLocalCapabilityHandleForPrompt } from "../capabilities/localCapabilityRuntime";
import { getChatClientSessionId } from "./chatClientIdentity";
import { shouldAutoTitleConversation } from "./conversationAutoTitle";
import {
  resolvePromptAgentSelection,
  startsWithAssistantMention,
} from "./assistantMentions";
import {
  buildPromptAdvisoryScopeClaims,
  decideTopLevelAgentCollaborationModes,
  GLOBAL_AGENT_COLLABORATION_SKILL_PATH,
} from "./agentCollaborationPolicy";
import { runLocalCapabilityConversationFlow } from "./localCapabilityConversationFlow";
import { parseTerminalCommandRequest } from "./terminalCommand";
import { getGitAutoSyncAfterApplyPreference } from "./gitAutoSyncPreference";
import { createConversationTaskQueue } from "./conversationTaskQueue";
import {
  buildGroupParticipationMetadata,
  buildUnavailableGroupParticipationMetadata,
  readGroupParticipationDecision,
  readGroupParticipationPreflightStatus,
  resolveGroupParticipationReplyTargets,
  shouldResolveAmbientGroupParticipation,
  withGroupParticipationPreflightMetadata,
  type ConversationGroupParticipationPreflightInput,
  type ConversationGroupParticipationPreflightResult,
} from "./groupParticipation";
import {
  buildLocalCapabilityAssistantPromptContextMetadata,
  type BuiltInAssistantHandle,
  type BuiltInAssistantPromptContextMetadata,
  getDefaultAssistantHandle,
  resolveBuiltInAssistantHandle,
  resolveLocalCapabilityAssistantHandle,
} from "../assistants/localBuiltInAssistantCatalog";
import {
  getWebdevRuntimeEnv,
  WEBDEV_RUNTIME_DISPLAY_NAME,
  WEBDEV_RUNTIME_FLAVOR,
} from "../runtime/utils/webdevRuntime";
import {
  buildConversationClientMetadata,
  createConversationMessage,
  isLearnPrompt,
  patchConversationMessageMetadata,
  resolveSubmittedImageFiles,
  sleep,
  uploadConversationImageAttachments,
} from "./conversationSubmitHelpers";
import { withRuntimeExpectations } from "./conversationRuntimeExpectations";
import {
  activeGoalPromptMetadata,
  applyGoalCommand,
  createConversationGoalMetadataPatch,
  parseGoalCommand,
  resolveGoalCommandDispatch,
  updateConversationGoal,
} from "./conversationGoals";
import type {
  SubmitConversationOptions,
  SubmitConversationRuntimeOverride,
  SubmitConversationResult,
  UseConversationSubmitFlowArgs,
} from "./conversationSubmitTypes";
import { useConversationAutoTitle } from "./useConversationAutoTitle";
import { useConversationControllerDispatch } from "./useConversationControllerDispatch";
import { withUserMentionMetadata } from "./userMentions";

export type {
  SubmitConversationOptions,
  SubmitConversationRuntimeOverride,
  SubmitConversationResult,
} from "./conversationSubmitTypes";

const {
  recordMessage: recordControllerConversationMessage,
  resolveParticipation: resolveControllerConversationParticipation,
  updateMetadata: updateControllerConversationMetadata,
} = controllerClient.conversations;
const { ensure: ensureRuntime, fetchStatus: fetchRuntimeStatus } = controllerClient.runtimes;

type RuntimeDispatchOverride = SubmitConversationRuntimeOverride | null;

type WebdevRuntimeNeed = "screenshot" | "node";

function isDedicatedAgentThreadHandle(handle: string): boolean {
  const resolved = resolveBuiltInAssistantHandle(handle);
  return resolved === null || resolved === getDefaultAssistantHandle();
}

/**
 * Build the assistant capability context that rides along with a cloud prompt.
 *
 * Resolves target handles against the full local-capability assistant
 * registry, so capability-only feature modules contribute their catalogs
 * without requiring the public application to know their identities.
 */
export function buildAssistantCapabilityContextForTargets(
  targetHandles: readonly string[],
): BuiltInAssistantPromptContextMetadata | null {
  const resolvedHandles = targetHandles
    .map((handle) => resolveLocalCapabilityAssistantHandle(handle))
    .filter((handle): handle is BuiltInAssistantHandle => handle !== null);
  return buildLocalCapabilityAssistantPromptContextMetadata(
    resolvedHandles,
    LOCAL_CAPABILITY_DEFINITIONS,
  );
}

function detectWebdevRuntimeNeed(): WebdevRuntimeNeed | null {
  return null;
}

export function useConversationSubmitFlow({
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
  setConversationTitle,
  setConversationGoal,
  appendMessages,
  updateMessage,
  linkRunToConversation,
}: UseConversationSubmitFlowArgs) {
  const chatClientSessionId = useMemo(() => getChatClientSessionId(), []);
  const stickyMentionedAgentByConversationRef = useRef<Map<string, string>>(new Map());
  const localCapabilityFlowQueueRef = useRef(createConversationTaskQueue());

  const {
    resolveProjectId,
    resolveRuntimeTarget,
    ensureConversation,
    handleCreateConversation,
    handleInputChange,
    ensureControllerConversationId,
    sendPromptToController,
    recordMessageToController,
    pendingAgentEvaluationRunIdsRef,
  } = useConversationControllerDispatch({
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
  });

  const { maybeAutoTitleConversation, queueAutoTitleConversation } =
    useConversationAutoTitle({
      conversations,
      resolveProjectId,
      ensureControllerConversationId,
      setConversationTitle,
    });

  const resolveGroupParticipationBeforeSubmit = useCallback(
    async (
      input: ConversationGroupParticipationPreflightInput,
    ): Promise<ConversationGroupParticipationPreflightResult> => {
      const unchanged = (): ConversationGroupParticipationPreflightResult => ({
        mode: "unchanged",
        metadata: input.metadata,
      });
      if (input.hasBrowserTask) {
        return {
          mode: "unchanged",
          metadata: withGroupParticipationPreflightMetadata(
            input.metadata,
            "bypassed",
          ),
        };
      }
      const projectId = resolveProjectId();
      if (
        !projectId ||
        input.hasTerminalCommand ||
        input.displayPrompt.trimStart().startsWith("/") ||
        isLearnPrompt(input.displayPrompt)
      ) {
        return unchanged();
      }

      const conversation =
        conversations.find((entry) => entry.localId === input.conversationId) ??
        activeConversation ??
        ensureConversation();
      const aiOverride = startsWithAssistantMention(input.displayPrompt);
      const { replyToOcto, replyToHuman } = resolveGroupParticipationReplyTargets(
        input.metadata,
        conversation.messages,
        getDefaultAssistantHandle(),
      );
      const shouldResolve = shouldResolveAmbientGroupParticipation({
        assistantEnabled: conversation.assistantEnabled,
        usesDefaultAssistantOnly: input.agentSelection.usesDefaultAssistantOnly,
        activeHandles: input.agentSelection.activeHandles,
        targetHandles: input.agentSelection.targetHandles,
        explicitMentionedHandles: input.agentSelection.explicitMentionedHandles,
        defaultAssistantHandle: getDefaultAssistantHandle(),
        threadKind: conversation.threadKind,
        ownerAgentHandle: conversation.ownerAgent?.handle ?? null,
        hasTerminalCommand: false,
        hasBrowserTask: input.hasBrowserTask,
        hasExplicitAssistantOverride: aiOverride,
        replyToOcto,
        isAmbientTurn: true,
      });
      if (!shouldResolve) {
        return unchanged();
      }

      // A resolved peer directory with no other human matches the controller's
      // single_human_conversation fast path, so skip the serialized resolver
      // round-trip. The controller's dispatch-side gate stays authoritative, so
      // a stale client view costs one server-side classification, never a
      // wrong outcome. Unresolved or errored directories keep the preflight.
      if (
        input.humanPeerContext?.resolved === true &&
        !input.humanPeerContext.hasHumanPeer
      ) {
        return {
          mode: "dispatch",
          metadata: withGroupParticipationPreflightMetadata(
            input.metadata,
            "single_human",
          ),
        };
      }

      let participationResult: Awaited<
        ReturnType<typeof resolveControllerConversationParticipation>
      > = null;
      try {
        const controllerConversationId = await ensureControllerConversationId(
          projectId,
          conversation,
        );
        participationResult = controllerConversationId
          ? await resolveControllerConversationParticipation({
              conversationId: controllerConversationId,
              content: input.dispatchPrompt,
              metadata: input.metadata,
              explicitOcto: false,
              replyToOcto,
              replyToHuman,
            })
          : null;
      } catch (error) {
        console.warn(
          "Failed to resolve group participation before submit; deferring to the controller.",
          error,
        );
      }

      if (participationResult === "unsupported") {
        return {
          mode: "dispatch",
          metadata: withGroupParticipationPreflightMetadata(
            input.metadata,
            "unsupported",
          ),
        };
      }

      if (!participationResult) {
        return {
          mode: "controller_deferred",
          metadata: withGroupParticipationPreflightMetadata(
            input.metadata,
            "controller_deferred",
          ),
        };
      }

      const groupParticipation = buildGroupParticipationMetadata(participationResult);
      if (participationResult.coverage) {
        return {
          mode: "controller_coverage",
          metadata: withGroupParticipationPreflightMetadata(
            input.metadata,
            "controller_coverage",
            groupParticipation,
          ),
        };
      }
      return {
        mode:
          participationResult.decision === "silent"
            ? "record_only"
            : "dispatch",
        metadata: withGroupParticipationPreflightMetadata(
          input.metadata,
          "resolved",
          groupParticipation,
        ),
      };
    },
    [
      activeConversation,
      conversations,
      ensureControllerConversationId,
      ensureConversation,
      resolveProjectId,
    ],
  );

  const handleSubmit = useCallback(
    async (
      conversationId: string | null,
      rawInput: string,
      options?: SubmitConversationOptions,
    ): Promise<SubmitConversationResult> => {
      const trimmed = rawInput.trim();
      const dispatchTrimmed =
        typeof options?.dispatchInput === "string" && options.dispatchInput.trim().length > 0
          ? options.dispatchInput.trim()
          : trimmed;
      if (!trimmed) {
        return;
      }
      let submittedMetadata: Record<string, unknown>;
      try {
        submittedMetadata = withUserMentionMetadata(options?.metadata, options?.editorState);
      } catch (error) {
        showStatus(error instanceof Error ? error.message : String(error), "error", 4500);
        return;
      }
      const terminalRequest = parseTerminalCommandRequest(trimmed);
      if (terminalRequest && terminalRequest.command.length === 0) {
        showStatus("Add a command after /terminal.", "error", 4000);
        return;
      }
      const projectId = resolveProjectId();
      if (!projectId) {
        showStatus("Select or create a project before chatting.", "error", 4000);
        return;
      }
      const conversation = ensureConversation();
      const requestedConversationId = conversationId ?? conversation.localId;
      const sourceConversation =
        conversations.find(
          (entry) =>
            entry.localId === requestedConversationId ||
            entry.controllerId === requestedConversationId,
        ) ?? conversation;
      const sourceConversationId = sourceConversation.localId;

      const goalCommand = parseGoalCommand(trimmed);
      if (goalCommand) {
        const result = applyGoalCommand(
          sourceConversation.activeGoal,
          goalCommand,
          currentUserId,
        );
        if (result.changed) {
          setConversationGoal(sourceConversation.localId, result.goal);
        }
        const goalCommandDispatch = resolveGoalCommandDispatch({
          command: goalCommand,
          goal: result.goal,
          messages: sourceConversation.messages,
        });
        const goalCommandDispatchInput = goalCommandDispatch?.input ?? null;
        const goalUserMetadata = {
          ...submittedMetadata,
          client: buildConversationClientMetadata(chatClientSessionId, currentUserId),
          clientMessageId: generateUUID(),
          command: { type: "goal" },
        };
        const userMessage = createConversationMessage(
          "user",
          trimmed,
          currentUserId,
          goalUserMetadata,
        );
        const assistantMessage = {
          ...createConversationMessage("assistant", result.message, null, {
            messageType: "goal_update",
            details: {
              status: result.goal?.status ?? null,
              objective: result.goal?.objective ?? null,
              goalId: result.goal?.id ?? null,
              changed: result.changed,
            },
          }),
          messageType: "goal_update",
        };
        appendMessages(sourceConversation.localId, [userMessage, assistantMessage]);
        void (async () => {
          try {
            const conversationWithGoal = {
              ...sourceConversation,
              activeGoal: result.goal,
            };
            const controllerConversationId = await ensureControllerConversationId(
              projectId,
              conversationWithGoal,
            );
            if (controllerConversationId && result.changed) {
              await updateControllerConversationMetadata({
                conversationId: controllerConversationId,
                metadata: createConversationGoalMetadataPatch(result.goal),
              });
            }
            if (goalCommandDispatchInput) {
              const dispatchResult = await sendPromptToController(
                sourceConversation.localId,
                goalCommandDispatchInput,
                {
                  ...goalUserMetadata,
                  goal: activeGoalPromptMetadata(result.goal),
                  ...(goalCommandDispatch?.continuationTurn
                    ? {
                        goalContinuation: {
                          source: "manual_resume",
                          turn: goalCommandDispatch.continuationTurn,
                        },
                      }
                    : {}),
                  displayContent: trimmed,
                  dispatchContent: goalCommandDispatchInput,
                },
                options?.runtimeOverride,
                conversationWithGoal,
                undefined,
                options?.expectedLaneIdle ?? false,
              );
              if (dispatchResult?.ok === false && result.goal?.status === "active") {
                const blockedGoal = updateConversationGoal(
                  result.goal,
                  {
                    status: "blocked",
                    progressSummary:
                      dispatchResult.errorMessage ??
                      "Controller unavailable before the goal could start.",
                  },
                  currentUserId,
                );
                setConversationGoal(sourceConversation.localId, blockedGoal);
                if (controllerConversationId) {
                  await updateControllerConversationMetadata({
                    conversationId: controllerConversationId,
                    metadata: createConversationGoalMetadataPatch(blockedGoal),
                  }).catch(() => null);
                }
              }
            } else {
              await recordMessageToController(
                sourceConversation.localId,
                trimmed,
                userMessage.metadata,
                "user",
                conversationWithGoal,
              );
              await recordMessageToController(
                sourceConversation.localId,
                result.message,
                assistantMessage.metadata,
                "assistant",
                conversationWithGoal,
              );
            }
          } catch (error) {
            console.warn("Failed to persist conversation goal", error);
          }
        })();
        return;
      }

      let displayConversationId = sourceConversationId;
      let displayConversationControllerId: string | null = sourceConversation.controllerId ?? null;

      let targetConversationId = sourceConversationId;
      let targetConversation = sourceConversation;

      if (isLearnPrompt(trimmed)) {
        const parentConversation = sourceConversation;
        const parentControllerId = await ensureControllerConversationId(projectId, parentConversation);
        if (!parentControllerId) {
          showStatus("Controller unavailable. Try again shortly.", "error", 4000);
          return;
        }
        displayConversationControllerId = parentControllerId;
        const learnConversation = createConversation({
          title: "",
          visibility: parentConversation.visibility,
          parentConversationId: parentControllerId,
          threadKind: "thread",
          select: false,
        });
        targetConversationId = learnConversation.localId;
        targetConversation = learnConversation;
        displayConversationId = parentConversation.localId;
      }
      const autoSyncAfterApply = getGitAutoSyncAfterApplyPreference();
      let promptMetadata: Record<string, unknown> | null = {
        ...submittedMetadata,
        client: buildConversationClientMetadata(chatClientSessionId, currentUserId),
        clientMessageId: generateUUID(),
        git: {
          autoSyncAfterApply,
        },
      };
      const goalMetadata = activeGoalPromptMetadata(targetConversation.activeGoal);
      if (goalMetadata) {
        promptMetadata.goal = goalMetadata;
      }

      if (dispatchTrimmed !== trimmed) {
        promptMetadata = {
          ...(promptMetadata ?? {}),
          displayContent: trimmed,
          dispatchContent: dispatchTrimmed,
        };
      }

      // Runtime expectations should come from explicit commands/metadata, not
      // frontend regexes over the user's natural-language prompt.
      if (terminalRequest) {
        promptMetadata = withRuntimeExpectations(
          {
            ...(promptMetadata ?? {}),
            terminalCommand: {
              command: terminalRequest.command,
              shell: "bash",
            },
          },
          { commandExecution: true },
        );
      }
      const shouldAttemptAutoTitle = shouldAutoTitleConversation(targetConversation, trimmed);
      const userMessage = createConversationMessage(
        "user",
        trimmed,
        currentUserId,
        promptMetadata,
      );
      const imageFiles = resolveSubmittedImageFiles(options?.imageFile, options?.imageFiles);

      if (imageFiles.length > 0) {
        try {
          const { runtimeId } = resolveRuntimeTarget(targetConversation);
          const attachments = await uploadConversationImageAttachments({
            projectId,
            runtimeId,
            imageFiles,
          });

          promptMetadata = {
            ...(promptMetadata ?? {}),
            attachments,
          };

          userMessage.metadata = promptMetadata;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          showStatus(`Image upload failed: ${message}`, "error", 5000);
          return { ok: false, reason: "image_upload_failed" };
        }
      }

      // Only publish a message after its images exist. A failed upload leaves
      // the composer retryable and must not leave an optimistic ghost row.
      appendMessages(displayConversationId, [userMessage]);

      const configuredAgentHandles =
        options?.agentHandles
          ?.map((handle) => handle.trim().toLowerCase())
          .filter((handle) => handle.length > 0) ?? [];
      const stickyMentionedAgent =
        stickyMentionedAgentByConversationRef.current.get(displayConversationId) ?? null;
      const agentSelection = resolvePromptAgentSelection({
        prompt: trimmed,
        assistantEnabled: targetConversation.assistantEnabled,
        extraAgentHandles: targetConversation.extraAgentHandles ?? [],
        configuredAgentHandles,
        stickyMentionedAgent,
      });
      const explicitTopLevelAgentHandles =
        sourceConversation.threadKind === "agent"
          ? []
          : agentSelection.explicitMentionedHandles.filter(isDedicatedAgentThreadHandle);
      const ownerAgentHandle =
        sourceConversation.threadKind === "agent"
          ? sourceConversation.ownerAgent?.handle ??
            sourceConversation.extraAgentHandles[0] ??
            null
          : null;
      const effectiveAgentSelection = ownerAgentHandle
        ? {
            ...agentSelection,
            activeHandles: [ownerAgentHandle],
            explicitMentionedHandles: [ownerAgentHandle],
            mentionedHandles: [ownerAgentHandle],
            targetHandles: [ownerAgentHandle],
            nextStickyMentionedAgent: ownerAgentHandle,
            usesDefaultAssistantOnly: ownerAgentHandle === getDefaultAssistantHandle(),
          }
        : agentSelection;
      if (agentSelection.nextStickyMentionedAgent) {
        stickyMentionedAgentByConversationRef.current.set(
          displayConversationId,
          agentSelection.nextStickyMentionedAgent,
        );
      } else {
        stickyMentionedAgentByConversationRef.current.delete(displayConversationId);
      }
      const topLevelAgentCollaborationModes =
        explicitTopLevelAgentHandles.length > 0
          ? decideTopLevelAgentCollaborationModes({
              prompt: trimmed,
              explicitHandles: explicitTopLevelAgentHandles,
              hasAttachments: imageFiles.length > 0,
              hasTerminalIntent: Boolean(terminalRequest),
            })
          : {};
      const threadedExplicitAgentHandles =
        explicitTopLevelAgentHandles.filter(
          (handle) => topLevelAgentCollaborationModes[handle] === "thread",
        );
      const inlineExplicitAgentHandles =
        explicitTopLevelAgentHandles.filter(
          (handle) => topLevelAgentCollaborationModes[handle] === "inline",
        );
      const topLevelAgentCollaborationMode =
        explicitTopLevelAgentHandles.length > 0
          ? threadedExplicitAgentHandles.length > 0
            ? "thread"
            : "inline"
          : null;
      if (
        effectiveAgentSelection.activeHandles.length > 0 ||
        effectiveAgentSelection.mentionedHandles.length > 0
      ) {
        const agentSelectionMetadata = {
          active: effectiveAgentSelection.activeHandles,
          mentions: effectiveAgentSelection.mentionedHandles,
        };
        const existingAgentCollaboration =
          promptMetadata?.agentCollaboration &&
          typeof promptMetadata.agentCollaboration === "object" &&
          !Array.isArray(promptMetadata.agentCollaboration)
            ? (promptMetadata.agentCollaboration as Record<string, unknown>)
            : null;
        promptMetadata = {
          ...(promptMetadata ?? {}),
          agentSelection: agentSelectionMetadata,
          ...(topLevelAgentCollaborationMode
            ? {
                agentCollaboration: {
                  mode: topLevelAgentCollaborationMode,
                  policySkillPath: GLOBAL_AGENT_COLLABORATION_SKILL_PATH,
                  ...(existingAgentCollaboration ?? {}),
                },
              }
            : {}),
        };

        patchConversationMessageMetadata(
          updateMessage,
          displayConversationId,
          userMessage.id,
          promptMetadata,
        );
      }

      const assistantCapabilityContext = buildAssistantCapabilityContextForTargets(
        effectiveAgentSelection.targetHandles,
      );
      if (assistantCapabilityContext) {
        promptMetadata = {
          ...(promptMetadata ?? {}),
          assistantCapabilityContext,
        };

        patchConversationMessageMetadata(
          updateMessage,
          displayConversationId,
          userMessage.id,
          promptMetadata,
        );
      }

      const aiOverride = startsWithAssistantMention(trimmed);
      const shouldRunAssistant =
        effectiveAgentSelection.targetHandles.length > 0 ||
        aiOverride ||
        Boolean(terminalRequest);
      let deferGroupParticipationToController = false;
      if (shouldRunAssistant) {
        const { replyToOcto, replyToHuman } = resolveGroupParticipationReplyTargets(
          promptMetadata,
          targetConversation.messages,
          getDefaultAssistantHandle(),
        );
        const shouldResolveParticipation = shouldResolveAmbientGroupParticipation({
          assistantEnabled: targetConversation.assistantEnabled,
          usesDefaultAssistantOnly: effectiveAgentSelection.usesDefaultAssistantOnly,
          activeHandles: effectiveAgentSelection.activeHandles,
          targetHandles: effectiveAgentSelection.targetHandles,
          explicitMentionedHandles: effectiveAgentSelection.explicitMentionedHandles,
          defaultAssistantHandle: getDefaultAssistantHandle(),
          threadKind: sourceConversation.threadKind,
          ownerAgentHandle: sourceConversation.ownerAgent?.handle ?? null,
          hasTerminalCommand: Boolean(terminalRequest),
          hasBrowserTask: false,
          hasExplicitAssistantOverride: aiOverride,
          replyToOcto,
          isAmbientTurn: displayConversationId === targetConversationId,
        });

        if (shouldResolveParticipation) {
          const existingPreflightStatus = readGroupParticipationPreflightStatus(
            promptMetadata,
          );
          const existingDecision = readGroupParticipationDecision(promptMetadata);

          if (
            existingPreflightStatus === "controller_deferred" ||
            existingPreflightStatus === "controller_coverage"
          ) {
            deferGroupParticipationToController = true;
          } else if (existingPreflightStatus === "resolved") {
            if (existingDecision === "silent" || !existingDecision) {
              if (!existingDecision) {
                promptMetadata = {
                  ...(promptMetadata ?? {}),
                  groupParticipation: buildUnavailableGroupParticipationMetadata(),
                };
              }
              patchConversationMessageMetadata(
                updateMessage,
                displayConversationId,
                userMessage.id,
                promptMetadata,
              );
              await recordMessageToController(
                displayConversationId,
                trimmed,
                promptMetadata,
                "user",
                sourceConversation,
              );
              return;
            }
          } else if (
            existingPreflightStatus !== "unsupported" &&
            existingPreflightStatus !== "bypassed" &&
            existingPreflightStatus !== "single_human"
          ) {
            let participationResult: Awaited<
              ReturnType<typeof resolveControllerConversationParticipation>
            > = null;
            try {
              const controllerConversationId = await ensureControllerConversationId(
                projectId,
                targetConversation,
              );
              participationResult = controllerConversationId
                ? await resolveControllerConversationParticipation({
                    conversationId: controllerConversationId,
                    content: dispatchTrimmed,
                    metadata: promptMetadata,
                    explicitOcto: false,
                    replyToOcto,
                    replyToHuman,
                  })
                : null;
            } catch (error) {
              console.warn(
                "Failed to resolve group participation; deferring to the controller.",
                error,
              );
            }

            if (participationResult === null) {
              promptMetadata = withGroupParticipationPreflightMetadata(
                promptMetadata,
                "controller_deferred",
              );
              patchConversationMessageMetadata(
                updateMessage,
                displayConversationId,
                userMessage.id,
                promptMetadata,
              );
              deferGroupParticipationToController = true;
            } else if (participationResult !== "unsupported") {
              const hasAuthoritativeCoverage = Boolean(participationResult.coverage);
              promptMetadata = withGroupParticipationPreflightMetadata(
                promptMetadata,
                hasAuthoritativeCoverage ? "controller_coverage" : "resolved",
                buildGroupParticipationMetadata(participationResult),
              );
              patchConversationMessageMetadata(
                updateMessage,
                displayConversationId,
                userMessage.id,
                promptMetadata,
              );

              if (hasAuthoritativeCoverage) {
                deferGroupParticipationToController = true;
              } else if (participationResult.decision === "silent") {
                await recordMessageToController(
                  displayConversationId,
                  trimmed,
                  promptMetadata,
                  "user",
                  sourceConversation,
                );
                return;
              }
            }
          }
        }

        if (shouldAttemptAutoTitle && !deferGroupParticipationToController) {
          queueAutoTitleConversation(targetConversationId, trimmed);
        }
      }

      const localBuiltInCapabilityHandle =
        !terminalRequest && !deferGroupParticipationToController
          ? resolveSingleLocalCapabilityHandleForPrompt({
            targetHandles: effectiveAgentSelection.targetHandles,
            prompt: trimmed,
            conversationMessages: targetConversation.messages,
          })
        : null;
      if (localBuiltInCapabilityHandle) {
        const localCapabilityQueueKey =
          (await ensureControllerConversationId(projectId, targetConversation)) ?? targetConversationId;
        const localCapabilityResult = await localCapabilityFlowQueueRef.current.enqueue(
          localCapabilityQueueKey,
          async () =>
            runLocalCapabilityConversationFlow({
              handle: localBuiltInCapabilityHandle,
              prompt: trimmed,
              projectId,
              conversationId: targetConversationId,
              displayConversationId,
              promptMetadata,
              userMessageId: userMessage.id,
              conversationMessages: targetConversation.messages,
              appendMessages,
              updateMessage,
              recordMessageToController: (conversationId, content, metadata, role) =>
                recordMessageToController(
                  conversationId,
                  content,
                  metadata,
                  role,
                  targetConversation,
                ),
              onCapabilityError: (message) => {
                showStatus(message, "error", 5000);
              },
            }),
        );
        promptMetadata = localCapabilityResult.promptMetadata;
        if (localCapabilityResult.handled) {
          return;
        }
      }

      if (threadedExplicitAgentHandles.length > 0) {
        const parentControllerId = await ensureControllerConversationId(
          projectId,
          sourceConversation,
        );
        if (!parentControllerId) {
          showStatus("Controller unavailable. Try again shortly.", "error", 4000);
          return;
        }
        displayConversationControllerId = parentControllerId;
        const advisoryScopeClaims = buildPromptAdvisoryScopeClaims(trimmed);

        for (const handle of threadedExplicitAgentHandles) {
          const existingThread =
            conversations.find(
              (entry) =>
                entry.parentConversationId === parentControllerId &&
                entry.threadKind === "agent" &&
                (entry.ownerAgent?.handle === handle ||
                  entry.extraAgentHandles.includes(handle)),
            ) ?? null;
          const threadConversation =
            existingThread ??
            createConversation({
              title: `@${handle}`,
              visibility: sourceConversation.visibility,
              parentConversationId: parentControllerId,
              threadKind: "agent",
              ownerAgent: { id: null, handle },
              originMessageId: userMessage.id,
              assistantEnabled: false,
              extraAgentHandles: [handle],
              select: false,
            });
          const threadPromptMetadata = {
            ...(promptMetadata ?? {}),
            agentSelection: {
              active: [handle],
              mentions: [handle],
            },
            agentCollaboration: {
              mode: "thread",
              policySkillPath: GLOBAL_AGENT_COLLABORATION_SKILL_PATH,
              linkedThreadLocalId: threadConversation.localId,
              parentConversationLocalId: sourceConversation.localId,
            },
            linkedThreadId: threadConversation.localId,
            ...(advisoryScopeClaims.length > 0
              ? { advisoryScopeClaims }
              : {}),
            agentThread: {
              ownerHandle: handle,
              parentConversationId: parentControllerId,
              sourceConversationId: sourceConversation.controllerId ?? parentControllerId,
            },
          };
          await sendPromptToController(
            threadConversation.localId,
            dispatchTrimmed,
            threadPromptMetadata,
            options?.runtimeOverride,
            threadConversation,
            terminalRequest ? "terminal_command" : undefined,
            options?.expectedLaneIdle ?? false,
          );
        }
        if (inlineExplicitAgentHandles.length === 0) {
          return;
        }
        promptMetadata = {
          ...(promptMetadata ?? {}),
          agentSelection: {
            active: inlineExplicitAgentHandles,
            mentions: inlineExplicitAgentHandles,
          },
          agentCollaboration: {
            mode: "inline",
            policySkillPath: GLOBAL_AGENT_COLLABORATION_SKILL_PATH,
          },
        };
      }

      if (shouldRunAssistant) {
        let runtimeOverride: RuntimeDispatchOverride | undefined = options?.runtimeOverride ?? undefined;

        const hasExplicitPersonalBrowserRuntime =
          promptMetadata?.browserTransport === "desktop-personal" &&
          Boolean(runtimeOverride?.runtimeId);
        const webdevNeed = terminalRequest || hasExplicitPersonalBrowserRuntime
          ? null
          : detectWebdevRuntimeNeed();
        if (webdevNeed) {
          const runtimeSnapshot = await fetchRuntimeStatus({
            projectId,
            accessToken: null,
            quietOnAbort: true,
          }).catch(() => null);
          const statuses = Array.isArray(runtimeSnapshot?.runtimes)
            ? runtimeSnapshot.runtimes
            : runtimeStatuses ?? [];
          const { runtimeId, runtimeDisplayName } = resolveRuntimeTarget(targetConversation);
          const existingEntry =
            runtimeId && statuses.length > 0
              ? statuses.find((entry) => entry.runtimeId === runtimeId) ?? null
              : null;
          const alreadyWebdevNameMatch =
            (runtimeDisplayName ?? "").toLowerCase().includes("webdev") ||
            (runtimeDisplayName ?? "").toLowerCase().includes("playwright") ||
            (existingEntry?.displayName ?? "").toLowerCase().includes("webdev") ||
            (existingEntry?.displayName ?? "").toLowerCase().includes("playwright");
          const alreadyWebdev =
            alreadyWebdevNameMatch &&
            runtimeEntryIsDispatchable(existingEntry);

          if (alreadyWebdev && runtimeId) {
            runtimeOverride = {
              runtimeId,
              runtimeDisplayName:
                existingEntry?.displayName ?? runtimeDisplayName ?? WEBDEV_RUNTIME_DISPLAY_NAME,
              preferRuntime: true,
            };
          } else {
            const existingWebdevReady = statuses.find((entry) => {
              if (!runtimeEntryIsDispatchable(entry)) {
                return false;
              }
              const name = (entry.displayName ?? "").toLowerCase();
              return name.includes("webdev") || name.includes("playwright");
            });

            const actionLabel =
              webdevNeed === "screenshot"
                ? "take the screenshot"
                : "run Node tooling";

            const switchMessage = {
              ...createConversationMessage(
                "assistant",
                `Switching to the Webdev runtime (Playwright) so I can ${actionLabel}…`,
                null,
                {
                  messageType: "runtime_switch",
                  details: {
                    status: "in_progress",
                    target: "webdev",
                    reason: webdevNeed,
                  },
                  kind: "runtime-switch",
                  target: "webdev",
                  reason: webdevNeed,
                },
              ),
              messageType: "runtime_switch",
            };
            appendMessages(targetConversationId, [switchMessage]);
            showStatus("Switching to Webdev runtime…", "info", 4000);

            if (existingWebdevReady?.runtimeId) {
              runtimeOverride = {
                runtimeId: existingWebdevReady.runtimeId,
                runtimeDisplayName: existingWebdevReady.displayName ?? WEBDEV_RUNTIME_DISPLAY_NAME,
                preferRuntime: true,
              };
              updateMessage(targetConversationId, switchMessage.id, (previous) => {
                const previousMetadata =
                  previous.metadata && typeof previous.metadata === "object"
                    ? (previous.metadata as Record<string, unknown>)
                    : {};
                const previousDetails =
                  previousMetadata.details && typeof previousMetadata.details === "object"
                    ? (previousMetadata.details as Record<string, unknown>)
                    : {};
                return {
                  ...previous,
                  content:
                    "Switching to the Webdev runtime (Playwright) — it’s already ready; running your request now…",
                  metadata: {
                    ...previousMetadata,
                    details: {
                      ...previousDetails,
                      status: "completed",
                    },
                    runtimePreference: {
                      runtimeId: existingWebdevReady.runtimeId,
                      source: "conversation",
                      displayName: existingWebdevReady.displayName ?? WEBDEV_RUNTIME_DISPLAY_NAME,
                    },
                  },
                };
              });
            } else {
              const autoCloudRuntime =
                statuses.find((entry) => runtimeEntryIsReady(entry) && entry.isLocal === false) ?? null;
              const autoRuntime = autoCloudRuntime ?? statuses.find((entry) => runtimeEntryIsReady(entry)) ?? null;
              const provider = existingEntry?.provider ?? autoRuntime?.provider ?? "instafy-cloud";
              const requestedRuntimeId = generateUUID();

              updateMessage(targetConversationId, switchMessage.id, (previous) => {
                const previousMetadata =
                  previous.metadata && typeof previous.metadata === "object"
                    ? (previous.metadata as Record<string, unknown>)
                    : {};
                const previousDetails =
                  previousMetadata.details && typeof previousMetadata.details === "object"
                    ? (previousMetadata.details as Record<string, unknown>)
                    : {};
                return {
                  ...previous,
                  content:
                    "Switching to the Webdev runtime (Playwright) — starting it now; I’ll run your request as soon as it’s ready…",
                  metadata: {
                    ...previousMetadata,
                    details: {
                      ...previousDetails,
                      status: "in_progress",
                    },
                    runtimePreference: {
                      runtimeId: requestedRuntimeId,
                      source: "conversation",
                      displayName: WEBDEV_RUNTIME_DISPLAY_NAME,
                    },
                  },
                };
              });

              try {
                const webdevRuntimeEnv = getWebdevRuntimeEnv();
                const ensured = await ensureRuntime({
                  projectId,
                  provider,
                  displayName: WEBDEV_RUNTIME_DISPLAY_NAME,
                  runtimeId: requestedRuntimeId,
                  metadata: {
                    runtimeFlavor: WEBDEV_RUNTIME_FLAVOR,
                    env: {
                      ...webdevRuntimeEnv,
                      INSTAFY_ENABLE_BROWSER_SESSION: "1",
                    },
                  },
                });
                const ensuredRuntimeId = ensured?.runtimeId?.trim() ?? "";
                if (!ensuredRuntimeId) {
                  throw new Error("Unable to provision the Webdev runtime.");
                }

                let ready = false;
                const deadline = Date.now() + 8 * 60_000;
                while (Date.now() < deadline) {
                  const status = await fetchRuntimeStatus({
                    projectId,
                    accessToken: null,
                    quietOnAbort: true,
                  }).catch(() => null);
                  const entry =
                    status?.runtimes?.find((candidate) => candidate.runtimeId === ensuredRuntimeId) ?? null;
                  if (entry && runtimeEntryIsDispatchable(entry)) {
                    ready = true;
                    updateMessage(targetConversationId, switchMessage.id, (previous) => {
                      const previousMetadata =
                        previous.metadata && typeof previous.metadata === "object"
                          ? (previous.metadata as Record<string, unknown>)
                          : {};
                      const previousDetails =
                        previousMetadata.details && typeof previousMetadata.details === "object"
                          ? (previousMetadata.details as Record<string, unknown>)
                          : {};
                      return {
                        ...previous,
                        content:
                          "Switching to the Webdev runtime (Playwright) — it’s ready; running your request now…",
                        metadata: {
                          ...previousMetadata,
                          details: {
                            ...previousDetails,
                            status: "completed",
                          },
                        },
                      };
                    });
                    break;
                  }
                  await sleep(2000);
                }
                if (!ready) {
                  throw new Error("Webdev runtime is taking longer than expected to start.");
                }

                runtimeOverride = {
                  runtimeId: ensuredRuntimeId,
                  runtimeDisplayName: WEBDEV_RUNTIME_DISPLAY_NAME,
                  preferRuntime: true,
                };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                updateMessage(targetConversationId, switchMessage.id, (previous) => {
                  const previousMetadata =
                    previous.metadata && typeof previous.metadata === "object"
                      ? (previous.metadata as Record<string, unknown>)
                      : {};
                  const previousDetails =
                    previousMetadata.details && typeof previousMetadata.details === "object"
                      ? (previousMetadata.details as Record<string, unknown>)
                      : {};
                  return {
                    ...previous,
                    content: `Switching to the Webdev runtime (Playwright) failed (${message}).`,
                    metadata: {
                      ...previousMetadata,
                      details: {
                        ...previousDetails,
                        status: "failed",
                      },
                      runtimePreference: null,
                    },
                  };
                });
                showStatus(`Unable to start Webdev runtime: ${message}`, "error", 5000);
                return;
              }
            }
          }
        }

        if (displayConversationId !== targetConversationId && displayConversationControllerId) {
          await recordControllerConversationMessage({
            conversationId: displayConversationControllerId,
            projectId,
            content: dispatchTrimmed,
            metadata: promptMetadata,
            accessToken: null,
          }).catch(() => null);
        }

        await sendPromptToController(
          targetConversationId,
          dispatchTrimmed,
          promptMetadata,
          runtimeOverride,
          targetConversation,
          terminalRequest ? "terminal_command" : undefined,
          options?.expectedLaneIdle ?? false,
        );
      } else {
        await recordMessageToController(
          displayConversationId,
          trimmed,
          promptMetadata,
          "user",
          sourceConversation,
        );
      }
    },
    [
      appendMessages,
      chatClientSessionId,
      conversations,
      createConversation,
      currentUserId,
      ensureConversation,
      ensureControllerConversationId,
      queueAutoTitleConversation,
      recordMessageToController,
      resolveProjectId,
      resolveRuntimeTarget,
      runtimeStatuses,
      sendPromptToController,
      setConversationGoal,
      showStatus,
      updateMessage,
    ],
  );

  return {
    ensureConversation,
    handleCreateConversation,
    handleInputChange,
    recordMessageToController,
    maybeAutoTitleConversation,
    resolveGroupParticipationBeforeSubmit,
    handleSubmit,
    sendPromptToController,
    // Single source of truth for sticky @agent routing. UI surfaces (e.g.
    // "Chat without AI") must clear this exact map or handleSubmit keeps
    // dispatching to the stale sticky agent.
    stickyMentionedAgentByConversationRef,
    // Submitter-local marks for skill-mode ambient dispatches; presence
    // (typing / workspace-activity rows) stays hidden for these runs until a
    // visible assistant message streams.
    pendingAgentEvaluationRunIdsRef,
  };
}

export function buildConversationAgentHandles(
  assistantEnabled: boolean,
  extraAgentHandles: string[],
) {
  const handles = assistantEnabled
    ? [getDefaultAssistantHandle(), ...extraAgentHandles]
    : [...extraAgentHandles];
  return Array.from(new Set(handles));
}
