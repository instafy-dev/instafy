import { useCallback, useRef, useState, type MutableRefObject } from "react";
import type { ResolvedPromptAgentSelection } from "../../../conversations/assistantMentions";
import type {
  ConversationGroupParticipationPreflightInput,
  ConversationGroupParticipationPreflightResult,
  ConversationHumanPeerPresence,
} from "../../../conversations/groupParticipation";
import type { SubmitConversationRuntimeOverride } from "../../../conversations/useConversation";
import type { ControllerConversationParticipant } from "../../../services/runtimeController/conversations";
import type {
  FetchRuntimeStatusParams,
  FetchRuntimeStatusResult,
} from "../../../services/runtimeController/runtimes";
import type { StatusIntent } from "../../../status/useStatus";
import { logAppWarn } from "../../../debug/appLogs";
import {
  runtimeEntryIsDispatchable,
  runtimeEntryIsReady,
} from "../../../runtime/utils/runtimeEntry";
import type { ChatMessage } from "../types";
import type { StudioPanel } from "../types";
import type { BrowserSessionPage, BrowserSessionPageTarget } from "./browserSessionPages";
import { resolvePrivateConversationInvitePrompt } from "./chatPrivateConversationInvitePrompt";
import { buildChatSubmitPlan, type ChatSubmitOverride } from "./chatSubmitPlanning";
import { runChatSubmitPreflight } from "./chatSubmitPreflight";
import {
  buildSharedBrowserSubmitMetadata,
  resolveSharedBrowserSubmitRouting,
  withPersonalBrowserRuntimeExpectations,
} from "./sharedBrowserSubmitRouting";
import type { PendingConversationInvitePrompt } from "./useChatInvitePromptHandlers";
import type { ChatSubmitDispatchPayload } from "./useChatSubmitDispatch";
import type { EnqueueServerSendQueuePayload } from "./useChatServerSendQueue";
import { buildServerSendQueuePromptBody } from "./useChatServerSendQueue";
import type { PreparedEmailInvite } from "../../../sharing/preparedEmailInvite";

export type SubmitMessageFn = (
  override?: ChatSubmitOverride,
  options?: {
    allowWhileBusy?: boolean;
    metadata?: Record<string, unknown> | null;
    intent?: "send" | "queue" | "steer";
    expectedActiveJobId?: string | null;
  },
) => Promise<boolean>;

export function resolvePersonalBrowserSubmitRouting(input: {
  active: boolean;
  messageRequiresAi: boolean;
  runtimeOverride: SubmitConversationRuntimeOverride | null;
  terminalRequest: unknown;
}):
  | { kind: "standard"; runtimeOverride: null }
  | { kind: "blocked"; runtimeOverride: null }
  | { kind: "personal"; runtimeOverride: SubmitConversationRuntimeOverride } {
  if (!input.active || !input.messageRequiresAi || input.terminalRequest) {
    return { kind: "standard", runtimeOverride: null };
  }
  if (!input.runtimeOverride?.runtimeId) {
    return { kind: "blocked", runtimeOverride: null };
  }
  return { kind: "personal", runtimeOverride: input.runtimeOverride };
}

type ShowStatus = (message: string, intent?: StatusIntent, durationMs?: number) => void;

type ConversationEntryLike = {
  controllerId?: string | null;
  visibility?: string | null;
} | null;

export function useChatSubmitFlow({
  activeConversationEntry,
  activeConversationId,
  activeConversationMessages,
  activeOrgId,
  activeProjectId,
  appendMessages,
  broadcastTyping,
  clearComposerAfterQueue,
  clearComposerIfUnchanged,
  clearPendingBrowserLaunchMode,
  createConversation,
  createOrgInvitation,
  credentialsReady,
  currentUserId,
  effectiveRuntimeId,
  enqueueChatSendQueueItem,
  enqueueServerSendQueueItem,
  fetchRuntimeStatus,
  focusInput,
  hasHiddenBrowserSession,
  browserSessionOpen,
  humanPeerContext,
  imageFiles,
  isAssistantTyping,
  inputEditorState,
  inputValue,
  interruptConversationRuns,
  invitePrompt,
  listConversationParticipants,
  localTypingStateRef,
  onMaybeAutoTitleConversation,
  onPreparedEmailInvite,
  onRecordMessage,
  openInvitePrompt,
  openPanelTab,
  outOfCredits,
  pendingBrowserLaunchMode,
  pendingTypingBroadcastRef,
  performSubmit,
  personalBrowserActive,
  personalBrowserAgentError,
  personalBrowserRuntimeOverride,
  preferredBrowserPage,
  preferredRuntimeId,
  revealAiGatesForCurrentDraft,
  requestRuntimeRecovery,
  resolveGroupParticipationBeforeSubmit,
  resolvePromptAgentTargets,
  runtimeControllerEnabled,
  runtimeReady,
  scrollToBottom,
  sendingAttachment,
  sharedBrowserActive,
  sharedBrowserRuntimeId,
  showCredentialsGate,
  showStatus,
  shouldAutoScrollRef,
  softPrefillSuggestion,
  submitSendIntent,
  targetsOverlapActiveRuns,
}: {
  activeConversationEntry: ConversationEntryLike;
  activeConversationId: string | null;
  activeConversationMessages: ChatMessage[];
  activeOrgId: string | null;
  activeProjectId: string | null;
  appendMessages: (conversationId: string, messages: ChatMessage[]) => void;
  broadcastTyping: (isTyping: boolean, conversationId: string | null) => void;
  clearComposerAfterQueue: (conversationId: string, expectedDraft: string) => void;
  clearComposerIfUnchanged: (conversationId: string, expectedDraft: string) => void;
  clearPendingBrowserLaunchMode: () => void;
  createConversation: () => { localId: string };
  createOrgInvitation: (input: {
    orgId: string;
    projectId?: string;
    conversationId?: string;
    email: string;
    role: string;
  }) => Promise<{
    acceptUrl: string;
    email: string;
    role: string;
    expiresAt?: string | null;
  }>;
  credentialsReady: boolean;
  currentUserId: string | null;
  effectiveRuntimeId: string | null;
  enqueueChatSendQueueItem: (payload: {
    message: string;
    editorState: string | null;
    targetAgentHandles: string[];
    browserPageTarget: BrowserSessionPageTarget | null;
    browserLaunchMode: "new_page" | null;
    metadata?: Record<string, unknown> | null;
    runtimeOverride?: SubmitConversationRuntimeOverride | null;
  }) => void;
  enqueueServerSendQueueItem: (payload: EnqueueServerSendQueuePayload) => Promise<boolean>;
  fetchRuntimeStatus: (input: FetchRuntimeStatusParams) => Promise<FetchRuntimeStatusResult | null>;
  focusInput: (options?: { force?: boolean }) => void;
  hasHiddenBrowserSession: boolean;
  browserSessionOpen: boolean;
  humanPeerContext: ConversationHumanPeerPresence | null;
  imageFiles: File[];
  isAssistantTyping: boolean;
  inputEditorState: string | null;
  inputValue: string;
  interruptConversationRuns: (input: {
    conversationId: string;
    reason?: string | null;
    accessToken: null;
  }) => Promise<string[] | null>;
  invitePrompt: PendingConversationInvitePrompt | null;
  listConversationParticipants: (input: {
    conversationId: string;
    accessToken: null;
  }) => Promise<ControllerConversationParticipant[] | null>;
  localTypingStateRef: MutableRefObject<{ isTyping: boolean; lastSentAt: number }>;
  onMaybeAutoTitleConversation: (conversationId: string, prompt: string) => void | Promise<void>;
  onPreparedEmailInvite: (invite: PreparedEmailInvite) => void;
  onRecordMessage: (
    conversationId: string,
    message: string,
    metadata?: Record<string, unknown> | null,
    role?: "assistant" | "user",
  ) => Promise<ChatMessage | null>;
  openInvitePrompt: (prompt: PendingConversationInvitePrompt) => void;
  openPanelTab: (panelId: StudioPanel, options?: { activate?: boolean }) => void;
  outOfCredits: boolean;
  pendingBrowserLaunchMode: "new_page" | null;
  pendingTypingBroadcastRef: MutableRefObject<{
    conversationLocalId: string | null;
    controllerId: string | null;
    at: number;
  } | null>;
  performSubmit: (payload: ChatSubmitDispatchPayload) => Promise<void>;
  personalBrowserActive: boolean;
  personalBrowserAgentError: string | null;
  personalBrowserRuntimeOverride: SubmitConversationRuntimeOverride | null;
  preferredBrowserPage: BrowserSessionPage | null;
  preferredRuntimeId: string | null;
  revealAiGatesForCurrentDraft: () => boolean;
  requestRuntimeRecovery: () => void;
  resolveGroupParticipationBeforeSubmit: (
    input: ConversationGroupParticipationPreflightInput,
  ) => Promise<ConversationGroupParticipationPreflightResult>;
  resolvePromptAgentTargets: (
    prompt: string,
    options?: {
      useSticky?: boolean;
      updateSticky?: boolean;
    },
  ) => ResolvedPromptAgentSelection;
  runtimeControllerEnabled: boolean;
  runtimeReady: boolean;
  scrollToBottom: () => void;
  sendingAttachment: boolean;
  sharedBrowserActive: boolean;
  sharedBrowserRuntimeId: string | null;
  showCredentialsGate: () => void;
  showStatus: ShowStatus;
  shouldAutoScrollRef: MutableRefObject<boolean>;
  softPrefillSuggestion: string | null | undefined;
  submitSendIntent: (input: {
    mode: "queue" | "steer";
    request: Record<string, unknown>;
    targetAgentHandles: string[];
    expectedActiveJobId: string | null;
  }) => Promise<boolean>;
  targetsOverlapActiveRuns: (targetAgentHandles: string[]) => boolean;
}) {
  const submitMessageInFlightRef = useRef(false);
  const [submissionPending, setSubmissionPending] = useState(false);
  const submitMessageOnce = useCallback<SubmitMessageFn>(async (override, options) => {
    if (invitePrompt) {
      return false;
    }

    const allowWhileBusy = options?.allowWhileBusy ?? false;
    const requestedIntent = options?.intent ?? "send";
    const baseSubmitMetadata = override?.metadata ?? options?.metadata ?? null;
    const {
      agentSelection,
      browserLaunchMode,
      browserPageTarget,
      dispatchedMessage,
      messageRequiresAi,
      messageRequiresRuntime,
      messageToSend,
      shouldApplyBrowserPageTarget,
      shouldApplyNewBrowserLaunch,
      shouldConsumeNewBrowserLaunch,
      terminalRequest,
      trimmed,
    } = buildChatSubmitPlan({
      activeConversationMessages,
      browserTargetingEnabled: !personalBrowserActive,
      browserSessionOpen,
      hasHiddenBrowserSession,
      imageAttachmentCount: imageFiles.length,
      inputValue,
      override,
      pendingBrowserLaunchMode,
      preferredBrowserPage,
      resolvePromptAgentTargets,
      softPrefillSuggestion,
    });
    if (!messageToSend) {
      if (imageFiles.length > 0) {
        showStatus("Add a message to send with your image attachments.", "error", 4000);
      }
      focusInput();
      return false;
    }

    const participationPreflight = await resolveGroupParticipationBeforeSubmit({
      conversationId: activeConversationId,
      displayPrompt: messageToSend,
      dispatchPrompt: dispatchedMessage,
      metadata: baseSubmitMetadata,
      agentSelection,
      hasTerminalCommand: Boolean(terminalRequest),
      hasBrowserTask:
        personalBrowserActive ||
        sharedBrowserActive ||
        shouldApplyBrowserPageTarget ||
        shouldApplyNewBrowserLaunch,
      humanPeerContext,
    });
    const participationRecordOnly = participationPreflight.mode === "record_only";
    const participationControllerDeferred =
      participationPreflight.mode === "controller_deferred";
    const participationControllerCoverage =
      participationPreflight.mode === "controller_coverage";
    const participationNeutralizesLocalPreflight =
      participationRecordOnly ||
      participationControllerDeferred ||
      participationControllerCoverage;
    const participationBypassesBusySerialization =
      participationRecordOnly || participationControllerCoverage;
    const effectiveMessageRequiresAi = participationNeutralizesLocalPreflight
      ? false
      : messageRequiresAi;
    const effectiveMessageRequiresRuntime = participationNeutralizesLocalPreflight
      ? false
      : messageRequiresRuntime;
    const effectiveTargetAgentHandles = participationRecordOnly
      ? []
      : agentSelection.targetHandles;
    const resolvedBaseSubmitMetadata = participationPreflight.metadata;

    const queuedRuntimeOverride = override?.runtimeOverride?.runtimeId
      ? override.runtimeOverride
      : null;
    const personalBrowserRouting = resolvePersonalBrowserSubmitRouting({
      active: !queuedRuntimeOverride && personalBrowserActive,
      messageRequiresAi: effectiveMessageRequiresAi,
      runtimeOverride: personalBrowserRuntimeOverride,
      terminalRequest,
    });
    const sharedBrowserRouting = resolveSharedBrowserSubmitRouting({
      active: !queuedRuntimeOverride && sharedBrowserActive,
      messageRequiresAi: effectiveMessageRequiresAi,
      resolvedRuntimeId: sharedBrowserRuntimeId,
      terminalRequest,
    });
    const usePersonalBrowserRuntime = personalBrowserRouting.kind === "personal";
    const useSharedBrowserRuntime = sharedBrowserRouting.kind === "shared";
    if (personalBrowserRouting.kind === "blocked") {
      showStatus(
        personalBrowserAgentError ??
          "Personal Browser agent control is still starting. Resume it before sending this browser task.",
        "warning",
        5000,
      );
      return false;
    }
    if (sharedBrowserRouting.kind === "blocked") {
      showStatus(
        "Shared Browser agent control is still connecting. Wait for the browser to be ready before sending this task.",
        "warning",
        5000,
      );
      return false;
    }
    const submitRuntimeOverride =
      queuedRuntimeOverride ??
      personalBrowserRouting.runtimeOverride ??
      sharedBrowserRouting.runtimeOverride;
    const submitMetadata = usePersonalBrowserRuntime
      ? withPersonalBrowserRuntimeExpectations({
          ...(resolvedBaseSubmitMetadata ?? {}),
          browserTransport: "desktop-personal",
        })
      : useSharedBrowserRuntime && submitRuntimeOverride?.runtimeId
        ? buildSharedBrowserSubmitMetadata({
            baseMetadata: resolvedBaseSubmitMetadata,
            browserPageTarget:
              browserLaunchMode === "new_page" ? null : browserPageTarget,
            runtimeId: submitRuntimeOverride.runtimeId,
          })
      : resolvedBaseSubmitMetadata;
    const queuedSubmitMetadata = {
      ...(submitMetadata ?? {}),
      agentSelection: {
        active: effectiveTargetAgentHandles,
        mentions:
          agentSelection.mentionedHandles.length > 0
            ? effectiveTargetAgentHandles
            : [],
      },
    };
    const consumeBrowserComposerTarget = () => {
      if (shouldConsumeNewBrowserLaunch) {
        clearPendingBrowserLaunchMode();
      }
    };
    const effectiveIntent =
      requestedIntent === "steer" &&
      (participationRecordOnly || effectiveTargetAgentHandles.length === 0)
        ? "send"
        : requestedIntent;

    if (effectiveIntent === "queue" || effectiveIntent === "steer") {
      if (imageFiles.length > 0) {
        showStatus(
          effectiveIntent === "steer"
            ? "Steer currently supports text only. Remove image attachments first."
            : "Queue currently supports text only. Remove image attachments first.",
          "info",
          4500,
        );
        focusInput();
        return false;
      }
      if (!activeConversationEntry?.controllerId) {
        showStatus(
          "Send the first message normally before using Queue or Steer.",
          "info",
          4500,
        );
        focusInput();
        return false;
      }
      const accepted = await submitSendIntent({
        mode: effectiveIntent,
        request: buildServerSendQueuePromptBody({
          message: dispatchedMessage,
          targetAgentHandles: effectiveTargetAgentHandles,
          metadata: queuedSubmitMetadata,
          runtimeOverride: submitRuntimeOverride,
          intent: terminalRequest ? "terminal_command" : null,
        }),
        targetAgentHandles: effectiveTargetAgentHandles,
        expectedActiveJobId: options?.expectedActiveJobId ?? null,
      });
      if (!accepted) {
        return false;
      }
      consumeBrowserComposerTarget();
      if (activeConversationId) {
        if (effectiveIntent === "queue") {
          clearComposerAfterQueue(activeConversationId, messageToSend);
        } else {
          clearComposerIfUnchanged(activeConversationId, messageToSend);
        }
      }
      pendingTypingBroadcastRef.current = null;
      if (localTypingStateRef.current.isTyping) {
        localTypingStateRef.current.isTyping = false;
        localTypingStateRef.current.lastSentAt = Date.now();
        broadcastTyping(false, activeConversationEntry.controllerId);
      }
      focusInput();
      return true;
    }
    if (
      usePersonalBrowserRuntime &&
      !allowWhileBusy &&
      (isAssistantTyping || sendingAttachment) &&
      (sendingAttachment || targetsOverlapActiveRuns(agentSelection.targetHandles))
    ) {
      showStatus(
        "Wait for the current reply before sending a Personal Browser task. Personal Browser tasks are not queued yet.",
        "info",
        5000,
      );
      return false;
    }
    if (
      (usePersonalBrowserRuntime || useSharedBrowserRuntime) &&
      activeProjectId &&
      submitRuntimeOverride?.runtimeId
    ) {
      const snapshot = await fetchRuntimeStatus({
        projectId: activeProjectId,
        quietOnAbort: true,
      }).catch(() => null);
      const browserRuntimeEntry = snapshot?.runtimes.find(
        (item) => item.runtimeId === submitRuntimeOverride.runtimeId,
      );
      if (!runtimeEntryIsDispatchable(browserRuntimeEntry)) {
        showStatus(
          usePersonalBrowserRuntime
            ? "Personal Browser is still available for manual browsing, but its agent is unavailable. Resume agent control before sending this task."
            : "Shared Browser is visible, but its agent runtime is unavailable. Reconnect the browser before sending this task.",
          "warning",
          5500,
        );
        return false;
      }
    }

    const pinToBottom = () => {
      shouldAutoScrollRef.current = true;
      scrollToBottom();
    };

    const queueCurrentMessage = (editorState: string | null) => {
      enqueueChatSendQueueItem({
        message: messageToSend,
        editorState,
        targetAgentHandles: effectiveTargetAgentHandles,
        browserPageTarget: shouldApplyBrowserPageTarget ? browserPageTarget : null,
        browserLaunchMode: shouldApplyNewBrowserLaunch ? browserLaunchMode : null,
        metadata: queuedSubmitMetadata,
        runtimeOverride: submitRuntimeOverride,
      });
    };

    const queueMessageToServer = async (): Promise<boolean> => {
      return await enqueueServerSendQueueItem({
        message: dispatchedMessage,
        targetAgentHandles: effectiveTargetAgentHandles,
        metadata: queuedSubmitMetadata,
        runtimeOverride: submitRuntimeOverride,
        intent: terminalRequest ? "terminal_command" : null,
      });
    };

    const resolveRuntimeAvailable = async () => {
      if (submitRuntimeOverride?.runtimeId) {
        return true;
      }
      let runtimeAvailable = runtimeReady;
      if (
        effectiveMessageRequiresRuntime &&
        runtimeControllerEnabled &&
        activeProjectId &&
        runtimeReady
      ) {
        const snapshot = await fetchRuntimeStatus({
          projectId: activeProjectId,
          quietOnAbort: true,
        }).catch(() => null);
        if (snapshot) {
          const targetRuntimeId = effectiveRuntimeId ?? preferredRuntimeId ?? null;
          if (targetRuntimeId) {
            const entry = snapshot.runtimes.find((item) => item.runtimeId === targetRuntimeId) ?? null;
            runtimeAvailable = runtimeEntryIsReady(entry);
          } else {
            runtimeAvailable = snapshot.runtimes.some((item) => runtimeEntryIsReady(item));
          }
        }
      }
      return runtimeAvailable;
    };

    const preflight = await runChatSubmitPreflight({
      activeConversationControllerId: activeConversationEntry?.controllerId ?? null,
      activeConversationId,
      activeConversationVisibility: activeConversationEntry?.visibility ?? null,
      activeOrgId,
      activeProjectId,
      allowWhileBusy: allowWhileBusy || participationBypassesBusySerialization,
      appendMessages,
      attachedImageCount: imageFiles.length,
      // Clearing is conditional on the composer still holding the text that was
      // queued — the same match performSubmit and the steer path make. Passing
      // the live composer value instead would always match itself and so wipe
      // whatever the user had typed when the queued message came from somewhere
      // else (a programmatic send like the conversational-undo request, whose
      // text never came from the composer).
      clearQueuedComposerDraft: () => {
        if (activeConversationId) {
          clearComposerAfterQueue(activeConversationId, messageToSend);
        }
      },
      clearSubmittedComposerDraft: () => {
        if (!override && activeConversationId) {
          clearComposerIfUnchanged(activeConversationId, messageToSend);
        }
      },
      consumeBrowserComposerTarget,
      createConversationId: () => createConversation().localId,
      createOrgInvitation,
      credentialsReady,
      currentUserId,
      focusInput,
      handleOutOfCredits: () => {
        if (!(effectiveMessageRequiresAi && outOfCredits)) {
          return false;
        }
        logAppWarn("Blocked assistant send because credits are exhausted.");
        if (revealAiGatesForCurrentDraft()) {
          openPanelTab("credits", { activate: true });
        }
        return true;
      },
      inputEditorState,
      isAssistantTyping,
      messageRequiresAi: effectiveMessageRequiresAi,
      messageRequiresRuntime: effectiveMessageRequiresRuntime,
      messageToSend,
      onMaybeAutoTitleConversation,
      onPreparedEmailInvite,
      onRecordMessage,
      override,
      pinToBottom,
      queueCurrentMessage,
      queueMessageToServer,
      recoverRuntime: requestRuntimeRecovery,
      resolveRuntimeAvailable,
      runtimeControllerEnabled,
      sendingAttachment: participationBypassesBusySerialization ? false : sendingAttachment,
      showCredentialsGate,
      showStatus,
      targetAgentHandles: effectiveTargetAgentHandles,
      targetsOverlapActiveRuns,
      trimmed,
    });
    if (preflight.status === "handled") {
      return preflight.submitted;
    }

    const { editorState } = preflight;
    const controllerId = activeConversationEntry?.controllerId ?? null;
    pendingTypingBroadcastRef.current = null;

    if (localTypingStateRef.current.isTyping) {
      localTypingStateRef.current.isTyping = false;
      localTypingStateRef.current.lastSentAt = Date.now();
      broadcastTyping(false, controllerId);
    }

    const submitImageFiles = override ? [] : imageFiles;
    const invitePromptRequest = await resolvePrivateConversationInvitePrompt({
      activeConversationId,
      browserLaunchMode: shouldApplyNewBrowserLaunch ? browserLaunchMode : null,
      browserPageTarget: shouldApplyBrowserPageTarget ? browserPageTarget : null,
      controllerId,
      editorState,
      imageFiles: submitImageFiles,
      isPrivateConversation: activeConversationEntry?.visibility === "private",
      listConversationParticipants: listConversationParticipants,
      message: messageToSend,
      expectedLaneIdle: !allowWhileBusy && !participationBypassesBusySerialization,
    });
    if (invitePromptRequest) {
      if (usePersonalBrowserRuntime) {
        showStatus(
          "Personal Browser tasks cannot wait for participant confirmation. Finish the invitation first, then send the browser task again.",
          "warning",
          5500,
        );
        return false;
      }
      openInvitePrompt(invitePromptRequest);
      consumeBrowserComposerTarget();
      return false;
    }

    await performSubmit({
      message: dispatchedMessage,
      composerMessage: messageToSend,
      editorState,
      imageFiles: submitImageFiles,
      metadata: submitMetadata,
      runtimeOverride: submitRuntimeOverride,
      expectedLaneIdle: !allowWhileBusy && !participationBypassesBusySerialization,
    });
    consumeBrowserComposerTarget();
    return true;
  }, [
    activeConversationEntry?.controllerId,
    activeConversationEntry?.visibility,
    activeConversationId,
    activeConversationMessages,
    activeOrgId,
    activeProjectId,
    appendMessages,
    broadcastTyping,
    browserSessionOpen,
    clearComposerAfterQueue,
    clearComposerIfUnchanged,
    clearPendingBrowserLaunchMode,
    createConversation,
    createOrgInvitation,
    credentialsReady,
    currentUserId,
    effectiveRuntimeId,
    enqueueChatSendQueueItem,
    enqueueServerSendQueueItem,
    fetchRuntimeStatus,
    focusInput,
    hasHiddenBrowserSession,
    humanPeerContext,
    imageFiles,
    isAssistantTyping,
    inputEditorState,
    inputValue,
    invitePrompt,
    listConversationParticipants,
    localTypingStateRef,
    onMaybeAutoTitleConversation,
    onPreparedEmailInvite,
    onRecordMessage,
    openInvitePrompt,
    openPanelTab,
    outOfCredits,
    pendingBrowserLaunchMode,
    pendingTypingBroadcastRef,
    performSubmit,
    personalBrowserActive,
    personalBrowserAgentError,
    personalBrowserRuntimeOverride,
    preferredBrowserPage,
    preferredRuntimeId,
    revealAiGatesForCurrentDraft,
    requestRuntimeRecovery,
    resolveGroupParticipationBeforeSubmit,
    resolvePromptAgentTargets,
    runtimeControllerEnabled,
    runtimeReady,
    scrollToBottom,
    sendingAttachment,
    sharedBrowserActive,
    sharedBrowserRuntimeId,
    showCredentialsGate,
    showStatus,
    shouldAutoScrollRef,
    softPrefillSuggestion,
    submitSendIntent,
    targetsOverlapActiveRuns,
  ]);

  const submitMessage = useCallback<SubmitMessageFn>(async (override, options) => {
    if (submitMessageInFlightRef.current) {
      return false;
    }
    submitMessageInFlightRef.current = true;
    setSubmissionPending(true);
    try {
      return await submitMessageOnce(override, options);
    } finally {
      submitMessageInFlightRef.current = false;
      setSubmissionPending(false);
    }
  }, [submitMessageOnce]);

  const handleCancelActiveTerminalCommand = useCallback(async () => {
    if (!activeConversationId) {
      showStatus("Open a conversation before cancelling terminal commands.", "info", 3500);
      return;
    }

    const controllerId = activeConversationEntry?.controllerId ?? null;
    if (!controllerId) {
      showStatus("Run is still initializing. Try cancelling again in a moment.", "info", 3500);
      return;
    }

    try {
      const canceledRunIds =
        (await interruptConversationRuns({
          conversationId: controllerId,
          reason: "Terminal command cancelled by user",
          accessToken: null,
        })) ?? [];

      if (canceledRunIds.length > 0) {
        showStatus("Terminal command cancelled.", "info", 2500);
        return;
      }

      showStatus("No active run was available to cancel.", "info", 3500);
    } catch (error) {
      console.warn("[chat] failed to interrupt active run", error);
      showStatus("Unable to cancel terminal command right now.", "error", 4500);
    }
  }, [
    activeConversationEntry?.controllerId,
    activeConversationId,
    interruptConversationRuns,
    showStatus,
  ]);

  return {
    handleCancelActiveTerminalCommand,
    submissionPending,
    submitMessage,
  };
}
