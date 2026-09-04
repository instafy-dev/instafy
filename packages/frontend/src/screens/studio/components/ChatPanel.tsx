import {
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type JSX,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Capacitor } from "@capacitor/core";
import { Button } from "../../../components/Button";
import { OctoScrollMotionScope } from "../../../components/OctoMark";
import { Spinner } from "../../../components/Spinner";
import { useBreakpoint } from "../../../hooks/useBreakpoint";
import {
  addFloatingSurfaceViewportChangeListener,
  clampFloatingSurfacePositionToStudioViewport,
} from "../../../utils/floatingSurfacePosition";
import { ChatGettingStartedCard } from "./ChatGettingStartedCard";
import { type ChatInputHandle } from "./chat-input/ChatInput";
import { formatConversationTranscript, resolveCopyableMessageContent } from "./chatTranscriptCopy";
import {
  resolveChatInputCanRunAmbientParticipationPreflight,
  resolveChatInputHasBrowserTask,
  resolveChatInputRequiresAi,
} from "./chatInputAiIntent";
import { resolveGettingStartedAiChoices } from "./gettingStartedAiChoices";
import { resolveComposerEnterAction } from "./chat-input/enterBehavior";
import {
  useConversation,
  type SubmitConversationRuntimeOverride,
} from "../../../conversations/useConversation";
import {
  resolvePromptAgentSelection,
} from "../../../conversations/assistantMentions";
import { parseInviteCommandRequest } from "../../../conversations/inviteCommand";
import { resolveGroupParticipationReplyTargets } from "../../../conversations/groupParticipation";
import { getChatClientSessionId } from "../../../conversations/chatClientIdentity";
import { generateUUID } from "../../../utils/uuid";
import { useConversations } from "../../../conversations/ConversationsProvider";
import { useConversationParticipants } from "../../../conversations/useConversationParticipants";
import {
  buildConversationGoalHealth,
  buildGoalUnblockHelpPrompt,
  isNonRecoverableRunErrorMessage,
  normalizeConversationGoalProgressSummaryForDisplay,
} from "../../../conversations/conversationGoals";
import { resolveRunFailureRetryPrompt } from "../../../conversations/runFailurePresentation";
import { isRunActivelyProgressing } from "../../../conversations/runLiveness";
import { useRuntimeMenuOptions, type RuntimeMenuOption } from "../../../runtime/useRuntimeMenu";
import {
  shouldPinChatMessagesToBottom,
  shouldShowBrowserSessionPageStripInComposer,
  shouldUseCompactBrowserChrome,
} from "./browserSessionLayout";
import {
  resolveStaleStartingRecoveryKey,
  STALE_STARTING_RECOVERY_DELAY_MS,
} from "./staleStartingRecovery";
import type {
  ChatMessage,
} from "../types";
import type { RunRecord } from "../../../types";
import { useProject } from "../../../projects/useProject";
import { canOpenProjectDeviceHandoff } from "../../../projects/projectCapabilities";
import type { PreparedEmailInvite } from "../../../sharing/preparedEmailInvite";
import { useProjects } from "../../../projects/useProjects";
import { useProjectMembers } from "../../../projects/useProjectMembers";
import { useCredits } from "../../../credits/useCredits";
import { useStatus } from "../../../status/useStatus";
import { writeClipboardText } from "../../../runtime/runtimeMenuShared";
import {
  getBuiltInAssistantDisplayName,
  getDefaultAssistantHandle,
  listBuiltInAssistantMentionTokens,
} from "../../../assistants/localBuiltInAssistantCatalog";
import {
  type ControllerProjectMember,
  controllerClient,
} from "../../../sdk/instafy";
import { useAuth } from "../../../providers/AuthProvider";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { useWorkspaceUi } from "../../../workspace/useWorkspace";
import { useWorkspaceControls } from "../workspaceControls";
import { hasSupabaseConfig, supabase } from "../../../lib/supabaseClient";
import {
  enableMessageNotifications,
  markBrowserNotificationsNudgeSeen,
  shouldOfferBrowserNotificationsNudge,
} from "../../../notifications/assistantMessageNotifications";
import { recordGenuineAssistantResponseAndMaybeOfferNativeNotifications } from "../../../notifications/nativeNotificationsNudge";
import {
  createNotificationNudgeConversationObservation,
  observeNotificationNudgeAssistantResponses,
  type NotificationNudgeConversationObservation,
} from "../../../notifications/notificationNudgeEligibility";
import {
  buildSharedLocationDispatchInput,
  buildSharedLocationVisibleMessage,
  requestCurrentLocation,
  type LocationSharePrecision,
} from "../../../location/requestCurrentLocation";
import { setPendingAgentProfileTarget } from "./agentProfileDeepLink";
import { ChatBubbleRow } from "./ChatBubbleRow";
import {
  CHAT_SPEAKER_MARKER_SELECTOR,
  isAssistantSpeakerMarker,
  isHumanSpeakerMarker,
  readStickyChatSpeakerMarker,
  type StickyChatSpeaker,
} from "./chatSpeakerMarker";
import { ChatColumn } from "./ChatColumn";
import { useOctoSilenceHint } from "./useOctoSilenceHint";
import { ChatTypingRows } from "./ChatTypingRows";
import {
  AssistantMessageEntry,
  extractImageAttachments,
  UserMessageBubble,
  ChatRuntimeActivityContext,
} from "./ChatMessageEntries";
import { RunFailureRetryProvider, type RunFailureRetryContextValue } from "./RunFailureNotice";
import { useRunFailureAutoRetry } from "./useRunFailureAutoRetry";
import {
  buildTimedSyntheticChatRows,
  ChatPostTranscriptAuxiliaryRows,
} from "./ChatSystemRows";
import {
  ChatImageLightboxOverlay,
  ChatInvitePromptOverlay,
  ChatMessageMenuOverlay,
} from "./ChatPanelOverlays";
import { ConversationMessageRows } from "./ConversationMessageRows";
import { buildHumanLabelByUserId } from "./chatHumanLabels";
import {
  createChatSendQueueKey,
  readChatSendQueue,
  type EditingQueuedChatItem,
  type QueuedChatSendItem,
  writeChatSendQueue,
} from "./chatSendQueueStorage";
import {
  shouldAssistantMessagesShareVisualGroup,
} from "./assistantMessageGrouping";
import {
  isCompactionStatusText,
  normalizeAssistantStatusText,
} from "./assistantStatusHeuristics";
import {
  readWorkspaceFileStaleNotice,
  type WorkspaceFileStaleNotice,
  writeWorkspaceFileStaleNotice,
} from "./workspaceFileStaleNoticeStore";
import { buildParentConversationThreadMessage } from "./conversationThreadMessages";
import {
  collectReferencedThreadTargets,
  shouldHideStandaloneConversationThreadPreview,
} from "./agentThreadBranchRows";
import {
  COMPOSER_INLINE_COMPLETION_DEBOUNCE_MS,
  buildComposerInlineCompletionPath,
  buildComposerInlineSuggestion,
  shouldRequestComposerInlineCompletion,
} from "./composerInlineCompletion";
import { shouldSuppressOuterAvatarForConversationThread } from "./conversationThreadPreviewLayout";
import { resolveComposerGhostSuggestion } from "./composerGhostSuggestion";
import { useChatBrowserSessionState } from "./useChatBrowserSessionState";
import { useChatComposerBrowserTargeting } from "./useChatComposerBrowserTargeting";
import { useChatCredentialGate } from "./useChatCredentialGate";
import { useAmbientCredentialGatePresentation } from "./useAmbientCredentialGatePresentation";
import { canUseDesktopCodexAuthJson } from "./desktopCodexAuthJson";
import { CredentialsConnectModal } from "./CredentialsConnectModal";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { AgentProfileCardContent } from "./AssistantAvatarPopover";
import {
  OPEN_AGENT_PROFILE_EVENT,
  type OpenAgentProfileDetail,
} from "./agentProfileOpen";
import { emitAiConfigChanged } from "./aiConfigEvents";
import { formatProxyUpstreamErrorSummary } from "./proxyError";
import { useCredentialsConnectFlow } from "./useCredentialsConnectFlow";
import { useChatAgentRoster } from "./useChatAgentRoster";
import { useChatConversationInviteState } from "./useChatConversationInviteState";
import { useChatOrgMembers } from "./useChatOrgMembers";
import { useChatGithubImportFlow } from "./useChatGithubImportFlow";
import {
  coerceThreadMessages,
  resolveThreadRunStatusFromMessages,
} from "./threadPreviewHelpers";
import { getMessageType } from "./chatMessageMetadata";
import {
  type AssistantAgentIdentity,
  type AssistantAvatarMotion,
  type AssistantTypingAgent,
  extractAgentIdentityFromMetadata,
  extractRunIdFromMetadata,
  resolvePreviousAssistantHandle,
  shouldShowAssistantAvatarForMessage,
  shouldShowAssistantIdentityForMessage,
} from "./chatAssistantIdentity";
import { useStudioNavigationPosture } from "../useStudioNavigationPosture";
import {
  toBrowserSessionPageTarget,
  type BrowserSessionPageTarget,
} from "./browserSessionPages";
import { truncate } from "./chatContentHelpers";
import { resolveChatComposerAffordances } from "./chatComposerAffordances";
import { useChatInvitePromptHandlers } from "./useChatInvitePromptHandlers";
import { useChatComposerAttachments } from "./useChatComposerAttachments";
import { useChatSendQueueActions } from "./useChatSendQueueActions";
import { useChatSendQueuePresentation } from "./useChatSendQueuePresentation";
import {
  isServerQueuedChatSendItem,
  useChatServerSendQueue,
} from "./useChatServerSendQueue";
import { useChatMessageStashes } from "./useChatMessageStashes";
import { useChatSubmitDispatch } from "./useChatSubmitDispatch";
import { useChatSubmitFlow, type SubmitMessageFn } from "./useChatSubmitFlow";
import { useChatVoiceComposerController } from "./useChatVoiceComposerController";
import { useChatGettingStartedState } from "./useChatGettingStartedState";
import {
  resolveConversationHumanPeerContext,
  resolveGettingStartedConversationContext,
} from "./gettingStartedConversationContext";
import {
  resolveConversationRosterHumans,
  type ConversationRosterAgent,
} from "./conversationRosterMembers";
import { ConversationRoster } from "./ConversationRoster";
import {
  clearChatParticipants,
  publishChatParticipants,
  type ParticipantAgent,
  type ParticipantCredentialState,
  type ParticipantEditingContext,
  type ParticipantRuntimeInfo,
} from "./chatParticipantsStore";
import { updateMyAgent } from "../../../services/runtimeController/agents";
import { formatProviderLabel } from "./CreditsUsageRates";
import { parseSubscriptionUsage } from "./subscriptionUsageFormat";
import { resolveCredentialLabel } from "../../../utils/credentialFormatting";
import {
  modelOptionsForProvider,
  normalizeAiModelId,
  normalizeAiProviderId,
  type AiProviderId,
} from "../../../utils/aiProviderModels";
import { useChatComposerLayoutState } from "./useChatComposerLayoutState";
import { useChatAutoScrollSync, useChatScrollController } from "./useChatScrollOrchestration";
import {
  buildMessageSelectionReplyContext,
  formatSelectionReplyComposerText,
  getCurrentMessageSelection,
  getCurrentSelectedTextForMessage,
  shouldAttachPendingReplyContext,
  shouldStageSelectionReplyDraft,
  type MessageSelectionReplyAction,
  type MessageSelectionReplyContext,
} from "./messageSelectionReply";
import {
  createMessageUndoRequestHandler,
  REQUEST_MESSAGE_UNDO_EVENT,
} from "./messageUndoRequest";
import {
  collapseLifecycleMessages,
  extractAgentJobId,
  runMatchesThreadJobId,
  shouldDisplayChatMessage,
  shouldDisplayJobThreadMessage,
  synthesizeAgentJobThreadMessages,
} from "./chatMessagePresentation";
import { resolveAgentWaitingActivityCopy } from "./runtimeAlertPresentation";
import {
  formatPromptContextModeLabel,
  isCurrentUserChatMessage,
  resolveBrowserSessionAutoOpenCandidate,
  resolveComposerUiSuggestedReplies,
  resolveTokenUsageForMessage,
} from "./chatMessageDetailHelpers";
import {
  HumanSpeakerIdentityLabel,
  resolveHumanChatIdentity,
} from "./chatHumanIdentity";
import { ChatComposerSurface } from "./ChatComposerSurface";
import type { ControllerMessageStash } from "../../../services/runtimeController/messageStashes";
import {
  createConversationClientSendId,
  createConversationSendIntentAttemptKey,
  sendConversationIntent,
} from "../../../services/runtimeController/sendIntents";
import { ControllerApiError } from "../../../services/runtimeController/core";
import { normalizeChatMessageStashEnvelope } from "./chatMessageStashEnvelope";
import {
  requireExpectedJobForSteer,
  resolveComposerPrimaryActionMode,
  resolveExpectedSteerJobId,
  resolveSteerableComposerRuns,
} from "./composerSendMode";
import {
  resolveMessageStashRestoreBlock,
  shouldDeleteRestoredMessageStashAfterAction,
} from "./messageStashLifecycle";
import { BrowserSessionModal } from "./BrowserSessionModal";
import type { SharedBrowserChromeProps } from "./SharedBrowserChrome";
import { resolveSharedBrowserViewerKind } from "./sharedBrowserViewer";
import { ChatBrowserSubtabs, type ChatBrowserSubtab } from "./ChatBrowserSubtabs";
import {
  BrowserTransportSelector,
  PersonalBrowserSurface,
} from "./PersonalBrowserSurface";
import {
  resolveDefaultBrowserTransport,
  type BrowserTransport,
  usePersonalBrowserBridge,
} from "./usePersonalBrowserBridge";
import {
  readBrowserTransportPreference,
  writeBrowserTransportPreference,
} from "./browserTransportPreference";
import { ChatSpeakerStickyOverlay, ChatTranscriptViewport } from "./ChatTranscriptViewport";
import { resolveSharedBrowserControlOwner } from "./sharedBrowserControlOwner";
import { useSharedBrowserApprovalTransport } from "./useSharedBrowserApprovalTransport";

const { enabled: runtimeControllerEnabled } = controllerClient.core;
const {
  addParticipant: addControllerConversationParticipant,
  interruptRuns: interruptControllerConversationRuns,
  listParticipants: listControllerConversationParticipants,
} = controllerClient.conversations;
const { createInvitationStrict: createControllerOrgInvitationStrict } =
  controllerClient.organizations;
const { fetchStatus: fetchRuntimeStatus } = controllerClient.runtimes;
const { requestProjectEditorInline: requestProjectEditorInlineCompletion } = controllerClient.completions;
const { write: writeWorkspaceFileToController } = controllerClient.workspace.files;

const AI_CONNECT_WIZARD_STORAGE_PREFIX = "instafy.chat.aiConnectWizard.v1";
const DEFAULT_CHAT_INPUT_PLACEHOLDER = "Ask for something…";
const MAX_AUTO_REVEAL_HISTORY_FETCHES = 3;
const ADAPTIVE_SHARED_BROWSER_WIDTH_PX = 640;
const ASSISTANT_AVATAR_GUTTER_PLACEHOLDER = (
  <span aria-hidden="true" className="h-8 w-8 shrink-0 pointer-events-none" />
);

type ChatPanelJobThread = {
  conversationId: string;
  jobId: string;
};

function formatCredentialConnectionFailure(raw: string | null | undefined): string | null {
  const normalized = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!normalized) {
    return null;
  }

  const proxySummary = formatProxyUpstreamErrorSummary(normalized);
  if (proxySummary) {
    return proxySummary;
  }

  const lowered = normalized.toLowerCase();
  if (
    lowered.includes("cloudcode-pa.googleapis.com/") &&
    (lowered.includes("404") || lowered.includes("requested url <code>/</code>"))
  ) {
    return "Gemini endpoint returned 404. Update and restart the backend stack, then retry.";
  }
  if (
    lowered.includes("access_token_scope_insufficient") ||
    lowered.includes("insufficient authentication scopes")
  ) {
    return "This Gemini connection used Google login, which is no longer supported. Replace it with a Gemini API key.";
  }
  if (
    lowered.includes("service_disabled") ||
    lowered.includes("accessnotconfigured") ||
    lowered.includes("cloud code private api has not been used")
  ) {
    return "Gemini Code Assist API is not enabled for this Google project/account.";
  }
  if (lowered.includes("permission_denied") || lowered.includes("insufficientpermissions")) {
    return "Google account is connected but does not have Gemini Code Assist access.";
  }
  if (
    lowered.includes("usage_limit_reached") ||
    lowered.includes("rate limit") ||
    lowered.includes("429")
  ) {
    return "Provider rate limit reached. Try again shortly.";
  }

  const withoutHtml = normalized.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const compact = withoutHtml || normalized;
  const maxChars = 220;
  return compact.length <= maxChars
    ? compact
    : `${compact.slice(0, maxChars - 1).trimEnd()}…`;
}

const NARROW_SPEAKER_INLINE_SELECTOR = '[data-chat-speaker-inline="true"]';
// The scroll container's own top padding (`pt-2`) — where its content
// actually starts painting. The pill now lives in the roster row above the
// transcript rather than overlapping it, so this edge (not the pill's own
// position) is the only stable line left to compare marker positions against.
const CHAT_TRANSCRIPT_VISIBLE_TOP_INSET_PX = 8;

function speakersEqual(left: StickyChatSpeaker | null, right: StickyChatSpeaker | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  if (left.kind === "assistant") {
    return (
      right.kind === "assistant" &&
      left.handle === right.handle &&
      left.avatarSeed === right.avatarSeed
    );
  }
  return (
    right.kind === "human" &&
    left.label === right.label &&
    left.avatarSeed === right.avatarSeed
  );
}

function hasVisibleConversationAnchor(messages: ChatMessage[]): boolean {
  return messages.some((message) => {
    if (message.role === "user") {
      return true;
    }
    const messageType = (getMessageType(message) ?? "").trim().toLowerCase();
    if (messageType === "agent_job_thread") {
      return false;
    }
    return message.content.trim().length > 0;
  });
}

export function ChatPanel({ jobThread }: { jobThread?: ChatPanelJobThread | null } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const runtimeMenu = useRuntimeMenuOptions();
  const rootRef = useRef<HTMLDivElement>(null);
  const {
    runtime: runtimeContext,
    currentRuntime,
    runtimeOptionsById
  } = runtimeMenu;
  const {
    preferredRuntimeId,
    effectiveRuntimeId,
    runtimeReady,
    refreshRuntimeStatuses,
    setSessionRuntimeOverride,
    waitingForPreferredRuntime,
    ensureDesktopRuntime,
    ensureHostedRuntime,
    hostedRuntimeEnsuring,
    runtimeEnsureError,
    runtimeEnsureLimit,
    runs,
  } = runtimeContext;
  const {
    projectKey: conversationsProjectKey,
    remoteConversationHistoryResolved = true,
    conversations,
    appendMessages,
    createConversation,
    setConversationDraft,
  } = useConversations();
  const {
    activeConversationId,
    messages,
    inputValue,
    inputEditorState,
    assistantEnabled,
    extraAgentHandles,
    agentHandles,
    onAssistantEnabledChange,
    onRemoveAgentHandle,
    isAssistantTyping,
    hasMoreHistory,
    isHistoryLoading,
    isInitialHistoryLoading,
    loadOlderMessages,
    onInputChange,
    onRecordMessage,
    onMaybeAutoTitleConversation,
    onResolveGroupParticipationBeforeSubmit,
    onSubmit,
    stickyMentionedAgentByConversationRef,
  } = useConversation();
  const latestInputValueRef = useRef(inputValue);
  const pendingReplyContextRef = useRef<MessageSelectionReplyContext | null>(null);
  const recentMessageSelectionRef = useRef<{
    messageId: string;
    selectedText: string;
    capturedAt: number;
  } | null>(null);
  const [composerInlineCompletion, setComposerInlineCompletion] = useState<string | null>(null);
  useLayoutEffect(() => {
    latestInputValueRef.current = inputValue;
  }, [inputValue]);
  const latestInputEditorStateRef = useRef<string | null>(inputEditorState);
  useEffect(() => {
    latestInputEditorStateRef.current = inputEditorState;
  }, [inputEditorState]);
  useEffect(() => {
    if (typeof document === "undefined") {
      return undefined;
    }
    const handleSelectionChange = () => {
      const selection = getCurrentMessageSelection();
      if (!selection) {
        return;
      }
      recentMessageSelectionRef.current = {
        ...selection,
        capturedAt: Date.now(),
      };
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, []);
  const { showStatus } = useStatus();
  const {
    activeProjectId,
    projectCapabilitiesResolved,
    effectiveProjectRole,
    canWriteProject,
    canShareProject: serverCanShareProject,
  } = useProject();
  const projectWriteDisabled =
    projectCapabilitiesResolved === false ||
    (projectCapabilitiesResolved === true && canWriteProject === false);
  const projectReadOnly =
    projectCapabilitiesResolved === true &&
    (effectiveProjectRole === "viewer" || canWriteProject === false);
  const latestProjectAccessRef = useRef({ projectReadOnly, projectWriteDisabled });
  latestProjectAccessRef.current = { projectReadOnly, projectWriteDisabled };
  // Written further down, once useChatOrgMembers has resolved this user's org
  // role. Only an org member reaches a useful Team settings -> Members list; a
  // project guest lands on the "you have access as a guest" notice there, so a
  // guest gets copy naming someone they can actually reach instead of a button
  // into a dead end.
  const latestOrgMembershipRef = useRef(false);
  const ensureProjectWriteAccess = useCallback(() => {
    const latestAccess = latestProjectAccessRef.current;
    if (!latestAccess.projectWriteDisabled) {
      return true;
    }
    if (!latestAccess.projectReadOnly) {
      showStatus("Checking your access to this space. Try again in a moment.", "warning", 3500);
      return false;
    }
    if (!latestOrgMembershipRef.current) {
      showStatus(
        "This space is read-only for your account. Ask whoever shared it with you for edit access.",
        "warning",
        3500,
      );
      return false;
    }
    showStatus(
      "This space is read-only for your account. Ask an admin for edit access.",
      "warning",
      6000,
      {
        actionLabel: "Open team settings",
        onAction: () => {
          if (typeof window === "undefined") {
            return;
          }
          // WorkspaceTabsProvider is mounted below the providers this panel runs
          // in, so route the tab open through StudioLayout the same way
          // "instafy:open-source-control" does.
          window.dispatchEvent(new CustomEvent("instafy:open-org-members"));
        },
      },
    );
    return false;
  }, [showStatus]);
  const activeConversationControllerId = useMemo(() => {
    if (!activeConversationId) {
      return null;
    }
    return conversations.find((conversation) => conversation.localId === activeConversationId)?.controllerId ?? null;
  }, [activeConversationId, conversations]);
  const {
    browserSessionOpen,
    browserSessionExpandRequestToken,
    handleBrowserRuntimeIdResolved,
    handleBrowserSessionOpenChange,
    handleHiddenBrowserSessionUnavailable,
    handleToggleBrowserSession,
    hasHiddenBrowserSession,
    openBrowserSession,
    preferredBrowserRuntimeId,
    requestBrowserSessionExpand,
    resolvedBrowserRuntimeId,
  } = useChatBrowserSessionState({
    activeConversationControllerId,
    activeConversationId,
    activeProjectId: activeProjectId ?? null,
    effectiveRuntimeId,
    preferredRuntimeId: preferredRuntimeId ?? null,
    refreshRuntimeStatuses,
    setSessionRuntimeOverride,
  });
  // Which conversation subtab is visible: chat messages or the docked browser.
  // Kept as its own state (not derived from browserSessionOpen) so switching
  // back to Chat does NOT close/unmount the browser — it keeps the live remote
  // connection mounted, avoiding a reconnect on every switch.
  const [browserSubtab, setBrowserSubtab] = useState<ChatBrowserSubtab>("chat");
  const [sharedBrowserApprovalPending, setSharedBrowserApprovalPending] = useState(false);
  const [browserTransport, setBrowserTransport] = useState<BrowserTransport>("shared");
  const [browserTransportPreferenceResolved, setBrowserTransportPreferenceResolved] =
    useState(false);
  const [sharedBrowserActivated, setSharedBrowserActivated] = useState(false);
  const sharedBrowserActivationScopeRef = useRef<string | null>(null);
  const browserTransportInitializedUserRef = useRef<string | null>(null);
  const browserPanelId = useId();
  const chatPanelId = useId();
  const browserPrevOpenRef = useRef(false);
  useLayoutEffect(() => {
    if (browserSessionOpen && !browserPrevOpenRef.current) {
      setBrowserSubtab("browser");
    } else if (!browserSessionOpen) {
      setBrowserSubtab("chat");
    }
    browserPrevOpenRef.current = browserSessionOpen;
  }, [browserSessionOpen]);
  useLayoutEffect(() => {
    if (browserSessionOpen && browserSessionExpandRequestToken > 0) {
      setBrowserSubtab("browser");
    }
  }, [browserSessionExpandRequestToken, browserSessionOpen]);
  const handleBrowserSubtabChange = useCallback(
    (tab: ChatBrowserSubtab) => {
      setBrowserSubtab(tab);
      if (tab === "browser" && !browserSessionOpen) {
        handleToggleBrowserSession();
      }
    },
    [browserSessionOpen, handleToggleBrowserSession],
  );
  const handleBackToChat = useCallback(() => {
    setBrowserSubtab("chat");
  }, []);
  const { onOpenProjectSettings, homeAttentionCount = 0 } = useWorkspaceControls();
  const activeConversationEntry = useMemo(() => {
    if (!activeConversationId) {
      return null;
    }
    return conversations.find((conversation) => conversation.localId === activeConversationId) ?? null;
  }, [activeConversationId, conversations]);
  const isAtLeastSmallViewport = useBreakpoint("sm");
  const { showComposerHomeButton, touchLikeInput } = useStudioNavigationPosture();
  const compactBrowserViewport = !isAtLeastSmallViewport;
  const [browserPanelSize, setBrowserPanelSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const updateSize = (width: number, height: number) => {
      if (width < 1 || height < 1) {
        return;
      }
      setBrowserPanelSize((current) =>
        current && current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };
    const rect = root.getBoundingClientRect();
    updateSize(Math.round(rect.width), Math.round(rect.height));
    if (typeof ResizeObserver !== "function") {
      const updateFromWindow = () => {
        const next = root.getBoundingClientRect();
        updateSize(Math.round(next.width), Math.round(next.height));
      };
      window.addEventListener("resize", updateFromWindow);
      return () => window.removeEventListener("resize", updateFromWindow);
    }
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect ?? root.getBoundingClientRect();
      updateSize(Math.round(next.width), Math.round(next.height));
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [jobThread]);
  const compactBrowserBar = shouldUseCompactBrowserChrome({
    containerWidth: browserPanelSize?.width ?? null,
    compactViewport: compactBrowserViewport,
  });
  const compactSharedBrowserViewport =
    browserPanelSize !== null
      ? browserPanelSize.width < ADAPTIVE_SHARED_BROWSER_WIDTH_PX
      : compactBrowserViewport;
  const homeAttentionBadge = homeAttentionCount > 9 ? "9+" : homeAttentionCount.toString();
  const pinChatMessagesToBottom = shouldPinChatMessagesToBottom({
    hasMoreHistory,
    smallViewport: compactBrowserViewport,
  });
  const chatSendQueueKey = useMemo(() => {
    if (!activeProjectId || !activeConversationId) {
      return null;
    }
    return createChatSendQueueKey(activeProjectId, activeConversationId);
  }, [activeConversationId, activeProjectId]);
  const [chatSendQueue, setChatSendQueue] = useState<QueuedChatSendItem[]>([]);
  const [chatSendQueueExpanded, setChatSendQueueExpanded] = useState(false);
  const [editingQueuedItem, setEditingQueuedItem] = useState<EditingQueuedChatItem | null>(null);
  const runtimeRecoveryInFlightRef = useRef<Promise<boolean> | null>(null);
  const runtimeRecoveryCooldownUntilRef = useRef(0);
  const staleStartingRecoveryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const staleStartingRecoveryKeyRef = useRef<string | null>(null);
  const staleStartingRecoveryCooldownUntilRef = useRef(0);
  const autoRevealHistoryConversationRef = useRef<string | null>(null);
  const autoRevealHistoryAttemptRef = useRef(0);
  useEffect(() => {
    if (!chatSendQueueKey) {
      setChatSendQueue([]);
      setEditingQueuedItem(null);
      setChatSendQueueExpanded(false);
      return;
    }
    setChatSendQueue(readChatSendQueue(chatSendQueueKey));
    setEditingQueuedItem(null);
    setChatSendQueueExpanded(false);
  }, [chatSendQueueKey]);
  useEffect(() => {
    if (!chatSendQueueKey) {
      return;
    }
    writeChatSendQueue(chatSendQueueKey, chatSendQueue);
  }, [chatSendQueue, chatSendQueueKey]);
  const {
    dispatchServerSendQueueEntryNow,
    enqueueServerSendQueueItem,
    refreshServerSendQueue,
    removeServerSendQueueEntry,
    reorderServerSendQueueEntry,
    serverQueueReordering,
    serverQueueHydrated,
    serverSendQueueItems,
  } = useChatServerSendQueue({
    conversationControllerId: activeConversationEntry?.controllerId ?? null,
    runtimeControllerEnabled,
  });
  const {
    createStash: createServerMessageStash,
    mutating: messageStashMutating,
    removeStash: removeServerMessageStash,
    stashes: messageStashes,
  } = useChatMessageStashes({
    conversationControllerId: activeConversationEntry?.controllerId ?? null,
    enabled: runtimeControllerEnabled,
  });
  const [restoredMessageStash, setRestoredMessageStash] =
    useState<ControllerMessageStash | null>(null);
  useEffect(() => {
    setRestoredMessageStash(null);
  }, [activeConversationEntry?.controllerId]);
  const combinedChatSendQueue = useMemo<QueuedChatSendItem[]>(
    () =>
      serverSendQueueItems.length > 0
        ? [...serverSendQueueItems, ...chatSendQueue]
        : chatSendQueue,
    [chatSendQueue, serverSendQueueItems],
  );
  const { projectList } = useProjects();
  const { billing: creditBilling, controllerEnabled: creditsControllerEnabled } = useCredits();
  const {
    members: projectMembers,
    loading: projectMembersLoading,
    error: projectMembersError,
  } = useProjectMembers(activeProjectId);
  const [projectMembersResolvedProjectId, setProjectMembersResolvedProjectId] =
    useState<string | null>(null);
  useEffect(() => {
    if (!activeProjectId) {
      setProjectMembersResolvedProjectId(null);
      return;
    }
    if (!projectMembersLoading) {
      setProjectMembersResolvedProjectId(activeProjectId);
    }
  }, [activeProjectId, projectMembersLoading]);
  const projectMemberContextLoading = Boolean(
    activeProjectId && projectMembersResolvedProjectId !== activeProjectId,
  );
  const { user } = useAuth();
  const currentUserId = user?.id ?? null;
  const {
    participants: conversationParticipants,
    loading: conversationParticipantsLoading,
    error: conversationParticipantsError,
  } = useConversationParticipants(
    activeConversationEntry?.controllerId ?? null,
    { enabled: runtimeControllerEnabled },
  );
  const personalBrowser = usePersonalBrowserBridge({
    active:
      browserSessionOpen &&
      browserSubtab === "browser" &&
      browserTransport === "personal",
    profileUserId: currentUserId,
    projectId: activeProjectId ?? null,
  });
  useEffect(() => {
    browserTransportInitializedUserRef.current = null;
    setBrowserTransportPreferenceResolved(false);
    setSharedBrowserActivated(false);
  }, [currentUserId]);
  useEffect(() => {
    if (
      !personalBrowser.checked ||
      !currentUserId ||
      !activeProjectId ||
      browserTransportInitializedUserRef.current === currentUserId
    ) {
      return;
    }
    browserTransportInitializedUserRef.current = currentUserId;
    const storedTransport = readBrowserTransportPreference(currentUserId);
    const nextTransport =
      storedTransport === "shared" ||
      (storedTransport === "personal" && personalBrowser.available)
        ? storedTransport
        : resolveDefaultBrowserTransport({
            checked: personalBrowser.checked,
            supported: personalBrowser.status?.supported ?? false,
            enabled: personalBrowser.status?.enabled ?? false,
          });
    setBrowserTransport(nextTransport);
    setBrowserTransportPreferenceResolved(true);
    setSharedBrowserActivated(browserSessionOpen && nextTransport === "shared");
  }, [
    activeProjectId,
    currentUserId,
    personalBrowser.available,
    personalBrowser.checked,
    personalBrowser.status?.enabled,
    personalBrowser.status?.supported,
    browserSessionOpen,
  ]);
  useEffect(() => {
    if (
      browserTransport === "personal" &&
      personalBrowser.checked &&
      !personalBrowser.available
    ) {
      setBrowserTransport("shared");
      setBrowserTransportPreferenceResolved(true);
      setSharedBrowserActivated(browserSessionOpen);
    }
  }, [browserSessionOpen, browserTransport, personalBrowser.available, personalBrowser.checked]);
  const handleBrowserTransportChange = useCallback((transport: BrowserTransport) => {
    setBrowserTransportPreferenceResolved(true);
    if (transport === "shared") {
      setSharedBrowserActivated(true);
    }
    setBrowserTransport(transport);
    if (currentUserId) {
      writeBrowserTransportPreference(currentUserId, transport);
    }
  }, [currentUserId]);
  const revealSharedBrowserApproval = useCallback(() => {
    // Approval requests belong to the mounted Shared Browser. Reveal that
    // surface without stealing focus from Chat or overwriting the user's saved
    // Personal Browser preference; Personal remains mounted for the next switch.
    setBrowserTransportPreferenceResolved(true);
    setSharedBrowserActivated(true);
    setBrowserTransport("shared");
  }, []);
  useSharedBrowserApprovalTransport({
    pending: sharedBrowserApprovalPending,
    transport: browserTransport,
    revealSharedBrowser: revealSharedBrowserApproval,
  });
  useEffect(() => {
    if (!browserTransportPreferenceResolved) {
      setSharedBrowserActivated(false);
      return;
    }
    const scope = browserSessionOpen
      ? `${currentUserId ?? "anonymous"}:${activeProjectId ?? "none"}`
      : null;
    if (sharedBrowserActivationScopeRef.current === scope) {
      return;
    }
    sharedBrowserActivationScopeRef.current = scope;
    setSharedBrowserActivated(Boolean(scope && browserTransport === "shared"));
  }, [
    activeProjectId,
    browserSessionOpen,
    browserTransport,
    browserTransportPreferenceResolved,
    currentUserId,
  ]);
  const outOfCredits = useMemo(() => {
    if (!creditsControllerEnabled) {
      return false;
    }
    if (creditBilling.creditLimit <= 0) {
      return false;
    }
    return creditBilling.creditBalance <= 0;
  }, [creditBilling.creditBalance, creditBilling.creditLimit, creditsControllerEnabled]);
  const chatClientSessionId = useMemo(() => getChatClientSessionId(), []);
  const aiConnectWizardStorageKey = useMemo(() => {
    if (!currentUserId || !activeProjectId) {
      return null;
    }
    return `${AI_CONNECT_WIZARD_STORAGE_PREFIX}:${currentUserId}:${activeProjectId}`;
  }, [activeProjectId, currentUserId]);
  const typingRealtimeEnabled =
    runtimeControllerEnabled &&
    hasSupabaseConfig &&
    typeof (supabase as unknown as { channel?: unknown }).channel === "function";
  const typingChannelRef = useRef<RealtimeChannel | null>(null);
  const typingChannelControllerIdRef = useRef<string | null>(null);
  const pendingCredentialAutoSubmitRef = useRef(false);
  const typingChannelSubscribedRef = useRef(false);
  const pendingTypingBroadcastRef = useRef<{
    conversationLocalId: string;
    controllerId: string | null;
    at: number;
  } | null>(null);
  const localTypingStateRef = useRef<{ isTyping: boolean; lastSentAt: number }>({
    isTyping: false,
    lastSentAt: 0,
  });
  const [peerTypingActivity, setPeerTypingActivity] = useState<Record<string, number>>({});
  const activeOrgId = useMemo(() => {
    if (!activeProjectId) {
      return null;
    }
    const project = projectList.find((entry) => entry.id === activeProjectId) ?? null;
    return project?.orgId ?? null;
  }, [activeProjectId, projectList]);
  const {
    canShareProject,
    currentUserRole: orgMembersCurrentUserRole,
    error: orgMembersError,
    loading: orgMembersLoading,
    members: orgMembers,
  } = useChatOrgMembers({
    activeOrgId,
    currentUserId,
    enabled: runtimeControllerEnabled,
  });
  // A resolved org role is the gate SettingsPanel itself uses (`isOrgMember`)
  // to decide whether Team settings renders the member list or the guest
  // notice. Read above by ensureProjectWriteAccess, which is declared before
  // this hook runs.
  latestOrgMembershipRef.current = Boolean(orgMembersCurrentUserRole);
  const effectiveCanShareProject =
    projectCapabilitiesResolved === true
      ? serverCanShareProject === true
      : projectCapabilitiesResolved === false
        ? false
        : canShareProject;
  const mentionableUsers = useMemo(() => {
    const merged = [...(orgMembers ?? []), ...(projectMembers ?? [])];
    const result: ControllerProjectMember[] = [];
    const seen = new Set<string>();
    for (const member of merged) {
      const userId = typeof member.userId === "string" ? member.userId.trim() : "";
      if (!userId || userId === currentUserId || seen.has(userId)) {
        continue;
      }
      seen.add(userId);
      result.push(member);
    }
    result.sort((a, b) => {
      const labelA = `${a.fullName ?? ""} ${a.email ?? ""}`.trim().toLowerCase();
      const labelB = `${b.fullName ?? ""} ${b.email ?? ""}`.trim().toLowerCase();
      return labelA.localeCompare(labelB);
    });
    return result;
  }, [currentUserId, orgMembers, projectMembers]);

  const chatInputRef = useRef<ChatInputHandle | null>(null);

  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [preparedEmailInviteFromCommand, setPreparedEmailInviteFromCommand] =
    useState<PreparedEmailInvite | null>(null);
  const handlePreparedEmailInvite = useCallback((invite: PreparedEmailInvite) => {
    setPreparedEmailInviteFromCommand(invite);
    setAddMenuOpen(true);
  }, []);
  const handlePreparedEmailInviteConsumed = useCallback(() => {
    setPreparedEmailInviteFromCommand(null);
  }, []);
  const { openPanelTab, openConversationTab, openJobThreadTab, requestUrlPush } = useWorkspaceTabs();
  const { pendingConversationInviteId, clearConversationInvite } = useWorkspaceUi();
  const canUseDesktopConnect = canUseDesktopCodexAuthJson();
  const [notificationsNudgeOpen, setNotificationsNudgeOpen] = useState(false);
  const [notificationsNudgeKind, setNotificationsNudgeKind] = useState<"browser" | "native">("browser");
  const [notificationsNudgeAnchorTimestamp, setNotificationsNudgeAnchorTimestamp] = useState<number | null>(null);
  const [outOfCreditsAnchorTimestamp, setOutOfCreditsAnchorTimestamp] = useState<number | null>(null);

  const composerOverlayRef = useRef<HTMLDivElement | null>(null);
  const [messageMenu, setMessageMenu] = useState<MessageMenuState | null>(null);
  const [workspaceGitSyncConflict, setWorkspaceGitSyncConflict] = useState<{
    projectId: string | null;
    error: string | null;
    detectedAt: number;
  } | null>(null);
  const resolveVisibleWorkspaceFileStaleNotice = useCallback(
    (notice: WorkspaceFileStaleNotice | null) => {
      if (!notice) {
        return null;
      }
      const noticeProjectId =
        typeof notice.projectId === "string" && notice.projectId.trim().length > 0
          ? notice.projectId.trim()
          : null;
      if (noticeProjectId && activeProjectId && noticeProjectId !== activeProjectId) {
        return null;
      }
      return notice;
    },
    [activeProjectId],
  );
  const [workspaceFileStaleNotice, setWorkspaceFileStaleNotice] = useState<WorkspaceFileStaleNotice | null>(() =>
    resolveVisibleWorkspaceFileStaleNotice(readWorkspaceFileStaleNotice()),
  );
  const [workspaceFileStaleBusy, setWorkspaceFileStaleBusy] = useState<null | "merge">(null);
  const [workspaceFileStaleError, setWorkspaceFileStaleError] = useState<string | null>(null);
  const [imageLightbox, setImageLightbox] = useState<ImageLightboxState | null>(null);
  const [sendingAttachment, setSendingAttachment] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handler = (event: Event) => {
      const custom = event as CustomEvent<{
        projectId?: string | null;
        ok?: boolean;
        conflict?: boolean;
        error?: string | null;
      }>;
      const projectIdFromEvent =
        custom.detail && typeof custom.detail.projectId === "string" ? custom.detail.projectId : null;
      if (projectIdFromEvent && activeProjectId && projectIdFromEvent !== activeProjectId) {
        return;
      }

      if (custom.detail?.ok === true) {
        setWorkspaceGitSyncConflict(null);
        return;
      }

      if (custom.detail?.conflict === true) {
        const error =
          typeof custom.detail?.error === "string" && custom.detail.error.trim().length > 0
            ? custom.detail.error.trim()
            : null;
        setWorkspaceGitSyncConflict({
          projectId: projectIdFromEvent ?? activeProjectId ?? null,
          error,
          detectedAt: Date.now(),
        });
        return;
      }

      if (custom.detail?.ok === false) {
        setWorkspaceGitSyncConflict(null);
      }
    };
    window.addEventListener("instafy:workspace-git-sync-result", handler as EventListener);
    return () => {
      window.removeEventListener("instafy:workspace-git-sync-result", handler as EventListener);
    };
  }, [activeProjectId]);

  useEffect(() => {
    setWorkspaceFileStaleNotice(resolveVisibleWorkspaceFileStaleNotice(readWorkspaceFileStaleNotice()));
  }, [resolveVisibleWorkspaceFileStaleNotice]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handler = (event: Event) => {
      const custom = event as CustomEvent<{
        projectId?: string | null;
        path?: string | null;
        label?: string | null;
        baseText?: string | null;
        localText?: string | null;
        detectedAt?: number | null;
      }>;
      const detail = custom.detail ?? null;
      if (!detail || typeof detail.path !== "string" || detail.path.trim().length === 0) {
        return;
      }

      const projectIdFromEvent =
        typeof detail.projectId === "string" && detail.projectId.trim().length > 0
          ? detail.projectId.trim()
          : null;
      if (projectIdFromEvent && activeProjectId && projectIdFromEvent !== activeProjectId) {
        return;
      }

      const path = detail.path.trim();
      const label =
        typeof detail.label === "string" && detail.label.trim().length > 0
          ? detail.label.trim()
          : path.split("/").pop() ?? path;
      const baseText = typeof detail.baseText === "string" ? detail.baseText : "";
      const localText = typeof detail.localText === "string" ? detail.localText : "";
      const detectedAt =
        typeof detail.detectedAt === "number" && Number.isFinite(detail.detectedAt)
          ? detail.detectedAt
          : Date.now();

      setWorkspaceFileStaleError(null);
      setWorkspaceFileStaleNotice({
        projectId: projectIdFromEvent ?? activeProjectId ?? null,
        path,
        label,
        baseText,
        localText,
        detectedAt,
      });
    };
    window.addEventListener("instafy:workspace-file-stale", handler as EventListener);
    return () => {
      window.removeEventListener("instafy:workspace-file-stale", handler as EventListener);
    };
  }, [activeProjectId]);

  const resolveWorkspaceGitSyncConflict = useCallback(() => {
    const conversationId =
      activeConversationId ?? createConversation({ title: "Resolve conflicts", select: true }).localId;

    const prompt = [
      "We hit a version history conflict while saving changes.",
      "",
      "Please resolve it and get the project back to a clean state.",
      "",
      "Guidelines:",
      "- Prefer automatic merges for text files.",
      "- If a conflict involves a binary-like file (images, large blobs), ask me which version to keep.",
      "- Keep your explanation non-technical; summarize what changed and only ask when needed.",
      "",
      "Follow the git-canonical conflict playbook:",
      "- `packages/runtime-agent/assets/instafy/.agents/skills/instafy-git-canonical-conflicts/SKILL.md`",
      activeProjectId ? "" : null,
      activeProjectId ? "Project:" : null,
      activeProjectId ? `- ${activeProjectId}` : null,
      workspaceGitSyncConflict?.error ? "" : null,
      workspaceGitSyncConflict?.error ? "Error:" : null,
      workspaceGitSyncConflict?.error ? workspaceGitSyncConflict.error : null,
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n");

    setConversationDraft(conversationId, prompt);
    requestUrlPush();
    openConversationTab(conversationId);
  }, [
    activeConversationId,
    activeProjectId,
    createConversation,
    openConversationTab,
    requestUrlPush,
    setConversationDraft,
    workspaceGitSyncConflict?.error,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleDismiss = () => {
      setWorkspaceGitSyncConflict(null);
    };
    const handleResolve = () => {
      resolveWorkspaceGitSyncConflict();
    };

    window.addEventListener("instafy:workspace-git-conflict-dismiss", handleDismiss);
    window.addEventListener("instafy:workspace-git-conflict-resolve", handleResolve);
    return () => {
      window.removeEventListener("instafy:workspace-git-conflict-dismiss", handleDismiss);
      window.removeEventListener("instafy:workspace-git-conflict-resolve", handleResolve);
    };
  }, [resolveWorkspaceGitSyncConflict]);

  const workspaceGitSyncConflictDetails = useMemo(() => {
    if (!workspaceGitSyncConflict) {
      return null;
    }
    const errorSuffix = workspaceGitSyncConflict.error ? " Check the details and resolve the conflict." : "";
    return {
      testId: "workspace-git-conflict-card",
      icon: "terminal",
      overline: "Version history",
      title: "Merge conflict detected",
      description:
        "Two sets of changes touched the same files while saving a version." + errorSuffix,
      context: workspaceGitSyncConflict.error ? workspaceGitSyncConflict.error : null,
      actions: [
        {
          id: "resolve",
          label: "Resolve with Assistant",
          variant: "primary",
          event: "instafy:workspace-git-conflict-resolve",
          testId: "workspace-git-conflict-resolve",
        },
        {
          id: "open-changes",
          label: "Open Changes",
          variant: "outline",
          event: "instafy:open-source-control",
          testId: "workspace-git-conflict-open-changes",
        },
        {
          id: "dismiss",
          label: "Dismiss",
          variant: "ghost",
          event: "instafy:workspace-git-conflict-dismiss",
          testId: "workspace-git-conflict-dismiss",
        },
      ],
    } satisfies Record<string, unknown>;
  }, [workspaceGitSyncConflict]);

  const handleWorkspaceFileStaleDismiss = useCallback(() => {
    setWorkspaceFileStaleBusy(null);
    setWorkspaceFileStaleError(null);
    setWorkspaceFileStaleNotice(null);
    writeWorkspaceFileStaleNotice(null);
  }, []);

  const handleWorkspaceFileStaleReload = useCallback(() => {
    const notice = workspaceFileStaleNotice;
    if (!notice || typeof window === "undefined") {
      return;
    }

    const detail = {
      projectId: notice.projectId ?? activeProjectId ?? null,
      path: notice.path,
    };

    const runtimeWindow = window as typeof window & {
      __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: unknown;
    };
    runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ = detail;
    window.dispatchEvent(new CustomEvent("instafy:open-workspace-file", { detail }));
    handleWorkspaceFileStaleDismiss();
  }, [activeProjectId, handleWorkspaceFileStaleDismiss, workspaceFileStaleNotice]);

  const handleWorkspaceFileStaleMerge = useCallback(async () => {
    if (!ensureProjectWriteAccess()) {
      return;
    }
    const notice = workspaceFileStaleNotice;
    if (!notice) {
      return;
    }
    const conversationId = activeConversationId ?? createConversation({ title: "Merge changes", select: true }).localId;
    const projectId = notice.projectId ?? activeProjectId ?? null;
    if (!projectId) {
      setWorkspaceFileStaleError("Pick a space before merging changes.");
      return;
    }

    setWorkspaceFileStaleBusy("merge");
    setWorkspaceFileStaleError(null);

    try {
      const sizeEstimate = notice.baseText.length + notice.localText.length;
      const shouldWriteSnapshots = sizeEstimate > 12_000;
      const snapshotPaths: { basePath: string; localPath: string } | null = shouldWriteSnapshots
        ? (() => {
            const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
            const folder = `artifacts/instafy-merge/${stamp}`;
            const safeStemRaw = notice.path.replace(/[^a-zA-Z0-9._-]+/g, "_");
            const safeStem = safeStemRaw.length > 96 ? safeStemRaw.slice(-96) : safeStemRaw;
            const dotIndex = safeStem.lastIndexOf(".");
            const baseName =
              dotIndex > 0
                ? `${safeStem.slice(0, dotIndex)}.base${safeStem.slice(dotIndex)}`
                : `${safeStem}.base.txt`;
            const localName =
              dotIndex > 0
                ? `${safeStem.slice(0, dotIndex)}.local${safeStem.slice(dotIndex)}`
                : `${safeStem}.local.txt`;
            return {
              basePath: `${folder}/${baseName}`,
              localPath: `${folder}/${localName}`,
            };
          })()
        : null;

      let persistedSnapshots = snapshotPaths;
      if (snapshotPaths) {
        const [baseWrite, localWrite] = await Promise.all([
          writeWorkspaceFileToController({
            projectId,
            path: snapshotPaths.basePath,
            content: notice.baseText,
            runtimeId: effectiveRuntimeId ?? null,
          }),
          writeWorkspaceFileToController({
            projectId,
            path: snapshotPaths.localPath,
            content: notice.localText,
            runtimeId: effectiveRuntimeId ?? null,
          }),
        ]);
        if (!baseWrite?.ok || !localWrite?.ok) {
          persistedSnapshots = null;
        }
      }

      const extension = notice.path.split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
      const fence = (() => {
        if (extension === "ts" || extension === "tsx") {
          return "tsx";
        }
        if (extension === "js" || extension === "jsx") {
          return "jsx";
        }
        if (extension === "json") {
          return "json";
        }
        if (extension === "md" || extension === "mdx") {
          return "md";
        }
        if (extension === "toml") {
          return "toml";
        }
        if (extension === "rs") {
          return "rust";
        }
        return "";
      })();

      const prompt = persistedSnapshots
        ? [
            `A teammate (or another tab) updated the workspace version of \`${notice.path}\` while I have unsaved edits.`,
            "",
            "Please merge my edits into the latest workspace version and keep it clean.",
            "",
            "Files:",
            `- Target (latest): ${notice.path}`,
            `- Base snapshot (what I started from): ${persistedSnapshots.basePath}`,
            `- My unsaved edits snapshot: ${persistedSnapshots.localPath}`,
            "",
            "Instructions:",
            `1. Read the latest content from \`${notice.path}\`.`,
            `2. Read the base + local snapshot files.`,
            `3. Produce a merged result and write it back to \`${notice.path}\`.`,
            "4. Keep your explanation non-technical; summarize what changed.",
            "5. If something is ambiguous, ask me which version to keep (only ask when needed).",
          ].join("\n")
        : [
            `A teammate (or another tab) updated the workspace version of \`${notice.path}\` while I have unsaved edits.`,
            "",
            "Please merge my edits into the latest workspace version and keep it clean.",
            "",
            "Instructions:",
            `1. Read the latest content from \`${notice.path}\`.`,
            `2. Use the two versions below to do a 3-way merge (base vs my edits vs latest).`,
            `3. Write the merged result back to \`${notice.path}\`.`,
            "4. Keep your explanation non-technical; summarize what changed.",
            "5. If something is ambiguous, ask me which version to keep (only ask when needed).",
            "",
            "Base version:",
            "```" + fence,
            notice.baseText,
            "```",
            "",
            "My unsaved edits:",
            "```" + fence,
            notice.localText,
            "```",
          ].join("\n");

      const preservedDraft = latestInputValueRef.current;
      const preservedEditorState = latestInputEditorStateRef.current;

      if (!ensureProjectWriteAccess()) {
        return;
      }
      await onSubmit(conversationId, prompt);

      if (preservedDraft.trim().length > 0) {
        onInputChange(activeConversationId ?? conversationId, preservedDraft, preservedEditorState);
      }

      handleWorkspaceFileStaleDismiss();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start merge.";
      setWorkspaceFileStaleError(message);
    } finally {
      setWorkspaceFileStaleBusy(null);
    }
  }, [
    activeConversationId,
    activeProjectId,
    createConversation,
    effectiveRuntimeId,
    ensureProjectWriteAccess,
    handleWorkspaceFileStaleDismiss,
    onInputChange,
    onSubmit,
    workspaceFileStaleNotice,
  ]);

  const anyAgentsEnabled = assistantEnabled || extraAgentHandles.length > 0;
  const conversationHumanPeerContext = useMemo(
    () =>
      resolveConversationHumanPeerContext({
        conversationVisibility: activeConversationEntry?.visibility ?? null,
        controllerConversationId: activeConversationEntry?.controllerId ?? null,
        currentUserId,
        orgMemberError: orgMembersError,
        orgMemberLoading: orgMembersLoading,
        orgMembers,
        participantError: conversationParticipantsError,
        participantLoading: conversationParticipantsLoading,
        participants: conversationParticipants,
        projectMemberError: projectMembersError,
        projectMemberLoading: projectMemberContextLoading,
        projectMembers,
        runtimeControllerEnabled,
      }),
    [
      activeConversationEntry?.controllerId,
      activeConversationEntry?.visibility,
      conversationParticipants,
      conversationParticipantsError,
      conversationParticipantsLoading,
      currentUserId,
      orgMembers,
      orgMembersError,
      orgMembersLoading,
      projectMemberContextLoading,
      projectMembers,
      projectMembersError,
    ],
  );
  // Skill-mode group silence affordances: the quiet "listening" chip and the
  // one-time decline hint only apply when other humans can see the
  // conversation and the default assistant is enabled for the sender.
  const groupListeningActive =
    assistantEnabled &&
    conversationHumanPeerContext.resolved &&
    conversationHumanPeerContext.hasHumanPeer;
  const octoSilenceHint = useOctoSilenceHint({
    runs,
    conversationControllerId: activeConversationEntry?.controllerId ?? null,
    eligible: groupListeningActive && !jobThread,
  });
  const gettingStartedConversationContext = useMemo(
    () =>
      resolveGettingStartedConversationContext({
        anyAgentsEnabled,
        conversationVisibility: activeConversationEntry?.visibility ?? null,
        controllerConversationId: activeConversationEntry?.controllerId ?? null,
        currentUserId,
        orgMemberError: orgMembersError,
        orgMemberLoading: orgMembersLoading,
        orgMembers,
        participantError: conversationParticipantsError,
        participantLoading: conversationParticipantsLoading,
        participants: conversationParticipants,
        projectMemberError: projectMembersError,
        projectMemberLoading: projectMemberContextLoading,
        projectMembers,
        runtimeControllerEnabled,
      }),
    [
      activeConversationEntry?.controllerId,
      activeConversationEntry?.visibility,
      anyAgentsEnabled,
      conversationParticipants,
      conversationParticipantsError,
      conversationParticipantsLoading,
      currentUserId,
      orgMembersError,
      orgMembers,
      orgMembersLoading,
      projectMemberContextLoading,
      projectMembers,
      projectMembersError,
    ],
  );
  const composerInlineSuggestion = useMemo(
    () => buildComposerInlineSuggestion(inputValue, composerInlineCompletion),
    [composerInlineCompletion, inputValue],
  );
  const suggestedReplies = useMemo(() => {
    const lastVisible = (() => {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const candidate = messages[index];
        if (shouldDisplayChatMessage(candidate)) {
          return candidate;
        }
      }
      return null;
    })();

    if (!lastVisible || lastVisible.role !== "assistant") {
      return [];
    }
    return resolveComposerUiSuggestedReplies(lastVisible);
  }, [messages]);
  const composerGhostSuggestion = useMemo(
    () =>
      resolveComposerGhostSuggestion(
        inputValue,
        composerInlineSuggestion ? [composerInlineSuggestion, ...suggestedReplies] : suggestedReplies,
      ),
    [composerInlineSuggestion, inputValue, suggestedReplies],
  );
  const softPrefillSuggestion = composerGhostSuggestion?.suggestion ?? suggestedReplies[0] ?? null;
  const chatInputPlaceholder = useMemo(() => {
    if (anyAgentsEnabled) {
      return DEFAULT_CHAT_INPUT_PLACEHOLDER;
    }
    const mentions = listBuiltInAssistantMentionTokens();
    if (mentions.length === 0) {
      return "Message teammates…";
    }
    if (mentions.length === 1) {
      const mention = mentions[0];
      const displayName = getBuiltInAssistantDisplayName(mention) ?? mention;
      return `Message teammates… (type ${mention} to ask ${displayName})`;
    }
    return `Message teammates… (type ${mentions.slice(0, 2).join(" or ")} to route a built-in assistant)`;
  }, [anyAgentsEnabled]);
  const openAiManager = useCallback(() => {
    requestUrlPush();
    openPanelTab("ai", { activate: true });
  }, [openPanelTab, requestUrlPush]);

  const openAgentProfileSettings = useCallback(
    (handle: string) => {
      setPendingAgentProfileTarget(handle);
      openAiManager();
    },
    [openAiManager],
  );

  const {
    agentByHandle,
    availableAgents,
    mentionableAgentHandles,
    primaryAgentHandleForPopover,
    refreshAvailableAgents,
    renderAssistantAvatar,
    resolveAgentProfileCardProps,
    runAgentHandleByRunId,
    runAgentIdentityByRunId,
  } = useChatAgentRoster({
    activeConversationId,
    activeProjectId,
    agentHandles,
    assistantEnabled,
    currentRuntime,
    currentUserId,
    extraAgentHandles,
    onOpenAgentProfileSettings: openAgentProfileSettings,
    onRemoveAgentHandle,
    runs,
    runtimeOptionsById,
    preferredRuntimeId,
    setChatSendQueue,
    showStatus,
    stickyMentionedAgentByConversationRef,
  });
  const resolvePromptAgentTargets = useCallback(
    (
      prompt: string,
      options?: {
        useSticky?: boolean;
        updateSticky?: boolean;
      },
    ) => {
      const conversationKey = activeConversationId ?? "";
      const stickyMentionedAgent =
        options?.useSticky !== false && conversationKey
          ? (stickyMentionedAgentByConversationRef.current.get(conversationKey) ?? null)
          : null;
      const selection = resolvePromptAgentSelection({
        prompt,
        assistantEnabled,
        extraAgentHandles,
        configuredAgentHandles: mentionableAgentHandles,
        stickyMentionedAgent,
      });
      if (options?.updateSticky && conversationKey) {
        if (selection.nextStickyMentionedAgent) {
          stickyMentionedAgentByConversationRef.current.set(conversationKey, selection.nextStickyMentionedAgent);
        } else {
          stickyMentionedAgentByConversationRef.current.delete(conversationKey);
        }
      }
      return selection;
    },
    [
      activeConversationId,
      assistantEnabled,
      extraAgentHandles,
      mentionableAgentHandles,
      stickyMentionedAgentByConversationRef,
    ],
  );

  const isChatInputFocused = useCallback(() => {
    if (typeof document === "undefined") {
      return false;
    }
    const element = document.getElementById("studio-chat-input");
    if (!element) {
      return false;
    }
    const active = document.activeElement;
    return active === element || (active instanceof HTMLElement && element.contains(active));
  }, []);

  const focusInput = useCallback(
    (options?: { force?: boolean }) => {
      if (Capacitor.isNativePlatform() && !options?.force && !isChatInputFocused()) {
        return;
      }
      chatInputRef.current?.focus();
    },
    [isChatInputFocused],
  );
  const clearInputEditor = useCallback(() => {
    chatInputRef.current?.clear();
  }, []);
  // Surfaces outside the chat tree (the agent profile card, panels) hand
  // keyboard focus to the composer after navigating here — without this the
  // popover's focus restore lands on <body> once its trigger unmounts.
  useEffect(() => {
    const handler = () => focusInput({ force: true });
    window.addEventListener("instafy:focus-composer", handler);
    return () => window.removeEventListener("instafy:focus-composer", handler);
  }, [focusInput]);
  // Anchor-less profile opens: inline mention chips and narrow speaker labels
  // dispatch a handle; this panel owns agent resolution, so it hosts the card.
  const [agentProfileModalHandle, setAgentProfileModalHandle] = useState<string | null>(null);
  useEffect(() => {
    const handler = (event: Event) => {
      const handle = (event as CustomEvent<OpenAgentProfileDetail>).detail?.handle;
      if (typeof handle === "string" && handle) {
        setAgentProfileModalHandle(handle);
      }
    };
    window.addEventListener(OPEN_AGENT_PROFILE_EVENT, handler);
    return () => window.removeEventListener(OPEN_AGENT_PROFILE_EVENT, handler);
  }, []);
  // This identity belongs to one mounted Shared Browser surface. Keeping it in
  // memory avoids duplicate tabs or side-by-side surfaces replacing each other,
  // while remaining stable across transport and network reconnects.
  const sharedBrowserSurfaceSessionId = useMemo(() => generateUUID(), []);
  const {
    browserSessionPages,
    clearPendingBrowserLaunchMode,
    handleClearPendingNewBrowserSession,
    handleOpenBrowserFromLauncher,
    handlePrepareNewBrowserSession,
    handleSelectBrowserSessionPage,
    pendingBrowserLaunchMode,
    preferredBrowserPage,
    sharedBrowserCapabilities,
    sharedBrowserCapabilitiesResolved,
    sharedBrowserCapabilitiesUnsupported,
    sharedBrowserChromePages,
    sharedBrowserChromeResolved,
    sharedBrowserCommandPending,
    sharedBrowserCommandError,
    clearSharedBrowserCommandError,
    navigateSharedBrowserPage,
    goBackInSharedBrowser,
    goForwardInSharedBrowser,
    reloadSharedBrowserPage,
    setPendingBrowserLaunchMode,
    showBrowserSessionPageStrip,
  } = useChatComposerBrowserTargeting({
    activeConversationId,
    activeProjectId,
    browserSessionOpen,
    browserSessionId: sharedBrowserSurfaceSessionId,
    sharedBrowserActivated,
    browserTransport,
    compactBrowserViewport,
    focusInput,
    hasHiddenBrowserSession,
    messages,
    onHiddenBrowserSessionUnavailable: handleHiddenBrowserSessionUnavailable,
    openBrowserSession,
    preferredBrowserRuntimeId,
    requestBrowserSessionExpand,
    resolvedBrowserRuntimeId,
    showStatus,
  });
  const browserModeActive = browserSessionOpen && browserSubtab === "browser";
  const showBrowserSessionPageStripForComposer =
    shouldShowBrowserSessionPageStripInComposer({
      browserModeActive,
      pendingNewBrowser: pendingBrowserLaunchMode === "new_page",
      showPageStrip: showBrowserSessionPageStrip,
    });
  const sharedBrowserViewerKind = useMemo(
    () =>
      resolveSharedBrowserViewerKind(
        sharedBrowserCapabilities,
        sharedBrowserCapabilitiesUnsupported,
        compactSharedBrowserViewport,
      ),
    [
      compactSharedBrowserViewport,
      sharedBrowserCapabilities,
      sharedBrowserCapabilitiesUnsupported,
    ],
  );
  const sharedBrowserChrome = useMemo<SharedBrowserChromeProps | null>(() => {
    const controls = sharedBrowserCapabilities?.controls;
    if (
      !sharedBrowserCapabilities?.viewportOnly ||
      !controls
    ) {
      return null;
    }
    return {
      pages: sharedBrowserChromePages,
      resolved: sharedBrowserCapabilitiesResolved && sharedBrowserChromeResolved,
      pendingAction: sharedBrowserCommandPending,
      error: sharedBrowserCommandError,
      controls,
      compact: compactBrowserBar,
      onNavigate: (pageId, url) => {
        void navigateSharedBrowserPage(pageId, url);
      },
      onBack: (pageId) => {
        void goBackInSharedBrowser(pageId);
      },
      onForward: (pageId) => {
        void goForwardInSharedBrowser(pageId);
      },
      onReload: (pageId) => {
        void reloadSharedBrowserPage(pageId);
      },
      onFocusPage: (pageId) => {
        void handleSelectBrowserSessionPage(pageId);
      },
      onClearError: clearSharedBrowserCommandError,
    };
  }, [
    clearSharedBrowserCommandError,
    compactBrowserBar,
    goBackInSharedBrowser,
    goForwardInSharedBrowser,
    handleSelectBrowserSessionPage,
    navigateSharedBrowserPage,
    reloadSharedBrowserPage,
    sharedBrowserCapabilities,
    sharedBrowserCapabilitiesResolved,
    sharedBrowserChromePages,
    sharedBrowserChromeResolved,
    sharedBrowserCommandError,
    sharedBrowserCommandPending,
  ]);
  const handleInsertSlashCommand = useCallback(
    (command: string) => {
      const trimmedCommand = command.trim();
      if (!trimmedCommand) {
        return;
      }
      const currentDraft = inputValue.trim();
      const nextValue =
        currentDraft && !currentDraft.startsWith("/")
          ? `${trimmedCommand} ${currentDraft}`
          : `${trimmedCommand} `;
      latestInputValueRef.current = nextValue;
      chatInputRef.current?.focusAfterValueSync();
      onInputChange(activeConversationId, nextValue, null);
    },
    [activeConversationId, inputValue, onInputChange],
  );
  const {
    inviteParticipantBusyUserId,
    inviteParticipantIdSet,
    inviteParticipantsLoading,
    handleInviteTeammate,
  } = useChatConversationInviteState({
    activeConversation: activeConversationEntry,
    activeConversationId,
    addMenuOpen,
    clearConversationInvite,
    pendingConversationInviteId,
    setAddMenuOpen,
    showStatus,
  });

  const {
    clearImageAttachments,
    handleComposerDragOver,
    handleComposerDrop,
    handleComposerPaste,
    handleImageInputChange,
    imageAttachments,
    imageInputRef,
    openImagePicker,
    removeImageAttachment,
  } = useChatComposerAttachments({
    isInputLocked: () => onboardingInputLocked,
    showStatus,
  });

  const openImageLightbox = useCallback((src: string, alt: string) => {
    setImageLightbox({ src, alt });
  }, []);
  const {
    autoScrollSuspendedRef,
    autoScrollPendingRef,
    handleScrollContentRef,
    lastComposerScrollTopRef,
    lastScrollHeightRef,
    recordScrollPosition,
    requestOlderMessages,
    scrollContainerRef,
    scrollToBottom,
    setAutoScrollSuspended,
    shouldAutoScrollRef,
    showHistoryLoadButton,
  } = useChatScrollController({
    activeConversationId,
    hasMoreHistory,
    isHistoryLoading,
    loadOlderMessages,
    messages,
  });

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.localId === activeConversationId) ?? null,
    [conversations, activeConversationId]
  );

  const broadcastTyping = useCallback(
    (typing: boolean, controllerId: string | null) => {
      const channel = typingChannelRef.current;
      if (!channel || !chatClientSessionId) {
        return;
      }
      if (!controllerId) {
        return;
      }
      if (!typingChannelSubscribedRef.current) {
        return;
      }
      if (typingChannelControllerIdRef.current !== controllerId) {
        return;
      }
      channel
        .send({
          type: "broadcast",
          event: "typing",
          payload: { userId: currentUserId, sessionId: chatClientSessionId, typing }
        })
        .catch(() => {});
    },
    [chatClientSessionId, currentUserId]
  );

  const handleChatInputChange = useCallback(
    (nextValue: string, nextEditorState: string) => {
      latestInputValueRef.current = nextValue;
      if (!nextValue.trim()) {
        pendingReplyContextRef.current = null;
      }
      onInputChange(activeConversationId, nextValue, nextEditorState);

      const isTypingNow = nextValue.trim().length > 0;
      const localState = localTypingStateRef.current;
      const now = Date.now();

      if (!isTypingNow) {
        pendingTypingBroadcastRef.current = null;
      }

      if (!typingRealtimeEnabled || !chatClientSessionId) {
        localState.isTyping = isTypingNow;
        return;
      }

      const controllerId = activeConversation?.controllerId ?? null;
      if (!controllerId) {
        localState.isTyping = isTypingNow;
        if (isTypingNow && activeConversationId) {
          pendingTypingBroadcastRef.current = {
            conversationLocalId: activeConversationId,
            controllerId: null,
            at: now,
          };
        }
        return;
      }

      if (
        !typingChannelRef.current ||
        !typingChannelSubscribedRef.current ||
        typingChannelControllerIdRef.current !== controllerId
      ) {
        localState.isTyping = isTypingNow;
        if (isTypingNow && activeConversationId) {
          pendingTypingBroadcastRef.current = { conversationLocalId: activeConversationId, controllerId, at: now };
        }
        return;
      }

      if (!isTypingNow && localState.isTyping) {
        localState.isTyping = false;
        localState.lastSentAt = now;
        broadcastTyping(false, controllerId);
        return;
      }

      if (isTypingNow) {
        const shouldSend = !localState.isTyping || now - localState.lastSentAt > 1200;
        if (shouldSend) {
          localState.isTyping = true;
          localState.lastSentAt = now;
          pendingTypingBroadcastRef.current = null;
          broadcastTyping(true, controllerId);
        }
      }
    },
    [
      activeConversation?.controllerId,
      activeConversationId,
      broadcastTyping,
      chatClientSessionId,
      onInputChange,
      typingRealtimeEnabled,
    ]
  );

  const activeGoalHealth = useMemo(
    () =>
      buildConversationGoalHealth({
        goal: activeConversationEntry?.activeGoal ?? null,
        messages,
      }),
    [activeConversationEntry?.activeGoal, messages],
  );
  const [goalDetailsCollapseToken, setGoalDetailsCollapseToken] = useState(0);

  const submitMessageRef = useRef<SubmitMessageFn>(async () => false);
  const composerPrimaryActionRef = useRef<{
    mode: "send" | "steer";
    expectedActiveJobId: string | null;
  }>({ mode: "send", expectedActiveJobId: null });
  const sendIntentAttemptRef = useRef<{ key: string; clientSendId: string } | null>(null);
  const invokeSubmitMessage = useCallback<SubmitMessageFn>(async (override, options) => {
    if (!ensureProjectWriteAccess()) {
      return false;
    }
    const restoredStash = override ? null : restoredMessageStash;
    const restoredEnvelope = restoredStash
      ? normalizeChatMessageStashEnvelope(restoredStash.composerEnvelope)
      : null;
    const baseOverride =
      override ??
      (restoredStash && restoredEnvelope
        ? {
            message: latestInputValueRef.current ?? restoredStash.text,
            editorState: latestInputEditorStateRef.current,
            targetAgentHandles: restoredEnvelope.targetAgentHandles,
            browserPageTarget: restoredEnvelope.browserPageTarget,
            browserLaunchMode: restoredEnvelope.browserLaunchMode,
            metadata: restoredEnvelope.metadata,
            runtimeOverride: restoredEnvelope.runtimeOverride,
          }
        : undefined);
    const overrideHasMetadata = Boolean(
      baseOverride && Object.prototype.hasOwnProperty.call(baseOverride, "metadata"),
    );
    const optionsHasMetadata = Boolean(
      options && Object.prototype.hasOwnProperty.call(options, "metadata"),
    );
    const explicitMetadata = overrideHasMetadata
      ? (baseOverride?.metadata ?? null)
      : optionsHasMetadata
        ? (options?.metadata ?? null)
        : undefined;
    const pendingReplyContext = pendingReplyContextRef.current;
    const candidateMessage = baseOverride?.message ?? latestInputValueRef.current ?? "";
    const metadata =
      explicitMetadata !== undefined
        ? explicitMetadata
        : shouldAttachPendingReplyContext(pendingReplyContext, candidateMessage)
          ? { replyContext: pendingReplyContext }
          : undefined;
    const nextOverride =
      baseOverride && metadata !== undefined
        ? {
            ...baseOverride,
            metadata,
          }
        : baseOverride;
    const nextOptions =
      metadata !== undefined
        ? {
            ...options,
            metadata,
          }
        : options;
    const submitted = await submitMessageRef.current(nextOverride, nextOptions);
    if (submitted && pendingReplyContextRef.current === pendingReplyContext) {
      pendingReplyContextRef.current = null;
    }
    if (
      restoredStash &&
      shouldDeleteRestoredMessageStashAfterAction({
        submitted,
        action: options?.intent ?? "send",
      })
    ) {
      try {
        const removed = await removeServerMessageStash(restoredStash.id);
        if (removed) {
          setRestoredMessageStash((current) =>
            current?.id === restoredStash.id ? null : current,
          );
        }
      } catch (error) {
        console.warn("[chat] sent restored stash but could not delete it:", error);
      }
    }
    return submitted;
  }, [ensureProjectWriteAccess, removeServerMessageStash, restoredMessageStash]);

  // Conversational undo (#165): the Undo chip on an agent message dispatches a
  // window event; this panel owns the composer, so it turns the request into a
  // normal user message (with the target-message reference in metadata) and
  // sends it. The handler serializes rapid requests, and the standard submit
  // preflight queues the message when the assistant is busy — the intent is
  // never dropped and never double-sent.
  useEffect(() => {
    const handler = createMessageUndoRequestHandler(async ({ message, metadata }) =>
      invokeSubmitMessage({ message, editorState: null, metadata }),
    );
    window.addEventListener(REQUEST_MESSAGE_UNDO_EVENT, handler);
    return () => window.removeEventListener(REQUEST_MESSAGE_UNDO_EVENT, handler);
  }, [invokeSubmitMessage]);

  const invokeComposerPrimaryAction = useCallback<SubmitMessageFn>(
    async (override, options) => {
      const primaryAction = composerPrimaryActionRef.current;
      return await invokeSubmitMessage(override, {
        ...options,
        intent: primaryAction.mode,
        expectedActiveJobId: primaryAction.expectedActiveJobId,
      });
    },
    [invokeSubmitMessage],
  );

  const submitGoalCommand = useCallback(
    (command: "/goal pause" | "/goal resume" | "/goal clear") => {
      void invokeSubmitMessage(
        {
          message: command,
          editorState: null,
        },
        { allowWhileBusy: true },
      );
    },
    [invokeSubmitMessage],
  );

  const handleHelpUnblockGoal = useCallback(() => {
    const goal = activeConversationEntry?.activeGoal ?? null;
    if (!goal) {
      return;
    }
    setGoalDetailsCollapseToken((current) => current + 1);
    const blocker =
      normalizeConversationGoalProgressSummaryForDisplay(activeGoalHealth?.detail) ||
      normalizeConversationGoalProgressSummaryForDisplay(goal.progressSummary) ||
      "No blocker details were reported.";
    const prompt = buildGoalUnblockHelpPrompt({ goal, blocker });

    void invokeSubmitMessage({
      message: prompt,
      editorState: null,
    });
  }, [activeConversationEntry?.activeGoal, activeGoalHealth?.detail, invokeSubmitMessage]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await invokeSubmitMessage();
  };

  // "Try again" on a failed run re-submits the triggering user prompt through
  // the normal submit flow, so a busy agent naturally routes the resend into
  // the server send queue.
  const [pendingRunFailureRetryKey, setPendingRunFailureRetryKey] = useState<string | null>(null);
  const handleRunFailureRetry = useCallback(
    async (failureMessage: ChatMessage) => {
      const prompt = resolveRunFailureRetryPrompt({
        conversationMessages: messages,
        failureMessage,
      });
      if (!prompt) {
        showStatus("Couldn't find the original message to send again.", "info", 4000);
        return;
      }
      setPendingRunFailureRetryKey(failureMessage.id);
      try {
        await invokeSubmitMessage({ message: prompt, editorState: null });
      } finally {
        setPendingRunFailureRetryKey(null);
      }
    },
    [invokeSubmitMessage, messages, showStatus],
  );
  // Automatic transient-failure re-dispatch mirrors handleRunFailureRetry but
  // deliberately does NOT touch pendingRunFailureRetryKey — that state is the
  // manual "Try again" in-flight signal, and the auto path presents its own calm
  // "trying again automatically" state via autoRetryingKey instead.
  const handleRunFailureAutoRetry = useCallback(
    async ({ promptText }: { failureMessage: ChatMessage; promptText: string }) => {
      await invokeSubmitMessage({ message: promptText, editorState: null });
    },
    [invokeSubmitMessage],
  );
  // Busy while the assistant is producing output or a manual retry resend is in
  // flight — do not stack an automatic retry on top of an active run.
  const runFailureAutoRetryBusy = isAssistantTyping || pendingRunFailureRetryKey !== null;
  const { autoRetryingKey: runFailureAutoRetryingKey } = useRunFailureAutoRetry({
    messages,
    conversationKey: activeConversationId,
    isBusy: runFailureAutoRetryBusy,
    autoRetry: handleRunFailureAutoRetry,
  });
  const runFailureRetryContextValue = useMemo<RunFailureRetryContextValue>(
    () => ({
      pendingRetryKey: pendingRunFailureRetryKey,
      requestRetry: handleRunFailureRetry,
      autoRetryingKey: runFailureAutoRetryingKey,
      onConnectAi: openAiManager,
    }),
    [handleRunFailureRetry, openAiManager, pendingRunFailureRetryKey, runFailureAutoRetryingKey],
  );

  const scheduleSubmitMessage = () => {
    if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
      window.setTimeout(() => {
        void invokeSubmitMessage();
      }, 0);
      return;
    }
    void invokeSubmitMessage();
  };
  const scheduleComposerPrimaryAction = () => {
    if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
      window.setTimeout(() => {
        void invokeComposerPrimaryAction();
      }, 0);
      return;
    }
    void invokeComposerPrimaryAction();
  };
  const {
    handleChatVoiceTap,
    handleSendButtonPress,
    handleStartVoiceInputHold,
    handleStopVoiceInputHold,
    providerTriggerNoticeProps,
    recordingIndicatorLabel,
    showVoicePrimaryAction,
    showVoiceSecondaryAction,
    showVoiceStatus,
    voiceActionActive,
    voiceDebugState,
    voiceHoldActive,
    voiceInputListening,
    voiceInputStarting,
    voiceInputTranscribing,
    voiceStatusMessage,
  } = useChatVoiceComposerController({
    activeConversationId,
    activeProjectId,
    chatInputRef,
    imageAttachmentCount: imageAttachments.length,
    inputValue,
    invokeSubmitMessage: invokeComposerPrimaryAction,
    isAssistantTyping,
    latestInputValueRef,
    messages,
    onInputChange,
    scheduleSubmitMessage: scheduleComposerPrimaryAction,
    sendingAttachment,
    showStatus,
    touchLikeInput,
  });

  const handleInputKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const findVisibleComposerElement = (selectors: string[]) => {
      if (typeof document === "undefined") {
        return null;
      }
      for (const selector of selectors) {
        const candidates = document.querySelectorAll<HTMLElement>(selector);
        for (const candidate of candidates) {
          const style = window.getComputedStyle(candidate);
          if (
            candidate.getClientRects().length > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          ) {
            return candidate;
          }
        }
      }
      return null;
    };
    const activeComposerMenu =
      findVisibleComposerElement(['[data-testid="assistant-mention-menu"]']) ??
      findVisibleComposerElement(['[data-testid="chat-slash-command-menu"]']);
    const acceptOpenComposerMenuSelection = () => {
      if (!activeComposerMenu) {
        return false;
      }
      const highlightedOption =
        activeComposerMenu.querySelector<HTMLElement>(
          '[data-testid="assistant-mention-option"][data-highlighted="true"]'
        ) ??
        activeComposerMenu.querySelector<HTMLElement>(
          '[data-testid="chat-slash-command-option"][data-highlighted="true"]'
        ) ??
        activeComposerMenu.querySelector<HTMLElement>('[data-testid="assistant-mention-option"]') ??
        activeComposerMenu.querySelector<HTMLElement>('[data-testid="chat-slash-command-option"]');
      if (!highlightedOption) {
        return false;
      }
      highlightedOption.click();
      return true;
    };
    const hasOpenComposerMenu = Boolean(activeComposerMenu);
    if (
      event.key === "Tab" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      hasOpenComposerMenu
    ) {
      if (acceptOpenComposerMenuSelection()) {
        event.preventDefault();
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation?.();
        return;
      }
    }
    if (
      event.key === "Tab" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !hasOpenComposerMenu &&
      !onboardingInputLocked &&
      !sendingAttachment
    ) {
      const inlineSuggestionRemainder = composerGhostSuggestion?.remainder ?? "";
      if (inlineSuggestionRemainder.trim().length > 0) {
        event.preventDefault();
        chatInputRef.current?.acceptGhostSuggestion(inlineSuggestionRemainder);
        return;
      }
    }
    const enterAction = resolveComposerEnterAction({
      key: event.key,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      isComposing: event.nativeEvent.isComposing,
      hasOpenMenu: hasOpenComposerMenu,
      hasActiveMatchingAgent: composerPrimaryActionRef.current.mode === "steer",
      touchLikeInput,
    });
    if (enterAction === "menu") {
      if (acceptOpenComposerMenuSelection()) {
        event.preventDefault();
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation?.();
      }
      return;
    }
    if (
      enterAction === "ignore" ||
      enterAction === "newline"
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation?.();
    if (enterAction === "stash") {
      void handleStashDraft();
      return;
    }
    if (
      (enterAction === "send" || enterAction === "steer") &&
      parseInviteCommandRequest(inputValue.trim())
    ) {
      scheduleSubmitMessage();
      return;
    }
    void invokeSubmitMessage(undefined, {
      intent: enterAction,
      expectedActiveJobId:
        enterAction === "steer"
          ? composerPrimaryActionRef.current.expectedActiveJobId
          : null,
    });
  };

  useEffect(() => {
    if (!typingRealtimeEnabled || !activeConversation?.controllerId) {
      typingChannelRef.current = null;
      typingChannelControllerIdRef.current = null;
      typingChannelSubscribedRef.current = false;
      setPeerTypingActivity({});
      return;
    }

    const controllerId = activeConversation.controllerId;
    setPeerTypingActivity({});
    localTypingStateRef.current = { isTyping: false, lastSentAt: 0 };
    const channelName = `conversation:${controllerId}:typing`;
    const channel = supabase.channel(channelName);
    typingChannelRef.current = channel;
    typingChannelControllerIdRef.current = controllerId;
    typingChannelSubscribedRef.current = false;

    const TTL_MS = 3500;
    const PENDING_TTL_MS = 5000;

    const flushPendingTypingBroadcast = () => {
      const pending = pendingTypingBroadcastRef.current;
      if (!pending) {
        return;
      }
      if (pending.conversationLocalId !== activeConversationId) {
        return;
      }
      if (pending.controllerId && pending.controllerId !== controllerId) {
        return;
      }
      if (Date.now() - pending.at > PENDING_TTL_MS) {
        pendingTypingBroadcastRef.current = null;
        return;
      }
      pendingTypingBroadcastRef.current = null;
      localTypingStateRef.current = { isTyping: true, lastSentAt: Date.now() };
      broadcastTyping(true, controllerId);
    };

    channel.on("broadcast", { event: "typing" }, (event) => {
      const payloadRaw = (event as { payload?: unknown }).payload;
      if (!payloadRaw || typeof payloadRaw !== "object") {
        return;
      }
      const payload = payloadRaw as Record<string, unknown>;
      const userIdRaw = payload.userId;
      const userId = typeof userIdRaw === "string" ? userIdRaw.trim() : "";
      const sessionIdRaw = payload.sessionId;
      const sessionId = typeof sessionIdRaw === "string" ? sessionIdRaw.trim() : "";

      if (userId && currentUserId && userId === currentUserId) {
        return;
      }

      if (sessionId && sessionId === chatClientSessionId) {
        return;
      }

      const senderKey = userId || sessionId;
      if (!senderKey) {
        return;
      }
      const typing = payload.typing === false ? false : true;
      if (!typing) {
        setPeerTypingActivity((current) => {
          if (!Object.prototype.hasOwnProperty.call(current, senderKey)) {
            return current;
          }
          const next = { ...current };
          delete next[senderKey];
          return next;
        });
        return;
      }
      const now = Date.now();
      setPeerTypingActivity((current) => ({ ...current, [senderKey]: now }));
    });

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        typingChannelSubscribedRef.current = true;
        flushPendingTypingBroadcast();
        return;
      }
      if (status === "TIMED_OUT" || status === "CHANNEL_ERROR") {
        // eslint-disable-next-line no-console
        console.warn(`[chat] typing channel ${channelName} ${status.toLowerCase()}`);
      }
    });

    const intervalId = window.setInterval(() => {
      const now = Date.now();
      setPeerTypingActivity((current) => {
        let changed = false;
        const next: Record<string, number> = {};
        for (const [userId, lastSeen] of Object.entries(current)) {
          if (now - lastSeen < TTL_MS) {
            next[userId] = lastSeen;
          } else {
            changed = true;
          }
        }
        return changed ? next : current;
      });
    }, 1000);

    return () => {
      typingChannelRef.current = null;
      typingChannelControllerIdRef.current = null;
      typingChannelSubscribedRef.current = false;
      window.clearInterval(intervalId);
      channel.unsubscribe().catch(() => {});
    };
  }, [
    activeConversation?.controllerId,
    activeConversationId,
    broadcastTyping,
    chatClientSessionId,
    currentUserId,
    typingRealtimeEnabled,
  ]);

  const humanLabelByUserId = useMemo(() => {
    return buildHumanLabelByUserId({
      directoryMembers: mentionableUsers,
      conversationParticipants,
    });
  }, [conversationParticipants, mentionableUsers]);

  const conversationRosterHumans = useMemo(
    () =>
      resolveConversationRosterHumans({
        conversationVisibility: activeConversationEntry?.visibility ?? null,
        currentUserId,
        humanLabelByUserId,
        humanPeerContext: conversationHumanPeerContext,
        orgMembers,
        participants: conversationParticipants,
        projectMembers,
      }),
    [
      activeConversationEntry?.visibility,
      conversationHumanPeerContext,
      conversationParticipants,
      currentUserId,
      humanLabelByUserId,
      orgMembers,
      projectMembers,
    ],
  );
  // AI participants active in this conversation (default assistant when
  // enabled plus any added agents), each carrying its own avatar seed so the
  // roster faces match the transcript.
  const conversationRosterAgents = useMemo<ConversationRosterAgent[]>(() => {
    const seen = new Set<string>();
    const rosterAgents: ConversationRosterAgent[] = [];
    for (const rawHandle of agentHandles) {
      const handle = rawHandle.trim().toLowerCase();
      if (!handle || seen.has(handle)) {
        continue;
      }
      seen.add(handle);
      const profile = agentByHandle.get(handle) ?? null;
      const avatarSeed =
        typeof profile?.avatarSeed === "string" && profile.avatarSeed.trim().length > 0
          ? profile.avatarSeed.trim()
          : handle;
      const displayName =
        getBuiltInAssistantDisplayName(handle) ??
        (profile?.displayName?.trim() ? profile.displayName.trim() : `@${handle}`);
      rosterAgents.push({ handle, displayName, avatarSeed });
    }
    return rosterAgents;
  }, [agentByHandle, agentHandles]);

  const peerTypingLabel = useMemo(() => {
    const peerIds = Object.keys(peerTypingActivity);
    if (peerIds.length === 0) {
      return null;
    }

    const names = peerIds
      .map((peerId) => humanLabelByUserId.get(peerId) ?? "Teammate")
      .filter((name) => name.trim().length > 0);
    names.sort((a, b) => a.localeCompare(b));

    if (names.length === 1) {
      return `${names[0]} is typing…`;
    }
    if (names.length === 2) {
      return `${names[0]} and ${names[1]} are typing…`;
    }
    return `${names[0]} and ${names.length - 1} others are typing…`;
  }, [humanLabelByUserId, peerTypingActivity]);

  const firstPlanMessageId = useMemo(() => {
    for (const message of messages) {
      const type = getMessageType(message);
      if (type && type.toLowerCase() === "todo_list") {
        return message.id;
      }
    }
    return null;
  }, [messages]);

  const collapsedConversationMessages = useMemo(() => collapseLifecycleMessages(messages), [messages]);

  const displayedMessages = useMemo(() => {
    const collapsedVisible = collapsedConversationMessages.filter((message) => shouldDisplayChatMessage(message));
    const jobThreads = synthesizeAgentJobThreadMessages(collapsedConversationMessages, collapsedVisible);

    const parentControllerId = activeConversation?.controllerId ?? null;
    if (!parentControllerId) {
      return jobThreads;
    }

    const threads = (conversations ?? [])
      .filter((conversation) => conversation.parentConversationId === parentControllerId)
      .filter((conversation) => conversation.lifecycleStatus !== "deleted");

    if (threads.length === 0) {
      return jobThreads;
    }

    threads.sort((a, b) => a.createdAt - b.createdAt);

    const referencedThreadTargets = collectReferencedThreadTargets(jobThreads);
    const threadMessages: ChatMessage[] = [];
    threads.forEach((thread) => {
      const preview = buildParentConversationThreadMessage({
        thread,
        parentMessages: messages,
        collapsedThreadMessages: collapseLifecycleMessages(thread.messages),
      });
      if (
        shouldHideStandaloneConversationThreadPreview({
          thread,
          preview,
          referencedThreadTargets,
        })
      ) {
        return;
      }
      threadMessages.push(preview);
    });

    return [...jobThreads, ...threadMessages];
  }, [activeConversation?.controllerId, collapsedConversationMessages, conversations, messages]);

  useEffect(() => {
    if (autoRevealHistoryConversationRef.current !== activeConversationId) {
      autoRevealHistoryConversationRef.current = activeConversationId;
      autoRevealHistoryAttemptRef.current = 0;
    }
    if (!activeConversationId || !hasMoreHistory || isHistoryLoading) {
      return;
    }
    if (hasVisibleConversationAnchor(displayedMessages)) {
      return;
    }
    if (autoRevealHistoryAttemptRef.current >= MAX_AUTO_REVEAL_HISTORY_FETCHES) {
      return;
    }

    autoRevealHistoryAttemptRef.current += 1;
    void requestOlderMessages();
  }, [
    activeConversationId,
    displayedMessages,
    hasMoreHistory,
    isHistoryLoading,
    requestOlderMessages,
  ]);

  const browserSessionAutoOpenedMessageIdsRef = useRef<Set<string>>(new Set());
  const browserSessionAutoOpenConversationKeyRef = useRef<string>("");
  const browserSessionAutoOpenActivatedAtRef = useRef<number>(0);
  useEffect(() => {
    const conversationKey = activeConversationId ?? "__none__";
    if (browserSessionAutoOpenConversationKeyRef.current !== conversationKey) {
      browserSessionAutoOpenConversationKeyRef.current = conversationKey;
      browserSessionAutoOpenedMessageIdsRef.current = new Set();
      browserSessionAutoOpenActivatedAtRef.current = Date.now();
    }

    const candidates = messages
      .map((message) => {
        const candidate = resolveBrowserSessionAutoOpenCandidate(message);
        if (!candidate) {
          return null;
        }
        return {
          id: message.id,
          runtimeId: candidate.runtimeId,
          timestamp: message.timestamp,
        };
      })
      .filter((value): value is { id: string; runtimeId: string | null; timestamp: number } => value !== null);
    if (candidates.length === 0) {
      return;
    }

    const seenIds = browserSessionAutoOpenedMessageIdsRef.current;
    const unseen = candidates.filter((candidate) => !seenIds.has(candidate.id));
    if (unseen.length === 0) {
      return;
    }
    candidates.forEach((candidate) => seenIds.add(candidate.id));

    const newest = unseen[unseen.length - 1];
    const activatedAt = browserSessionAutoOpenActivatedAtRef.current;
    const candidateTimestamp = Number.isFinite(newest.timestamp) ? newest.timestamp : 0;
    // Only auto-open for real-time command executions; historical messages (or malformed timestamps)
    // should not spawn the browser session surface on conversation switch.
    if (candidateTimestamp <= 0 || candidateTimestamp < activatedAt - 1_000) {
      return;
    }

    openBrowserSession(newest.runtimeId);
  }, [activeConversationId, messages, openBrowserSession]);
  const activeConversationRuns = useMemo<RunRecord[]>(() => {
    const controllerId = activeConversationEntry?.controllerId ?? null;
    if (!controllerId) {
      return [];
    }

    const nowMs = Date.now();
    const byId = new Map<string, RunRecord>();
    const pendingRunIds = activeConversationEntry?.pendingRunIds ?? [];
    const hasNonRecoverableErrorForRun = (runId: string) =>
      messages.some((message) => isNonRecoverableRunErrorMessage(message, runId));
    for (const runId of pendingRunIds) {
      const run = runs?.[runId];
      if (
        !run ||
        run.conversationId !== controllerId ||
        !isRunActivelyProgressing(run, nowMs) ||
        hasNonRecoverableErrorForRun(run.id)
      ) {
        continue;
      }
      byId.set(run.id, run);
    }

    for (const run of Object.values(runs ?? {})) {
      if (
        run.conversationId !== controllerId ||
        !isRunActivelyProgressing(run, nowMs) ||
        hasNonRecoverableErrorForRun(run.id)
      ) {
        continue;
      }
      byId.set(run.id, run);
    }

    const candidates = Array.from(byId.values());
    if (candidates.length === 0) {
      return [];
    }

    candidates.sort((left, right) => resolveRunSortTimestamp(right) - resolveRunSortTimestamp(left));
    return candidates;
  }, [activeConversationEntry?.controllerId, activeConversationEntry?.pendingRunIds, messages, runs]);
  const activeConversationRun = activeConversationRuns[0] ?? null;
  const showOutOfCreditsNotice = outOfCredits && activeConversationRuns.length === 0;
  // Keep the complete active-handle set for existing busy/queue overlap
  // behavior. Steer discovery applies the narrower silent-evaluation guard
  // below without changing dispatch concurrency semantics.
  const activeConversationRunAgentHandles = useMemo(() => {
    const handles = new Set<string>();
    for (const run of activeConversationRuns) {
      const metadata = run.metadata && isRecord(run.metadata) ? run.metadata : null;
      const identity = extractAgentIdentityFromMetadata(metadata);
      if (identity) {
        handles.add(identity.handle);
      }
    }
    return handles;
  }, [activeConversationRuns]);
  const steerableActiveConversationRuns = useMemo(
    () => resolveSteerableComposerRuns(activeConversationRuns, messages),
    [activeConversationRuns, messages],
  );
  const steerableActiveConversationRunAgentHandles = useMemo(() => {
    const handles = new Set<string>();
    for (const run of steerableActiveConversationRuns) {
      const metadata = run.metadata && isRecord(run.metadata) ? run.metadata : null;
      const identity = extractAgentIdentityFromMetadata(metadata);
      if (identity) {
        handles.add(identity.handle);
      }
    }
    return handles;
  }, [steerableActiveConversationRuns]);
  const composerTargetAgentHandles = useMemo(() => {
    const prompt = inputValue.trim().length > 0
      ? inputValue
      : (softPrefillSuggestion ?? "");
    return resolvePromptAgentTargets(prompt, {
      useSticky: true,
      updateSticky: false,
    }).targetHandles;
  }, [inputValue, resolvePromptAgentTargets, softPrefillSuggestion]);
  const candidateComposerPrimaryActionMode = resolveComposerPrimaryActionMode({
    // Queue-dispatched and cross-device runs can become active without going
    // through this tab's optimistic typing state. The reconciled controller
    // run set is already conversation-scoped, terminal-filtered, and bounded
    // by the active-run freshness policy, so it is the authoritative fallback
    // for exposing Steer in those cases.
    isAssistantActive: isAssistantTyping || steerableActiveConversationRuns.length > 0,
    targetAgentHandles: composerTargetAgentHandles,
    activeAgentHandles: steerableActiveConversationRunAgentHandles,
  });
  const composerHasActiveMatchingAgent = candidateComposerPrimaryActionMode === "steer";
  const expectedSteerRun = useMemo(() => {
    if (!composerHasActiveMatchingAgent) {
      return null;
    }
    const matchingRuns = steerableActiveConversationRuns.filter((run) => {
      if (steerableActiveConversationRunAgentHandles.size === 0) {
        return true;
      }
      const metadata = run.metadata && isRecord(run.metadata) ? run.metadata : null;
      const identity = extractAgentIdentityFromMetadata(metadata);
      return Boolean(identity && composerTargetAgentHandles.includes(identity.handle));
    });
    return matchingRuns.length === 1 ? matchingRuns[0] : null;
  }, [
    composerHasActiveMatchingAgent,
    composerTargetAgentHandles,
    steerableActiveConversationRunAgentHandles,
    steerableActiveConversationRuns,
  ]);
  const expectedActiveJobId = resolveExpectedSteerJobId(expectedSteerRun, messages);
  // True steering is an exact-job CAS. If older run metadata cannot identify
  // that job unambiguously, fall back to ordinary Send/Queue behavior rather
  // than risk steering a replacement run on the same agent lane.
  const composerPrimaryActionMode = requireExpectedJobForSteer(
    candidateComposerPrimaryActionMode,
    expectedActiveJobId,
  );
  composerPrimaryActionRef.current = {
    mode: composerPrimaryActionMode,
    expectedActiveJobId,
  };

  const typingIndicatorFallback = useMemo<{ phase: TypingIndicatorPhase; label: string | null } | null>(() => {
    if (!isAssistantTyping) {
      return null;
    }
    if (waitingForPreferredRuntime || hostedRuntimeEnsuring) {
      return { phase: "waiting", label: null };
    }

    if (!activeConversationRun) {
      return { phase: "waiting", label: null };
    }

    if (activeConversationRun.status === "queued") {
      return { phase: "waiting", label: null };
    }

    if (activeConversationRun.status === "awaiting_approval") {
      return { phase: "waiting", label: "Waiting for approval to continue…" };
    }

    if (activeConversationRun.status === "in_progress") {
      return { phase: "thinking", label: "Thinking…" };
    }

    return null;
  }, [activeConversationRun, hostedRuntimeEnsuring, isAssistantTyping, waitingForPreferredRuntime]);

  const typingIndicatorState = useMemo(() => {
    if (!isAssistantTyping) {
      return null;
    }
    return resolveTypingIndicatorState(messages, typingIndicatorFallback);
  }, [isAssistantTyping, messages, typingIndicatorFallback]);
  const typingAgentIdentity = useMemo<AssistantAgentIdentity | null>(() => {
    const activeRunMetadata =
      activeConversationRun?.metadata && isRecord(activeConversationRun.metadata)
        ? (activeConversationRun.metadata as Record<string, unknown>)
        : null;
    const activeRunIdentity = extractAgentIdentityFromMetadata(activeRunMetadata);
    if (activeRunIdentity) {
      return activeRunIdentity;
    }
    for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
      const message = messages[cursor];
      if (message.role !== "assistant") {
        continue;
      }
      const messageType = (getMessageType(message) ?? "").trim().toLowerCase();
      if (messageType === "agent_job_thread") {
        continue;
      }
      const metadata =
        message.metadata && isRecord(message.metadata) ? (message.metadata as Record<string, unknown>) : null;
      const metadataIdentity = extractAgentIdentityFromMetadata(metadata);
      if (metadataIdentity) {
        return metadataIdentity;
      }
      const runId = extractRunIdFromMetadata(metadata);
      if (runId) {
        const runIdentity = runAgentIdentityByRunId.get(runId);
        if (runIdentity) {
          return runIdentity;
        }
      }
    }
    return null;
  }, [activeConversationRun?.metadata, messages, runAgentIdentityByRunId]);
  const typingAgentHandle =
    typingAgentIdentity?.handle ?? primaryAgentHandleForPopover ?? getDefaultAssistantHandle();
  const typingAgentProfile = agentByHandle.get(typingAgentHandle) ?? null;
  const typingAgentAvatarSeed =
    typeof typingAgentProfile?.avatarSeed === "string" && typingAgentProfile.avatarSeed.trim().length > 0
      ? typingAgentProfile.avatarSeed.trim()
      : typingAgentIdentity?.avatarSeed ?? typingAgentHandle;
  const typingAgentDisplayName =
    getBuiltInAssistantDisplayName(typingAgentHandle) ??
    (typingAgentProfile?.displayName?.trim()
      ? typingAgentProfile.displayName.trim()
      : `@${typingAgentHandle}`);
  const sharedBrowserControlOwner = resolveSharedBrowserControlOwner({
    activeRuns: activeConversationRuns,
    browserPageId: preferredBrowserPage?.id ?? null,
    browserRuntimeId: resolvedBrowserRuntimeId,
  });
  const typingAgents = useMemo<AssistantTypingAgent[]>(() => {
    const order: string[] = [];
    const thinkingHandles = new Set<string>();
    for (const run of activeConversationRuns) {
      const metadata = run.metadata && isRecord(run.metadata) ? run.metadata : null;
      const identity = extractAgentIdentityFromMetadata(metadata);
      if (identity?.handle) {
        order.push(identity.handle);
        if (run.status === "in_progress") {
          thinkingHandles.add(identity.handle);
        }
      }
    }
    if (order.length === 0) {
      order.push(typingAgentHandle);
    }
    const uniqueHandles: string[] = [];
    const seen = new Set<string>();
    for (const handle of order) {
      const normalized = handle.trim().toLowerCase();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      uniqueHandles.push(normalized);
    }
    return uniqueHandles.map((handle) => {
      const profile = agentByHandle.get(handle) ?? null;
      const avatarSeed =
        typeof profile?.avatarSeed === "string" && profile.avatarSeed.trim().length > 0
          ? profile.avatarSeed.trim()
          : handle;
      const displayName =
        getBuiltInAssistantDisplayName(handle) ??
        (profile?.displayName?.trim() ? profile.displayName.trim() : `@${handle}`);
      return { handle, avatarSeed, displayName, isThinking: thinkingHandles.has(handle) };
    });
  }, [activeConversationRuns, agentByHandle, typingAgentHandle]);
  const hasMultipleTypingAgents = typingAgents.length > 1;
  const multiTypingPhase = useMemo<"waiting" | "thinking">(() => {
    if (!hasMultipleTypingAgents) {
      return "thinking";
    }
    for (const run of activeConversationRuns) {
      if (run.status === "in_progress") {
        return "thinking";
      }
    }
    if (typingIndicatorState?.phase === "waiting") {
      return "waiting";
    }
    return "thinking";
  }, [activeConversationRuns, hasMultipleTypingAgents, typingIndicatorState?.phase]);
  const chatRuntimeActivityValue = useMemo(
    () => ({
      workspaceStarting:
        waitingForPreferredRuntime ||
        hostedRuntimeEnsuring ||
        (!runtimeReady && activeConversationRun?.status === "queued"),
    }),
    [activeConversationRun?.status, hostedRuntimeEnsuring, runtimeReady, waitingForPreferredRuntime],
  );
  const waitingActivityCopy = resolveAgentWaitingActivityCopy({
    displayNames: hasMultipleTypingAgents
      ? typingAgents.map((agent) => agent.displayName)
      : [typingAgentDisplayName],
    workspaceStarting:
      waitingForPreferredRuntime ||
      hostedRuntimeEnsuring ||
      (!runtimeReady && activeConversationRun?.status === "queued"),
    queued: activeConversationRun?.status === "queued",
    runtimeLimit:
      !runtimeReady && runtimeEnsureLimit?.limitReached
        ? {
            limitReached: true,
            blockerProjectLabel: runtimeEnsureLimit.blockerProjectLabel,
            blockerRuntimeLabel: runtimeEnsureLimit.blockerRuntimeLabel,
          }
        : null,
  });
  const typingStatusLabel = hasMultipleTypingAgents
    ? (multiTypingPhase === "waiting" ? waitingActivityCopy.label : "Thinking…")
    : (typingIndicatorState?.label ??
      (typingIndicatorState?.phase === "finalizing"
        ? "Finalizing…"
        : typingIndicatorState?.phase === "compacting"
          ? COMPACTION_STATUS_LABEL
        : typingIndicatorState?.phase === "thinking"
          ? "Thinking…"
          : typingIndicatorState?.phase === "waiting"
            ? waitingActivityCopy.label
            : "Typing…"));
  const typingStatusAriaLabel = hasMultipleTypingAgents
    ? multiTypingPhase === "waiting"
      ? waitingActivityCopy.ariaLabel
      : `${typingAgents.map((agent) => agent.displayName).join(", ")} are thinking`
    : typingIndicatorState?.label
      ? `${typingAgentDisplayName} status: ${typingIndicatorState.label}`
      : typingIndicatorState?.phase === "finalizing"
        ? `${typingAgentDisplayName} is finalizing response`
        : typingIndicatorState?.phase === "compacting"
          ? `${typingAgentDisplayName} is reorganizing context`
        : typingIndicatorState?.phase === "thinking"
          ? `${typingAgentDisplayName} is thinking`
          : typingIndicatorState?.phase === "waiting"
            ? waitingActivityCopy.ariaLabel
            : `${typingAgentDisplayName} is typing`;
  const staleStartingRecoveryKey = useMemo(
    () =>
      resolveStaleStartingRecoveryKey({
        isAssistantTyping,
        typingPhase: typingIndicatorState?.phase ?? null,
        runtimeControllerEnabled,
        runtimeReady,
        waitingForPreferredRuntime,
        hostedRuntimeEnsuring,
        runtimeEnsureError,
        activeConversationId,
        activeConversationControllerId,
        pendingRunIds: activeConversationEntry?.pendingRunIds ?? [],
      }),
    [
      activeConversationControllerId,
      activeConversationEntry?.pendingRunIds,
      activeConversationId,
      hostedRuntimeEnsuring,
      isAssistantTyping,
      runtimeEnsureError,
      runtimeReady,
      typingIndicatorState?.phase,
      waitingForPreferredRuntime,
    ],
  );
  useEffect(() => {
    if (!staleStartingRecoveryKey) {
      if (staleStartingRecoveryTimeoutRef.current) {
        clearTimeout(staleStartingRecoveryTimeoutRef.current);
        staleStartingRecoveryTimeoutRef.current = null;
      }
      staleStartingRecoveryKeyRef.current = null;
      return;
    }
    if (staleStartingRecoveryKeyRef.current === staleStartingRecoveryKey) {
      return;
    }

    if (staleStartingRecoveryTimeoutRef.current) {
      clearTimeout(staleStartingRecoveryTimeoutRef.current);
      staleStartingRecoveryTimeoutRef.current = null;
    }
    staleStartingRecoveryKeyRef.current = staleStartingRecoveryKey;
    staleStartingRecoveryTimeoutRef.current = setTimeout(() => {
      staleStartingRecoveryTimeoutRef.current = null;
      const now = Date.now();
      if (now >= staleStartingRecoveryCooldownUntilRef.current) {
        staleStartingRecoveryCooldownUntilRef.current = now + 20_000;
        showStatus("Octo is still starting. Re-syncing runtime status…", "info", 3500);
      }
      void refreshRuntimeStatuses();
    }, STALE_STARTING_RECOVERY_DELAY_MS);
  }, [refreshRuntimeStatuses, showStatus, staleStartingRecoveryKey]);
  useEffect(
    () => () => {
      if (staleStartingRecoveryTimeoutRef.current) {
        clearTimeout(staleStartingRecoveryTimeoutRef.current);
        staleStartingRecoveryTimeoutRef.current = null;
      }
    },
    [],
  );
  const isAssistantTypingCoveredByJobThreadPreview = useMemo(() => {
    if (!isAssistantTyping) {
      return false;
    }
    const latestDisplayedMessage = displayedMessages[displayedMessages.length - 1];
    if (!latestDisplayedMessage) {
      return false;
    }
    const messageType = (getMessageType(latestDisplayedMessage) ?? "").trim().toLowerCase();
    if (messageType !== "agent_job_thread") {
      return false;
    }
    const metadata = latestDisplayedMessage.metadata;
    const threadMessages = coerceThreadMessages(
      metadata && isRecord(metadata) ? metadata["threadMessages"] : null,
    );
    if (threadMessages.length === 0) {
      return false;
    }
    return resolveThreadRunStatusFromMessages(threadMessages).phase !== "completed";
  }, [displayedMessages, isAssistantTyping]);
  const activeAssistantAvatarMotion = useMemo<{
    messageId: string;
    motion: AssistantAvatarMotion;
  } | null>(() => {
    if (
      !isAssistantTypingCoveredByJobThreadPreview ||
      typingIndicatorState?.phase !== "thinking"
    ) {
      return null;
    }

    const latestDisplayedMessage = displayedMessages[displayedMessages.length - 1];
    if (!latestDisplayedMessage) {
      return null;
    }
    const jobId = extractAgentJobId(latestDisplayedMessage);
    const matchingRun =
      jobId && !jobId.startsWith("thread:")
        ? activeConversationRuns.find((run) => runMatchesThreadJobId(run, jobId)) ?? null
        : activeConversationRun;
    if (matchingRun?.status !== "in_progress") {
      return null;
    }

    return { messageId: latestDisplayedMessage.id, motion: "thinking" };
  }, [
    activeConversationRun,
    activeConversationRuns,
    displayedMessages,
    isAssistantTypingCoveredByJobThreadPreview,
    typingIndicatorState?.phase,
  ]);
  const [isThinkingLabelExpanded, setIsThinkingLabelExpanded] = useState(false);

  useEffect(() => {
    setIsThinkingLabelExpanded(false);
  }, [typingIndicatorState?.label, isAssistantTyping]);

  const [stickyChatSpeaker, setStickyChatSpeaker] =
    useState<StickyChatSpeaker | null>(null);
  // Rendered in the roster row above the transcript (never inside the
  // scroller), so the ref stays valid for as long as the chat panel is
  // mounted — the sticky-speaker effect below no longer reads its rect (see
  // CHAT_TRANSCRIPT_VISIBLE_TOP_INSET_PX), but ChatSpeakerStickyOverlay still
  // takes a ref, so this stays the one it's given.
  const stickySpeakerOverlayRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      setStickyChatSpeaker(null);
      return;
    }

    let animationFrameId: number | null = null;
    const readAndApplySpeaker = () => {
      // The pill lives in the roster row now, physically separate from the
      // transcript, so its own rect can no longer mark the handoff line — a
      // marker's inline label only needs to hide once it has actually
      // scrolled past the transcript's own visible top edge.
      const containerRect = scrollContainer.getBoundingClientRect();
      const thresholdTop = containerRect.top + CHAT_TRANSCRIPT_VISIBLE_TOP_INSET_PX;
      const markers = Array.from(
        scrollContainer.querySelectorAll(CHAT_SPEAKER_MARKER_SELECTOR),
      );
      let nextSpeaker: StickyChatSpeaker | null = null;
      for (const marker of markers) {
        const markerTop = marker.getBoundingClientRect().top;
        const hasReachedStickyLine = markerTop <= thresholdTop;
        const inlineSpeaker =
          isAssistantSpeakerMarker(marker) || isHumanSpeakerMarker(marker)
            ? marker.nextElementSibling
            : null;
        if (inlineSpeaker instanceof HTMLElement && inlineSpeaker.matches(NARROW_SPEAKER_INLINE_SELECTOR)) {
          if (hasReachedStickyLine) {
            inlineSpeaker.dataset.chatSpeakerCovered = "true";
          } else {
            delete inlineSpeaker.dataset.chatSpeakerCovered;
          }
        }
        if (hasReachedStickyLine) {
          nextSpeaker = readStickyChatSpeakerMarker(marker);
        }
      }
      setStickyChatSpeaker((currentSpeaker) =>
        speakersEqual(currentSpeaker, nextSpeaker) ? currentSpeaker : nextSpeaker,
      );
    };
    const scheduleSpeakerUpdate = () => {
      if (animationFrameId !== null) {
        return;
      }
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        readAndApplySpeaker();
      });
    };

    readAndApplySpeaker();
    scrollContainer.addEventListener("scroll", scheduleSpeakerUpdate, { passive: true });
    window.addEventListener("resize", scheduleSpeakerUpdate);

    return () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      scrollContainer.removeEventListener("scroll", scheduleSpeakerUpdate);
      window.removeEventListener("resize", scheduleSpeakerUpdate);
    };
  }, [
    activeConversationId,
    displayedMessages,
    isAssistantTyping,
    scrollContainerRef,
    typingAgentAvatarSeed,
    typingAgentHandle,
  ]);

  const conversationLabel = activeConversation?.title ? `Conversation: ${activeConversation.title}` : "Conversation";

  const selectedMessage = useMemo(() => {
    if (!messageMenu || messageMenu.kind !== "message" || !messageMenu.messageId) {
      return null;
    }
    return (
      messages.find((message) => message.id === messageMenu.messageId) ??
      displayedMessages.find((message) => message.id === messageMenu.messageId) ??
      null
    );
  }, [displayedMessages, messageMenu, messages]);

  const selectedMessageTokenUsage = useMemo(() => {
    if (!messageMenu || messageMenu.kind !== "message" || !messageMenu.messageId) {
      return null;
    }
    return resolveTokenUsageForMessage(messages, messageMenu.messageId);
  }, [messageMenu, messages]);

  // "Open run thread in a tab" is a secondary action, so it lives in the message
  // context menu (right-click / press-and-hold) rather than a persistent button.
  const openSelectedMessageThread = useMemo(() => {
    if (!selectedMessage) {
      return null;
    }
    const messageType = (getMessageType(selectedMessage) ?? "").trim().toLowerCase();
    if (messageType !== "agent_job_thread") {
      return null;
    }
    const metadata =
      selectedMessage.metadata && isRecord(selectedMessage.metadata)
        ? (selectedMessage.metadata as Record<string, unknown>)
        : null;
    const threadLocalId =
      typeof metadata?.threadLocalId === "string" ? metadata.threadLocalId.trim() : "";
    const jobId = extractAgentJobId(selectedMessage);
    if (!threadLocalId && (!jobId || !activeConversationId)) {
      return null;
    }
    return () => {
      requestUrlPush();
      if (threadLocalId) {
        openConversationTab(threadLocalId);
      } else if (jobId && activeConversationId) {
        openJobThreadTab({ conversationId: activeConversationId, jobId });
      }
    };
  }, [
    activeConversationId,
    openConversationTab,
    openJobThreadTab,
    requestUrlPush,
    selectedMessage,
  ]);

  const closeMessageMenu = useCallback(() => {
    setMessageMenu(null);
  }, []);

  useEffect(() => {
    if (!messageMenu) {
      return;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMessageMenu();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    const removeViewportChangeListener =
      addFloatingSurfaceViewportChangeListener(closeMessageMenu);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      removeViewportChangeListener();
    };
  }, [closeMessageMenu, messageMenu]);

  useEffect(() => {
    if (!imageLightbox) {
      return;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setImageLightbox(null);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [imageLightbox]);

  const openMessageMenuAt = useCallback((messageId: string, clientX: number, clientY: number) => {
    const { x, y, maxHeight } = clampMessageMenuPosition(clientX, clientY);
    const liveSelectedText = getCurrentSelectedTextForMessage(messageId);
    const recentSelection = recentMessageSelectionRef.current;
    const recentSelectedText =
      recentSelection &&
      recentSelection.messageId === messageId &&
      Date.now() - recentSelection.capturedAt < 10_000
        ? recentSelection.selectedText
        : null;
    setMessageMenu({
      kind: "message",
      messageId,
      selectedText: liveSelectedText ?? recentSelectedText,
      x,
      y,
      maxHeight,
      view: "actions",
    });
  }, []);

  const openConversationMenuAt = useCallback((clientX: number, clientY: number) => {
    const { x, y, maxHeight } = clampMessageMenuPosition(clientX, clientY);
    setMessageMenu({
      kind: "conversation",
      messageId: null,
      selectedText: null,
      x,
      y,
      maxHeight,
      view: "actions",
    });
  }, []);

  const handleMessageContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>, messageId: string) => {
      event.preventDefault();
      event.stopPropagation();
      openMessageMenuAt(messageId, event.clientX, event.clientY);
    },
    [openMessageMenuAt]
  );

  const handleConversationContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) {
        return;
      }
      const target = event.target;
      if (target instanceof Element) {
        if (
          target.closest("button, a, input, textarea, select, [role='button'], [role='menuitem'], [contenteditable='true']")
        ) {
          return;
        }
      }
      event.preventDefault();
      openConversationMenuAt(event.clientX, event.clientY);
    },
    [openConversationMenuAt],
  );

  const handleMessageActionsRequest = useCallback(
    (messageId: string, anchorRect: DOMRect | null) => {
      if (!anchorRect) {
        return;
      }
      const prefersLeftAlign =
        typeof window === "undefined" ||
        anchorRect.left + MESSAGE_MENU_WIDTH + MESSAGE_MENU_PADDING <= window.innerWidth;
      const preferredX = prefersLeftAlign ? anchorRect.left : anchorRect.right - MESSAGE_MENU_WIDTH;
      openMessageMenuAt(messageId, preferredX, anchorRect.bottom + 6);
    },
    [openMessageMenuAt]
  );

  const handleMessageActionsAtPoint = useCallback(
    (messageId: string, clientX: number, clientY: number) => {
      openMessageMenuAt(messageId, clientX, clientY);
    },
    [openMessageMenuAt],
  );

  const handleCopySelectedMessage = useCallback(async () => {
    if (!selectedMessage) {
      return;
    }
    const content = resolveCopyableMessageContent(selectedMessage);
    if (!content) {
      showStatus("No message content to copy.", "warning", 3000);
      closeMessageMenu();
      return;
    }
    try {
      await writeClipboardText(content);
      showStatus("Copied message.", "success", 2000, { presentation: "confirmation" });
      closeMessageMenu();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Unable to copy message: ${message}`, "error", 4000);
    }
  }, [closeMessageMenu, selectedMessage, showStatus]);

  const handleCopyConversation = useCallback(async () => {
    const transcript = formatConversationTranscript(displayedMessages);

    if (!transcript) {
      showStatus("No conversation messages to copy.", "warning", 3000);
      closeMessageMenu();
      return;
    }

    try {
      await writeClipboardText(transcript);
      showStatus("Copied conversation.", "success", 2000, { presentation: "confirmation" });
      closeMessageMenu();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Unable to copy conversation: ${message}`, "error", 4000);
    }
  }, [closeMessageMenu, displayedMessages, showStatus]);

  const handleCopyTokenUsage = useCallback(async () => {
    if (!selectedMessageTokenUsage) {
      return;
    }
    const contextSummary = selectedMessageTokenUsage.context
      ? `\nContext — ${formatPromptContextModeLabel(selectedMessageTokenUsage.context)}${
          selectedMessageTokenUsage.context.estimatedPromptTokens !== null
            ? `, prompt est: ${Math.round(selectedMessageTokenUsage.context.estimatedPromptTokens)}`
            : ""
        }${
          selectedMessageTokenUsage.context.estimatedPromptUsagePercent !== null
            ? `, window: ${selectedMessageTokenUsage.context.estimatedPromptUsagePercent}%`
            : ""
        }`
      : "";
    const summary = `Message stats — input: ${selectedMessageTokenUsage.inputTokens}, cached: ${selectedMessageTokenUsage.cachedInputTokens}, output: ${selectedMessageTokenUsage.outputTokens}${contextSummary}`;
    try {
      await writeClipboardText(summary);
      showStatus("Copied message stats.", "success", 2000, { presentation: "confirmation" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Unable to copy message stats: ${message}`, "error", 4000);
    }
  }, [selectedMessageTokenUsage, showStatus]);

  const handleSelectionReplyAction = useCallback(
    (action: MessageSelectionReplyAction) => {
      if (!selectedMessage || !messageMenu?.selectedText) {
        showStatus("Select text in a message first.", "info", 2500);
        closeMessageMenu();
        return;
      }
      const context = buildMessageSelectionReplyContext({
        action,
        conversationId: activeConversationControllerId ?? activeConversationId,
        message: selectedMessage,
        selectedText: messageMenu.selectedText,
      });
      if (!context) {
        showStatus("Select text in a message first.", "info", 2500);
        closeMessageMenu();
        return;
      }

      const instruction =
        action === "summarize" ? "Summarize" : action === "explain_more" ? "Explain more" : null;
      const nextValue = formatSelectionReplyComposerText({ context, instruction });
      closeMessageMenu();

      if (shouldStageSelectionReplyDraft(action)) {
        latestInputValueRef.current = nextValue;
        chatInputRef.current?.focusAfterValueSync();
        onInputChange(activeConversationId, nextValue, null);
        pendingReplyContextRef.current = context;
        focusInput({ force: true });
        return;
      }

      pendingReplyContextRef.current = null;
      void invokeSubmitMessage({
        message: nextValue,
        editorState: null,
        metadata: { replyContext: context },
      });
    },
    [
      activeConversationControllerId,
      activeConversationId,
      closeMessageMenu,
      focusInput,
      invokeSubmitMessage,
      messageMenu?.selectedText,
      onInputChange,
      selectedMessage,
      showStatus,
    ],
  );

  const inputRequiresAi = useMemo(() => {
    return resolveChatInputRequiresAi({
      activeConversationMessages: messages,
      inputValue,
      hasImageAttachments: imageAttachments.length > 0,
      fallbackSuggestion: softPrefillSuggestion,
      resolvePromptAgentTargets,
    });
  }, [
    imageAttachments.length,
    inputValue,
    messages,
    resolvePromptAgentTargets,
    softPrefillSuggestion,
  ]);

  const inputReplyToOcto = useMemo(() => {
    const pendingReplyContext = pendingReplyContextRef.current;
    if (!shouldAttachPendingReplyContext(pendingReplyContext, inputValue)) {
      return false;
    }
    return resolveGroupParticipationReplyTargets(
      { replyContext: pendingReplyContext },
      messages,
      getDefaultAssistantHandle(),
    ).replyToOcto;
    // inputValue changes when a selection reply is staged, making the ref-backed
    // reply context observable to this synchronous composer affordance.
  }, [inputValue, messages]);

  const inputCanRunAmbientParticipationPreflight = useMemo(
    () =>
      resolveChatInputCanRunAmbientParticipationPreflight({
        inputValue,
        hasImageAttachments: imageAttachments.length > 0,
        fallbackSuggestion: softPrefillSuggestion,
        activeConversationControllerId,
        conversationHasHumanPeer:
          conversationHumanPeerContext.resolved &&
          conversationHumanPeerContext.hasHumanPeer,
        assistantEnabled,
        threadKind: activeConversationEntry?.threadKind ?? null,
        ownerAgentHandle: activeConversationEntry?.ownerAgent?.handle ?? null,
        hasBrowserTask: resolveChatInputHasBrowserTask({
          inputValue,
          hasImageAttachments: imageAttachments.length > 0,
          fallbackSuggestion: softPrefillSuggestion,
          personalBrowserActive:
            browserTransport === "personal" && browserSessionOpen,
          sharedBrowserModeActive:
            browserTransport === "shared" && browserModeActive,
          pendingNewBrowser: pendingBrowserLaunchMode === "new_page",
          sharedBrowserPageTargetAvailable:
            browserTransport === "shared" &&
            (browserSessionOpen || hasHiddenBrowserSession) &&
            Boolean(preferredBrowserPage),
        }),
        replyToOcto: inputReplyToOcto,
        defaultAssistantHandle: getDefaultAssistantHandle(),
        resolvePromptAgentTargets,
      }),
    [
      activeConversationControllerId,
      activeConversationEntry?.ownerAgent?.handle,
      activeConversationEntry?.threadKind,
      assistantEnabled,
      browserModeActive,
      browserSessionOpen,
      browserTransport,
      conversationHumanPeerContext.hasHumanPeer,
      conversationHumanPeerContext.resolved,
      hasHiddenBrowserSession,
      imageAttachments.length,
      inputReplyToOcto,
      inputValue,
      pendingBrowserLaunchMode,
      preferredBrowserPage,
      resolvePromptAgentTargets,
      softPrefillSuggestion,
    ],
  );

  const pinAiOnboardingToBottom = useCallback(() => {
    shouldAutoScrollRef.current = true;
    scrollToBottom();
  }, [scrollToBottom, shouldAutoScrollRef]);
  const onGithubImportSuccessRef = useRef<() => void>(() => {});

  const {
    activeAiCredentials,
    aiOnboardingMode,
    aiOnboardingOpen,
    availableCredentials,
    closeAiOnboarding,
    connectFromDesktop,
    credentialGateDetail,
    credentialInventoryStatus,
    credentialGateState,
    credentialGateStateForBubble,
    credentialRequirements,
    credentialsBusy,
    credentialsReady,
    defaultAiCredential,
    handleSetDefaultCredentialFromChat,
    openAiOnboarding,
    refreshCredentialGate,
    refreshCredentials,
    saveApiKey,
    stashDraftForCredentials,
    uploadAuthJsonFile,
  } = useChatCredentialGate({
    activeConversationId,
    activeProjectId,
    aiConnectWizardStorageKey,
    canUseDesktopConnect,
    currentUserId,
    focusInput,
    hasUser: Boolean(user),
    inputEditorState,
    inputRequiresAi,
    inputValue,
    messages,
    onInputChange,
    pinAiOnboardingToBottom,
    pendingCredentialAutoSubmitRef,
    refreshAvailableAgents,
    runtimeControllerEnabled,
    showStatus,
  });
  const {
    deferAiGatesForAmbientParticipation,
    credentialGateState: presentedCredentialGateState,
    credentialGateStateForBubble: presentedCredentialGateStateForBubble,
    revealAiGatesForCurrentDraft,
    showCredentialsGate: showChatCredentialsGate,
  } = useAmbientCredentialGatePresentation({
    activeConversationId,
    credentialGateState,
    credentialGateStateForBubble,
    fallbackSuggestion: softPrefillSuggestion,
    inputCanRunAmbientParticipationPreflight,
    inputValue,
    pinCredentialGateToBottom: pinAiOnboardingToBottom,
  });
  const {
    openConnectModal: openGettingStartedConnectModal,
    connectModalProps: gettingStartedConnectModalProps,
  } = useCredentialsConnectFlow({
    userPresent: Boolean(user),
    loadCredentials: refreshCredentials,
    notifyAiConfigChanged: emitAiConfigChanged,
    showStatus,
    formatCredentialTestFailureMessage: formatCredentialConnectionFailure,
    onOpenAiManager: openAiManager,
  });
  const {
    beginGithubDeviceAuth,
    cancelGithubDeviceAuthSession,
    clearGithubImportUi,
    githubDeviceAuthError,
    githubDeviceAuthSession,
    githubImportBusy,
    githubImportElapsedSeconds,
    githubImportError,
    githubRepoDraft,
    githubRefDraft,
    handleGithubRepoDraftChange,
    handleGithubRefDraftChange,
    handleImportGithub,
  } = useChatGithubImportFlow({
    activeConversationId,
    activeProjectId,
    appendMessages,
    onImportSuccess: () => {
      onGithubImportSuccessRef.current();
    },
    onRecordMessage,
    showStatus,
  });
  const {
    beginGithubImport,
    clearGettingStartedManagedAiSelection,
    dismissGettingStarted,
    gettingStartedManagedAiSelected,
    gettingStartedMode,
    handleGettingStartedAction,
    handleGettingStartedModeChange,
    onboardingInputLocked,
    selectGettingStartedManagedAi,
    shouldShowGettingStarted,
  } = useChatGettingStartedState({
    activeConversationId,
    activeProjectId,
    aiOnboardingOpen,
    anyAgentsEnabled,
    clearGithubImportUi,
    conversations,
    conversationsProjectKey,
    credentialGateState: presentedCredentialGateState,
    credentialsReady,
    currentUserId,
    displayedMessageCount: displayedMessages.length,
    githubImportBusy,
    gettingStartedContextRelevant: gettingStartedConversationContext.relevant,
    gettingStartedContextResolved: gettingStartedConversationContext.resolved,
    hasMoreHistory,
    inputValue,
    isHistoryLoading,
    remoteHistoryPresenceResolved:
      remoteConversationHistoryResolved && !isInitialHistoryLoading,
    onInputChange,
    runtimeControllerEnabled,
  });
  const {
    managedAiOffer: gettingStartedManagedAiOffer,
    selectedAi: gettingStartedSelectedAi,
    canChangeAiChoice: canChangeGettingStartedAiChoice,
    personalAiConnectionState: gettingStartedPersonalAiConnectionState,
    viewState: gettingStartedAiViewState,
  } = resolveGettingStartedAiChoices({
    runtimeControllerEnabled,
    hasUser: Boolean(user),
    requirementsResolved: credentialRequirements.requiresUserCredentials !== null,
    hasDefaultCredential: credentialRequirements.hasDefaultCredential,
    credentialInventoryStatus,
    managedAi: credentialRequirements.managedAi,
    managedAiSelected: gettingStartedManagedAiSelected,
  });
  const handleStartWithManagedAi = useCallback(() => {
    // Focus moves to the workspace step (the card handles it) — not the composer,
    // which would open the mobile keyboard over the next decision.
    selectGettingStartedManagedAi();
  }, [selectGettingStartedManagedAi]);
  const handleConnectOwnAi = useCallback(() => {
    if (gettingStartedPersonalAiConnectionState === "needs_default") {
      openAiOnboarding({ mode: "personal_only" });
      return;
    }
    openGettingStartedConnectModal();
  }, [gettingStartedPersonalAiConnectionState, openAiOnboarding, openGettingStartedConnectModal]);

  const { clearComposerAfterQueue, clearComposerIfUnchanged, performSubmit } = useChatSubmitDispatch({
    activeConversationId,
    clearInputEditor,
    clearImageAttachments,
    focusInput,
    isChatInputFocused,
    latestInputValueRef,
    mentionableAgentHandles,
    onInputChange,
    onSubmit,
    scrollToBottom,
    setSendingAttachment,
    shouldAutoScrollRef,
  });
  const {
    handleInvitePromptClose,
    handleInvitePromptInviteAndSend,
    handleInvitePromptSendWithout,
    invitePrompt,
    invitePromptBusy,
    openInvitePrompt,
  } = useChatInvitePromptHandlers({
    addConversationParticipant: addControllerConversationParticipant,
    performSubmit,
    showStatus,
  });

  // The invite prompt dismisses on backdrop tap; Escape must work too.
  useEffect(() => {
    if (!invitePrompt || invitePromptBusy) {
      return;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        handleInvitePromptClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleInvitePromptClose, invitePrompt, invitePromptBusy]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handler = (
      event: Event,
    ) => {
      const customEvent = event as CustomEvent<{
        messageId?: string;
        args?: unknown[];
        input?: string | null;
        completion?: Promise<unknown> | null;
      }>;
      const requestedPrecision = (() => {
        const raw = customEvent.detail?.args?.[0];
        if (typeof raw !== "string") {
          return "approximate" as LocationSharePrecision;
        }
        return raw.trim().toLowerCase() === "precise" ? "precise" : "approximate";
      })();

      customEvent.detail.completion = (async () => {
        const location = await requestCurrentLocation(requestedPrecision).catch((error) => {
          const message = error instanceof Error ? error.message : "Unable to access your location right now.";
          showStatus(message, "error", 4500);
          throw error;
        });

        const visibleMessage = buildSharedLocationVisibleMessage(requestedPrecision);
        const dispatchMessage = buildSharedLocationDispatchInput(location);
        if (!ensureProjectWriteAccess()) {
          return;
        }
        await performSubmit({
          message: dispatchMessage,
          composerMessage: visibleMessage,
          editorState: null,
          imageFiles: [],
        });
      })();
    };

    window.addEventListener("instafy:request-location", handler as EventListener);
    return () => {
      window.removeEventListener("instafy:request-location", handler as EventListener);
    };
  }, [ensureProjectWriteAccess, performSubmit, showStatus]);

  const enqueueChatSendQueueItem = useCallback(
    (payload: {
      message: string;
      editorState: string | null;
      targetAgentHandles: string[];
      browserPageTarget: BrowserSessionPageTarget | null;
      browserLaunchMode: "new_page" | null;
      metadata?: Record<string, unknown> | null;
      runtimeOverride?: SubmitConversationRuntimeOverride | null;
    }) => {
      if (!activeConversationId) {
        return;
      }
      const id =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `queue-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const nextItem: QueuedChatSendItem = {
        id,
        message: payload.message,
        editorState: payload.editorState,
        createdAt: Date.now(),
        targetAgentHandles: payload.targetAgentHandles,
        browserPageTarget: payload.browserPageTarget,
        browserLaunchMode: payload.browserLaunchMode,
        metadata: payload.metadata ?? null,
        ...(payload.runtimeOverride
          ? { runtimeOverride: payload.runtimeOverride }
          : {}),
      };
      setChatSendQueue((previous) => [...previous, nextItem]);
      setChatSendQueueExpanded(false);
    },
    [activeConversationId],
  );

  const removeChatSendQueueItem = useCallback(
    (id: string) => {
      if (serverSendQueueItems.some((item) => item.id === id)) {
        void removeServerSendQueueEntry(id);
        return;
      }
      setChatSendQueue((previous) => previous.filter((item) => item.id !== id));
    },
    [removeServerSendQueueEntry, serverSendQueueItems],
  );

  const reorderChatSendQueueItem = useCallback(
    (id: string, targetIndex: number) => {
      const currentIndex = combinedChatSendQueue.findIndex((item) => item.id === id);
      const boundedTargetIndex = Math.max(
        0,
        Math.min(targetIndex, combinedChatSendQueue.length - 1),
      );
      if (currentIndex < 0 || currentIndex === boundedTargetIndex) {
        return;
      }
      const desiredOrder = [...combinedChatSendQueue];
      const [movingItem] = desiredOrder.splice(currentIndex, 1);
      if (!movingItem) {
        return;
      }
      desiredOrder.splice(boundedTargetIndex, 0, movingItem);

      if (isServerQueuedChatSendItem(movingItem)) {
        const desiredServerOrder = desiredOrder.filter(isServerQueuedChatSendItem);
        const serverIndex = desiredServerOrder.findIndex((item) => item.id === id);
        const beforeEntryId = desiredServerOrder[serverIndex + 1]?.id ?? null;
        void reorderServerSendQueueEntry(id, beforeEntryId).then((reordered) => {
          if (!reordered) {
            showStatus("Couldn’t reorder the queue. The saved order was restored.");
          }
        });
        return;
      }

      setChatSendQueue(
        desiredOrder.filter((item) => !isServerQueuedChatSendItem(item)),
      );
    },
    [combinedChatSendQueue, reorderServerSendQueueEntry, showStatus],
  );

  const targetsOverlapActiveRuns = useCallback(
    (targetAgentHandles: string[]) => {
      if (!isAssistantTyping) {
        return false;
      }
      if (activeConversationRunAgentHandles.size === 0) {
        return true;
      }
      if (targetAgentHandles.length === 0) {
        return true;
      }
      for (const handle of targetAgentHandles) {
        if (activeConversationRunAgentHandles.has(handle)) {
          return true;
        }
      }
      return false;
    },
    [activeConversationRunAgentHandles, isAssistantTyping],
  );

  const submitSendIntent = useCallback(
    async ({
      mode,
      request,
      targetAgentHandles,
      expectedActiveJobId,
    }: {
      mode: "queue" | "steer";
      request: Record<string, unknown>;
      targetAgentHandles: string[];
      expectedActiveJobId: string | null;
    }): Promise<boolean> => {
      const conversationId = activeConversationEntry?.controllerId ?? null;
      if (!conversationId) {
        return false;
      }
      const attemptKey = createConversationSendIntentAttemptKey({
        conversationId,
        mode,
        request,
        expectedActiveJobId,
        targetAgentHandles,
      });
      const clientSendId =
        sendIntentAttemptRef.current?.key === attemptKey
          ? sendIntentAttemptRef.current.clientSendId
          : createConversationClientSendId();
      sendIntentAttemptRef.current = { key: attemptKey, clientSendId };
      try {
        const result = await sendConversationIntent({
          conversationId,
          clientSendId,
          mode,
          request,
          expectedActiveJobId,
          targetAgentHandles,
        });
        if (!result) {
          showStatus("Unable to reach the message controller right now.", "warning", 4500);
          return false;
        }
        if (sendIntentAttemptRef.current?.key === attemptKey) {
          sendIntentAttemptRef.current = null;
        }
        if (mode === "queue") {
          void refreshServerSendQueue();
          showStatus("Message queued.", "success", 2500);
        } else {
          showStatus("Steer added to the current reply.", "success", 3000);
        }
        return true;
      } catch (error) {
        if (error instanceof ControllerApiError) {
          if (sendIntentAttemptRef.current?.key === attemptKey) {
            sendIntentAttemptRef.current = null;
          }
          const message = (() => {
            switch (error.code) {
              case "no_active_job":
                return "That reply finished before the steer arrived. Your message is still in the composer.";
              case "ambiguous_active_job":
                return "More than one matching reply is active. Mention one agent, then try Steer again.";
              case "active_job_conflict":
                return "The active reply changed before the steer arrived. Review the current reply and try again.";
              case "active_turn_input_unavailable":
                return "This agent cannot accept Steer during its current turn. Queue the message instead.";
              case "send_intent_idempotency_conflict":
                return "This message conflicts with an earlier send attempt. Edit it slightly and try again.";
              default:
                return error.message;
            }
          })();
          showStatus(message, "warning", 5500);
          return false;
        }
        const message = error instanceof Error ? error.message : "Unable to apply this message action.";
        showStatus(message, "error", 5000);
        return false;
      }
    },
    [activeConversationEntry?.controllerId, refreshServerSendQueue, showStatus],
  );

  const requestRuntimeRecovery = useCallback(() => {
    if (!runtimeControllerEnabled) {
      return;
    }
    const now = Date.now();
    if (runtimeRecoveryInFlightRef.current) {
      return;
    }
    if (now < runtimeRecoveryCooldownUntilRef.current) {
      return;
    }
    runtimeRecoveryCooldownUntilRef.current = now + 20_000;
    runtimeRecoveryInFlightRef.current = (async () => {
      try {
        if (currentRuntime?.isLikelyLocal) {
          return await ensureDesktopRuntime();
        }
        return await ensureHostedRuntime();
      } catch {
        return false;
      } finally {
        runtimeRecoveryInFlightRef.current = null;
      }
    })();
  }, [currentRuntime?.isLikelyLocal, ensureDesktopRuntime, ensureHostedRuntime]);

  const { handleCancelActiveTerminalCommand, submissionPending, submitMessage } = useChatSubmitFlow({
    activeConversationEntry,
    activeConversationId,
    activeConversationMessages: Array.isArray(activeConversation?.messages) ? activeConversation.messages : [],
    activeOrgId,
    activeProjectId,
    appendMessages,
    broadcastTyping,
    browserSessionOpen,
    clearComposerAfterQueue,
    clearComposerIfUnchanged,
    clearPendingBrowserLaunchMode,
    createConversation,
    createOrgInvitation: createControllerOrgInvitationStrict,
    credentialsReady,
    currentUserId,
    effectiveRuntimeId,
    enqueueChatSendQueueItem,
    enqueueServerSendQueueItem,
    fetchRuntimeStatus,
    focusInput,
    hasHiddenBrowserSession,
    humanPeerContext: conversationHumanPeerContext,
    imageFiles: imageAttachments.map((attachment) => attachment.file),
    isAssistantTyping,
    inputEditorState,
    inputValue,
    interruptConversationRuns: interruptControllerConversationRuns,
    invitePrompt,
    listConversationParticipants: listControllerConversationParticipants,
    localTypingStateRef,
    onMaybeAutoTitleConversation,
    onPreparedEmailInvite: handlePreparedEmailInvite,
    onRecordMessage,
    resolveGroupParticipationBeforeSubmit: onResolveGroupParticipationBeforeSubmit,
    openInvitePrompt,
    openPanelTab,
    outOfCredits,
    pendingBrowserLaunchMode,
    pendingTypingBroadcastRef,
    performSubmit,
    personalBrowserActive:
      browserTransport === "personal" &&
      browserSessionOpen,
    personalBrowserAgentControlEnabled: personalBrowser.status?.agentControlEnabled ?? false,
    personalBrowserAgentError: personalBrowser.agentError,
    personalBrowserAgentPhase: personalBrowser.agentPhase,
    personalBrowserAgentSurfaceReady: personalBrowser.status?.state === "ready",
    personalBrowserRetryAgentControl: personalBrowser.retryAgentControl,
    personalBrowserRuntimeOverride: personalBrowser.runtimeOverride,
    personalBrowserSetAgentControlEnabled: personalBrowser.setAgentControlEnabled,
    preferredBrowserPage,
    preferredRuntimeId,
    revealAiGatesForCurrentDraft,
    requestRuntimeRecovery,
    resolvePromptAgentTargets,
    runtimeControllerEnabled,
    runtimeReady,
    scrollToBottom,
    sendingAttachment,
    sharedBrowserActive:
      browserTransport === "shared" && browserModeActive,
    sharedBrowserRuntimeId: resolvedBrowserRuntimeId,
    showCredentialsGate: showChatCredentialsGate,
    showStatus,
    shouldAutoScrollRef,
    softPrefillSuggestion,
    submitSendIntent,
    targetsOverlapActiveRuns,
  });
  submitMessageRef.current = submitMessage;

  const handleStashDraft = useCallback(async (): Promise<boolean> => {
    if (!ensureProjectWriteAccess()) {
      return false;
    }
    if (imageAttachments.length > 0) {
      showStatus(
        "Stash currently supports text only. Remove image attachments first.",
        "info",
        4500,
      );
      focusInput();
      return false;
    }
    const conversationId = activeConversationEntry?.controllerId ?? null;
    if (!conversationId || !activeConversationId) {
      showStatus(
        "Send the first message normally before stashing drafts in this conversation.",
        "info",
        4500,
      );
      return false;
    }
    const text = latestInputValueRef.current ?? "";
    if (!text.trim()) {
      showStatus("Write something before stashing this draft.", "info", 3000);
      focusInput();
      return false;
    }

    const restoredEnvelope = restoredMessageStash
      ? normalizeChatMessageStashEnvelope(restoredMessageStash.composerEnvelope)
      : null;
    const pendingReplyContext = pendingReplyContextRef.current;
    const metadata = restoredEnvelope?.metadata ??
      (shouldAttachPendingReplyContext(pendingReplyContext, text)
        ? { replyContext: pendingReplyContext }
        : null);
    const targetAgentHandles = restoredEnvelope?.targetAgentHandles ??
      resolvePromptAgentTargets(text, {
        useSticky: true,
        updateSticky: false,
      }).targetHandles;
    const browserPageTarget = restoredEnvelope?.browserPageTarget ??
      (preferredBrowserPage ? toBrowserSessionPageTarget(preferredBrowserPage) : null);
    const browserLaunchMode = restoredEnvelope?.browserLaunchMode ?? pendingBrowserLaunchMode;
    const runtimeOverride = restoredEnvelope?.runtimeOverride ??
      (browserTransport === "personal" && personalBrowser.runtimeOverride?.runtimeId
        ? personalBrowser.runtimeOverride
        : browserTransport === "shared" && browserModeActive && resolvedBrowserRuntimeId
          ? {
              runtimeId: resolvedBrowserRuntimeId,
              runtimeDisplayName: null,
              preferRuntime: true,
            }
          : null);

    try {
      const stash = await createServerMessageStash({
        text,
        editorState: latestInputEditorStateRef.current,
        composerEnvelope: {
          targetAgentHandles,
          browserPageTarget,
          browserLaunchMode,
          metadata,
          runtimeOverride,
        },
      });
      if (!stash) {
        showStatus("Unable to stash this draft right now.", "warning", 4000);
        return false;
      }
      latestInputValueRef.current = "";
      latestInputEditorStateRef.current = null;
      onInputChange(activeConversationId, "", null);
      clearInputEditor?.();
      pendingReplyContextRef.current = null;
      setPendingBrowserLaunchMode(null);
      setRestoredMessageStash(null);
      showStatus("Draft stashed privately.", "success", 2500);
      focusInput();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to stash this draft.";
      showStatus(message, "error", 4500);
      return false;
    }
  }, [
    activeConversationEntry?.controllerId,
    activeConversationId,
    browserModeActive,
    browserTransport,
    clearInputEditor,
    createServerMessageStash,
    ensureProjectWriteAccess,
    focusInput,
    imageAttachments.length,
    onInputChange,
    pendingBrowserLaunchMode,
    personalBrowser.runtimeOverride,
    preferredBrowserPage,
    resolvePromptAgentTargets,
    resolvedBrowserRuntimeId,
    restoredMessageStash,
    setPendingBrowserLaunchMode,
    showStatus,
  ]);

  const handleRestoreMessageStash = useCallback(
    (stash: ControllerMessageStash) => {
      const restoreBlock = resolveMessageStashRestoreBlock({
        composerText: latestInputValueRef.current ?? "",
        attachmentCount: imageAttachments.length,
      });
      if (restoreBlock === "attachments") {
        showStatus(
          "Remove image attachments before restoring a stashed draft.",
          "info",
          4000,
        );
        return;
      }
      if (restoreBlock === "composer_text") {
        showStatus(
          "Stash or clear the current draft before restoring another one.",
          "info",
          4500,
        );
        focusInput();
        return;
      }
      if (!activeConversationId) {
        return;
      }
      const envelope = normalizeChatMessageStashEnvelope(stash.composerEnvelope);
      const editorState =
        typeof stash.editorState === "string"
          ? stash.editorState
          : stash.editorState
            ? JSON.stringify(stash.editorState)
            : null;
      latestInputValueRef.current = stash.text;
      latestInputEditorStateRef.current = editorState;
      onInputChange(activeConversationId, stash.text, editorState);
      setPendingBrowserLaunchMode(envelope.browserLaunchMode);
      setRestoredMessageStash(stash);
      chatInputRef.current?.focusAfterValueSync();
      focusInput();
      showStatus("Draft restored. It stays stashed until you send or delete it.", "info", 3500);
    },
    [
      activeConversationId,
      focusInput,
      imageAttachments.length,
      onInputChange,
      setPendingBrowserLaunchMode,
      showStatus,
    ],
  );

  const handleDeleteMessageStash = useCallback(
    async (stashId: string) => {
      try {
        const removed = await removeServerMessageStash(stashId);
        if (!removed) {
          showStatus("Unable to delete this stashed draft.", "warning", 3500);
          return;
        }
        setRestoredMessageStash((current) => current?.id === stashId ? null : current);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to delete this stashed draft.";
        showStatus(message, "error", 4000);
      }
    },
    [removeServerMessageStash, showStatus],
  );

  const handleAcceptGhostSuggestion = useCallback(() => {
    const remainder = composerGhostSuggestion?.remainder ?? "";
    if (!remainder) {
      return;
    }
    chatInputRef.current?.acceptGhostSuggestion(remainder);
    shouldAutoScrollRef.current = true;
    scrollToBottom();
  }, [composerGhostSuggestion?.remainder, scrollToBottom, shouldAutoScrollRef]);

  const {
    chatSendQueueDisplay,
    collapsedQueuedMessageSummary,
    queuedSummaryItems,
    queuedTargetHandlesByItemId,
    queueStatusLabel,
    resolveQueuedItemTargets,
    totalQueuedCount,
  } = useChatSendQueuePresentation({
    activeConversationControllerId: activeConversationEntry?.controllerId ?? null,
    activeConversationRun,
    agentByHandle,
    chatSendQueue: combinedChatSendQueue,
    currentRuntime,
    hostedRuntimeEnsuring,
    isAssistantTyping,
    resolvePromptAgentTargets,
    runtimeControllerEnabled,
    runtimeEnsureError,
    runtimeReady,
    sendingAttachment,
    waitingForPreferredRuntime,
  });

  // Mirror the roster, run state, and queue depth for surfaces outside the
  // chat surface (the participants drawer is a StudioLayout sibling, so props
  // cannot reach it). ChatPanel stays the single writer.
  const participantsSnapshotConversationId = activeConversationEntry?.controllerId ?? null;
  // Enrich each roster agent with the model, provider, and credential it draws
  // from, resolving pinned-vs-default and stale credentials the same way the
  // Runtime & AI panel does — so the drawer can show it without re-deriving.
  const participantAgents = useMemo<ParticipantAgent[]>(() => {
    const credentialsById = new Map(
      availableCredentials.map((credential) => [credential.id, credential]),
    );
    // The provider the workspace default credential routes to. A built-in
    // agent stores provider "assistant" / no model, so its effective provider
    // and model come from the default credential, not the profile.
    const defaultCredentialProviderId: AiProviderId = (() => {
      if (!defaultAiCredential || defaultAiCredential.kind === "codex_auth_json") {
        return "openai";
      }
      const metadata = defaultAiCredential.metadata as Record<string, unknown> | null | undefined;
      return normalizeAiProviderId(typeof metadata?.provider === "string" ? metadata.provider : "");
    })();
    // Static machine size ("2 vCPU · 4 GB") from a runtime option's capacity.
    const formatRuntimeCapacity = (
      resources: RuntimeMenuOption["resources"],
    ): string | null => {
      if (!resources) return null;
      const parts: string[] = [];
      const cores = resources.cpuLimitCores;
      if (typeof cores === "number" && cores > 0) {
        parts.push(`${Number.isInteger(cores) ? cores : cores.toFixed(1)} vCPU`);
      }
      const mem = resources.memoryLimitBytes;
      if (typeof mem === "number" && mem > 0) {
        const gb = mem / 1024 ** 3;
        parts.push(`${gb >= 1 ? Math.round(gb) : gb.toFixed(1)} GB`);
      }
      return parts.length > 0 ? parts.join(" · ") : null;
    };
    // Resolve the machine an agent runs in: its pinned runtime if it has one,
    // otherwise the workspace's current (shared) runtime. `native` = a local
    // self-hosted machine, `dedicated` = a pinned cloud box, `shared` = the
    // default. The id is the grouping key that clusters agents by machine.
    const resolveRuntime = (runtimeId: string | null): ParticipantRuntimeInfo | null => {
      const pinnedId = (runtimeId ?? "").trim() || null;
      let option =
        (pinnedId ? runtimeMenu.runtimeOptionsById.get(pinnedId) : null) ??
        runtimeMenu.currentRuntime;
      // "Auto (best available)" is a policy, not a machine. The roster groups
      // agents by machine, so when the workspace rides auto, name the concrete
      // runtime that is actually ready to serve it; fall back to the auto label
      // only when nothing concrete is up yet.
      if (!pinnedId && option?.isAuto) {
        const concrete = runtimeMenu.runtimeOptions.find(
          (candidate) =>
            Boolean(candidate.id) &&
            !candidate.isAuto &&
            ["ready", "online", "healthy"].includes(
              String(candidate.state ?? "").toLowerCase(),
            ),
        );
        if (concrete) option = concrete;
      }
      if (!option) return null;
      const kind: ParticipantRuntimeInfo["kind"] = option.isLikelyLocal
        ? "native"
        : pinnedId
          ? "dedicated"
          : "shared";
      return {
        id: option.id ?? pinnedId ?? "shared-runtime",
        label: option.label,
        kind,
        status: String(option.state ?? "unknown"),
        resourcesSummary: formatRuntimeCapacity(option.resources),
      };
    };
    return conversationRosterAgents.map((rosterAgent) => {
      const profile = agentByHandle.get(rosterAgent.handle) ?? null;
      const providerRaw = (profile?.provider ?? "").trim().toLowerCase();
      const providerId: AiProviderId =
        !providerRaw || providerRaw === "assistant"
          ? defaultCredentialProviderId
          : normalizeAiProviderId(providerRaw);
      // Explicit model, or the provider's default (the first option in
      // modelOptionsForProvider) when the agent pins none.
      const model =
        normalizeAiModelId(providerId, profile?.model) ??
        modelOptionsForProvider(providerId)[0]?.id ??
        null;
      let credentialLabel: string | null = null;
      let credentialState: ParticipantCredentialState = "none";
      // The credential whose live usage applies to this agent: the pinned one
      // when it resolves, otherwise the workspace default. Stays null for the
      // broken states (missing/revoked) — there's no live snapshot to show.
      let effectiveCredential: (typeof availableCredentials)[number] | null = null;
      if (profile?.credentialId) {
        const pinned = credentialsById.get(profile.credentialId) ?? null;
        if (!pinned) {
          credentialState = "missing";
        } else if (pinned.revokedAt) {
          credentialState = "revoked";
          credentialLabel = resolveCredentialLabel(pinned);
        } else {
          credentialState = "pinned";
          credentialLabel = resolveCredentialLabel(pinned);
          effectiveCredential = pinned;
        }
      } else if (defaultAiCredential) {
        credentialState = "default";
        credentialLabel = resolveCredentialLabel(defaultAiCredential);
        effectiveCredential = defaultAiCredential;
      }
      // Read `subscriptionUsage` defensively: it's a recent addition to the
      // controller payload, so tolerate its absence rather than hard-depend on
      // the field being present in the credential type.
      const subscriptionUsage = parseSubscriptionUsage(
        (effectiveCredential as { subscriptionUsage?: unknown } | null)?.subscriptionUsage,
      );
      return {
        ...rosterAgent,
        agentId: profile?.id ?? null,
        providerId,
        model,
        reasoningEffort: profile?.reasoningEffort ?? null,
        runtime: resolveRuntime(profile?.runtimeId ?? null),
        providerLabel: formatProviderLabel(providerId),
        credentialId: effectiveCredential?.id ?? null,
        credentialLabel,
        credentialKind: effectiveCredential?.kind ?? null,
        credentialState,
        subscriptionUsage,
      };
    });
  }, [
    agentByHandle,
    availableCredentials,
    conversationRosterAgents,
    defaultAiCredential,
    runtimeMenu,
  ]);
  // Amber dot on the roster facepile when any agent's credential needs
  // attention — visible without opening the drawer.
  const participantAgentsHaveCredentialWarning = participantAgents.some(
    (agent) =>
      agent.credentialState === "missing" ||
      agent.credentialState === "revoked" ||
      agent.credentialState === "none",
  );
  // Editing capability handed to the drawer so its agent rows are two-way.
  // ChatPanel owns the update + refresh; the drawer just calls saveAgent.
  const participantsEditing = useMemo<ParticipantEditingContext>(
    () => ({
      credentials: availableCredentials.map((credential) => ({
        id: credential.id,
        label: resolveCredentialLabel(credential),
        kind: credential.kind,
        revoked: Boolean(credential.revokedAt),
      })),
      saveAgent: async (agentId, patch) => {
        const result = await updateMyAgent(agentId, patch);
        if (result.success) {
          // Same refresh the chip's edits use, so the drawer's displayed
          // values reflect the saved change on the next published snapshot.
          void refreshCredentials();
          void refreshAvailableAgents({ silent: true });
        }
        return result.success;
      },
      onManageAgents: openAiManager,
    }),
    [availableCredentials, openAiManager, refreshAvailableAgents, refreshCredentials],
  );
  // The conversation's assistant switch, published for the participants panel —
  // same semantics as the composer chip's toggle: enabling with no AI connected
  // routes through onboarding first; disabling also clears invited agents.
  const participantsAssistant = useMemo(() => {
    const conversationId = activeConversationId;
    if (!conversationId) return null;
    const aiSetupState =
      activeAiCredentials.length === 0
        ? "missing"
        : !defaultAiCredential
          ? "needs_default"
          : "ready";
    const aiControlsReady = credentialsReady || aiSetupState === "ready";
    const enabled = assistantEnabled || extraAgentHandles.length > 0;
    return {
      enabled,
      hint: aiControlsReady
        ? null
        : aiSetupState === "needs_default"
          ? "Pick a default AI to resume replies."
          : "Connect AI first.",
      onToggle: (nextEnabled: boolean) => {
        if (nextEnabled) {
          if (enabled) return;
          if (!aiControlsReady) {
            openAiOnboarding();
            return;
          }
          onAssistantEnabledChange(conversationId, true);
          return;
        }
        if (!enabled) return;
        for (const handle of extraAgentHandles) {
          onRemoveAgentHandle(conversationId, handle);
        }
        onAssistantEnabledChange(conversationId, false);
      },
    };
  }, [
    activeAiCredentials.length,
    activeConversationId,
    assistantEnabled,
    credentialsReady,
    defaultAiCredential,
    extraAgentHandles,
    onAssistantEnabledChange,
    onRemoveAgentHandle,
    openAiOnboarding,
  ]);
  useEffect(() => {
    publishChatParticipants({
      conversationId: participantsSnapshotConversationId,
      humans: conversationRosterHumans,
      agents: participantAgents,
      runningAgentHandles: Array.from(activeConversationRunAgentHandles),
      totalQueuedCount,
      editing: participantsEditing,
      assistant: participantsAssistant,
    });
    return () => clearChatParticipants(participantsSnapshotConversationId);
  }, [
    activeConversationRunAgentHandles,
    conversationRosterHumans,
    participantAgents,
    participantsAssistant,
    participantsEditing,
    participantsSnapshotConversationId,
    totalQueuedCount,
  ]);

  const {
    browserModalBottomInset,
    browserPageStripBottomInset,
    chatScrollPaddingBottom,
    composerAutoHidden,
    composerOverlayHeight,
    handleScroll,
    nativeKeyboardOpen,
  } = useChatComposerLayoutState({
    activeConversationId,
    autoScrollPendingRef,
    browserModeActive,
    browserSessionOpen,
    chatSendQueueExpanded,
    compactBrowserViewport,
    composerGhostSuggestionRemainder: composerGhostSuggestion?.remainder ?? null,
    composerOverlayRef,
    editingQueuedItemActive: Boolean(editingQueuedItem),
    hasMoreHistory,
    imageAttachmentCount: imageAttachments.length,
    inputValue,
    isChatInputFocused,
    isHistoryLoading,
    lastComposerScrollTopRef,
    lastScrollHeightRef,
    queuedSummaryItemCount: queuedSummaryItems.length,
    recordScrollPosition,
    requestOlderMessages,
    rootRef,
    scrollContainerRef,
    sendingAttachment,
    shouldAutoScrollRef,
    showBrowserSessionPageStrip: showBrowserSessionPageStripForComposer,
    totalQueuedCount,
    touchLikeInput,
    voiceHoldActive,
    voiceInputListening,
  });

  const gettingStartedTopAnchoredRef = useRef(false);
  const gettingStartedTopAnchorActive =
    shouldShowGettingStarted && (compactBrowserViewport || touchLikeInput);
  useLayoutEffect(() => {
    setAutoScrollSuspended(gettingStartedTopAnchorActive);
    const node = scrollContainerRef.current;
    if (!node) {
      gettingStartedTopAnchoredRef.current = gettingStartedTopAnchorActive;
      return;
    }

    if (gettingStartedTopAnchorActive) {
      shouldAutoScrollRef.current = false;
      node.scrollTop = 0;
      lastScrollHeightRef.current = node.scrollHeight;
      gettingStartedTopAnchoredRef.current = true;
      return;
    }

    if (!gettingStartedTopAnchoredRef.current) {
      return;
    }
    gettingStartedTopAnchoredRef.current = false;
    shouldAutoScrollRef.current = true;
    scrollToBottom({ behavior: "auto" });
  }, [
    activeConversationId,
    compactBrowserViewport,
    gettingStartedTopAnchorActive,
    gettingStartedMode,
    lastScrollHeightRef,
    scrollContainerRef,
    scrollToBottom,
    setAutoScrollSuspended,
    shouldAutoScrollRef,
  ]);

  useChatAutoScrollSync({
    aiOnboardingOpen,
    autoScrollSuspendedRef,
    autoScrollPendingRef,
    composerAutoHidden,
    composerOverlayHeight,
    credentialGateStateForBubble: presentedCredentialGateStateForBubble,
    displayedMessages,
    isAssistantTyping,
    lastScrollHeightRef,
    notificationsNudgeAnchorTimestamp,
    notificationsNudgeOpen,
    peerTypingLabel,
    scrollContainerRef,
    scrollToBottom,
    shouldAutoScrollRef,
  });

  const {
    handleCancelQueuedEdit,
    handleEditQueuedMessage,
    handleRequeueEditedMessage,
    handleSendEditedMessageNow,
    handleSendQueuedMessageNow,
  } = useChatSendQueueActions({
    activeConversationControllerId: activeConversationEntry?.controllerId ?? null,
    activeConversationId,
    chatSendQueue,
    dispatchServerSendQueueEntryNow,
    editingQueuedItem,
    enqueueServerSendQueueItem,
    focusInput,
    hostedRuntimeEnsuring,
    imageAttachmentCount: imageAttachments.length,
    inputEditorState,
    inputValue,
    interruptConversationRuns: interruptControllerConversationRuns,
    invitePromptOpen: Boolean(invitePrompt),
    isAssistantTyping,
    latestInputValueRef,
    onInputChange,
    queuedTargetHandlesByItemId,
    refreshServerSendQueue,
    removeServerSendQueueEntry,
    resolvePromptAgentTargets,
    resolveQueuedItemTargets,
    runtimeReady,
    sendingAttachment,
    serverQueueHydrated,
    serverSendQueueItems,
    setChatSendQueue,
    setChatSendQueueExpanded,
    setEditingQueuedItem,
    setPendingBrowserLaunchMode,
    showStatus,
    submitMessage,
    targetsOverlapActiveRuns,
    waitingForPreferredRuntime,
  });

  const dismissNotificationsNudge = useCallback(() => {
    setNotificationsNudgeOpen(false);
    setNotificationsNudgeAnchorTimestamp(null);
  }, []);

  const enableNotificationsFromChat = useCallback(async () => {
    return await enableMessageNotifications();
  }, []);

  useEffect(() => {
    if (notificationsNudgeOpen) {
      return;
    }
    setNotificationsNudgeAnchorTimestamp(null);
  }, [notificationsNudgeOpen]);

  useEffect(() => {
    if (!notificationsNudgeOpen) {
      return;
    }
    setNotificationsNudgeAnchorTimestamp(null);
  }, [activeConversationId, notificationsNudgeOpen]);

  useEffect(() => {
    if (!notificationsNudgeOpen) {
      return;
    }
    if (notificationsNudgeAnchorTimestamp !== null) {
      return;
    }
    if (displayedMessages.length === 0) {
      return;
    }
    const latestTimestamp = displayedMessages.reduce((maxTimestamp, message) => {
      return Math.max(maxTimestamp, message.timestamp);
    }, 0);
    setNotificationsNudgeAnchorTimestamp(Math.max(Date.now(), latestTimestamp + 1));
  }, [displayedMessages, notificationsNudgeAnchorTimestamp, notificationsNudgeOpen]);

  useEffect(() => {
    setOutOfCreditsAnchorTimestamp(null);
  }, [activeConversationId]);

  useEffect(() => {
    if (!showOutOfCreditsNotice) {
      setOutOfCreditsAnchorTimestamp(null);
      return;
    }
    if (outOfCreditsAnchorTimestamp !== null) {
      return;
    }
    const latestTimestamp = displayedMessages.reduce((maxTimestamp, message) => {
      return Math.max(maxTimestamp, message.timestamp);
    }, 0);
    setOutOfCreditsAnchorTimestamp(Math.max(Date.now(), latestTimestamp + 1));
  }, [displayedMessages, showOutOfCreditsNotice, outOfCreditsAnchorTimestamp]);

  const notificationNudgeObservationsRef = useRef<
    Map<string, NotificationNudgeConversationObservation>
  >(new Map());
  useEffect(() => {
    if (!activeConversationId) {
      return;
    }

    const conversationObservationKey = `${conversationsProjectKey}:${activeConversationId}`;
    const existingObservation = notificationNudgeObservationsRef.current.get(conversationObservationKey);
    const observation =
      existingObservation ?? createNotificationNudgeConversationObservation();
    const result = observeNotificationNudgeAssistantResponses({
      observation,
      messages,
      historyReady: remoteConversationHistoryResolved && !isInitialHistoryLoading,
      assistantRoutingEnabled: anyAgentsEnabled,
    });
    notificationNudgeObservationsRef.current.set(conversationObservationKey, result.observation);

    if (
      !result.freshAssistantResponse ||
      notificationsNudgeOpen ||
      aiOnboardingOpen ||
      credentialGateState
    ) {
      return;
    }

    if (Capacitor.isNativePlatform()) {
      if (!recordGenuineAssistantResponseAndMaybeOfferNativeNotifications()) {
        return;
      }
      setNotificationsNudgeKind("native");
      setNotificationsNudgeOpen(true);
      return;
    }

    if (!shouldOfferBrowserNotificationsNudge()) {
      return;
    }
    markBrowserNotificationsNudgeSeen();
    setNotificationsNudgeKind("browser");
    setNotificationsNudgeOpen(true);
  }, [
    activeConversationId,
    aiOnboardingOpen,
    anyAgentsEnabled,
    conversationsProjectKey,
    credentialGateState,
    isInitialHistoryLoading,
    messages,
    notificationsNudgeOpen,
    remoteConversationHistoryResolved,
  ]);

  useEffect(() => {
    const projectId = activeProjectId?.trim() ?? null;
    if (
      !shouldRequestComposerInlineCompletion({
        projectId,
        inputValue,
        anyAgentsEnabled,
        credentialsReady,
        hasImageAttachments: imageAttachments.length > 0,
        onboardingInputLocked,
        sendingAttachment,
      })
    ) {
      setComposerInlineCompletion(null);
      return;
    }

    const normalizedInput = inputValue.replace(/\r/g, "");
    const abortController = typeof AbortController === "function" ? new AbortController() : null;
    setComposerInlineCompletion(null);

    const timeoutHandle = globalThis.setTimeout(() => {
      void (async () => {
        const result = await requestProjectEditorInlineCompletion({
          projectId: projectId!,
          path: buildComposerInlineCompletionPath(activeConversationId),
          prefix: normalizedInput,
          suffix: "",
          language: "markdown",
          credentialId: defaultAiCredential?.id ?? null,
          signal: abortController?.signal,
        });

        if (abortController?.signal.aborted) {
          return;
        }
        setComposerInlineCompletion(result.success ? result.completion : null);
      })();
    }, COMPOSER_INLINE_COMPLETION_DEBOUNCE_MS);

    return () => {
      globalThis.clearTimeout(timeoutHandle);
      abortController?.abort();
    };
  }, [
    activeConversationId,
    activeProjectId,
    anyAgentsEnabled,
    credentialsReady,
    defaultAiCredential?.id,
    imageAttachments.length,
    inputValue,
    onboardingInputLocked,
    sendingAttachment,
  ]);
  onGithubImportSuccessRef.current = dismissGettingStarted;

  const {
    composerActionIconClass,
    composerGhostActionClass,
    composerPrimaryActionClass,
    queueCanSendNow,
    sendButtonDisabled,
    sendButtonVariant,
    showMobileGhostSuggestionAcceptButton,
  } = resolveChatComposerAffordances({
    composerGhostSuggestionRemainder: composerGhostSuggestion?.remainder ?? null,
    credentialsReady,
    activeConversationControllerId: activeConversationEntry?.controllerId ?? null,
    imageAttachmentCount: imageAttachments.length,
    deferAiGatesForAmbientParticipation,
    inputRequiresAi,
    inputValue,
    onboardingInputLocked,
    outOfCredits,
    runtimeControllerEnabled,
    queueStatusLabel,
    sendingAttachment,
    submissionPending,
    totalQueuedCount,
    voiceHoldActive,
    voiceInputListening,
    voiceInputStarting,
    voiceInputTranscribing,
  });

  useEffect(() => {
    if (!pendingCredentialAutoSubmitRef.current) {
      return;
    }
    if (!credentialsReady || sendingAttachment || onboardingInputLocked) {
      return;
    }
    if (inputValue.trim().length === 0) {
      return;
    }
    pendingCredentialAutoSubmitRef.current = false;
    void submitMessage(undefined, { allowWhileBusy: true });
  }, [credentialsReady, inputValue, onboardingInputLocked, sendingAttachment, submitMessage]);

  // Managed AI is available and send is already unblocked (credentialsReady is
  // true), so the connect wizard's "Use free managed AI" button just dismisses
  // the wizard and fires whatever prompt the user already typed. The draft is
  // still in the composer (openAiOnboarding never clears it), so there is no
  // stashed draft to restore — and the false→true auto-submit effect above
  // never runs in this case, so we submit here explicitly.
  const handleUseManagedAi = useCallback(() => {
    closeAiOnboarding();
    if (sendingAttachment || onboardingInputLocked) {
      return;
    }
    if (inputValue.trim().length === 0) {
      return;
    }
    void submitMessage(undefined, { allowWhileBusy: true });
  }, [closeAiOnboarding, inputValue, onboardingInputLocked, sendingAttachment, submitMessage]);

  // The gate bubble's "just chatting with teammates?" escape: turn the assistant
  // off for this conversation so plain p2p messages send with no AI connected.
  // Mirrors the OctoAgentChip disable path — clear extra agent handles too, or a
  // lingering AI handle keeps inputRequiresAi true and the gate never clears.
  const handleChatWithoutAi = useCallback(() => {
    if (!activeConversationId) {
      return;
    }
    for (const handle of extraAgentHandles) {
      onRemoveAgentHandle(activeConversationId, handle);
    }
    // Also drop any sticky mentioned agent for this conversation — otherwise it
    // keeps inputRequiresAi true and the gate would never self-dismiss. This is
    // the submit flow's own map, so clearing it also stops handleSubmit from
    // dispatching follow-ups to the stale sticky agent.
    stickyMentionedAgentByConversationRef.current.delete(activeConversationId);
    onAssistantEnabledChange(activeConversationId, false);
  }, [
    activeConversationId,
    extraAgentHandles,
    onAssistantEnabledChange,
    onRemoveAgentHandle,
    stickyMentionedAgentByConversationRef,
  ]);

  const normalizedJobThread = useMemo((): ChatPanelJobThread | null => {
    const conversationId = jobThread?.conversationId?.trim() ?? "";
    const jobId = jobThread?.jobId?.trim() ?? "";
    if (!conversationId || !jobId) {
      return null;
    }
    return { conversationId, jobId };
  }, [jobThread?.conversationId, jobThread?.jobId]);

  const jobThreadMessages = useMemo((): ChatMessage[] => {
    if (!normalizedJobThread) {
      return [];
    }
    if (activeConversationId !== normalizedJobThread.conversationId) {
      return [];
    }

    const jobMessages = messages.filter((message) => extractAgentJobId(message) === normalizedJobThread.jobId);
    if (jobMessages.length === 0) {
      return [];
    }

    const visibleJobMessages = collapseLifecycleMessages(jobMessages.filter((message) => shouldDisplayJobThreadMessage(message)));
    if (visibleJobMessages.length === 0) {
      return [];
    }

    const firstJobIndex = messages.findIndex((message) => extractAgentJobId(message) === normalizedJobThread.jobId);
    if (firstJobIndex > 0) {
      for (let cursor = firstJobIndex - 1; cursor >= 0; cursor -= 1) {
        if (messages[cursor].role === "user") {
          return [messages[cursor], ...visibleJobMessages];
        }
      }
    }

    return visibleJobMessages;
  }, [activeConversationId, messages, normalizedJobThread]);

  const handleContinueFromJobThread = useCallback(() => {
    if (!normalizedJobThread) {
      return;
    }
    const params = new URLSearchParams(location.search);
    params.delete("jobId");
    params.set("conversationId", normalizedJobThread.conversationId);
    const search = params.toString();
    navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : "",
      },
      { replace: false },
    );
    openConversationTab(normalizedJobThread.conversationId);
  }, [location.pathname, location.search, navigate, normalizedJobThread, openConversationTab]);

  if (normalizedJobThread) {
    const isLoadingConversation = activeConversationId !== normalizedJobThread.conversationId;
    const fallbackContent = isLoadingConversation ? "Loading run…" : "Waiting for updates…";
    const threadRows =
      jobThreadMessages.length > 0
        ? jobThreadMessages
        : [
            {
              id: `job-thread-empty:${normalizedJobThread.jobId}`,
              role: "assistant" as const,
              content: fallbackContent,
              timestamp: Date.now(),
            },
          ];

        return (
          <div ref={rootRef} className="flex h-full min-h-0 flex-col overflow-hidden">
            <div
              className="flex-1 min-h-0 overflow-x-hidden overflow-y-auto px-3 pb-4 pt-2 sm:px-4 sm:pb-2"
              data-testid="chat-message-scroll"
              aria-label={conversationLabel}
              role="log"
              onScroll={handleScroll}
              onContextMenu={handleConversationContextMenu}
              ref={scrollContainerRef}
        >
          <div ref={handleScrollContentRef}>
            <ChatColumn className="space-y-2.5">
              {threadRows.map((message, messageIndex) => {
              const normalizedCurrentUserId = typeof currentUserId === "string" ? currentUserId.trim() : "";
              const humanIdentity =
                message.role === "user" ? resolveHumanChatIdentity(message, humanLabelByUserId) : null;
              const messageMetadata =
                message.metadata && isRecord(message.metadata)
                  ? (message.metadata as Record<string, unknown>)
                  : null;
              const messageAgentIdentityFromMetadata = extractAgentIdentityFromMetadata(messageMetadata);
              const messageRunId = extractRunIdFromMetadata(messageMetadata);
              const messageAgentIdentityFromRun =
                messageRunId ? runAgentIdentityByRunId.get(messageRunId) ?? null : null;
              const messageAgentIdentity = messageAgentIdentityFromMetadata ?? messageAgentIdentityFromRun;
              const previousAssistantHandle = resolvePreviousAssistantHandle(
                threadRows,
                messageIndex,
                runAgentHandleByRunId,
              );
              const isOwnUserMessage = isCurrentUserChatMessage(
                message,
                normalizedCurrentUserId,
                chatClientSessionId,
              );
              const isLeftAligned =
                message.role === "assistant" || (message.role === "user" && !isOwnUserMessage);
              const showAssistantAvatar =
                message.role === "assistant" &&
                shouldShowAssistantAvatarForMessage(message, runAgentHandleByRunId);
              const showAssistantIdentityAvatar =
                message.role === "assistant" &&
                shouldShowAssistantIdentityForMessage(message, previousAssistantHandle, runAgentHandleByRunId);
              const trimmedContent = message.content.trim();
              const hasImageAttachments = extractImageAttachments(message).length > 0;
              const hasFileChanges = Array.isArray(message.files) && message.files.length > 0;
              const groupIdentity =
                message.role === "assistant"
                  ? `assistant:${(messageAgentIdentity?.handle ?? "").trim() || "assistant"}`
                  : isOwnUserMessage
                    ? "user:self"
                    : humanIdentity?.groupIdentity ?? "user:teammate";
              const groupKey = `${isLeftAligned ? "left" : "right"}:${groupIdentity}`;
              const previousMessage = threadRows[messageIndex - 1] ?? null;
              const previousIsOwnUserMessage = previousMessage
                ? isCurrentUserChatMessage(previousMessage, normalizedCurrentUserId, chatClientSessionId)
                : false;
              const previousHumanIdentity =
                previousMessage?.role === "user" ? resolveHumanChatIdentity(previousMessage, humanLabelByUserId) : null;
              const previousIsSameOwnUserGroup =
                message.role === "user" &&
                isOwnUserMessage &&
                previousMessage !== null &&
                previousMessage.role === "user" &&
                previousIsOwnUserMessage &&
                shouldAssistantMessagesShareVisualGroup(
                  getMessageType(previousMessage),
                  getMessageType(message),
                );
              const previousIsSameLeftHumanGroup =
                message.role === "user" &&
                !isOwnUserMessage &&
                previousMessage !== null &&
                previousMessage.role === "user" &&
                !previousIsOwnUserMessage &&
                previousHumanIdentity?.groupIdentity === humanIdentity?.groupIdentity &&
                shouldAssistantMessagesShareVisualGroup(
                  getMessageType(previousMessage),
                  getMessageType(message),
                );
              const isGroupHead = !(previousIsSameOwnUserGroup || previousIsSameLeftHumanGroup);
              let isGroupTail = true;
              const nextMessage = threadRows[messageIndex + 1] ?? null;
              if (nextMessage) {
                const nextIsOwnUserMessage = isCurrentUserChatMessage(
                  nextMessage,
                  normalizedCurrentUserId,
                  chatClientSessionId,
                );
                const nextHumanIdentity =
                  nextMessage.role === "user" ? resolveHumanChatIdentity(nextMessage, humanLabelByUserId) : null;
                const nextIsLeftAligned =
                  nextMessage.role === "assistant" || (nextMessage.role === "user" && !nextIsOwnUserMessage);
                const nextMessageMetadata =
                  nextMessage.metadata && isRecord(nextMessage.metadata)
                    ? (nextMessage.metadata as Record<string, unknown>)
                    : null;
                const nextAgentIdentityFromMetadata = extractAgentIdentityFromMetadata(nextMessageMetadata);
                const nextRunId = extractRunIdFromMetadata(nextMessageMetadata);
                const nextAgentIdentityFromRun = nextRunId ? runAgentIdentityByRunId.get(nextRunId) ?? null : null;
                const nextAgentIdentity = nextAgentIdentityFromMetadata ?? nextAgentIdentityFromRun;
                const nextGroupIdentity =
                  nextMessage.role === "assistant"
                    ? `assistant:${(nextAgentIdentity?.handle ?? "").trim() || "assistant"}`
                    : nextIsOwnUserMessage
                      ? "user:self"
                      : nextHumanIdentity?.groupIdentity ?? "user:teammate";
                const nextGroupKey = `${nextIsLeftAligned ? "left" : "right"}:${nextGroupIdentity}`;
                if (
                  nextGroupKey === groupKey &&
                  shouldAssistantMessagesShareVisualGroup(
                    getMessageType(message),
                    getMessageType(nextMessage),
                  )
                ) {
                  isGroupTail = false;
                }
              }

              const normalizedMessageType = (getMessageType(message) ?? "").trim().toLowerCase();
              const isAgentJobThreadMessage = normalizedMessageType === "agent_job_thread";
              const suppressOuterAssistantAvatar =
                message.role === "assistant" &&
                (isAgentJobThreadMessage || shouldSuppressOuterAvatarForConversationThread(message));
              const showNotch = isGroupTail && (trimmedContent.length > 0 || hasFileChanges || hasImageAttachments);
              const hasOwnUserStartBoundaryRisk =
                trimmedContent.length >= 96 ||
                trimmedContent.includes("\n") ||
                hasFileChanges ||
                hasImageAttachments;
              const showStartNotch =
                message.role === "user" &&
                isOwnUserMessage &&
                !isLeftAligned &&
                isGroupHead &&
                hasOwnUserStartBoundaryRisk;
              const bubble =
                message.role === "user" ? (
                  <UserMessageBubble
                    message={message}
                    projectId={activeProjectId}
                    runtimeId={effectiveRuntimeId ?? preferredRuntimeId ?? null}
                    align={isLeftAligned ? "left" : "right"}
                    showNotch={showNotch}
                    showStartNotch={showStartNotch}
                    onOpenImage={openImageLightbox}
                    mentionableAgentHandles={mentionableAgentHandles}
                  />
                ) : (
                  <AssistantMessageEntry
                    message={message}
                    conversationMessages={displayedMessages}
                    projectId={activeProjectId}
                    showNotch={showNotch}
                    showAgentIdentityAvatar={showAssistantIdentityAvatar}
                    defaultPlanExpanded={false}
                    onRequestActions={handleMessageActionsRequest}
                    onRequestActionsAtPoint={handleMessageActionsAtPoint}
                    onCancelTerminalCommand={handleCancelActiveTerminalCommand}
                    conversationLocalId={activeConversationId ?? null}
                    conversationControllerId={activeConversationEntry?.controllerId ?? null}
                    mentionableAgentHandles={mentionableAgentHandles}
                    onMessageContextMenu={handleMessageContextMenu}
                    renderContext="runTrace"
                  />
                );
              const avatar =
                message.role === "assistant"
                  ? suppressOuterAssistantAvatar
                    ? ASSISTANT_AVATAR_GUTTER_PLACEHOLDER
                    : showAssistantAvatar
                      ? renderAssistantAvatar(messageMetadata, messageAgentIdentity)
                      : ASSISTANT_AVATAR_GUTTER_PLACEHOLDER
                  : null;
              const humanSpeakerIdentity =
                message.role === "user" && !isOwnUserMessage && isGroupHead && humanIdentity ? (
                  <HumanSpeakerIdentityLabel
                    avatarSeed={humanIdentity.avatarSeed}
                    label={humanIdentity.label}
                    timestamp={message.timestamp}
                  />
                ) : null;

                return (
                  <ChatBubbleRow
                    key={message.id}
                    align={isLeftAligned ? "left" : "right"}
                    avatar={avatar}
                    speakerIdentity={humanSpeakerIdentity}
                    onContextMenu={
                      message.role === "assistant"
                        ? (event) => handleMessageContextMenu(event, message.id)
                        : undefined
                    }
                  >
                    {bubble}
                  </ChatBubbleRow>
                );
              })}
            </ChatColumn>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/75 px-3 py-2.5 text-xs text-slate-500 dark:border-[color:var(--color-studio-dark-divider)] dark:bg-[var(--color-studio-dark-panel-soft)] dark:text-slate-400 sm:px-4">
          <div className="min-w-0">
            <div className="font-medium text-slate-700 dark:text-slate-200">Read-only run trace</div>
            <div className="truncate">Continue in the parent conversation to send messages.</div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            radius="full"
            onPress={handleContinueFromJobThread}
          >
            Continue in chat
          </Button>
        </div>
      </div>
    );
  }

  const browserTransportSelector = (
    <BrowserTransportSelector
      checked={personalBrowser.checked}
      compact={compactBrowserBar}
      mode={browserTransport}
      onModeChange={handleBrowserTransportChange}
      personalAvailable={personalBrowser.available}
    />
  );

  return (
    <RunFailureRetryProvider value={runFailureRetryContextValue}>
    <ChatRuntimeActivityContext.Provider value={chatRuntimeActivityValue}>
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="chat-panel-root"
    >
      {browserSessionOpen || hasHiddenBrowserSession ? (
        <ChatBrowserSubtabs
          activeTab={browserSubtab}
          browserAttention={sharedBrowserApprovalPending}
          browserPanelId={browserPanelId}
          chatPanelId={chatPanelId}
          onTabChange={handleBrowserSubtabChange}
        />
      ) : null}
      {browserSessionOpen || hasHiddenBrowserSession ? (
        <div
          id={browserPanelId}
          aria-label="Browser"
          role="tabpanel"
          hidden={browserSubtab !== "browser"}
          className={browserSubtab === "browser" ? "flex min-h-0 flex-1 flex-col" : "hidden"}
          style={
            !showBrowserSessionPageStripForComposer && browserModalBottomInset
              ? { marginBottom: browserModalBottomInset }
              : undefined
          }
        >
          {browserSessionOpen ? (
            <>
              {browserTransport === "shared" && !sharedBrowserActivated ? (
                <div
                  aria-busy={!personalBrowser.checked}
                  className="flex items-center border-b border-slate-200 bg-white px-2 py-0.5 dark:border-slate-800 dark:bg-slate-950 sm:px-3"
                  data-browser-session-safe-zone="true"
                >
                  {browserTransportSelector}
                </div>
              ) : null}
              <PersonalBrowserSurface
                active={browserTransport === "personal" && browserSubtab === "browser"}
                compactChrome={compactBrowserBar}
                model={personalBrowser}
                transportSelector={browserTransport === "personal" ? browserTransportSelector : null}
              />
              {sharedBrowserActivated ? (
                <div className={browserTransport === "shared" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                  <BrowserSessionModal
                    isOpen={browserSessionOpen}
                    onOpenChange={handleBrowserSessionOpenChange}
                    projectId={activeProjectId ?? null}
                    browserSessionId={sharedBrowserSurfaceSessionId}
                    preferRuntimeId={preferredBrowserRuntimeId}
                    expandRequestToken={browserSessionExpandRequestToken}
                    presentation="docked"
                    fillContainer
                    onBackToChat={handleBackToChat}
                    onApprovalPendingChange={setSharedBrowserApprovalPending}
                    toolbarLeading={browserTransport === "shared" ? browserTransportSelector : null}
                    transportActive={
                      browserTransport === "shared" && browserSubtab === "browser"
                    }
                    canControlBrowser={canWriteProject}
                    canClearBrowserData={canWriteProject}
                    controlOwner={sharedBrowserControlOwner}
                    sharedBrowserChrome={sharedBrowserChrome}
                    sharedBrowserViewerKind={sharedBrowserViewerKind}
                    sharedBrowserCapabilitiesResolved={sharedBrowserCapabilitiesResolved}
                    sharedBrowserCapabilitiesAvailable={Boolean(sharedBrowserCapabilities)}
                    sharedBrowserAvailableViewerKinds={
                      sharedBrowserCapabilities?.viewerKinds
                    }
                    sharedBrowserRfbCapabilities={sharedBrowserCapabilities?.rfb ?? null}
                    sharedBrowserWebRtcCapabilities={
                      sharedBrowserCapabilities?.webrtc ?? null
                    }
                    onRuntimeIdResolved={handleBrowserRuntimeIdResolved}
                    onStatus={showStatus}
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      <div
        id={chatPanelId}
        aria-label="Chat"
        role={browserSessionOpen || hasHiddenBrowserSession ? "tabpanel" : undefined}
        hidden={browserSubtab !== "chat"}
        className={browserSubtab === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}
      >
      {/* Presence belongs to the conversation, so it sits at the top of the
          conversation surface: one placement at every width, a flow row (never
          an overlay) so it cannot cover message text, and outside the scroller
          so it never scrolls away. Always rendered — the roster collapses to a
          plain "open participants" icon when no one has joined, so the
          participants/config panel is reachable even on a brand-new chat. */}
      <div
        className="flex-none px-3 pt-2 sm:px-4"
        data-testid="chat-conversation-roster-row"
      >
        {/* Constrain to the shared 56rem chat column so the roster's right
            edge lands on the message column, not the panel edge. The sticky
            speaker pill takes the column's left side (fading in/out as the
            transcript scrolls) and the roster stays right-aligned; both are
            always rendered, so the roster never shifts when the pill appears
            or disappears. */}
        <ChatColumn className="flex items-center justify-between gap-2">
          <ChatSpeakerStickyOverlay ref={stickySpeakerOverlayRef} speaker={stickyChatSpeaker} />
          <ConversationRoster
            agents={conversationRosterAgents}
            humans={conversationRosterHumans}
            hasCredentialWarning={participantAgentsHaveCredentialWarning}
          />
        </ChatColumn>
      </div>
      <ChatTranscriptViewport
        ariaLabel={conversationLabel}
        onScroll={handleScroll}
        onContextMenu={handleConversationContextMenu}
        scrollContainerRef={scrollContainerRef}
        scrollPaddingBottom={chatScrollPaddingBottom}
      >
        <OctoScrollMotionScope
          sourceRef={scrollContainerRef}
          resetKey={activeConversationId ?? "no-conversation"}
        >
          <div ref={handleScrollContentRef} className="flex min-h-full flex-col gap-2.5">
          {pinChatMessagesToBottom && !gettingStartedTopAnchorActive ? (
            <div className="flex-1" />
          ) : null}
          {/* Sits after the bottom-anchoring spacer so it rides directly above
              the oldest rendered message. Placed before it, an underfilled
              thread reads as [button][empty void][messages] and looks like it
              is asking for a click that the visible room says is unnecessary. */}
          {showHistoryLoadButton ? (
            <div className="flex justify-center">
              <Button
                onPress={requestOlderMessages}
                isDisabled={isHistoryLoading}
                variant="outline"
                size="xs"
                radius="full"
                data-testid="chat-history-load-button"
              >
                {isHistoryLoading ? (
                  <>
                    <Spinner aria-hidden="true" data-testid="chat-history-loading" tone="slate" size="sm" />
                    Loading earlier messages…
                  </>
                ) : (
                  "View earlier messages"
                )}
              </Button>
            </div>
          ) : null}
          <ChatColumn className="space-y-2.5">
            {shouldShowGettingStarted ? (
              <ChatBubbleRow align="left" avatar={renderAssistantAvatar(null)} collapseAvatarOnNarrow>
                <ChatGettingStartedCard
                  key={`${activeProjectId ?? "no-project"}:${activeConversationId ?? "no-conversation"}`}
                  mode={gettingStartedMode}
                  onSelectMode={handleGettingStartedModeChange}
                  onSelectAction={handleGettingStartedAction}
                  managedAiOffer={gettingStartedManagedAiOffer}
                  selectedAi={gettingStartedSelectedAi}
                  aiViewState={gettingStartedAiViewState}
                  canChangeAiChoice={canChangeGettingStartedAiChoice}
                  personalAiConnectionState={gettingStartedPersonalAiConnectionState}
                  onStartWithManagedAi={handleStartWithManagedAi}
                  onConnectOwnAi={handleConnectOwnAi}
                  onChangeAiChoice={clearGettingStartedManagedAiSelection}
                  githubRepoDraft={githubRepoDraft}
                  githubRefDraft={githubRefDraft}
                  githubImportBusy={githubImportBusy}
                  githubImportElapsedSeconds={githubImportElapsedSeconds}
                  githubImportError={githubImportError}
                  githubDeviceAuthSession={githubDeviceAuthSession}
                  githubDeviceAuthError={githubDeviceAuthError}
                  onGithubRepoDraftChange={handleGithubRepoDraftChange}
                  onGithubRefDraftChange={handleGithubRefDraftChange}
                  onBeginGithubDeviceAuth={() => void beginGithubDeviceAuth()}
                  onCancelGithubDeviceAuth={() => void cancelGithubDeviceAuthSession()}
                  onImportGithub={() => void handleImportGithub()}
                />
              </ChatBubbleRow>
            ) : null}
            {!shouldShowGettingStarted && isInitialHistoryLoading ? (
              <div className="flex justify-center px-2 py-1">
                <div className="inline-flex items-center gap-3 rounded-2xl border border-slate-200/70 bg-white/85 px-4 py-3 text-sm font-medium text-slate-600 shadow-sm dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel-soft)] dark:text-slate-300">
                  <Spinner aria-hidden="true" tone="slate" size="sm" />
                  <span>Loading messages…</span>
                </div>
              </div>
            ) : null}
            {(() => {
              const rows: JSX.Element[] = [];
              const timedSyntheticRows = buildTimedSyntheticChatRows({
                notificationsNudgeOpen,
                credentialGateState: presentedCredentialGateState,
                aiOnboardingOpen,
                notificationsNudgeAnchorTimestamp,
                notificationsNudgeKind,
                onEnableNotifications: enableNotificationsFromChat,
                onDismissNotificationsNudge: dismissNotificationsNudge,
                outOfCredits: showOutOfCreditsNotice,
                outOfCreditsAnchorTimestamp,
                creditLimit: creditBilling.creditLimit,
                onOpenCredits: () => openPanelTab("credits", { activate: true }),
                renderAssistantAvatar,
              });

              rows.push(
                <ConversationMessageRows
                  key="conversation-message-rows"
                  messages={displayedMessages}
                  allConversationMessages={collapsedConversationMessages}
                  timedSyntheticRows={timedSyntheticRows}
                  currentUserId={currentUserId}
                  chatClientSessionId={chatClientSessionId}
                  projectId={activeProjectId}
                  runtimeId={effectiveRuntimeId ?? preferredRuntimeId ?? null}
                  conversationLocalId={activeConversationId ?? null}
                  conversationControllerId={activeConversationEntry?.controllerId ?? null}
                  firstPlanMessageId={firstPlanMessageId}
                  mentionableAgentHandles={mentionableAgentHandles}
                  humanLabelByUserId={humanLabelByUserId}
                  runAgentIdentityByRunId={runAgentIdentityByRunId}
                  runAgentHandleByRunId={runAgentHandleByRunId}
                  activeAssistantAvatarMotion={activeAssistantAvatarMotion}
                  renderAssistantAvatar={renderAssistantAvatar}
                  assistantAvatarPlaceholder={ASSISTANT_AVATAR_GUTTER_PLACEHOLDER}
                  onOpenImage={openImageLightbox}
                  onRequestActions={handleMessageActionsRequest}
                  onRequestActionsAtPoint={handleMessageActionsAtPoint}
                  onCancelTerminalCommand={handleCancelActiveTerminalCommand}
                  onMessageContextMenu={handleMessageContextMenu}
                />,
              );

              return rows;
            })()}
            <ChatPostTranscriptAuxiliaryRows
              jobThreadPresent={Boolean(jobThread)}
              workspaceFileStaleNotice={workspaceFileStaleNotice}
              workspaceFileStaleBusy={workspaceFileStaleBusy}
              workspaceFileStaleError={workspaceFileStaleError}
              onWorkspaceFileStaleMerge={() => void handleWorkspaceFileStaleMerge()}
              onWorkspaceFileStaleReload={handleWorkspaceFileStaleReload}
              onWorkspaceFileStaleDismiss={handleWorkspaceFileStaleDismiss}
              workspaceGitSyncConflictDetails={workspaceGitSyncConflictDetails}
              workspaceGitSyncConflictDetectedAt={workspaceGitSyncConflict?.detectedAt ?? null}
              credentialGateStateForBubble={presentedCredentialGateStateForBubble}
              aiOnboardingOpen={aiOnboardingOpen}
              credentialGateDetail={credentialGateDetail}
              credentialsBusy={credentialsBusy}
              canUseDesktopConnect={canUseDesktopConnect}
              aiConnectWizardStorageKey={aiConnectWizardStorageKey}
              activeAiCredentials={activeAiCredentials}
              defaultCredentialId={defaultAiCredential?.id ?? null}
              managedAi={aiOnboardingMode === "personal_only" ? null : credentialRequirements.managedAi}
              onSetDefaultCredential={(credentialId) => void handleSetDefaultCredentialFromChat(credentialId)}
              onUseManagedAi={handleUseManagedAi}
              onChatWithoutAi={handleChatWithoutAi}
              onCloseAiOnboarding={closeAiOnboarding}
              onStashDraftForCredentials={stashDraftForCredentials}
              onConnectDesktop={connectFromDesktop}
              onUploadAuthJson={uploadAuthJsonFile}
              onSaveApiKey={saveApiKey}
              onRetryCredentials={refreshCredentialGate}
              renderAssistantAvatar={renderAssistantAvatar}
            />
            <ChatTypingRows
              peerTypingLabel={peerTypingLabel}
              isAssistantTyping={isAssistantTyping}
              isAssistantTypingCoveredByJobThreadPreview={isAssistantTypingCoveredByJobThreadPreview}
              typingAgents={typingAgents}
              hasMultipleTypingAgents={hasMultipleTypingAgents}
              typingAgentHandle={typingAgentHandle}
              typingAgentAvatarSeed={typingAgentAvatarSeed}
              typingIndicatorState={typingIndicatorState}
              typingStatusLabel={typingStatusLabel}
              typingStatusAriaLabel={typingStatusAriaLabel}
              suppressAssistantStatus={showOutOfCreditsNotice}
              isThinkingLabelExpanded={isThinkingLabelExpanded}
              onToggleThinkingLabel={() => setIsThinkingLabelExpanded((current) => !current)}
              latestDisplayedMessageId={displayedMessages[displayedMessages.length - 1]?.id ?? null}
              renderAssistantAvatar={renderAssistantAvatar}
            />
          </ChatColumn>
          </div>
        </OctoScrollMotionScope>
      </ChatTranscriptViewport>
      </div>

      <ChatMessageMenuOverlay
        messageMenu={messageMenu}
        selectedMessageTokenUsage={selectedMessageTokenUsage}
        onClose={closeMessageMenu}
        onShowActionsView={() =>
          setMessageMenu((current) => (current ? { ...current, view: "actions" } : null))
        }
        onShowTokenUsageView={() =>
          setMessageMenu((current) => (current ? { ...current, view: "token_usage" } : null))
        }
        onCopySelectedMessage={() => void handleCopySelectedMessage()}
        onCopyConversation={() => void handleCopyConversation()}
        onCopyTokenUsage={() => void handleCopyTokenUsage()}
        selectedTextAvailable={Boolean(messageMenu?.selectedText)}
        onReplyToSelection={() => handleSelectionReplyAction("reply")}
        onSummarizeSelection={() => handleSelectionReplyAction("summarize")}
        onExplainSelection={() => handleSelectionReplyAction("explain_more")}
        onOpenThread={openSelectedMessageThread}
        openThreadLabel="Open run thread"
      />

      <ChatImageLightboxOverlay
        imageLightbox={imageLightbox}
        onClose={() => setImageLightbox(null)}
      />

      <ChatInvitePromptOverlay
        invitePrompt={invitePrompt}
        invitePromptBusy={invitePromptBusy}
        onClose={handleInvitePromptClose}
        onSendWithout={() => void handleInvitePromptSendWithout()}
        onInviteAndSend={() => void handleInvitePromptInviteAndSend()}
      />

      <CredentialsConnectModal {...gettingStartedConnectModalProps} />

      <ChatComposerSurface
        mutationDisabled={projectWriteDisabled}
        silenceHintProps={
          octoSilenceHint.visible ? { onDismiss: octoSilenceHint.dismiss } : null
        }
        accessNotice={
          projectReadOnly
            ? "Read-only access — you can review this space, but you can’t send messages or change files."
            : null
        }
        accessChecking={!projectReadOnly && projectCapabilitiesResolved === false}
        browserDockProps={{
          browserModalBottomInset,
          browserSessionOpen,
          onBrowserSessionOpenChange: handleBrowserSessionOpenChange,
          projectId: activeProjectId ?? null,
          preferredRuntimeId: preferredBrowserRuntimeId,
          showBrowserSessionPageStrip: showBrowserSessionPageStripForComposer,
          browserSessionExpandRequestToken,
          onBrowserRuntimeIdResolved: handleBrowserRuntimeIdResolved,
          browserPageStripBottomInset,
          browserSessionPages,
          onSelectBrowserSessionPage: (pageId) => {
            setBrowserSubtab("browser");
            void handleSelectBrowserSessionPage(pageId);
          },
          onToggleBrowserSession: () => handleBrowserSubtabChange("browser"),
          onClearPendingNewBrowserSession: handleClearPendingNewBrowserSession,
          hasHiddenBrowserSession,
          pendingBrowserLaunchMode,
          renderModal: false,
        }}
        composerOverlayRef={composerOverlayRef}
        composerAutoHidden={composerAutoHidden}
        browserModeActive={browserModeActive}
        compactBrowserViewport={compactBrowserViewport}
        onSubmit={handleSubmit}
        queueSurfaceProps={{
          totalQueuedCount,
          editingQueuedItem,
          chatSendQueueExpanded,
          collapsedQueuedMessageSummary,
          queueCanSendNow,
          chatSendQueueDisplay,
          sendingAttachment,
          inputValue,
          onToggleExpanded: () => setChatSendQueueExpanded((current) => !current),
          onSendQueuedMessageNow: handleSendQueuedMessageNow,
          onRemoveQueuedItem: removeChatSendQueueItem,
          onReorderQueuedItem: reorderChatSendQueueItem,
          reorderDisabled:
            serverQueueReordering ||
            (serverSendQueueItems.length > 0 && chatSendQueue.length > 0),
          onEditQueuedMessage: handleEditQueuedMessage,
          onCancelQueuedEdit: handleCancelQueuedEdit,
          onRequeueEditedMessage: handleRequeueEditedMessage,
          onSendEditedMessageNow: handleSendEditedMessageNow,
        }}
        stashTrayProps={{
          stashes: messageStashes,
          restoredStashId: restoredMessageStash?.id ?? null,
          busy: messageStashMutating,
          onRestore: handleRestoreMessageStash,
          onDelete: (stashId) => {
            if (ensureProjectWriteAccess()) {
              void handleDeleteMessageStash(stashId);
            }
          },
        }}
        activeGoal={activeConversationEntry?.activeGoal ?? null}
        activeGoalHealth={activeGoalHealth}
        onPauseGoal={() => submitGoalCommand("/goal pause")}
        onResumeGoal={() => submitGoalCommand("/goal resume")}
        onClearGoal={() => submitGoalCommand("/goal clear")}
        onHelpUnblockGoal={handleHelpUnblockGoal}
        goalDetailsCollapseToken={goalDetailsCollapseToken}
        nativeKeyboardOpen={nativeKeyboardOpen}
        onboardingInputLocked={onboardingInputLocked}
        onDragOver={handleComposerDragOver}
        onDrop={handleComposerDrop}
        chatInputRef={chatInputRef}
        chatInputProps={{
          draftKey: `${activeProjectId ?? "no-project"}:${activeConversationId ?? "no-conversation"}`,
          value: inputValue,
          editorState: inputEditorState,
          ghostSuggestionRemainder: composerGhostSuggestion?.remainder ?? null,
          recordingIndicatorActive: false,
          recordingIndicatorLabel,
          agentHandles: mentionableAgentHandles,
          agentProfiles: availableAgents,
          mentionableUsers,
          placeholder: chatInputPlaceholder,
          onChange: handleChatInputChange,
          onKeyDown: handleInputKeyDown,
          onPaste: handleComposerPaste,
        }}
        imageInputRef={imageInputRef}
        onImageInputChange={handleImageInputChange}
        imageAttachments={imageAttachments}
        onOpenImage={openImageLightbox}
        onRemoveImageAttachment={removeImageAttachment}
        showVoiceStatus={showVoiceStatus}
        voiceStatusMessage={voiceStatusMessage}
        providerTriggerNoticeProps={providerTriggerNoticeProps}
        showComposerHomeButton={showComposerHomeButton}
        onOpenHome={() => {
          requestUrlPush();
          openPanelTab("home");
        }}
        homeAttentionCount={homeAttentionCount}
        homeAttentionBadge={homeAttentionBadge}
        composerActionMenuProps={{
          // The pre-AI lock gates sending, not the "+" actions (import a repo,
          // open a browser, invite) — none of which need AI connected. Keeping
          // it enabled here is what makes repo import reachable before setup.
          disabled: sendingAttachment,
          mutationDisabled: projectWriteDisabled,
          showBrowserAction: !(browserSessionOpen || hasHiddenBrowserSession),
          showNewBrowserAction: browserTransport === "shared",
          showInviteAction:
            canOpenProjectDeviceHandoff(activeProjectId, projectCapabilitiesResolved),
          inviteActionLabel: projectReadOnly ? "Open on another device" : "Invite or open elsewhere",
          pendingNewBrowser: pendingBrowserLaunchMode === "new_page",
          onOpenBrowser: handleOpenBrowserFromLauncher,
          onOpenNewBrowser: handlePrepareNewBrowserSession,
          onOpenInvite: () => setAddMenuOpen(true),
          onImportGithubRepo: beginGithubImport,
          onInsertCommand: handleInsertSlashCommand,
          onQueueMessage: () => {
            void invokeSubmitMessage(undefined, { intent: "queue" });
          },
          onStashDraft: () => {
            void handleStashDraft();
          },
          queueDisabled:
            submissionPending ||
            !inputValue.trim() ||
            imageAttachments.length > 0 ||
            !activeConversationId ||
            !activeConversationEntry?.controllerId,
          stashDisabled:
            messageStashMutating ||
            submissionPending ||
            !inputValue.trim() ||
            imageAttachments.length > 0 ||
            !activeConversationId ||
            !activeConversationEntry?.controllerId,
        }}
        onOpenImagePicker={openImagePicker}
        sendingAttachment={sendingAttachment}
        showMobileGhostSuggestionAcceptButton={showMobileGhostSuggestionAcceptButton}
        onAcceptGhostSuggestion={handleAcceptGhostSuggestion}
        showVoicePrimaryAction={showVoicePrimaryAction}
        showVoiceSecondaryAction={showVoiceSecondaryAction}
        voiceConversationActionStripProps={{
          showVoiceRepliesToggle: false,
          voiceActionActive,
          voiceListening: voiceInputListening,
          voiceStarting: voiceInputStarting,
          voiceTranscribing: voiceInputTranscribing,
          voiceState: voiceDebugState.state,
          voiceRoute: voiceDebugState.route,
          voiceCapture: voiceDebugState.capture,
          voiceBackendLabel: voiceDebugState.transcriptionBackendLabel,
          voiceError: voiceDebugState.lastError,
          voiceInteractionMode: "hold",
          disabled: projectWriteDisabled || sendingAttachment,
          onVoicePressStart: handleStartVoiceInputHold,
          onVoicePressEnd: handleStopVoiceInputHold,
          onVoiceTap: handleChatVoiceTap,
        }}
        sendButtonDisabled={projectWriteDisabled || sendButtonDisabled}
        sendButtonVariant={sendButtonVariant}
        primaryActionMode={composerPrimaryActionMode}
        onSendButtonPress={handleSendButtonPress}
        composerGhostActionClass={composerGhostActionClass}
        composerPrimaryActionClass={composerPrimaryActionClass}
        composerActionIconClass={composerActionIconClass}
        inviteModalProps={{
          isOpen: addMenuOpen,
          onOpenChange: setAddMenuOpen,
          mentionableUsers,
          inviteParticipantIdSet,
          inviteParticipantBusyUserId,
          inviteParticipantsLoading,
          onInviteTeammate: handleInviteTeammate,
          activeConversationVisibility: activeConversation?.visibility ?? null,
          activeConversationControllerId: activeConversation?.controllerId ?? null,
          activeOrgId,
          activeProjectId,
          canShareProject: effectiveCanShareProject,
          canWriteProject: canWriteProject === true,
          preparedEmailInvite: preparedEmailInviteFromCommand,
          onPreparedEmailInviteConsumed: handlePreparedEmailInviteConsumed,
          sharingPermissionsLoading:
            orgMembersLoading || projectCapabilitiesResolved === false,
          onOpenProjectSettings,
        }}
      />
      {agentProfileModalHandle ? (
        // By-handle profile opens (mention chips, narrow speaker labels) have
        // no anchor, so the card presents as a centered modal at every width.
        <StudioDialogModal
          isOpen
          isDismissable
          onOpenChange={(open) => {
            if (!open) setAgentProfileModalHandle(null);
          }}
          className="h-[100dvh] min-h-0 overflow-hidden"
          modalClassName="min-h-0 max-h-full w-full max-w-sm overflow-y-auto overscroll-contain"
          dialogAriaLabel={`Agent profile: @${agentProfileModalHandle}`}
        >
          <AgentProfileCardContent
            {...resolveAgentProfileCardProps(agentProfileModalHandle)}
            onRequestClose={() => setAgentProfileModalHandle(null)}
          />
        </StudioDialogModal>
      ) : null}
        </div>
    </ChatRuntimeActivityContext.Provider>
    </RunFailureRetryProvider>
      );
  }

type MessageMenuView = "actions" | "token_usage";
type MessageMenuKind = "message" | "conversation";

type MessageMenuState = {
  kind: MessageMenuKind;
  messageId: string | null;
  selectedText: string | null;
  x: number;
  y: number;
  maxHeight: number;
  view: MessageMenuView;
};

type ImageLightboxState = {
  src: string;
  alt: string;
};

const MESSAGE_MENU_PADDING = 12;
const MESSAGE_MENU_WIDTH = 256;
const MESSAGE_MENU_HEIGHT_ESTIMATE = 200;

function clampMessageMenuPosition(clientX: number, clientY: number) {
  return clampFloatingSurfacePositionToStudioViewport({
    clientX,
    clientY,
    surfaceWidth: MESSAGE_MENU_WIDTH,
    surfaceHeight: MESSAGE_MENU_HEIGHT_ESTIMATE,
    padding: MESSAGE_MENU_PADDING,
  });
}

type TypingIndicatorPhase = "typing" | "finalizing" | "thinking" | "waiting" | "compacting";
const COMPACTION_STATUS_LABEL = "Re-organizing my thoughts";

function resolveTypingIndicatorState(
  messages: ChatMessage[],
  fallback: { phase: TypingIndicatorPhase; label: string | null } | null = null,
): { phase: TypingIndicatorPhase; label: string | null } {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  const startIndex = lastUserIndex;

  for (let index = messages.length - 1; index > startIndex; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }
    const type = getMessageType(message);
    if (type !== "reasoning" && type !== "status") {
      continue;
    }
    const normalized = normalizeAssistantStatusText(message.content);
    if (!normalized) {
      continue;
    }
    if (isCompactionStatusText(normalized)) {
      return { phase: "compacting", label: COMPACTION_STATUS_LABEL };
    }
    const lowered = normalized.toLowerCase();
    if (lowered === "completed") {
      continue;
    }

    const phase = lowered.includes("response summary")
      ? "finalizing"
      : lowered.includes("drafting response")
        ? "typing"
        : "thinking";

    return { phase, label: truncate(normalized, 120) };
  }

  if (fallback) {
    return fallback;
  }
  return { phase: "typing", label: null };
}

function resolveRunSortTimestamp(run: RunRecord): number {
  const updatedAt = Date.parse(run.updatedAt ?? "");
  if (Number.isFinite(updatedAt)) {
    return updatedAt;
  }
  const createdAt = Date.parse(run.createdAt ?? "");
  if (Number.isFinite(createdAt)) {
    return createdAt;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
