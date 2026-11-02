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
import { Globe, Page, WebWindow } from "iconoir-react";
import { useWorkspaceStore } from "../../../store";
import { useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Capacitor } from "@capacitor/core";
import { Button } from "../../../components/Button";
import { OctoScrollMotionScope } from "../../../components/OctoMark";
import { Spinner } from "../../../components/Spinner";
import { useBreakpoint } from "../../../hooks/useBreakpoint";
import { useStudioChatPerformance } from "../../../telemetry/useStudioChatPerformance";
import { useConversationNotificationRead } from "../../../notifications/useConversationNotificationRead";
import {
  addFloatingSurfaceViewportChangeListener,
  clampFloatingSurfacePositionToStudioViewport,
} from "../../../utils/floatingSurfacePosition";
import { ChatGettingStartedCard } from "./ChatGettingStartedCard";
import { ConnectSheet } from "./ConnectSheet";
import { SkillsImportModal } from "./SkillsImportModal";
import type { Connector, SkillConnector } from "./connectors";
import { routeConnectorSelection } from "./connectorRouting";
import { useConnectToolsRequest } from "./connectToolRequest";
import { useStudioGuardedNavigation } from "../../../navigation/StudioDraftNavigationGuard";
import { useConnectSheetState } from "./useConnectSheetState";
import { useInstalledSkillNames } from "./useInstalledSkillNames";
import { useSkillsImportFlow } from "./useSkillsImportFlow";
import { buildSkillStartMessage } from "../../../conversations/skillCommands";
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
import { parseTerminalCommandRequest } from "../../../conversations/terminalCommand";
import { resolveGroupParticipationReplyTargets } from "../../../conversations/groupParticipation";
import { getChatClientSessionId } from "../../../conversations/chatClientIdentity";
import { generateUUID } from "../../../utils/uuid";
import { useSharedBrowserResume, useSharedBrowserResumeSearchReplacement } from "./useSharedBrowserResume";
import { useConversations } from "../../../conversations/ConversationsProvider";
import { useConversationParticipants } from "../../../conversations/useConversationParticipants";
import {
  buildConversationGoalHealth,
  buildGoalUnblockHelpPrompt,
  isNonRecoverableRunErrorMessage,
  normalizeConversationGoalProgressSummaryForDisplay,
} from "../../../conversations/conversationGoals";
import { isRunActivelyProgressing } from "../../../conversations/runLiveness";
import { useRuntimeMenuOptions, type RuntimeMenuOption } from "../../../runtime/useRuntimeMenu";
import {
  shouldPinChatMessagesToBottom,
  shouldUseCompactBrowserChrome,
} from "./browserSessionLayout";
import {
  resolveStaleStartingRecoveryKey,
  STALE_STARTING_RECOVERY_DELAY_MS,
} from "./staleStartingRecovery";
import type {
  ChatMessage,
} from "../types";
import type { RunRecord, RunStatus } from "../../../types";
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
  controllerClient,
} from "../../../sdk/instafy";
import { useAuth } from "../../../providers/AuthProvider";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { useWorkspaceUi } from "../../../workspace/useWorkspace";
import { useActiveWorkspaceVersioning } from "../../../workspace/useActiveWorkspaceVersioning";
import { useCodeUpdater } from "../../../code/useCode";
import { useWorkspaceControls } from "../workspaceControls";
import { hasSupabaseConfig, supabase } from "../../../lib/supabaseClient";
import { chatAttachmentsUnavailableReason as resolveChatAttachmentsUnavailableReason } from "../../../lib/chatAttachments";
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
import { browserTurnArrival } from "./browserTurnArrival";
import { ChatColumn } from "./ChatColumn";
import { ChatLoadingPill } from "./ChatLoadingPill";
import { ChatMessageContextToolbar } from "./ChatMessageContextToolbar";
import { ChatMessageHistoryControls } from "./ChatMessageHistoryControls";
import { useStudioSearchReturn } from "./StudioSearchReturnContext";
import { useOctoSilenceHint } from "./useOctoSilenceHint";
import { ChatTypingRows } from "./ChatTypingRows";
import { useChatRunStop } from "./useChatRunStop";
import { resolveChatRunStopTargets } from "./chatRunStopTargets";
import { ChatRunStopNoticeProvider } from "./ChatRunStopNotice";
import { useChatRunStopContinuation } from "./useChatRunStopContinuation";
import {
  AssistantMessageEntry,
  extractChatAttachments,
  UserMessageBubble,
  ChatRuntimeActivityContext,
} from "./ChatMessageEntries";
import { RunFailureRetryProvider } from "./RunFailureNotice";
import { useRunFailureRetryActions } from "./useRunFailureRetryActions";
import {
  buildTimedSyntheticChatRows,
  ChatPostTranscriptAuxiliaryRows,
  StoppedTurnRow,
  WorkspaceStartStalledRow,
} from "./ChatSystemRows";
import { useUnsavedWorkNotice } from "./useUnsavedWorkNotice";
import {
  ChatImageLightboxOverlay,
  ChatInvitePromptOverlay,
  ChatMessageMenuOverlay,
} from "./ChatPanelOverlays";
import { ConversationMessageRows } from "./ConversationMessageRows";
import { MultiAgentRunsContext } from "./MultiAgentPlanEntry";
import { ViewerAgentsContext } from "./viewerAgents";
import { RunTraceRerunNotice } from "./PlanRerunNotice";
import { useConversationPreviewThreads } from "./useConversationPreviewThreads";
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
  isTranscriptTailActiveTurnOutcome,
  resolveJobThreadTypingCoverage,
  resolveMultiAgentTypingStatus,
  resolveSingleAgentTypingStatus,
  resolveTranscriptTailKey,
  resolveTypingIndicatorState,
  type TypingIndicatorPhase,
} from "./typingIndicatorState";
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
  readComposerInlineCompletionPreference,
  shouldRequestComposerInlineCompletion,
} from "./composerInlineCompletion";
import { shouldSuppressOuterAvatarForConversationThread } from "./conversationThreadPreviewLayout";
import { resolveComposerGhostSuggestion } from "./composerGhostSuggestion";
import { useChatBrowserSessionState } from "./useChatBrowserSessionState";
import { sharedBrowserPagesFast, useChatComposerBrowserTargeting } from "./useChatComposerBrowserTargeting";
import {
  CHAT_BROWSER_VIEW_START,
  browserTurnUnderWay,
  chatBrowserCardReady,
  chatBrowserHandoffPage,
  chatBrowserTarget,
  chatPageOnScreen,
  newChatBrowserTabId,
  nextChatBrowserViewStep,
  useChatBrowserTab,
  useChatViewTabs,
  type ChatBrowserViewState,
} from "./chatBrowserTab";
import { useShowBrowserOnHumanInput, useShowBrowserOnRequest } from "./useShowBrowserOnRequest";
import { useChatCredentialGate } from "./useChatCredentialGate";
import { useAmbientCredentialGatePresentation } from "./useAmbientCredentialGatePresentation";
import { canUseDesktopCodexAuthJson } from "./desktopCodexAuthJson";
import { CredentialsConnectModal } from "./CredentialsConnectModal";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { AgentProfileCardContent } from "./AssistantAvatarPopover";
import {
  OPEN_AGENT_PROFILE_EVENT,
  resolveOpenedAgentIdentity,
  type OpenAgentProfileDetail,
} from "./agentProfileOpen";
import { emitAiConfigChanged } from "./aiConfigEvents";
import { formatProxyUpstreamErrorSummary } from "./proxyError";
import { useCredentialsConnectFlow } from "./useCredentialsConnectFlow";
import { useChatAgentRoster } from "./useChatAgentRoster";
import { useChatConversationInviteState } from "./useChatConversationInviteState";
import { useChatOrgMembers } from "./useChatOrgMembers";
import { useChatGithubImportFlow } from "./useChatGithubImportFlow";
import { getMessageType } from "./chatMessageMetadata";
import {
  type AssistantAgentIdentity,
  type AssistantAvatarMotion,
  type AssistantTypingAgent,
  extractAgentIdentityFromMetadata,
  extractRunIdFromMetadata,
  resolvePreviousAssistantHandle,
  resolveTypingAgentLanes,
  resolveViewerAgentProfile,
  shouldShowAssistantAvatarForMessage,
  shouldShowAssistantIdentityForMessage,
} from "./chatAssistantIdentity";
import { useStudioNavigationPosture } from "../useStudioNavigationPosture";
import {
  toBrowserSessionPageTarget,
  type BrowserSessionPageTarget,
} from "./browserSessionPages";
import { resolveChatComposerAffordances } from "./chatComposerAffordances";
import {
  resolveSharedBrowserSendBlocker,
  SHARED_BROWSER_SEND_BLOCKER_STATUS,
} from "./sharedBrowserSubmitRouting";
import { useChatInvitePromptHandlers } from "./useChatInvitePromptHandlers";
import { useChatComposerAttachments } from "./useChatComposerAttachments";
import { useSendPageToOcto } from "./useSendPageToOcto";
import { composerTargetsBrowser } from "./sentPageAttachment";
import { captureRuntimeBrowserSessionPage } from "../../../services/runtimeController/browserSession";
import { useChatComposerPreviewTab } from "./useChatComposerPreviewTab";
import { useChatSendQueueActions } from "./useChatSendQueueActions";
import { useChatSendQueuePresentation } from "./useChatSendQueuePresentation";
import { useStalledWorkspaceStart } from "./useStalledWorkspaceStart";
import { useStoppedTurnNotice } from "./useStoppedTurnNotice";
import {
  isServerQueuedChatSendItem,
  useChatServerSendQueue,
} from "./useChatServerSendQueue";
import { useChatMessageStashes } from "./useChatMessageStashes";
import { useChatSubmitDispatch } from "./useChatSubmitDispatch";
import { useChatSubmitFlow, type SubmitMessageFn } from "./useChatSubmitFlow";
import { useChatVoiceComposerController } from "./useChatVoiceComposerController";
import { useChatGettingStartedState } from "./useChatGettingStartedState";
import { mergeMentionableMembers } from "./mentionableMembers";
import { sendWorkspaceFileStaleMerge } from "./workspaceFileStaleMerge";
import { reloadStaleWorkspaceFile } from "./workspaceFileStaleReload";
import {
  resolveConversationHumanPeerContext,
  resolveGettingStartedConversationContext,
} from "./gettingStartedConversationContext";
import {
  resolveConversationRosterAgents,
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
import { resolveRosterCredential } from "./participantCredential";
import {
  modelOptionsForProvider,
  normalizeAiModelId,
  normalizeAiProviderId,
  type AiProviderId,
} from "../../../utils/aiProviderModels";
import { useChatComposerLayoutState } from "./useChatComposerLayoutState";
import { useChatAutoScrollSync, useChatScrollController } from "./useChatScrollOrchestration";
import { useChatNewerHistoryPaging } from "./useChatNewerHistoryPaging";
import { useChatNewMessages } from "./useChatNewMessages";
import { ChatNewMessagesButton } from "./ChatNewMessagesButton";
import { useConversationOnScreen } from "./useConversationOnScreen";
import { useMessageContext } from "../../../conversations/useMessageContext";
import { useStudioNavigation } from "../../../navigation/useStudioNavigation";
import { revealCanonicalMessageTarget } from "./messageContextPresentation";
import { ChatScrollSnapshotBoundary } from "./ChatScrollSnapshotBoundary";
import { resolveChatScrollHistoryVisit } from "./chatScrollHistory";
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
  resolveTokenUsageForMessage,
} from "./chatMessageDetailHelpers";
import {
  HumanSpeakerIdentityLabel,
  resolveHumanChatIdentity,
} from "./chatHumanIdentity";
import { ChatComposerSurface } from "./ChatComposerSurface";
import { useWorkerQuestionReply, WorkerQuestionReplyContext, WorkerQuestionReplyStrip } from "./WorkerQuestionReply";
import type { ControllerMessageStash } from "../../../services/runtimeController/messageStashes";
import {
  createConversationClientSendId,
  createConversationSendIntentAttemptKey,
  sendConversationIntent,
} from "../../../services/runtimeController/sendIntents";
import { ControllerApiError } from "../../../services/runtimeController/core";
import { normalizeChatMessageStashEnvelope } from "./chatMessageStashEnvelope";
import { describeSendIntentError } from "./sendIntentErrorMessage";
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
import { LazyBrowserSessionModal } from "./LazyBrowserSessionModal";
import { BrowserApprovalRow } from "./BrowserApprovalRow";
import { useChatSharedBrowserApproval, useChatViewApprovalPending } from "./useChatSharedBrowserApproval";
import {
  fallbackRowContinuesTail,
  TurnBrowserApprovalContext,
  TurnBrowserApprovalStateContext,
  useTurnBrowserApprovalProvider,
} from "./turnBrowserApproval";
import type { SharedBrowserChromeProps } from "./SharedBrowserChrome";
import { resolveSharedBrowserViewerKind } from "./sharedBrowserViewer";
import { LocalBrowserSharing, LocalBrowserTabPublisher } from "./LocalBrowserSharing";
import { ConversationSurfaceLayout, ConversationSurfaceTabs, type ConversationSurface } from "../../../workspace/ConversationSurfaceLayout";
import { ConversationWorkspaceViews } from "../../../workspace/ConversationWorkspaceViews";
import { ConversationFileContext } from "../../../workspace/ConversationFileContext";
import { ConversationPreviewContext, type ConversationPreviewOpener } from "../../../workspace/ConversationPreviewContext";
import { browserViewTabDetails } from "../../../workspace/browserViewTab";
import { conversationSurfaceScope, closeConversationFile, closeConversationPreview, conversationFileLabel, conversationResourceId, openConversationFile, openConversationPreview, selectConversationView, visibleSitePreviewId } from "../../../workspace/conversationSurfaces";
import { SitePreviewPanel } from "./SitePreviewPanel";
import { askOutcomesFromRuns, composerAskSender, siteAskAccess } from "./previewHost/siteAsks";
import type { SiteAskHost } from "./previewHost/useSiteAsks";
import { endOwnPresentation } from "./previewHost/followStore";
import { previewTabLocation } from "./previewHost/PreviewLocation";
import { useLocationSitesVersion } from "./previewHost/locationSites";
import type { OpenWorkspaceFileEventDetail } from "./useFilesPanelViewerState";
import { FilesPanel } from "../StudioLazyPanels";
import { composerBrowserActions } from "./composerBrowserActions";
import {
  BrowserLocationOptions,
  BrowserTransportSelector,
  PersonalBrowserSurface,
} from "./PersonalBrowserSurface";
import {
  type BrowserTransport,
  usePersonalBrowserBridge,
} from "./usePersonalBrowserBridge";
import {
  readBrowserTransportPreference,
  readBrowserSessionTransport,
  resolveBrowserTransportSelection,
  writeBrowserSessionTransport,
  writeBrowserTransportPreference,
} from "./browserTransportPreference";
import { ChatTranscriptViewport } from "./ChatTranscriptViewport";
import { resolveSharedBrowserControlOwner } from "./sharedBrowserControlOwner";
import { useSharedBrowserApprovalTransport } from "./useSharedBrowserApprovalTransport";
import { useChatBrowserHandoff } from "./useChatBrowserHandoff";
import { BROWSER_HUMAN_INPUT_CONTINUE_PROMPT, isLetOctoContinuePrompt } from "./useBrowserHumanInput";
import { useBrowserHandBack } from "./useBrowserHandBack";
import {
  useChatBrowserRequest,
  type BrowserAutoStartOptions,
  type SharedBrowserViewError,
} from "./useChatBrowserRequest";
import {
  BrowserRequestHostContext,
  anyBrowserCardOpening,
  browserRequestContinuedKeys,
  newestBrowserRequestKey,
  pressedBrowserCardSites,
  type BrowserRequestHost,
} from "./browserRequest";
import { routedBrowserWaitingKeys } from "./routedBrowserFold";
import {
  BROWSER_AUTO_START_COPY,
  browserAutoStartHeldByDraft,
  browserAutoStartHeldByOther,
  browserAutoStartPlan,
  browserPressRuntime,
  conversationBrowserHostId,
  markBrowserAutoStartDeclined,
  type SharedBrowserPresence,
} from "./browserAutoStart";
import { useSharedBrowserHostSnapshot } from "./useSharedBrowserHostSnapshot";
import { sharedBrowserLateAttachInputs, useSharedBrowserAutoAttach } from "./useSharedBrowserAutoAttach";
import { hostedBrowserPagesActive, type HostedBrowserViewKind } from "./hostedBrowserViewState";
import { isSkillSetupConversation } from "./skillSetupConversation";
import { routedBrowserFollowUp, sharedBrowserAgentPageIds, sharedBrowserConversationRunIds } from "./browserHandoffRouting";
import { BROWSER_AGENT_DEFAULT_NAME } from "./browserAgentTabs";

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
  const { user } = useAuth();
  const currentUserId = user?.id ?? null;
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
    hostedRuntimeStopAtMs,
    runtimeEnsureError,
    runtimeEnsureLimit,
    runtimeStatuses,
    runs,
    sharedBrowserHostPolicy,
  } = runtimeContext;
  const {
    projectKey: conversationsProjectKey,
    remoteConversationHistoryResolved = true,
    remoteConversationHistoryError = null,
    retryRemoteConversationHistory,
    conversations,
    appendMessages,
    replaceMessages,
    createConversation,
    setConversationDraft,
  } = useConversations();
  const {
    activeConversationId,
    messages: recentMessages,
    inputValue,
    inputEditorState,
    assistantEnabled,
    extraAgentHandles,
    agentHandles,
    onAssistantEnabledChange,
    onRemoveAgentHandle,
    isAssistantTyping,
    hasMoreHistory: hasMoreRecentHistory,
    isHistoryLoading: isRecentHistoryLoading,
    isInitialHistoryLoading: isInitialRecentHistoryLoading,
    hasResolvedHistory: hasResolvedRecentHistory,
    latestArrivalMessages,
    initialHistoryError: recentHistoryError,
    retryInitialHistory: retryRecentHistory,
    loadOlderMessages: loadOlderRecentMessages,
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
    projectInitialized,
    projectAccessPending,
    projectCapabilitiesResolved,
    effectiveProjectRole,
    canWriteProject,
    canShareProject: serverCanShareProject,
    chatAttachments,
  } = useProject();
  const chatAttachmentsUnavailableReason = resolveChatAttachmentsUnavailableReason(chatAttachments);
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
  const goToStudio = useStudioNavigation();
  const searchReturn = useStudioSearchReturn();
  const messageQueryClient = useQueryClient();
  const requestedMessageId = new URLSearchParams(location.search).get("messageId")?.trim() || null;
  const messageTargetActive = Boolean(requestedMessageId && !jobThread);
  const chatScrollHistoryVisit = resolveChatScrollHistoryVisit({
    location, userId: currentUserId, projectId: activeProjectId ?? null,
    conversationsProjectKey, conversationId: activeConversationId,
    conversationControllerId: activeConversationControllerId, jobThread,
  });
  const messageContext = useMessageContext(messageTargetActive && chatScrollHistoryVisit && activeConversationControllerId
    ? { userId: chatScrollHistoryVisit.userId, projectId: chatScrollHistoryVisit.projectId,
      conversationId: activeConversationControllerId, messageId: requestedMessageId!, visitKey: chatScrollHistoryVisit.key }
    : null);
  const messages = messageTargetActive ? messageContext.messages : recentMessages;
  const unsavedWorkNotice = useUnsavedWorkNotice({ userId: currentUserId, messages });
  const hasMoreHistory = messageTargetActive ? messageContext.hasOlder : hasMoreRecentHistory;
  const isHistoryLoading = messageTargetActive ? messageContext.loading : isRecentHistoryLoading;
  const isInitialHistoryLoading = messageTargetActive
    ? !chatScrollHistoryVisit || (messageContext.loading && !messages.length)
    : isInitialRecentHistoryLoading;
  const initialHistoryError = messageTargetActive ? messageContext.error : recentHistoryError;
  const displayedHistoryError = messageTargetActive && messageContext.newerError ? null : initialHistoryError;
  const retryInitialHistory = messageTargetActive ? messageContext.retry : retryRecentHistory;
  const loadOlderMessages = messageTargetActive ? messageContext.loadOlder : loadOlderRecentMessages;
  useEffect(() => {
    if (!messageContext.accessDenied || !currentUserId || !activeConversationId || !activeConversationControllerId) return;
    messageQueryClient.removeQueries({ queryKey: ["conversation-messages", currentUserId, activeConversationControllerId], exact: true });
    messageQueryClient.removeQueries({ queryKey: ["conversation-messages-latest", currentUserId, activeConversationControllerId], exact: true });
    replaceMessages(activeConversationId, []);
  }, [messageContext.accessDenied, currentUserId, activeConversationId, activeConversationControllerId, messageQueryClient, replaceMessages]);
  const returnToLatestMessages = useCallback(() => {
    if (!activeProjectId || !activeConversationId) return;
    goToStudio({ kind: "conversation", projectId: activeProjectId, conversationId: activeConversationId,
      conversationControllerId: activeConversationControllerId }, { replace: true, searchOriginToken: searchReturn.originToken ?? undefined });
  }, [activeProjectId, activeConversationId, activeConversationControllerId, goToStudio, searchReturn.originToken]);
  const {
    browserSessionOpen,
    browserSessionOpenedInPage,
    browserSessionStateHydrated,
    exactBrowserRuntimeId,
    browserSessionExpandRequestToken,
    handleBrowserRuntimeIdResolved,
    handleBrowserSessionOpenChange,
    handleHiddenBrowserSessionUnavailable,
    handleToggleBrowserSession,
    hasHiddenBrowserSession,
    openBrowserSession,
    resumeBrowserSession,
    preferredBrowserRuntimeId,
    requestBrowserSessionExpand,
    resolvedBrowserRuntimeId,
  } = useChatBrowserSessionState({
    currentUserId,
    activeConversationControllerId,
    activeConversationId,
    activeProjectId: activeProjectId ?? null,
    effectiveRuntimeId,
    preferredRuntimeId: preferredRuntimeId ?? null,
    refreshRuntimeStatuses,
    setSessionRuntimeOverride,
  });
  const { conversationWorkspace, conversationSurfaces, setConversationBrowser, openConversationTab: openSurfaceConversation } = useWorkspaceTabs();
  const surfaceScope = conversationSurfaceScope(currentUserId, activeProjectId ?? null, activeConversationId);
  const multiAgentRunContext = useMemo(() => ({ runs, scopeKey: surfaceScope }), [runs, surfaceScope]);
  const { read: readSurfaces, update: updateSurfaces } = conversationSurfaces;
  const surfaces = readSurfaces(surfaceScope);
  const dirtyFilePaths = useWorkspaceStore(store => store.state.code.files
    .filter(file => file.modified !== file.generated).map(file => file.path).join("\0"));
  const dirtyFiles = useMemo(() => new Set(dirtyFilePaths.split("\0")), [dirtyFilePaths]);
  const previewSurfaceRatio = useCallback((ratio: number) => {
    rootRef.current?.style.setProperty("--conversation-resource-ratio", String(ratio));
  }, []);
  const selectSurface = useCallback((id: string) => {
    updateSurfaces(surfaceScope, state => selectConversationView(state, id));
  }, [surfaceScope, updateSurfaces]);
  const setBrowserSubtab = selectSurface;
  const browserSubtab = surfaces.activeId;
  const [surfaceWidth, setSurfaceWidth] = useState(0);
  const hasBrowserView = browserSessionOpen || hasHiddenBrowserSession;
  // Each preview tab shows its site's 📍 while that site has the person's location.
  useLocationSitesVersion();
  const hasResources = hasBrowserView || surfaces.files.length > 0 || surfaces.previews.length > 0;
  const resourceId = conversationResourceId(surfaces, hasBrowserView);
  const activeSurfaceId = conversationWorkspace && jobThread ? "chat" : surfaces.activeId === "browser" && !hasBrowserView ? "chat" : surfaces.activeId;
  const wideSurfaces = surfaceWidth >= 1024;
  const splitSurfaces = !(conversationWorkspace && jobThread) && wideSurfaces && surfaces.split && hasResources;
  const browserVisible = hasBrowserView && resourceId === "browser" && (splitSurfaces || activeSurfaceId === "browser");
  const chatVisible = splitSurfaces || activeSurfaceId === "chat" || !hasResources;
  const [fileOpenRequest, setFileOpenRequest] = useState<OpenWorkspaceFileEventDetail | null>(null);
  const openSurfaceFile = useCallback((detail: OpenWorkspaceFileEventDetail) => {
    if (detail.projectId && detail.projectId !== activeProjectId) return;
    const path = detail.path.trim();
    if (!path) return;
    updateSurfaces(surfaceScope, state => openConversationFile(state, {
      id: `file:${path}`, path,
      line: detail.line ?? undefined, markdownView: detail.markdownView,
    }));
    setFileOpenRequest({ ...detail, path, projectId: activeProjectId });
    // Run threads share the task's files; selecting one leaves the transcript view.
    if (conversationWorkspace && jobThread && activeConversationId) openSurfaceConversation(activeConversationId);
  }, [activeProjectId, activeConversationId, conversationWorkspace, jobThread, openSurfaceConversation, surfaceScope, updateSurfaces]);
  const selectedFile = surfaces.files.find(file => file.id === resourceId);
  const selectedPreview = surfaces.previews.find(preview => preview.id === resourceId);
  const visiblePreviewId = visibleSitePreviewId(surfaces, { resourceId, activeId: activeSurfaceId, split: splitSurfaces });
  const openSurfacePreview = useCallback((preview: { previewId: string; title: string }) => {
    updateSurfaces(surfaceScope, state => openConversationPreview(state, preview));
    // As with files: a run thread shares the task's views, so opening one leaves the transcript.
    if (conversationWorkspace && jobThread && activeConversationId) openSurfaceConversation(activeConversationId);
  }, [activeConversationId, conversationWorkspace, jobThread, openSurfaceConversation, surfaceScope, updateSurfaces]);
  const previewOpener = useMemo<ConversationPreviewOpener>(() => ({ openPreview: openSurfacePreview, visiblePreviewId }), [openSurfacePreview, visiblePreviewId]);
  const fileRequest = useMemo(() => selectedFile ? (
    fileOpenRequest?.path === selectedFile.path ? fileOpenRequest : {
      path: selectedFile.path, projectId: activeProjectId, line: selectedFile.line, markdownView: selectedFile.markdownView,
    }
  ) : null, [activeProjectId, fileOpenRequest, selectedFile]);
  useEffect(() => { if (messageTargetActive) selectSurface("chat"); }, [messageTargetActive, location.key, selectSurface]);
  // Whether this chat's Browser view shows a prompt, kept with the chat the
  // view said it for: a chat the person goes to never reads the prompt of
  // the one they left (useChatViewApprovalPending).
  const chatViewApproval = useChatViewApprovalPending(surfaceScope);
  const sharedBrowserApprovalPending = chatViewApproval.pending;
  const [browserTransport, setBrowserTransport] = useState<BrowserTransport>("shared");
  const browserTransportScopeKey = currentUserId && activeProjectId && activeConversationId
    ? JSON.stringify([currentUserId, activeProjectId, activeConversationId]) : null;
  const [browserTransportPreferenceScope, setBrowserTransportPreferenceScope] = useState<string | null>(null);
  const browserTransportPreferenceResolved = Boolean(browserTransportScopeKey && browserTransportPreferenceScope === browserTransportScopeKey);
  const [sharedBrowserActivated, setSharedBrowserActivated] = useState(false);
  const sharedBrowserActivationScopeRef = useRef<string | null>(null);
  const generatedBrowserPanelId = useId();
  const generatedChatPanelId = useId();
  const browserPanelId = conversationWorkspace ? "conversation-workspace-browser" : generatedBrowserPanelId;
  const chatPanelId = conversationWorkspace ? "conversation-workspace-chat" : generatedChatPanelId;
  const showBrowserSubtab = useCallback(() => setBrowserSubtab("browser"), [setBrowserSubtab]);
  useShowBrowserOnRequest(browserSessionOpen, browserSessionExpandRequestToken, showBrowserSubtab);
  const handleBrowserSubtabChange = useCallback(
    (tab: string) => {
      setBrowserSubtab(tab);
      if (tab === "browser" && !browserSessionOpen) {
        handleToggleBrowserSession();
      }
    },
    [browserSessionOpen, handleToggleBrowserSession, setBrowserSubtab],
  );
  // Octo paused on the person's fields: the page where they sign in comes
  // forward, as the Browser tab would.
  const showBrowserForHumanInput = useCallback(() => handleBrowserSubtabChange("browser"), [handleBrowserSubtabChange]);
  const runRecords = useMemo(() => Object.values(runs ?? {}), [runs]);
  useShowBrowserOnHumanInput({
    identity: JSON.stringify([currentUserId, activeProjectId, activeConversationId]),
    userId: currentUserId,
    messages,
    runs: runRecords,
    show: showBrowserForHumanInput,
  });
  useEffect(() => {
    if (conversationWorkspace && !jobThread && surfaces.activeId === "browser" && hasHiddenBrowserSession && !browserSessionOpen) {
      handleToggleBrowserSession();
    }
  }, [conversationWorkspace, jobThread, surfaces.activeId, hasHiddenBrowserSession, browserSessionOpen, handleToggleBrowserSession]);
  const handleBackToChat = useCallback(() => {
    setBrowserSubtab("chat");
  }, [setBrowserSubtab]);
  const { onOpenProjectSettings, onOpenChatNavigation, homeAttentionCount = 0 } = useWorkspaceControls();
  const activeConversationEntry = useMemo(() => {
    if (!activeConversationId) {
      return null;
    }
    return conversations.find((conversation) => conversation.localId === activeConversationId) ?? null;
  }, [activeConversationId, conversations]);
  const isAtLeastSmallViewport = useBreakpoint("sm");
  const { showComposerNavigationButton, touchLikeInput } = useStudioNavigationPosture();
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
      setSurfaceWidth(width);
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
    containerWidth: browserPanelSize ? (splitSurfaces ? browserPanelSize.width * surfaces.ratio : browserPanelSize.width) : null,
    compactViewport: compactBrowserViewport,
  });
  const compactSharedBrowserViewport =
    browserPanelSize !== null
      ? (splitSurfaces ? browserPanelSize.width * surfaces.ratio : browserPanelSize.width) < ADAPTIVE_SHARED_BROWSER_WIDTH_PX
      : compactBrowserViewport;
  const homeAttentionBadge = homeAttentionCount > 9 ? "9+" : homeAttentionCount.toString();
  const pinChatMessagesToBottom = !messageTargetActive && shouldPinChatMessagesToBottom({
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
    restoreServerSendQueueItem,
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
      browserTransportPreferenceResolved &&
      browserSessionOpen &&
      browserVisible &&
      browserTransport === "personal",
    profileUserId: currentUserId,
    projectId: activeProjectId ?? null,
    conversationBindingKey: activeConversationId ?? null,
  });
  useEffect(() => {
    if (
      !personalBrowser.checked ||
      !currentUserId ||
      !activeProjectId ||
      !activeConversationId ||
      !browserSessionStateHydrated ||
      browserTransportPreferenceResolved
    ) {
      return;
    }
    const nextTransport = resolveBrowserTransportSelection({
      resume: readBrowserSessionTransport(currentUserId, activeProjectId, activeConversationId)
        ?? (exactBrowserRuntimeId ? "shared" : null),
      preference: readBrowserTransportPreference(currentUserId),
      personalAvailable: personalBrowser.available,
    });
    setBrowserTransport(nextTransport);
    setBrowserTransportPreferenceScope(browserTransportScopeKey);
    setSharedBrowserActivated(browserSessionOpen && nextTransport === "shared");
  }, [
    activeProjectId,
    activeConversationId,
    browserTransportScopeKey,
    browserTransportPreferenceResolved,
    browserSessionStateHydrated,
    exactBrowserRuntimeId,
    currentUserId,
    personalBrowser.available,
    personalBrowser.checked,
    browserSessionOpen,
  ]);
  useEffect(() => {
    if (browserTransportPreferenceResolved && browserSessionOpen && currentUserId && activeProjectId && activeConversationId) {
      writeBrowserSessionTransport(currentUserId, activeProjectId, activeConversationId, browserTransport);
    }
  }, [browserTransportPreferenceResolved, browserSessionOpen, currentUserId, activeProjectId, activeConversationId, browserTransport]);
  const handleBrowserTransportChange = useCallback((transport: BrowserTransport) => {
    setBrowserTransportPreferenceScope(browserTransportScopeKey);
    if (transport === "shared") {
      setSharedBrowserActivated(true);
    }
    setBrowserTransport(transport);
    if (currentUserId) {
      writeBrowserTransportPreference(currentUserId, transport);
    }
  }, [currentUserId, browserTransportScopeKey]);
  const revealSharedBrowserApproval = useCallback(() => {
    // Approval requests belong to the mounted Shared Browser. Reveal that
    // surface without stealing focus from Chat or overwriting the user's saved
    // Personal Browser preference; Personal remains mounted for the next switch.
    setBrowserTransportPreferenceScope(browserTransportScopeKey);
    setSharedBrowserActivated(true);
    setBrowserTransport("shared");
  }, [browserTransportScopeKey]);
  const resumeSharedBrowser = useCallback((runtimeId: string) => {
    revealSharedBrowserApproval();
    resumeBrowserSession(runtimeId);
  }, [resumeBrowserSession, revealSharedBrowserApproval]);
  const replaceSharedBrowserResumeSearch = useSharedBrowserResumeSearchReplacement();
  const { runtimeId: requestedSharedBrowserRuntimeId, acknowledgeRuntimeResolved } = useSharedBrowserResume({
    search: location.search,
    projectId: activeProjectId ?? null,
    userId: currentUserId,
    ready: browserTransportPreferenceResolved && browserSessionStateHydrated &&
      conversationsProjectKey === activeProjectId && Boolean(activeConversationId),
    onResume: resumeSharedBrowser,
    onReplaceSearch: replaceSharedBrowserResumeSearch,
  });
  const handleSharedBrowserRuntimeResolved = useCallback((runtimeId: string | null) => {
    acknowledgeRuntimeResolved(runtimeId);
    handleBrowserRuntimeIdResolved(runtimeId);
  }, [acknowledgeRuntimeResolved, handleBrowserRuntimeIdResolved]);
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
  const mentionableUsers = useMemo(
    () => mergeMentionableMembers({ orgMembers, projectMembers, currentUserId }),
    [currentUserId, orgMembers, projectMembers],
  );

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
  const { tabs: workspaceTabs, keepTabOpen, openPanelTab, openConversationTab, openJobThreadTab, requestUrlPush } = useWorkspaceTabs();
  const guardNavigation = useStudioGuardedNavigation();
  const hasComposerViewNavigation = showComposerNavigationButton && (hasResources || (conversationWorkspace && workspaceTabs.some(tab => tab.workspaceOwner?.conversationId === activeConversationId)));
  const { keepComposerTabOpen, keepComposerTabOpenForEdit } = useChatComposerPreviewTab({
    conversationId: activeConversationId,
    inputValue,
    inputEditorState,
    tabs: workspaceTabs,
    keepTabOpen,
  });
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
  const [workspaceFileStaleBusy, setWorkspaceFileStaleBusy] = useState<null | "merge" | "reload">(null);
  const [workspaceFileStaleError, setWorkspaceFileStaleError] = useState<string | null>(null);
  // Reload latest reads the way the Files panel does and writes its buffer.
  const updateWorkspace = useCodeUpdater();
  const { mode: filesVersioningMode, originId: filesVersioningOriginId } = useActiveWorkspaceVersioning();
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
        variant?: string | null;
        originId?: string | null;
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
        ...(detail.variant === "desktop" ? { variant: "desktop" as const } : {}),
        ...(typeof detail.originId === "string" && detail.originId ? { originId: detail.originId } : {}),
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

  const handleWorkspaceFileStaleReload = useCallback(async () => {
    const notice = workspaceFileStaleNotice;
    if (!notice || typeof window === "undefined") {
      return;
    }
    setWorkspaceFileStaleBusy("reload");
    setWorkspaceFileStaleError(null);
    const result = await reloadStaleWorkspaceFile({
      notice,
      projectId: notice.projectId ?? activeProjectId ?? null,
      versioning: { mode: filesVersioningMode, originId: filesVersioningOriginId },
      runtimeId: effectiveRuntimeId ?? null,
      updateWorkspace,
    });
    setWorkspaceFileStaleBusy(null);
    if (result.status === "reloaded") {
      handleWorkspaceFileStaleDismiss();
    } else if (result.status === "failed") {
      setWorkspaceFileStaleError(result.error);
    }
  }, [
    activeProjectId,
    effectiveRuntimeId,
    filesVersioningMode,
    filesVersioningOriginId,
    handleWorkspaceFileStaleDismiss,
    updateWorkspace,
    workspaceFileStaleNotice,
  ]);

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
      const preservedDraft = latestInputValueRef.current;
      const preservedEditorState = latestInputEditorStateRef.current;

      if (!ensureProjectWriteAccess()) {
        return;
      }
      // Large versions go to the agent as two attached snapshots in this
      // chat's Storage folder; without attachment storage they stay inline.
      await sendWorkspaceFileStaleMerge({
        notice,
        chatAttachments,
        submit: (prompt, options) => onSubmit(conversationId, prompt, options),
      });

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
    chatAttachments,
    createConversation,
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
  // The composer's own completion only: a reply's offered replies are never
  // shown, so none of them is ghost text or what Enter sends from an empty
  // composer.
  const composerGhostSuggestion = useMemo(
    () =>
      resolveComposerGhostSuggestion(
        inputValue,
        composerInlineSuggestion ? [composerInlineSuggestion] : [],
      ),
    [composerInlineSuggestion, inputValue],
  );
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
  // Handles belong to an owner, so a row's agent is the viewer's own only by
  // its exact id; the chat draws those from their current profile.
  const availableAgentById = useMemo(
    () => new Map(availableAgents.map((agent) => [agent.id, agent])),
    [availableAgents],
  );
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
  // keyboard focus to the composer after navigating here; without this the
  // popover's focus restore lands on <body> once its trigger unmounts.
  useEffect(() => {
    const handler = () => focusInput({ force: true });
    window.addEventListener("instafy:focus-composer", handler);
    return () => window.removeEventListener("instafy:focus-composer", handler);
  }, [focusInput]);
  // Carry the observed ID across the mobile/mention entrypoint; handles alone
  // cannot identify another user's bot. An open card belongs to this account/space.
  const [agentProfileTarget, setAgentProfileTarget] = useState<{
    identity: OpenAgentProfileDetail; projectId: string | null; userId: string | null;
  } | null>(null);
  const agentProfileModal = agentProfileTarget && agentProfileTarget.projectId === activeProjectId &&
    agentProfileTarget.userId === currentUserId ? agentProfileTarget.identity : null;
  const agentProfileCardIdentity = useMemo(
    () => agentProfileModal ? resolveOpenedAgentIdentity(agentProfileModal, agentByHandle) : null,
    [agentByHandle, agentProfileModal],
  );
  useEffect(() => {
    setAgentProfileTarget(null);
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<OpenAgentProfileDetail>).detail;
      const handle = detail?.handle;
      if (typeof handle === "string" && handle) {
        setAgentProfileTarget({ identity: detail, projectId: activeProjectId, userId: currentUserId });
      }
    };
    window.addEventListener(OPEN_AGENT_PROFILE_EVENT, handler);
    return () => window.removeEventListener(OPEN_AGENT_PROFILE_EVENT, handler);
  }, [activeProjectId, currentUserId]);
  // This identity belongs to one mounted Shared Browser surface. Keeping it in
  // memory avoids duplicate tabs or side-by-side surfaces replacing each other,
  // while remaining stable across transport and network reconnects.
  const sharedBrowserSurfaceSessionId = useMemo(() => generateUUID(), []);
  // What the open browser view shows (off, opening, live, failed, blocked),
  // or null while it is closed. Its pages are read only while it is opening
  // or live; a closed (hidden) one keeps its own rules.
  const [sharedBrowserViewKind, setSharedBrowserViewKind] = useState<HostedBrowserViewKind | null>(null);
  const sharedBrowserPagesActive = hostedBrowserPagesActive(sharedBrowserViewKind);
  // Who else is in the browser view (from the view's collaboration socket).
  // Its page list and the automatic-open decision below both read it.
  const [sharedBrowserPresence, setSharedBrowserPresence] = useState<SharedBrowserPresence | null>(null);
  // A card is opening Instafy's browser by itself (useChatBrowserRequest): its
  // tabs are read at the fast pace meanwhile, so the card's turn goes out as
  // soon as the browser lists one, with the person in Chat too.
  const [browserCardOpening, setBrowserCardOpening] = useState(false);
  // Work is running in the space. The browser view polls fast only then, and
  // Clear data's confirmation says that clearing restarts the machine.
  const spaceRunActive = useMemo(() => {
    const now = Date.now();
    return Object.values(runs ?? {}).some((run) =>
      (!run.projectId || run.projectId === (activeProjectId ?? null)) &&
      isRunActivelyProgressing(run, now));
  }, [activeProjectId, runs]);
  const {
    clearPendingBrowserLaunchMode,
    handleClearPendingNewBrowserSession,
    handleOpenBrowserFromLauncher,
    handlePrepareNewBrowserSession,
    handleSelectBrowserSessionPage,
    pendingBrowserLaunchMode,
    sharedBrowserCapabilities,
    sharedBrowserCapabilitiesResolved,
    sharedBrowserCapabilitiesUnsupported,
    sharedBrowserChromePages,
    sharedBrowserChromeResolved,
    sharedBrowserHostNotReadySinceMs,
    sharedBrowserCommandPending,
    sharedBrowserCommandError,
    clearSharedBrowserCommandError,
    navigateSharedBrowserPage,
    goBackInSharedBrowser,
    goForwardInSharedBrowser,
    reloadSharedBrowserPage,
    keepSharedBrowserPage,
    openSharedBrowserPage,
    sharedBrowserCanOpenPage,
    focusSharedBrowserPageQuietly,
    setPendingBrowserLaunchMode,
  } = useChatComposerBrowserTargeting({
    activeConversationId,
    activeProjectId,
    browserSessionOpen,
    browserSessionId: sharedBrowserSurfaceSessionId,
    sharedBrowserActivated,
    browserTransport,
    focusInput,
    hasHiddenBrowserSession,
    onHiddenBrowserSessionUnavailable: handleHiddenBrowserSessionUnavailable,
    openBrowserSession,
    preferredBrowserRuntimeId,
    requestBrowserSessionExpand,
    resolvedBrowserRuntimeId,
    showStatus,
    sharedBrowserPagesActive,
    sharedBrowserPagesPollFast: sharedBrowserPagesFast({
      runActive: spaceRunActive,
      cardOpening: browserCardOpening,
      presence: sharedBrowserPresence,
    }),
    sharedBrowserSurfaceVisible: browserVisible,
  });
  // This chat's own tab in Instafy's browser (chatBrowserTab.ts): its browser
  // turns go there, never to a page another chat left on screen.
  const projectRuns = runRecords;
  // A chat with nothing sent yet has no id: its tab is kept under its local
  // one until then, so its Browser view shows a tab of its own too.
  const newChatBrowserId = activeConversationId ? newChatBrowserTabId(activeConversationId) : null;
  const chatBrowserScopeId = activeConversationControllerId ?? newChatBrowserId;
  const chatBrowserTab = useChatBrowserTab({
    scope: {
      userId: currentUserId,
      projectId: activeProjectId ?? null,
      conversationId: chatBrowserScopeId,
      runtimeId: resolvedBrowserRuntimeId,
    },
    runs: projectRuns,
    pages: sharedBrowserChromePages,
    canOpenPage: sharedBrowserCanOpenPage,
    openPage: openSharedBrowserPage,
    newChatId: newChatBrowserId,
  });
  const chooseChatBrowserTab = chatBrowserTab.choose;
  const resolveChatBrowserTab = chatBrowserTab.resolveForTurn;
  // A message aimed at the browser goes to this chat's own tab, and the
  // Browser tab is named after it: never the tab another chat left in front.
  const chatBrowserMessageTarget = useMemo(
    () => browserTransport === "shared"
      ? chatBrowserTarget({
        tab: chatBrowserTab.tab,
        pages: sharedBrowserChromePages,
        resolved: sharedBrowserChromeResolved,
        canOpenPage: sharedBrowserCanOpenPage,
      })
      : null,
    [browserTransport, chatBrowserTab.tab, sharedBrowserCanOpenPage, sharedBrowserChromePages, sharedBrowserChromeResolved],
  );
  const preferredBrowserPage = chatBrowserMessageTarget?.page ?? null;
  const sharedBrowserBindingPage = chatBrowserMessageTarget?.bindingPage ?? null;
  // The chat's Browser view shows the chat's own tab (nextChatBrowserViewStep).
  const chatBrowserViewRef = useRef<ChatBrowserViewState>(CHAT_BROWSER_VIEW_START);
  const sharedBrowserPresenceKnown = sharedBrowserPresence?.status === "known";
  const sharedBrowserRemoteController = sharedBrowserPresence?.remoteController === true;
  // Only the person who holds the browser's control may bring a tab to the
  // front: until they do (nobody holds it, as after Release), the view waits,
  // and brings the chat's tab forward once they take control.
  const sharedBrowserSelfControls = sharedBrowserPresence?.selfControls !== false;
  const chatBrowserTurnUnderWay = browserTurnUnderWay(
    projectRuns, { conversationId: activeConversationControllerId, runtimeId: resolvedBrowserRuntimeId }, "chat");
  const anyBrowserTurnUnderWay = browserTurnUnderWay(
    projectRuns, { conversationId: activeConversationControllerId, runtimeId: resolvedBrowserRuntimeId }, "any");
  // The tabs this chat's Browser view shows (BrowserSessionModal): the chat's
  // own tab and the tabs Octo opened in the chat's turns, while the browser
  // lists them as Octo's: during the turn, and after it until the list names
  // the one Octo read in last as the chat's page. Never another chat's page:
  // any other tab in front leaves a blank stage. Null for an older browser
  // that cannot give a chat a tab of its own: its view shows the tab in
  // front, as before.
  const chatView = useChatViewTabs({
    chatKey: JSON.stringify([currentUserId, activeProjectId ?? null, chatBrowserScopeId, resolvedBrowserRuntimeId]),
    enabled: browserTransport === "shared" && sharedBrowserCanOpenPage !== false,
    chatTab: chatBrowserTab.tab,
    pages: sharedBrowserChromePages,
    chatTurnUnderWay: chatBrowserTurnUnderWay,
  });
  const chatViewPageIds = chatView.pageIds;
  const chatViewStepTabId = chatView.stepTab?.id ?? null;
  const chatViewStepTabActive = chatView.stepTab?.isActive === true;
  const anotherChatBrowserTurn = anyBrowserTurnUnderWay && !chatBrowserTurnUnderWay;
  useEffect(() => {
    const { state, step } = nextChatBrowserViewStep({
      onScreen: browserVisible && browserTransport === "shared",
      free: sharedBrowserPresenceKnown && !sharedBrowserRemoteController && sharedBrowserSelfControls,
      chatId: chatBrowserScopeId,
      tab: chatViewStepTabId ? { id: chatViewStepTabId, isActive: chatViewStepTabActive } : null,
      canOpenTab: canWriteProject && sharedBrowserChromeResolved && sharedBrowserCanOpenPage !== null,
      chatTurnUnderWay: chatBrowserTurnUnderWay,
      anyTurnUnderWay: anyBrowserTurnUnderWay,
      state: chatBrowserViewRef.current,
    });
    chatBrowserViewRef.current = state;
    if (step === "open-blank-tab") void resolveChatBrowserTab().catch(() => null);
    else if (step === "focus" && chatViewStepTabId) void focusSharedBrowserPageQuietly(chatViewStepTabId).catch(() => false);
  }, [
    anyBrowserTurnUnderWay,
    browserTransport,
    browserVisible,
    canWriteProject,
    chatBrowserScopeId,
    chatBrowserTurnUnderWay,
    chatViewStepTabActive,
    chatViewStepTabId,
    focusSharedBrowserPageQuietly,
    resolveChatBrowserTab,
    sharedBrowserCanOpenPage,
    sharedBrowserChromeResolved,
    sharedBrowserPresenceKnown,
    sharedBrowserRemoteController,
    sharedBrowserSelfControls,
  ]);
  const browserModeActive = browserSessionOpen && browserVisible;
  // A skill setup's composer answers the setup: its replies stay chat turns
  // while the browser is shown, and a walk there goes on only through the
  // browser's own controls (the card's button, Let Octo continue).
  const skillSetupConversation = useMemo(
    () => isSkillSetupConversation({
      messages: recentMessages,
      olderMessagesUnloaded: hasMoreRecentHistory,
      title: activeConversationEntry?.title,
    }),
    [activeConversationEntry?.title, hasMoreRecentHistory, recentMessages],
  );
  const browserRequestIdentity = JSON.stringify([currentUserId, activeProjectId, activeConversationId]);
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
        // The person sends this tab somewhere: it is this chat's tab now,
        // once the browser took the address.
        void navigateSharedBrowserPage(pageId, url).then((sent) => {
          if (sent) chooseChatBrowserTab(pageId);
        });
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
        // The person picks this tab: this chat's next browser turn uses it,
        // once it is the tab on screen.
        void handleSelectBrowserSessionPage(pageId).then((focused) => {
          if (focused) chooseChatBrowserTab(pageId);
        });
      },
      onClearError: clearSharedBrowserCommandError,
    };
  }, [
    chooseChatBrowserTab,
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

  const composerDraftKey = JSON.stringify([currentUserId, activeProjectId, activeConversationId]);
  const {
    attachSentPage,
    handleComposerDragOver,
    handleComposerDrop,
    handleComposerPaste,
    handleImageInputChange,
    imageAttachments,
    imageInputRef,
    markImageAttachmentsSending,
    openImagePicker,
    removeImageAttachment,
    removeSentImageAttachments,
  } = useChatComposerAttachments({
    draftKey: composerDraftKey,
    onAttachmentsAdded: keepComposerTabOpen,
    isInputLocked: () => onboardingInputLocked,
    showStatus,
    unavailableReason: chatAttachmentsUnavailableReason,
  });
  // Send page to Octo: a press in either browser reads its page once and
  // stages it here, like a paste. Only people who can add attachments see it.
  const { send: sendPageToOcto, pendingViewer: sendPagePendingViewer } = useSendPageToOcto({
    attachSentPage,
    showStatus,
    unavailableReason: chatAttachmentsUnavailableReason,
    identityKey: composerDraftKey,
  });
  const canSendPages = canWriteProject === true && Boolean(activeProjectId);
  const readPersonalPage = personalBrowser.readPage;
  const sendPersonalPage = useCallback(() => {
    void sendPageToOcto("personal", readPersonalPage);
  }, [readPersonalPage, sendPageToOcto]);
  const sendSharedPage = useCallback((pageId: string) => {
    const projectId = activeProjectId;
    if (!projectId) return;
    void sendPageToOcto("shared", () => captureRuntimeBrowserSessionPage({
      projectId,
      browserSessionId: sharedBrowserSurfaceSessionId,
      pageId,
      preferRuntimeId: resolvedBrowserRuntimeId,
    }));
  }, [activeProjectId, resolvedBrowserRuntimeId, sendPageToOcto, sharedBrowserSurfaceSessionId]);
  const sharedBrowserChromeWithSend = useMemo<SharedBrowserChromeProps | null>(
    () => sharedBrowserChrome && canSendPages
      ? { ...sharedBrowserChrome, onSendPage: sendSharedPage, sendPagePending: sendPagePendingViewer === "shared" }
      : sharedBrowserChrome,
    [canSendPages, sendPagePendingViewer, sendSharedPage, sharedBrowserChrome],
  );
  // A message that carries a sent page goes to Octo in chat, where it can
  // read the page and keep building, never to a browser-only turn that
  // cannot open attachments.
  const sentPageStaged = imageAttachments.some((attachment) => Boolean(attachment.page));
  // The split-view composer belongs to Chat. A visible resource must not
  // silently restrict every workspace task to browser tools.
  const browserComposerActive = composerTargetsBrowser({
    browserModeActive,
    splitSurfaces,
    skillSetupConversation,
    sentPageStaged,
  });

  const openImageLightbox = useCallback((src: string, alt: string) => {
    setImageLightbox({ src, alt });
  }, []);
  const chatScrollMutationIdentity = JSON.stringify([
    location.key, currentUserId, activeProjectId, conversationsProjectKey,
    activeConversationId, jobThread?.jobId ?? null, browserSubtab,
  ]);
  const {
    autoScrollSuspendedRef,
    autoScrollPendingRef,
    handleScrollContentRef,
    highlightedMessageId,
    isHistoryReadingReady,
    lastComposerScrollTopRef,
    lastScrollHeightRef,
    pinnedScrollTopRef,
    recordScrollPosition,
    scrollSnapshotKey,
    requestOlderMessages,
    scrollContainerRef,
    scrollToBottom,
    setAutoScrollSuspended,
    shouldAutoScrollRef,
    showHistoryLoadButton,
  } = useChatScrollController({
    activeConversationId,
    historyVisit: chatScrollHistoryVisit,
    hasMoreHistory,
    isHistoryLoading,
    isInitialHistoryLoading,
    loadOlderMessages,
    messages,
  });

  useChatNewerHistoryPaging({
    visitKey: scrollSnapshotKey,
    routeKey: location.key,
    enabled: messageTargetActive && chatVisible,
    hasNewer: messageContext.hasNewer,
    loading: messageContext.loading,
    error: messageContext.error,
    scrollContainerRef,
    isReadingReady: isHistoryReadingReady,
    loadNewer: messageContext.loadNewer,
    onReachLatest: returnToLatestMessages,
  });

  const { hasNewMessages, jumpToLatest: jumpToNewMessages } = useChatNewMessages({
    visitKey: scrollSnapshotKey,
    routeKey: location.key,
    currentUserId,
    enabled: Boolean(chatScrollHistoryVisit) && chatVisible && !jobThread,
    hasResolvedHistory: hasResolvedRecentHistory,
    arrivalMessages: latestArrivalMessages,
    messageTargetActive,
    scrollContainerRef,
    shouldAutoScrollRef,
    isReadingReady: isHistoryReadingReady,
    onJumpToLatest: () => {
      if (messageTargetActive) returnToLatestMessages();
      else {
        shouldAutoScrollRef.current = true;
        scrollToBottom({ behavior: "auto" });
      }
    },
  });

  useConversationNotificationRead({
    currentUserId,
    conversationId: activeConversationControllerId,
    rootRef: scrollContainerRef,
    enabled: chatVisible && !jobThread,
    // A reply that lands while this chat is open, in Chat or in its Browser
    // view, is read: Home and the badges never flag the chat the person is in.
    arrivals: hasResolvedRecentHistory && !jobThread ? latestArrivalMessages : null,
    open: (chatVisible || browserVisible) && !jobThread,
  });
  useConversationOnScreen(activeConversationControllerId, { chatVisible, browserVisible, jobThread: Boolean(jobThread) });

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
      keepComposerTabOpenForEdit(nextValue, nextEditorState);
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
      keepComposerTabOpenForEdit,
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

  const workerQuestionReply = useWorkerQuestionReply({
    scope: `${activeProjectId ?? ""}:${activeConversationId ?? ""}`,
    readDraft: () => latestInputValueRef.current ?? "",
    writeDraft: text => {
      latestInputValueRef.current = text;
      onInputChange(activeConversationId, text, null);
    },
    focusComposer: () => {
      chatInputRef.current?.focus();
      chatInputRef.current?.focusAfterValueSync();
    },
    hasAttachments: imageAttachments.length > 0,
    canSelect: () => {
      if (editingQueuedItem || queueEditPending) {
        showStatus("Finish or cancel the queued message edit before replying to a worker.");
        return false;
      }
      // A worker reply has its own recipient. Keep a restored stash saved and
      // discard only the ordinary composer's implicit routing metadata.
      setRestoredMessageStash(null);
      pendingReplyContextRef.current = null;
      return true;
    },
  });
  const submitMessageRef = useRef<SubmitMessageFn>(async () => false);
  const queuedEditSubmitRef = useRef<(override?: Parameters<SubmitMessageFn>[0]) => Promise<boolean> | null>(() => null);
  const composerPrimaryActionRef = useRef<{
    mode: "send" | "steer";
    expectedActiveJobId: string | null;
  }>({ mode: "send", expectedActiveJobId: null });
  const sendIntentAttemptRef = useRef<{ key: string; clientSendId: string } | null>(null);
  const invokeSubmitMessage = useCallback<SubmitMessageFn>(async (override, options) => {
    if (!ensureProjectWriteAccess()) {
      return false;
    }
    const queuedEditSubmission = queuedEditSubmitRef.current(override);
    if (queuedEditSubmission) {
      return await queuedEditSubmission;
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
    // An automatic send (a failed run's retry) is not composer work: it neither
    // pins the conversation tab nor uses up the reply context the person set
    // for their draft.
    const automatic = options?.automatic === true;
    if (!automatic && (candidateMessage.length > 0 || imageAttachments.length > 0)) {
      keepComposerTabOpen();
    }
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
    if (submitted && !automatic && pendingReplyContextRef.current === pendingReplyContext) {
      pendingReplyContextRef.current = null;
    }
    if (
      !submitted &&
      !automatic &&
      pendingReplyContext &&
      pendingReplyContextRef.current === null &&
      shouldAttachPendingReplyContext(pendingReplyContext, latestInputValueRef.current ?? "")
    ) {
      // Clearing the composer for the send dropped the reply context; a send
      // that failed put the quoted draft back, so it answers the same message.
      pendingReplyContextRef.current = pendingReplyContext;
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
  }, [ensureProjectWriteAccess, imageAttachments.length, keepComposerTabOpen, removeServerMessageStash, restoredMessageStash]);

  // Conversational undo (#165): the Undo chip on an agent message dispatches a
  // window event; this panel owns the composer, so it turns the request into a
  // normal user message (with the target-message reference in metadata) and
  // sends it. The handler serializes rapid requests, and the standard submit
  // preflight queues the message when the assistant is busy; the intent is
  // never dropped and never double-sent.
  useEffect(() => {
    const handler = createMessageUndoRequestHandler(async ({ message, metadata }) =>
      invokeSubmitMessage({ message, editorState: null, metadata }),
    );
    window.addEventListener(REQUEST_MESSAGE_UNDO_EVENT, handler);
    return () => window.removeEventListener(REQUEST_MESSAGE_UNDO_EVENT, handler);
  }, [invokeSubmitMessage]);

  // Ask Octo from a site in a preview pane (docs/Bound-Sites.md §2a): the click is the person's own message in this
  // conversation, through the same send path and access checks as typing it. Someone who may not send messages here
  // (or whose credits are used up) sees the site's ask disabled with this reason; someone signed out sees none.
  const siteAskCaps = siteAskAccess({
    userId: currentUserId,
    capabilitiesResolved: projectCapabilitiesResolved,
    writeDisabled: projectWriteDisabled,
    outOfCredits,
  });
  const sendSiteAsk = useMemo(() => composerAskSender(invokeSubmitMessage), [invokeSubmitMessage]);
  const siteAskOutcomes = useMemo(
    () => askOutcomesFromRuns(Object.values(runs ?? {}), activeConversationEntry?.controllerId ?? null),
    [activeConversationEntry?.controllerId, runs],
  );
  const siteAskHost = useMemo<SiteAskHost | null>(() => siteAskCaps === null ? null : ({
    canAsk: siteAskCaps,
    userId: currentUserId,
    send: sendSiteAsk,
    outcomes: siteAskOutcomes,
  }), [currentUserId, sendSiteAsk, siteAskCaps, siteAskOutcomes]);

  const invokeComposerPrimaryAction = useCallback<SubmitMessageFn>(
    async (override, options) => {
      if (workerQuestionReply.active) {
        if (!ensureProjectWriteAccess()) return false;
        return workerQuestionReply.submit(override?.message ?? latestInputValueRef.current ?? "", options?.intent);
      }
      const primaryAction = composerPrimaryActionRef.current;
      return await invokeSubmitMessage(override, {
        ...options,
        intent: primaryAction.mode,
        expectedActiveJobId: primaryAction.expectedActiveJobId,
      });
    },
    [ensureProjectWriteAccess, invokeSubmitMessage, workerQuestionReply],
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
    await invokeComposerPrimaryAction();
  };

  const normalizedJobThread = useMemo((): ChatPanelJobThread | null => {
    const conversationId = jobThread?.conversationId?.trim() ?? "";
    const jobId = jobThread?.jobId?.trim() ?? "";
    if (!conversationId || !jobId) {
      return null;
    }
    return { conversationId, jobId };
  }, [jobThread?.conversationId, jobThread?.jobId]);

  // Try again for a failed browser run sends the card's task again, or
  // presses Let Octo continue again, through the browser handoff (set once
  // useChatBrowserRequest below has run).
  const browserRequestRetryRef = useRef<
    ((promptMessage: ChatMessage, retryMetadata: Record<string, unknown>) => Promise<boolean>) | null
  >(null);
  const resendBrowserRequest = useCallback(
    (promptMessage: ChatMessage, retryMetadata: Record<string, unknown>) =>
      browserRequestRetryRef.current?.(promptMessage, retryMetadata) ?? Promise.resolve(false),
    [],
  );
  const runFailureRetryContextValue = useRunFailureRetryActions({
    messages,
    queuedSends: combinedChatSendQueue,
    conversationKey: activeConversationId,
    currentUserId,
    chatClientSessionId,
    isAssistantTyping,
    // The read-only run trace (rendered below whenever normalizedJobThread is
    // set) has no RunFailureRetryProvider, so its cards cannot show a
    // countdown or its Cancel: never resend automatically from it.
    autoRetryEnabled: normalizedJobThread === null,
    submit: invokeSubmitMessage,
    resendBrowserRequest,
    showStatus,
    onConnectAi: openAiManager,
  });

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
    manualSubmitOnly: Boolean(workerQuestionReply.active),
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
    if (workerQuestionReply.active) {
      if (enterAction === "stash") void workerQuestionReply.submit(latestInputValueRef.current ?? "", "stash");
      else void invokeComposerPrimaryAction(undefined, { intent: enterAction });
      return;
    }
    if (editingQueuedItem && !editingQueuedItem.restoreOnly) {
      void invokeSubmitMessage(undefined, { intent: "queue" });
      return;
    }
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
  // enabled plus any added agents).
  const conversationRosterAgents = useMemo<ConversationRosterAgent[]>(
    () => resolveConversationRosterAgents({ agentHandles, agentByHandle }),
    [agentByHandle, agentHandles],
  );

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
  const previewThreads = useConversationPreviewThreads(conversations, activeConversation?.controllerId ?? null);

  const groupedMessages = useMemo(() => {
    const collapsedVisible = collapsedConversationMessages.filter((message) => shouldDisplayChatMessage(message));
    const jobThreads = synthesizeAgentJobThreadMessages(collapsedConversationMessages, collapsedVisible);

    const parentControllerId = activeConversation?.controllerId ?? null;
    if (!parentControllerId) {
      return jobThreads;
    }

    const threads = previewThreads;

    if (threads.length === 0) {
      return jobThreads;
    }

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
  }, [activeConversation?.controllerId, collapsedConversationMessages, previewThreads, messages]);
  const displayedMessages = useMemo(() => revealCanonicalMessageTarget(
    groupedMessages, messages, messageTargetActive ? requestedMessageId : null,
  ), [groupedMessages, messages, messageTargetActive, requestedMessageId]);

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
  // A browser turn of this chat on its way: the Browser view says where Octo
  // is going over the blank tab it starts on.
  const browserArrival = useMemo(
    () => browserTurnArrival(activeConversationRuns, messages),
    [activeConversationRuns, messages],
  );
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
    return resolvePromptAgentTargets(inputValue, {
      useSticky: true,
      updateSticky: false,
    }).targetHandles;
  }, [inputValue, resolvePromptAgentTargets]);
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
  const composerPrimaryActionMode = workerQuestionReply.active ? "send" : requireExpectedJobForSteer(
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
    return resolveTypingIndicatorState(messages, typingIndicatorFallback, activeConversationRun);
  }, [activeConversationRun, isAssistantTyping, messages, typingIndicatorFallback]);
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
  // The run's own agent, as stamped: the viewer's saved agent only by its id.
  const typingAgentProfile = resolveViewerAgentProfile(
    typingAgentIdentity,
    typingAgentHandle,
    availableAgentById,
    agentByHandle,
  );
  const typingAgentId = typingAgentIdentity?.id;
  const typingAgentAvatarSeed =
    typeof typingAgentProfile?.avatarSeed === "string" && typingAgentProfile.avatarSeed.trim().length > 0
      ? typingAgentProfile.avatarSeed
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
  // The tabs this conversation's browser runs are bound to. With the tabs the
  // agent opened, they carry its name in the tab picker and fill the Reading
  // row, while it has control.
  const sharedBrowserAgentPages = useMemo(
    () => sharedBrowserAgentPageIds(activeConversationRuns, resolvedBrowserRuntimeId),
    [activeConversationRuns, resolvedBrowserRuntimeId],
  );
  const sharedBrowserChromeForView = useMemo<SharedBrowserChromeProps | null>(
    () => sharedBrowserChromeWithSend
      ? { ...sharedBrowserChromeWithSend, agentPageIds: sharedBrowserAgentPages }
      : null,
    [sharedBrowserAgentPages, sharedBrowserChromeWithSend],
  );
  // The Browser view tab says when the agent is using the browser: one of
  // this conversation's runs holds a tab of it (Shared), or drives this
  // device's browser (Personal).
  const browserAgentActive = browserTransport === "shared"
    ? sharedBrowserAgentPages.length > 0
    : activeConversationRuns.some((run) =>
      run.metadata?.browserTransport === "desktop-personal" &&
      (run.status === "in_progress" || run.status === "queued"));
  const browserAgentName =
    sharedBrowserControlOwner.kind === "agent" ? sharedBrowserControlOwner.displayName : BROWSER_AGENT_DEFAULT_NAME;
  // The page a message goes to, this chat's own tab, as the pane's own tab
  // picker names it.
  const browserActivePageTitle = preferredBrowserPage
    ? preferredBrowserPage.title?.trim() || preferredBrowserPage.label.trim() || preferredBrowserPage.host
    : null;
  // The prompts of this conversation's running Instafy's browser job, for the
  // person who started it, whatever the browser view is doing.
  const chatBrowserApproval = useChatSharedBrowserApproval({
    enabled: runtimeControllerEnabled && canWriteProject && !jobThread,
    projectId: activeProjectId ?? null,
    userId: currentUserId,
    runs: activeConversationRuns,
    browserSessionId: sharedBrowserSurfaceSessionId,
  });
  const chatBrowserApprovalTarget = chatBrowserApproval.target;
  const chatBrowserApprovalAsking = chatBrowserApproval.approval.pending !== null;
  const browserRunApproval = useMemo(
    () => chatBrowserApprovalTarget
      ? { runtimeId: chatBrowserApprovalTarget.runtimeId, approval: chatBrowserApproval.approval }
      : null,
    [chatBrowserApproval.approval, chatBrowserApprovalTarget],
  );
  const browserApprovalAttention = sharedBrowserApprovalPending || chatBrowserApprovalAsking;
  useEffect(() => {
    if (conversationWorkspace) {
      setConversationBrowser(surfaceScope, {
        available: hasBrowserView,
        attention: browserApprovalAttention,
        pageTitle: browserActivePageTitle,
        agentName: browserAgentActive ? browserAgentName : null,
      });
    }
  }, [
    browserActivePageTitle,
    browserAgentActive,
    browserAgentName,
    browserApprovalAttention,
    conversationWorkspace,
    hasBrowserView,
    setConversationBrowser,
    surfaceScope,
  ]);
  const chatBrowserApprovalAgentName = (() => {
    const handle = chatBrowserApprovalTarget
      ? extractAgentIdentityFromMetadata(chatBrowserApprovalTarget.runMetadata)?.handle ?? null
      : null;
    if (!handle) return typingAgentDisplayName;
    const profile = agentByHandle.get(handle) ?? null;
    return getBuiltInAssistantDisplayName(handle) ??
      (profile?.displayName?.trim() ? profile.displayName.trim() : `@${handle}`);
  })();
  // The run's turn shows its prompt under its activity line; the chat shows
  // it at the end of the transcript only when no turn on screen claims it.
  const turnBrowserApproval = useTurnBrowserApprovalProvider({
    target: chatBrowserApprovalTarget,
    approval: chatBrowserApproval.approval,
    agentName: chatBrowserApprovalAgentName,
  });
  const recordBrowserApprovalSettled = turnBrowserApproval.value.recordSettled;
  const typingLanes = useMemo(
    () => resolveTypingAgentLanes(activeConversationRuns, availableAgentById),
    [activeConversationRuns, availableAgentById],
  );
  const typingAgents = useMemo<AssistantTypingAgent[]>(() => {
    if (typingLanes.agents.length > 0) {
      return typingLanes.agents;
    }
    return [{
      key: typingAgentHandle,
      handle: typingAgentHandle,
      avatarSeed: typingAgentAvatarSeed,
      ...(typingAgentId ? { id: typingAgentId } : {}),
      displayName: typingAgentDisplayName,
      isThinking: false,
    }];
  }, [typingAgentAvatarSeed, typingAgentDisplayName, typingAgentHandle, typingAgentId, typingLanes]);
  const hasMultipleTypingAgents = typingAgents.length > 1;
  const multiTypingStatus = useMemo(() => resolveMultiAgentTypingStatus(activeConversationRuns.map(run => ({
    status: run.status,
    displayName: typingLanes.agentByRunId.get(run.id)?.displayName ?? "Agent",
  }))), [activeConversationRuns, typingLanes]);
  const workspaceStarting =
    waitingForPreferredRuntime ||
    hostedRuntimeEnsuring ||
    (!runtimeReady && activeConversationRun?.status === "queued");
  // When the live start began. Persisted runtime alerts older than this edge
  // are history; the alert this same start just produced is not.
  const [workspaceStartingSince, setWorkspaceStartingSince] = useState<number | null>(null);
  useEffect(() => {
    setWorkspaceStartingSince((previous) => {
      if (!workspaceStarting) {
        return null;
      }
      return previous ?? Date.now();
    });
  }, [workspaceStarting]);
  const chatRuntimeActivityValue = useMemo(
    () => ({ workspaceStarting, workspaceStartingSince }),
    [workspaceStarting, workspaceStartingSince],
  );
  // A hosted launch that has not come up in five minutes turns the
  // "Starting…" status into a notice with Try again.
  const workspaceStartStall = useStalledWorkspaceStart({
    runtimeStatuses,
    runtimeReady,
    localRuntime: currentRuntime?.isLikelyLocal === true,
    conversationId: activeConversationEntry?.controllerId ?? null,
    runs,
    messages,
    runtimeLimitReached: Boolean(runtimeEnsureLimit?.limitReached),
    outOfCredits,
    hostedRuntimeStopAtMs,
    ensureHostedRuntime: projectWriteDisabled ? null : ensureHostedRuntime,
    showStatus,
  });
  // A turn the person's Machines > Stop cut off says so in place of the
  // typing status, which would otherwise read as still working.
  const stoppedTurnNotice = useStoppedTurnNotice({
    projectId: activeProjectId ?? null,
    runtimeReady,
    requestingMachine: hostedRuntimeEnsuring || Boolean(runtimeEnsureLimit?.limitReached),
    activeRuns: activeConversationRuns,
    messages,
    agentDisplayName: hasMultipleTypingAgents ? null : typingAgentDisplayName,
  });
  const waitingActivityCopy = resolveAgentWaitingActivityCopy({
    displayNames: hasMultipleTypingAgents
      ? typingAgents.map((agent) => agent.displayName)
      : [typingAgentDisplayName],
    workspaceStarting,
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
  // The row before a turn's first step, which the turn's own line takes over
  // from: one "Starting…" from the send until then, however long it takes.
  const singleTypingStatus = resolveSingleAgentTypingStatus({
    state: typingIndicatorState,
    runStatus: activeConversationRun?.status ?? null,
    agentName: typingAgentDisplayName,
    waiting: waitingActivityCopy,
  });
  const typingStatusLabel = hasMultipleTypingAgents
    ? (workspaceStarting ? waitingActivityCopy.label : multiTypingStatus.label)
    : singleTypingStatus.label;
  // Every typing label is one truncated line except the runtime-busy notice,
  // which carries an instruction and is meant to wrap.
  const typingStatusIsRuntimeBusyNotice =
    waitingActivityCopy.isRuntimeBusyNotice === true && typingStatusLabel === waitingActivityCopy.label;
  const typingStatusAriaLabel = hasMultipleTypingAgents
    ? workspaceStarting
      ? waitingActivityCopy.ariaLabel
      : multiTypingStatus.ariaLabel
    : singleTypingStatus.ariaLabel;
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
  const jobThreadTypingCoverage = useMemo(
    () =>
      isAssistantTyping
        ? resolveJobThreadTypingCoverage(
            displayedMessages[displayedMessages.length - 1],
            activeConversationRuns,
            messages,
          )
        : "none",
    [activeConversationRuns, displayedMessages, isAssistantTyping, messages],
  );
  const isAssistantTypingCoveredByJobThreadPreview = jobThreadTypingCoverage !== "none";
  const transcriptTailEndsActiveTurn = useMemo(
    () =>
      isAssistantTyping &&
      isTranscriptTailActiveTurnOutcome(
        displayedMessages[displayedMessages.length - 1],
        activeConversationRuns,
        messages,
      ),
    [activeConversationRuns, displayedMessages, isAssistantTyping, messages],
  );
  const transcriptTailKey = useMemo(
    () => resolveTranscriptTailKey(displayedMessages[displayedMessages.length - 1]),
    [displayedMessages],
  );
  const activeAssistantAvatarMotion = useMemo<{
    messageId: string;
    motion: AssistantAvatarMotion;
  } | null>(() => {
    if (jobThreadTypingCoverage !== "live" || typingIndicatorState?.phase !== "thinking") {
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
    jobThreadTypingCoverage,
    typingIndicatorState?.phase,
  ]);
  const [isThinkingLabelExpanded, setIsThinkingLabelExpanded] = useState(false);

  useEffect(() => {
    setIsThinkingLabelExpanded(false);
  }, [typingIndicatorState?.label, isAssistantTyping]);

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
        event.preventDefault();
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
        event.preventDefault();
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
      ? `\nContext: ${formatPromptContextModeLabel(selectedMessageTokenUsage.context)}${
          selectedMessageTokenUsage.context.estimatedPromptTokens !== null
            ? `, prompt est: ${Math.round(selectedMessageTokenUsage.context.estimatedPromptTokens)}`
            : ""
        }${
          selectedMessageTokenUsage.context.estimatedPromptUsagePercent !== null
            ? `, window: ${selectedMessageTokenUsage.context.estimatedPromptUsagePercent}%`
            : ""
        }`
      : "";
    const summary = `Message stats. Input: ${selectedMessageTokenUsage.inputTokens}, cached: ${selectedMessageTokenUsage.cachedInputTokens}, output: ${selectedMessageTokenUsage.outputTokens}${contextSummary}`;
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
      if (workerQuestionReply.busy) return;
      workerQuestionReply.cancel();
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
      workerQuestionReply,
      selectedMessage,
      showStatus,
    ],
  );

  const inputRequiresAi = useMemo(() => {
    return resolveChatInputRequiresAi({
      activeConversationMessages: messages,
      inputValue,
      hasImageAttachments: imageAttachments.length > 0,
      resolvePromptAgentTargets,
    });
  }, [
    imageAttachments.length,
    inputValue,
    messages,
    resolvePromptAgentTargets,
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
        activeConversationControllerId,
        conversationHasHumanPeer:
          conversationHumanPeerContext.resolved &&
          conversationHumanPeerContext.hasHumanPeer,
        assistantEnabled,
        threadKind: activeConversationEntry?.threadKind ?? null,
        ownerAgentHandle: activeConversationEntry?.ownerAgent?.handle ?? null,
        hasBrowserTask: resolveChatInputHasBrowserTask({
          inputValue,
          personalBrowserActive:
            browserTransport === "personal" && browserComposerActive,
          sharedBrowserModeActive:
            browserTransport === "shared" && browserComposerActive,
          pendingNewBrowser: pendingBrowserLaunchMode === "new_page",
          sharedBrowserPageTargetAvailable:
            !skillSetupConversation &&
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
      browserComposerActive,
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
      skillSetupConversation,
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
    // Connecting from chat ("Connect your own AI", the AI gate) is choosing
    // that AI over Instafy AI. An existing own default keeps its old rules.
    newConnectionDefault: () =>
      credentialRequirements.hasDefaultCredential || defaultAiCredential ? undefined : true,
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
    gettingStartedCollapsed,
    gettingStartedManagedAiSelected,
    gettingStartedMode,
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
      remoteConversationHistoryResolved && !isInitialHistoryLoading && !initialHistoryError,
    runtimeControllerEnabled,
  });
  // Connect: one sheet (browse and confirm stages) shared by the composer
  // sub-view, the getting-started card and the custom skill import modal.
  // Every send lands in the current conversation as a new turn; nothing here
  // creates a conversation or switches tabs.
  const installedSkills = useInstalledSkillNames({
    projectId: activeProjectId,
    runtimeId: effectiveRuntimeId ?? null,
  });
  const skillsImport = useSkillsImportFlow({
    activeConversationId,
    assistantEnabled,
    onSubmit,
    showStatus,
    loadSkills: installedSkills.refresh,
  });
  const connectSheet = useConnectSheetState();
  const connectSheetOpen = connectSheet.state !== null;
  const { handleOpenAddSkillModal: openAddSkillModal, queueSkillImportTask } = skillsImport;
  const { openBrowse: openConnectBrowse, openConfirm: openConnectConfirm, back: backConnectSheet, close: closeConnectSheet } = connectSheet;
  useConnectToolsRequest({ projectId: activeProjectId ?? null, conversationId: activeConversationId }, openConnectBrowse);
  const handleSelectConnector = useCallback(
    (connector: Connector) => {
      routeConnectorSelection(connector, {
        openConfirm: openConnectConfirm,
        leaveSheet: closeConnectSheet,
        openImportModal: openAddSkillModal,
        beginGithubImport,
      });
    },
    [beginGithubImport, closeConnectSheet, openAddSkillModal, openConnectConfirm],
  );
  const handleConnectPasteLink = useCallback(() => {
    closeConnectSheet();
    openAddSkillModal();
  }, [closeConnectSheet, openAddSkillModal]);
  const handleConnectConfirm = useCallback(
    async (connector: SkillConnector) => {
      const queued = await queueSkillImportTask({
        source: connector.source,
        skillName: connector.skillName,
        overwrite: false,
        label: connector.name,
      });
      if (queued) {
        closeConnectSheet();
      }
    },
    [closeConnectSheet, queueSkillImportTask],
  );
  // "Set up again" prefills the composer, but focusing it from inside the
  // sheet's press is undone by the dialog's focus containment and then by its
  // restore-focus frame once the sheet unmounts. Hand the composer focus only
  // after the sheet is gone, two frames later so it runs after that restore.
  const pendingComposerFocusRef = useRef(false);
  const handleConnectSetUpAgain = useCallback(
    (connector: SkillConnector) => {
      onInputChange(activeConversationId, `${buildSkillStartMessage(connector.skillName)} `, null);
      pendingComposerFocusRef.current = true;
      closeConnectSheet();
    },
    [activeConversationId, closeConnectSheet, onInputChange],
  );
  useEffect(() => {
    if (!pendingComposerFocusRef.current || connectSheetOpen) {
      return;
    }
    pendingComposerFocusRef.current = false;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => focusInput({ force: true }));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [connectSheetOpen, focusInput]);
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
    // Focus moves to the workspace step (the card handles it), not the composer,
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
  // The gate's "Connect AI": the same Add AI connection modal the card opens.
  // Nothing is stashed or armed. The modal never clears the composer, so the
  // draft simply stays where it is ("Your message is kept") and goes out on
  // the user's own press once AI is connected; arming an auto-submit here
  // would fire a stale draft later, since closing the modal without connecting
  // leaves nothing to clear it. The composer is refocused when credentials
  // become ready, because the gate bubble (the modal's focus-restore target)
  // unmounts at that moment and focus would otherwise land on <body>.
  const connectFromGateRef = useRef(false);
  const handleConnectAiFromGate = useCallback(() => {
    connectFromGateRef.current = true;
    openGettingStartedConnectModal();
  }, [openGettingStartedConnectModal]);
  useEffect(() => {
    connectFromGateRef.current = false;
  }, [activeConversationId]);
  useEffect(() => {
    if (!credentialsReady || !connectFromGateRef.current) {
      return;
    }
    connectFromGateRef.current = false;
    focusInput({ force: true });
  }, [credentialsReady, focusInput]);
  // "Change AI" on the card: the managed choice resets to the AI step; a saved
  // credential is changed in the AI panel, where the connections live.
  const handleChangeAiChoice = useCallback(() => {
    if (gettingStartedSelectedAi === "connected") {
      openAiManager();
      return;
    }
    clearGettingStartedManagedAiSelection();
  }, [clearGettingStartedManagedAiSelection, gettingStartedSelectedAi, openAiManager]);
  const gettingStartedConnectedAiLabel = useMemo(
    () => (defaultAiCredential ? resolveCredentialLabel(defaultAiCredential) : null),
    [defaultAiCredential],
  );
  // Alone in a space, "turn the assistant off" has nobody to chat with. The
  // mentionable set is the source of truth: org and project members merged,
  // minus the viewer, so an org-shared space counts its teammates too.
  const spaceHasTeammates = mentionableUsers.length > 0;

  const { clearComposerAfterQueue, clearComposerIfUnchanged, performSubmit } = useChatSubmitDispatch({
    activeConversationId,
    clearInputEditor,
    markImageAttachmentsSending,
    removeSentImageAttachments,
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
          showStatus(describeSendIntentError(error.code, error.message), "warning", 5500);
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

  const { submissionPending, submitMessage } = useChatSubmitFlow({
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
      browserComposerActive,
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
      browserTransport === "shared" && browserComposerActive,
    sharedBrowserBindingPage,
    resolveSharedBrowserTab: resolveChatBrowserTab,
    sharedBrowserRuntimeId: resolvedBrowserRuntimeId,
    showCredentialsGate: showChatCredentialsGate,
    showStatus,
    shouldAutoScrollRef,
    skillSetupConversation,
    submitSendIntent,
    targetsOverlapActiveRuns,
  });
  submitMessageRef.current = submitMessage;

  // The page Take over and Let Octo continue act on: the tab the chat's view
  // shows, else the chat's own tab. Never another chat's page in front, nor
  // the browser's first tab when it names none in front.
  const browserHandoffPage = sharedBrowserChrome
    ? chatBrowserHandoffPage({ pages: sharedBrowserChrome.pages, chatPageIds: chatViewPageIds, chatTab: chatBrowserTab.tab })
    : null;
  const browserHumanInputRunIds = useMemo(() => sharedBrowserConversationRunIds(Object.values(runs ?? {}), {
    projectId: activeProjectId ?? null,
    conversationId: activeConversationEntry?.controllerId ?? null,
    runtimeId: resolvedBrowserRuntimeId,
    pageId: browserHandoffPage?.id ?? null,
  }), [runs, activeProjectId, activeConversationEntry?.controllerId, resolvedBrowserRuntimeId, browserHandoffPage?.id]);
  // The sites of the cards the person pressed in this chat: their OK for
  // each one in the chat's later browser turns.
  const activeConversationMessageList = activeConversation?.messages;
  const pressedCardSites = useMemo(
    () => pressedBrowserCardSites(
      Array.isArray(activeConversationMessageList) ? activeConversationMessageList : [],
      currentUserId,
    ),
    [activeConversationMessageList, currentUserId],
  );
  const browserHandoff = useChatBrowserHandoff({
    userId: currentUserId,
    projectId: activeProjectId ?? null,
    conversationId: activeConversationId,
    transport: browserTransport,
    open: browserSessionOpen,
    canWrite: canWriteProject,
    runtimeId: resolvedBrowserRuntimeId,
    page: browserHandoffPage,
    runs: activeConversationRuns,
    browserCardSites: pressedCardSites,
    personal: personalBrowser,
    agentHandle: typingAgentHandle,
    onSubmit,
    keepAgentTab: keepSharedBrowserPage,
  });
  // Octo opens the browser in the desktop app, or Instafy's browser on the
  // conversation's own machine in a covered space, by itself for its
  // request_browser cards (useChatBrowserRequest and browserAutoStartPlan say
  // when); any other hosted browser waits for a press. These are what that
  // decision reads, together with sharedBrowserPresence above.
  // Turns in the browser on this device run on this device's runtime, which
  // Instafy AI does not reach.
  const personalTurnsAllowed = credentialRequirements.hasDefaultCredential || !credentialRequirements.managedAi?.enabled;
  const browserRunActive = useMemo(() => {
    const now = Date.now();
    return Object.values(runs ?? {}).some((run) =>
      (!run.projectId || run.projectId === (activeProjectId ?? null)) &&
      isRunActivelyProgressing(run, now) &&
      (run.metadata?.browserTransport === "shared" || run.metadata?.browserTransport === "desktop-personal"));
  }, [activeProjectId, runs]);
  // A press that opens Instafy's browser while the space's machine is not
  // running starts it through the generic hosted ensure.
  const ensureSpaceMachineForBrowser = useCallback(
    (): Promise<boolean> => ensureHostedRuntime(),
    [ensureHostedRuntime],
  );
  const activeConversationRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of activeConversationRuns) {
      ids.add(run.id);
      const jobId = run.metadata?.jobId;
      if (typeof jobId === "string" && jobId) ids.add(jobId);
    }
    return ids;
  }, [activeConversationRuns]);
  // Only a draft holds a card: in a narrow pane, or with side-by-side view
  // off, the browser takes the view by itself as a press does.
  const browserAutoStartBlocked = browserAutoStartHeldByDraft({ draft: inputValue });
  const browserHeldByOther = browserAutoStartHeldByOther({
    browserRunActive,
    remoteController: sharedBrowserPresence?.remoteController === true,
    humanInputRequest: Boolean(personalBrowser.status?.humanInputRequest),
    pendingHandoff: personalBrowser.pendingHandoff !== null,
  });
  const personalOwnAi = credentialRequirements.hasDefaultCredential === true;
  const runtimeStatusKey = (runtimeStatuses ?? [])
    .map((entry) => `${entry.runtimeId}:${entry.status}:${entry.displayName ?? ""}:${entry.origin?.originId ?? ""}:${entry.sharedBrowserHost?.mode ?? ""}`)
    .join("|");
  const browserAutoStartAllowed = !jobThread && canWriteProject;
  // Instafy's browser on this conversation's own machine, in a space the
  // controller covers: Studio reads it to decide whether it may open it by
  // itself, and reads it again while a card waits on it.
  const conversationBrowserHostRuntimeId = conversationBrowserHostId({
    sharedBrowserHostPolicy: sharedBrowserHostPolicy ?? null,
    conversationRuntimeId: effectiveRuntimeId ?? null,
    runtimes: runtimeStatuses ?? null,
  });
  const [browserAutoWaiting, setBrowserAutoWaiting] = useState(false);
  // A press asks the open browser view to attach to its machine again by
  // bumping this, and the view reports the error it shows so the card can say
  // why it did not open instead of waiting out its deadline.
  const [sharedBrowserAttachRequestToken, setSharedBrowserAttachRequestToken] = useState(0);
  const [sharedBrowserViewError, setSharedBrowserViewError] = useState<SharedBrowserViewError | null>(null);
  const handleSharedBrowserConnectionErrorChange = useCallback((message: string | null) => {
    setSharedBrowserViewError((current) => {
      if (!message) return null;
      return current?.message === message ? current : { message, atMs: Date.now() };
    });
  }, []);
  const requestSharedBrowserReattach = useCallback(() => {
    setSharedBrowserAttachRequestToken((current) => current + 1);
  }, []);
  // An open Studio made by itself never starts the space's machine; that
  // lasts until the browser closes or the person presses a card.
  const [browserAttachOnly, setBrowserAttachOnly] = useState(false);
  useEffect(() => {
    if (!browserSessionOpen) setBrowserAttachOnly(false);
  }, [browserSessionOpen]);
  // Instafy's browser on the conversation's machine is open here but off:
  // a reading taken once it went off, and then the same ten-second reading,
  // notices an agent or another viewer starting it, and the view attaches
  // without a press (hands-free).
  const sharedBrowserViewOff =
    browserSessionOpen &&
    browserTransport === "shared" &&
    sharedBrowserViewKind === "off" &&
    conversationBrowserHostRuntimeId !== null &&
    (resolvedBrowserRuntimeId ?? conversationBrowserHostRuntimeId) === conversationBrowserHostRuntimeId;
  const sharedBrowserHost = useSharedBrowserHostSnapshot({
    projectId: activeProjectId ?? null,
    runtimeId: conversationBrowserHostRuntimeId,
    browserSessionId: sharedBrowserSurfaceSessionId,
    enabled: (browserAutoStartAllowed || sharedBrowserViewOff) && conversationBrowserHostRuntimeId !== null,
    poll: browserAutoWaiting || sharedBrowserViewOff,
  });
  // Studio asks the view to attach again by itself (see autoAttachToken),
  // also once when the machine a press gave up on comes up a little later.
  const {
    autoAttachToken: sharedBrowserAutoAttachToken,
    requestAutoAttach: requestSharedBrowserAutoAttach,
  } = useSharedBrowserAutoAttach({
    open: browserSessionOpen,
    off: sharedBrowserViewOff,
    host: sharedBrowserHost,
    ...sharedBrowserLateAttachInputs({
      transport: browserTransport,
      kind: sharedBrowserViewKind,
      error: sharedBrowserViewError,
      hostRuntimeId: conversationBrowserHostRuntimeId,
    }),
  });
  const sharedBrowserHostKey = sharedBrowserHost.snapshot
    ? [
      sharedBrowserHost.snapshot.state,
      sharedBrowserHost.snapshot.generation ?? "",
      sharedBrowserHost.snapshot.startedByYou,
      sharedBrowserHost.snapshot.othersPresent,
      sharedBrowserHost.snapshot.controlledByOther,
      sharedBrowserHost.snapshot.agentRunActive,
      sharedBrowserHost.snapshot.agentRunStartedByYou,
    ].join(":")
    : "none";
  const browserAutoStart: BrowserAutoStartOptions | null = !browserAutoStartAllowed ? null : {
    currentUserId,
    chatClientSessionId,
    activeRunIds: activeConversationRunIds,
    // A draft the person is typing leaves the card to them, and the card says so.
    blocked: browserAutoStartBlocked ? { reason: BROWSER_AUTO_START_COPY.draftHeld } : null,
    heldByOther: browserHeldByOther,
    plan: (_request, transport) => browserAutoStartPlan({
      transport,
      personalAvailable: personalBrowser.available,
      personalOwnAi,
      projectId: activeProjectId ?? null,
      runtimes: runtimeStatuses ?? null,
      sharedBrowserHostPolicy: sharedBrowserHostPolicy ?? null,
      conversationRuntimeId: effectiveRuntimeId ?? null,
      host: sharedBrowserHost.snapshot,
      hostReadAtMs: sharedBrowserHost.receivedAtMs,
      nowMs: Date.now(),
    }),
    refreshHost: sharedBrowserHost.refresh,
    // The roster connects only while the Browser view is on screen.
    presence: browserVisible && browserTransport === "shared" ? sharedBrowserPresence : null,
    revision: JSON.stringify([
      browserAutoStartBlocked,
      browserHeldByOther,
      runtimeStatusKey,
      personalBrowser.available,
      personalOwnAi,
      sharedBrowserHostPolicy ?? null,
      effectiveRuntimeId ?? null,
      sharedBrowserHostKey,
      sharedBrowserHost.receivedAtMs,
      // A failed reading also decides a waiting card again, which stops
      // reading once the card is too old to open by itself.
      sharedBrowserHost.failedAtMs,
    ]),
  };
  // The person's browser turn a message Octo sent straight to the browser
  // goes on from, while Instafy's browser is open in this chat: its card's
  // turn goes on there by itself, in that turn's tab, naming the run so the
  // sites the person allowed in it keep their OK (useChatBrowserRequest).
  const resolveRoutedBrowserFollowUp = useCallback((routedJobId: string) => routedBrowserFollowUp(runRecords, {
    open: browserTransport === "shared" && browserSessionOpen,
    conversationId: activeConversationEntry?.controllerId ?? null,
    runtimeId: resolvedBrowserRuntimeId,
    userId: currentUserId,
    pages: sharedBrowserChromePages,
    takenByAnotherChat: chatBrowserTab.takenByAnotherChat,
  }, routedJobId), [
    activeConversationEntry?.controllerId,
    browserSessionOpen,
    browserTransport,
    chatBrowserTab.takenByAnotherChat,
    currentUserId,
    resolvedBrowserRuntimeId,
    runRecords,
    sharedBrowserChromePages,
  ]);
  const browserRequestState = useChatBrowserRequest({
    identity: browserRequestIdentity,
    messages,
    canWrite: canWriteProject,
    ready: browserTransportPreferenceResolved && browserSessionStateHydrated,
    transport: browserTransport,
    open: browserSessionOpen,
    busy: isAssistantTyping,
    personalAvailable: personalBrowser.available,
    personalTurnsAllowed,
    personalReady: personalBrowser.status?.state === "ready",
    // A card's turn finds a tab: the chat's own, or a blank one it gets as it
    // is sent (resolveForTurn), with the person in Chat too. A chat with no tab
    // yet has no page on screen (browserHandoffPage) until its view shows.
    sharedReady: chatBrowserCardReady({ runtimeId: resolvedBrowserRuntimeId, target: chatBrowserMessageTarget }),
    sharedRuntimeId: resolvedBrowserRuntimeId,
    sharedUnavailable: sharedBrowserCapabilitiesUnsupported,
    sharedHost: {
      runtimeId: conversationBrowserHostRuntimeId,
      refresh: sharedBrowserHost.refresh,
      reattach: requestSharedBrowserReattach,
      heldByOther: browserHeldByOther,
    },
    sharedError: browserSessionOpen && browserTransport === "shared" ? sharedBrowserViewError : null,
    sharedNotReadySinceMs: sharedBrowserHostNotReadySinceMs,
    agentName: typingAgentDisplayName.replace(/^@/, ""),
    activate: (transport, plan) => {
      // A turn that goes on in the browser open in this chat opens nothing,
      // and the person stays where they are.
      if (plan?.kind === "continue") return;
      if (plan?.kind === "attach") {
        // Studio opens Instafy's browser on the conversation's own machine
        // by itself: exactly that machine, and never starting it. A view that
        // is open but off or did not open attaches again by itself too. Only
        // a press switches to the Browser view: this stays in Chat, with the
        // reading line and the Browser tab's dot.
        setBrowserTransport("shared");
        setSharedBrowserActivated(true);
        setBrowserAttachOnly(true);
        resumeBrowserSession(plan.runtimeId, { show: false });
        if (browserSessionOpen) requestSharedBrowserAutoAttach();
        return;
      }
      // A press is the person's own: the browser may start the machine.
      setBrowserAttachOnly(false);
      // This request selects a session, not a new device-wide preference.
      setBrowserTransport(transport);
      if (transport === "shared") setSharedBrowserActivated(true);
      // A press opens this conversation's own machine by name, so it never
      // asks which machine (browserPressRuntime).
      const press = browserPressRuntime({
        transport,
        hostRuntimeId: conversationBrowserHostRuntimeId,
        exactRuntimeId: exactBrowserRuntimeId,
        resolvedRuntimeId: resolvedBrowserRuntimeId,
      });
      if ("resume" in press) resumeBrowserSession(press.resume);
      else openBrowserSession(press.open);
      setBrowserSubtab("browser");
    },
    // A card's turn in Instafy's browser runs in this chat's own tab: the
    // one its last browser turn used, or a blank one opened for it now. A
    // message Octo sent straight to the browser that goes on from the
    // person's own browser turn goes on in that turn's tab (`extras.tab`).
    continueTask: (transport, message, extras) => {
      if (transport === "personal") return browserHandoff.startPersonal(message, extras);
      const followUpTab = extras.tab;
      return browserHandoff.continueShared(message, extras, followUpTab ? async () => followUpTab : resolveChatBrowserTab);
    },
    followUp: resolveRoutedBrowserFollowUp,
    onError: (message) => showStatus(message, "error", 6000),
    auto: browserAutoStart,
  });
  // Try again on a turn a press of Let Octo continue started presses it
  // again, in this chat's browser; on a card's turn it sends the card's task
  // again.
  browserRequestRetryRef.current = async (promptMessage, retryMetadata) => {
    if (!isLetOctoContinuePrompt(promptMessage)) {
      return browserRequestState.retryContinuation(promptMessage, retryMetadata);
    }
    try {
      if (await browserHandoff.retryContinue(BROWSER_HUMAN_INPUT_CONTINUE_PROMPT, retryMetadata)) return true;
      showStatus("Open the browser to try again.", "info", 4000);
    } catch (error) {
      showStatus(error instanceof Error && error.message ? error.message : "Unable to continue.", "error", 6000);
    }
    return false;
  };
  // Once a browser turn that continued Octo's card finishes, one turn goes
  // back to the building lane with what it found (useBrowserHandBack).
  const runStatusesById = useMemo(() => {
    const statuses = new Map<string, RunStatus>();
    for (const run of Object.values(runs ?? {})) {
      statuses.set(run.id, run.status);
      const jobId = run.metadata?.jobId;
      if (typeof jobId === "string" && jobId) statuses.set(jobId, run.status);
    }
    return statuses;
  }, [runs]);
  useBrowserHandBack({
    identity: browserRequestIdentity,
    messages,
    canWrite: browserAutoStartAllowed,
    busy: isAssistantTyping,
    activeRunIds: activeConversationRunIds,
    runStatuses: runStatusesById,
    held: browserAutoStartBlocked ||
      Boolean(personalBrowser.status?.humanInputRequest) ||
      personalBrowser.pendingHandoff !== null,
    agentName: typingAgentDisplayName.replace(/^@/, ""),
    send: async (message, extras) => {
      try {
        await onSubmit(activeConversationId, extras.display, {
          agentHandles: [typingAgentHandle],
          imageFiles: [],
          editorState: null,
          expectedLaneIdle: true,
          requireDispatch: true,
          dispatchInput: message,
          metadata: extras.metadata,
        });
        return true;
      } catch {
        return false;
      }
    },
  });
  const browserRequestAutoWaiting = browserRequestState.autoWaiting;
  useEffect(() => {
    setBrowserAutoWaiting(browserRequestAutoWaiting);
  }, [browserRequestAutoWaiting]);
  const browserCardOpeningNow = useMemo(
    () => anyBrowserCardOpening(browserRequestState.cardStates),
    [browserRequestState.cardStates],
  );
  useEffect(() => {
    setBrowserCardOpening(browserCardOpeningNow);
  }, [browserCardOpeningNow]);
  // A continuation whose dispatch failed continues no card; the failure also
  // sets that card's state, which recomputes this.
  const browserRequestContinued = useMemo(
    () => browserRequestContinuedKeys(messages),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, browserRequestState.cardStates],
  );
  const newestBrowserRequest = useMemo(() => newestBrowserRequestKey(messages), [messages]);
  // Cards for a message Octo sent straight to the browser that Studio opened
  // by itself and that are still opening (routedBrowserFold.ts).
  const routedBrowserWaiting = useMemo(() => routedBrowserWaitingKeys(messages), [messages]);
  const browserRequestHost = useMemo<BrowserRequestHost>(() => ({
    transport: browserTransport,
    personalAvailable: personalBrowser.available,
    sharedUnavailable: sharedBrowserCapabilitiesUnsupported,
    personalTurnsAllowed,
    cardStates: browserRequestState.cardStates,
    continuedKeys: browserRequestContinued,
    routedWaitingKeys: routedBrowserWaiting,
    newestCardKey: newestBrowserRequest,
  }), [
    browserRequestContinued,
    routedBrowserWaiting,
    newestBrowserRequest,
    browserRequestState.cardStates,
    browserTransport,
    personalBrowser.available,
    personalTurnsAllowed,
    sharedBrowserCapabilitiesUnsupported,
  ]);
  // The person closed, paused or stopped the browser here: Octo does not open
  // it again by itself in this conversation.
  const browserOpenTrackRef = useRef<{ identity: string; open: boolean } | null>(null);
  useEffect(() => {
    if (!browserSessionStateHydrated) return;
    const previous = browserOpenTrackRef.current;
    browserOpenTrackRef.current = { identity: browserRequestIdentity, open: browserSessionOpen };
    if (previous && previous.identity === browserRequestIdentity && previous.open && !browserSessionOpen) {
      markBrowserAutoStartDeclined(browserRequestIdentity);
    }
  }, [browserRequestIdentity, browserSessionOpen, browserSessionStateHydrated]);
  const browserRunStatusRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const controllerId = activeConversationEntry?.controllerId ?? null;
    const seen = browserRunStatusRef.current;
    for (const run of Object.values(runs ?? {})) {
      if (!controllerId || run.conversationId !== controllerId) continue;
      if (run.metadata?.browserTransport !== "shared" && run.metadata?.browserTransport !== "desktop-personal") continue;
      const previous = seen.get(run.id);
      seen.set(run.id, run.status);
      if (previous && previous !== "canceled" && run.status === "canceled") {
        markBrowserAutoStartDeclined(browserRequestIdentity);
      }
    }
  }, [activeConversationEntry?.controllerId, browserRequestIdentity, runs]);
  const declineBrowserAutoStart = useCallback(() => {
    markBrowserAutoStartDeclined(browserRequestIdentity);
  }, [browserRequestIdentity]);
  const takeOverSharedBrowser = useCallback(async (options?: { agentHoldsBrowser?: boolean }) => {
    declineBrowserAutoStart();
    // The tab the person takes over is this chat's from then on, when it is
    // one the chat's view shows: its Browser view goes on showing it once
    // Octo's turn has ended. Take over pressed over a blank stage (another
    // chat's page still in front as the turn starts) leaves the chat its own
    // tab, and that page the other chat's.
    const taken = chatPageOnScreen(sharedBrowserChromePages, chatViewPageIds);
    const tookOver = await browserHandoff.takeOverShared(options);
    if (tookOver && taken) chooseChatBrowserTab(taken.id);
    return tookOver;
  }, [browserHandoff, chatViewPageIds, chooseChatBrowserTab, declineBrowserAutoStart, sharedBrowserChromePages]);

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

    keepComposerTabOpen();
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
      (browserComposerActive && browserTransport === "personal" && personalBrowser.runtimeOverride?.runtimeId
        ? personalBrowser.runtimeOverride
        : browserTransport === "shared" && browserComposerActive && resolvedBrowserRuntimeId
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
    browserComposerActive,
    browserTransport,
    clearInputEditor,
    createServerMessageStash,
    ensureProjectWriteAccess,
    focusInput,
    imageAttachments.length,
    keepComposerTabOpen,
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
  // Runtime & AI panel does, so the drawer can show it without re-deriving.
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
      const profile = rosterAgent.agentId
        ? availableAgents.find((candidate) => candidate.id === rosterAgent.agentId) ?? null
        : null;
      const providerRaw = (profile?.provider ?? "").trim().toLowerCase();
      const providerId: AiProviderId =
        !providerRaw || providerRaw === "assistant"
          ? defaultCredentialProviderId
          : normalizeAiProviderId(providerRaw);
      // Explicit model, or the lane's default: the managed model the
      // controller reports, else the provider's first option.
      const resolution = profile
        ? resolveRosterCredential({
            pinnedCredentialId: profile.credentialId,
            pinnedModel: normalizeAiModelId(providerId, profile.model) ?? null,
            providerDefaultModel: modelOptionsForProvider(providerId)[0]?.id ?? null,
            credentialsById,
            defaultCredential: defaultAiCredential ?? null,
            managedAi: credentialRequirements.managedAi,
          })
        : null;
      const model = resolution?.model ?? null;
      const credentialState: ParticipantCredentialState = resolution?.credentialState ?? "none";
      const credentialLabel = resolution?.labelCredential
        ? resolveCredentialLabel(resolution.labelCredential)
        : resolution?.managedLabel ?? null;
      const effectiveCredential = resolution?.credential ?? null;
      // Read `subscriptionUsage` defensively: it's a recent addition to the
      // controller payload, so tolerate its absence rather than hard-depend on
      // the field being present in the credential type.
      const subscriptionUsage = parseSubscriptionUsage(
        (effectiveCredential as { subscriptionUsage?: unknown } | null)?.subscriptionUsage,
      );
      return {
        ...rosterAgent,
        agentId: rosterAgent.agentId ?? null,
        canEditProfile: Boolean(profile),
        providerId,
        model,
        modelLabel: resolution?.modelLabel ?? null,
        reasoningEffort: profile?.reasoningEffort ?? null,
        runtime: profile ? resolveRuntime(profile.runtimeId ?? null) : null,
        providerLabel: profile ? formatProviderLabel(providerId) : null,
        credentialId: effectiveCredential?.id ?? null,
        credentialLabel,
        credentialKind: effectiveCredential?.kind ?? null,
        credentialState,
        subscriptionUsage,
      };
    });
  }, [
    availableAgents,
    availableCredentials,
    conversationRosterAgents,
    credentialRequirements.managedAi,
    defaultAiCredential,
    runtimeMenu,
  ]);
  // Amber dot on the roster facepile when any agent's credential needs
  // attention, visible without opening the drawer.
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
  // The conversation's assistant switch, published for the participants panel:
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
    pinnedScrollTopRef,
    queuedSummaryItemCount: queuedSummaryItems.length,
    recordScrollPosition,
    requestOlderMessages,
    rootRef,
    scrollContainerRef,
    sendingAttachment,
    shouldAutoScrollRef,
    totalQueuedCount,
    touchLikeInput,
    voiceHoldActive,
    voiceInputListening,
  });

  const gettingStartedTopAnchoredRef = useRef(false);
  const gettingStartedTopAnchorActive =
    shouldShowGettingStarted && !gettingStartedCollapsed && (compactBrowserViewport || touchLikeInput);
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
    followLatest: !messageTargetActive,
    aiOnboardingOpen,
    autoScrollSuspendedRef,
    autoScrollPendingRef,
    composerAutoHidden,
    composerOverlayHeight,
    composerScrollPaddingBottom: chatScrollPaddingBottom,
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
    queueEditPending,
    handleCancelQueuedEdit,
    handleEditQueuedMessage,
    handleRequeueEditedMessage,
    handleQueuedEditComposerSubmit,
    handleSendEditedMessageNow,
    handleSendQueuedMessageNow,
  } = useChatSendQueueActions({
    activeConversationControllerId: activeConversationEntry?.controllerId ?? null,
    activeConversationId,
    chatSendQueue,
    dispatchServerSendQueueEntryNow,
    editingQueuedItem,
    restoreServerSendQueueItem,
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
  queuedEditSubmitRef.current = handleQueuedEditComposerSubmit;

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
      historyReady: remoteConversationHistoryResolved && !isInitialHistoryLoading && !initialHistoryError,
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
    initialHistoryError,
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
        inlineCompletionEnabled: readComposerInlineCompletionPreference(),
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

  // Cancellation authority comes from controller job state, not a preview's
  // animation, activity timeout, command history, or lingering typing snapshot.
  const stopConversationId = activeConversationEntry?.controllerId ?? null;
  const stopTargets = useMemo(() => resolveChatRunStopTargets(
    Object.values(runs ?? {}).filter((run) => run.conversationId === stopConversationId),
    messages,
    { getAgentDisplayName: (handle) => agentByHandle.get(handle)?.displayName },
  ), [agentByHandle, messages, runs, stopConversationId]);
  const canStopRuns = projectCapabilitiesResolved === true && canWriteProject === true
    && !projectAccessPending && Boolean(currentUserId) && !jobThread;
  const runStop = useChatRunStop({
    conversationId: stopConversationId,
    targets: stopTargets,
    canStop: canStopRuns,
    viewerUserId: currentUserId,
    active: chatVisible && !jobThread,
    escapeBlocked: Boolean(messageMenu || imageLightbox || invitePrompt || connectSheetOpen
      || addMenuOpen || skillsImport.addSkillModalOpen || agentProfileModal || browserVisible),
  });
  const runStopNoticeContext = useChatRunStopContinuation({
    conversationId: stopConversationId,
    viewerUserId: currentUserId,
    humanLabelByUserId,
    canWrite: canStopRuns,
    busy: stopTargets.length > 0 || activeConversationRuns.length > 0,
    messages,
    queuedSends: combinedChatSendQueue,
    submitMessage,
  });

  // A send from the browser's own composer that the submit flow would refuse
  // (no browser runtime yet, or no tab the chat has or can get) disables Send
  // and says why instead of "Enter sends the message." A restored stash
  // carries its own runtime and page, so it is left to the submit flow.
  const sharedBrowserSendBlocker = useMemo(
    () =>
      resolveSharedBrowserSendBlocker({
        active:
          browserTransport === "shared" &&
          browserComposerActive &&
          pendingBrowserLaunchMode !== "new_page" &&
          !restoredMessageStash,
        messageRequiresAi: inputRequiresAi && !deferAiGatesForAmbientParticipation,
        pageAvailable: chatBrowserMessageTarget?.tabAvailable === true,
        resolvedRuntimeId: resolvedBrowserRuntimeId,
        terminalRequest: parseTerminalCommandRequest(inputValue),
      }),
    [
      browserComposerActive,
      browserTransport,
      chatBrowserMessageTarget,
      deferAiGatesForAmbientParticipation,
      inputRequiresAi,
      inputValue,
      pendingBrowserLaunchMode,
      resolvedBrowserRuntimeId,
      restoredMessageStash,
    ],
  );
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
    sharedBrowserSendBlocked: sharedBrowserSendBlocker !== null,
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
  // true), so the connect wizard's "Use Instafy AI" button just dismisses
  // the wizard and fires whatever prompt the user already typed. The draft is
  // still in the composer (openAiOnboarding never clears it), so there is no
  // stashed draft to restore, and the false→true auto-submit effect above
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
  // Mirrors the OctoAgentChip disable path: clear extra agent handles too, or a
  // lingering AI handle keeps inputRequiresAi true and the gate never clears.
  const handleChatWithoutAi = useCallback(() => {
    if (!activeConversationId) {
      return;
    }
    for (const handle of extraAgentHandles) {
      onRemoveAgentHandle(activeConversationId, handle);
    }
    // Also drop any sticky mentioned agent for this conversation; otherwise it
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

  // A plan job the controller ran again (a continued turn, a rate-limit
  // retry) ends with a quiet line to the run that stands for it.
  const jobThreadRerunSources = useMemo(
    () => (normalizedJobThread ? [...Object.values(runs), ...messages] : []),
    [messages, normalizedJobThread, runs],
  );
  const openJobThreadRerun = useCallback((jobId: string) => {
    if (!normalizedJobThread) return;
    requestUrlPush();
    openJobThreadTab({ conversationId: normalizedJobThread.conversationId, jobId });
  }, [normalizedJobThread, openJobThreadTab, requestUrlPush]);

  const beginHistoryRetry = useStudioChatPerformance({
    projectId: activeProjectId,
    organizationId: activeOrgId,
    conversationId: normalizedJobThread?.conversationId ?? activeConversationId,
    selectedConversationId: activeConversationId,
    messageCount: normalizedJobThread ? jobThreadMessages.length : messages.length,
    projectInitialized,
    projectAccessPending,
    conversationListResolved: remoteConversationHistoryResolved,
    initialHistoryLoading: isInitialHistoryLoading,
    error: Boolean(initialHistoryError || remoteConversationHistoryError),
    enabled: conversationsProjectKey === activeProjectId,
  });

  const handleContinueFromJobThread = useCallback(() => {
    if (!normalizedJobThread) {
      return;
    }
    // Use the same surface/tab transition as the Chat tab. A partial URL
    // edit leaves chatView pointing at this trace and route hydration wins.
    requestUrlPush();
    const scope = conversationSurfaceScope(currentUserId, activeProjectId ?? null, normalizedJobThread.conversationId);
    updateSurfaces(scope, state => selectConversationView(state, "chat"));
    openConversationTab(normalizedJobThread.conversationId);
  }, [activeProjectId, currentUserId, normalizedJobThread, openConversationTab, requestUrlPush, updateSurfaces]);

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
          <MultiAgentRunsContext.Provider value={multiAgentRunContext}>
          <ViewerAgentsContext.Provider value={availableAgentById}>
          <ChatScrollSnapshotBoundary identity={chatScrollMutationIdentity} messages={messages} capture={recordScrollPosition}>
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
              const hasImageAttachments = extractChatAttachments(message).length > 0;
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
                    projectId={activeProjectId}
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
              <RunTraceRerunNotice jobId={normalizedJobThread.jobId} sources={jobThreadRerunSources} onOpen={openJobThreadRerun} />
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
      </ChatScrollSnapshotBoundary>
      </ViewerAgentsContext.Provider>
      </MultiAgentRunsContext.Provider>
    );
  }

  const browserLocation = {
    checked: personalBrowser.checked,
    mode: browserTransport,
    onModeChange: handleBrowserTransportChange,
    personalAvailable: personalBrowser.available,
  };
  // Where the browser runs is a setting: each browser's Options menu has it.
  const browserLocationOptions = <BrowserLocationOptions {...browserLocation} />;

  const sitePreviewPanelId = conversationWorkspace ? "conversation-workspace-preview" : `${chatPanelId}-preview`;
  const resourceTabs: ConversationSurface[] = [
    ...(hasBrowserView ? [{
      id: "browser", label: "Browser", panelId: browserPanelId, icon: <Globe className="h-3.5 w-3.5" />,
      ...browserViewTabDetails({ pageTitle: browserActivePageTitle, agentName: browserAgentActive ? browserAgentName : null }),
      attention: browserApprovalAttention ? <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800 dark:bg-amber-400/15 dark:text-amber-200" data-testid="shared-browser-approval-attention">Approve</span> : undefined,
    }] : []),
    ...surfaces.files.map(file => ({
      id: file.id, label: conversationFileLabel(file, surfaces.files), title: file.path,
      panelId: conversationWorkspace ? "conversation-workspace-file" : `${chatPanelId}-file`, icon: <Page className="h-3.5 w-3.5" />, dirty: dirtyFiles.has(file.path),
      onClose: () => updateSurfaces(surfaceScope, state => closeConversationFile(state, file.id, hasBrowserView)),
    })),
    ...surfaces.previews.map(preview => ({
      id: preview.id, label: preview.title, title: preview.title,
      panelId: sitePreviewPanelId, icon: <WebWindow className="h-3.5 w-3.5" />,
      ...previewTabLocation(preview.previewId, preview.title),
      // Closing the tab ends a presentation this page runs for the site (switching views does not).
      onClose: () => { endOwnPresentation(preview.previewId); updateSurfaces(surfaceScope, state => closeConversationPreview(state, preview.id, hasBrowserView)); },
    })),
  ];
  const chatSurface = (
      <div
        id={chatPanelId}
        aria-label="Chat"
        tabIndex={-1}
        role={hasResources ? "tabpanel" : undefined}
        hidden={!chatVisible}
        className={chatVisible ? "flex h-full min-h-0 flex-col" : "hidden"}
      >
      <ChatMessageContextToolbar />
      {activeProjectId && currentUserId ? (
        <LocalBrowserSharing
          key={`${activeProjectId}:${currentUserId}`}
          projectId={activeProjectId}
          userId={currentUserId}
          active={chatVisible}
        />
      ) : null}
      <ChatScrollSnapshotBoundary identity={chatScrollMutationIdentity} messages={messages} capture={recordScrollPosition}>
      <ChatTranscriptViewport
        ariaLabel={conversationLabel}
        onScroll={handleScroll}
        onContextMenu={handleConversationContextMenu}
        scrollContainerRef={scrollContainerRef}
        scrollPaddingBottom={chatScrollPaddingBottom}
        header={
      // A turn's own header names who wrote it, so nothing sticks over the
      // transcript to say it again. The roster rides above it where a chat
      // shows one.
      !conversationWorkspace || jobThread ? (
      <div className="px-3 pt-2 sm:px-4" data-testid="chat-conversation-roster-row">
        {/* Constrain to the shared 56rem chat column so the roster's right
            edge lands on the message column, not the panel edge. */}
        <ChatColumn className="pointer-events-none flex items-center justify-end gap-2 [&>:last-child]:pointer-events-auto">
          <ConversationRoster
            agents={conversationRosterAgents}
            humans={conversationRosterHumans}
            hasCredentialWarning={participantAgentsHaveCredentialWarning}
          />
        </ChatColumn>
      </div>
      ) : undefined
        }
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
                    Loading messages…
                  </>
                ) : (
                  "Load older messages"
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
                  collapsed={gettingStartedCollapsed}
                  onSelectMode={handleGettingStartedModeChange}
                  onSelectConnector={handleSelectConnector}
                  onBrowseConnectors={openConnectBrowse}
                  installedSkillNames={installedSkills.names}
                  showConnectTools={!projectWriteDisabled}
                  managedAiOffer={gettingStartedManagedAiOffer}
                  selectedAi={gettingStartedSelectedAi}
                  connectedAiLabel={gettingStartedConnectedAiLabel}
                  aiViewState={gettingStartedAiViewState}
                  canChangeAiChoice={canChangeGettingStartedAiChoice}
                  personalAiConnectionState={gettingStartedPersonalAiConnectionState}
                  desktopCodexLoginFound={
                    gettingStartedConnectModalProps.desktopCodexAuthJsonStatus?.exists === true
                  }
                  onStartWithManagedAi={handleStartWithManagedAi}
                  onConnectOwnAi={handleConnectOwnAi}
                  onChangeAiChoice={handleChangeAiChoice}
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
            {(messageTargetActive || !shouldShowGettingStarted) && isInitialHistoryLoading && !initialHistoryError && !remoteConversationHistoryError ? (
              <ChatLoadingPill>Loading messages…</ChatLoadingPill>
            ) : null}
            {displayedHistoryError || remoteConversationHistoryError ? (
              <div className="flex justify-center px-2 py-1" role="alert" data-testid="chat-history-error">
                <div className="flex flex-wrap items-center justify-center gap-3 text-sm text-slate-600 dark:text-slate-300">
                  <span>{displayedHistoryError ?? remoteConversationHistoryError}</span>
                  <Button
                    onPress={() => {
                      beginHistoryRetry();
                      if (displayedHistoryError) void retryInitialHistory();
                      else retryRemoteConversationHistory();
                    }}
                    variant="outline"
                    size="xs"
                    radius="full"
                    data-testid="chat-history-retry"
                  >
                    Retry
                  </Button>
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
                  scrollSnapshotKey={scrollSnapshotKey}
                  targetedMessageId={messageTargetActive ? requestedMessageId : null}
                  highlightedMessageId={highlightedMessageId}
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
                  onMessageContextMenu={handleMessageContextMenu}
                />,
              );

              return rows;
            })()}
            <ChatMessageHistoryControls
              messageTargetActive={messageTargetActive}
              loadingNewer={messageContext.loadingNewer}
              newerError={messageContext.newerError}
              canReturnToLatest={Boolean(chatScrollHistoryVisit)}
              onLoadNewer={() => void messageContext.loadNewer()}
              onReturnToLatest={returnToLatestMessages}
              hideLatest={hasNewMessages}
            />
            <ChatPostTranscriptAuxiliaryRows
              jobThreadPresent={Boolean(jobThread)}
              workspaceFileStaleNotice={workspaceFileStaleNotice}
              workspaceFileStaleBusy={workspaceFileStaleBusy}
              workspaceFileStaleError={workspaceFileStaleError}
              onWorkspaceFileStaleMerge={() => void handleWorkspaceFileStaleMerge()}
              onWorkspaceFileStaleReload={handleWorkspaceFileStaleReload}
              onWorkspaceFileStaleDismiss={handleWorkspaceFileStaleDismiss}
              unsavedWorkNotice={unsavedWorkNotice}
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
              onConnectAi={handleConnectAiFromGate}
              hasTeammates={spaceHasTeammates}
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
              typingAgentId={typingAgentId}
              typingIndicatorState={hasMultipleTypingAgents
                ? { phase: workspaceStarting ? "waiting" : multiTypingStatus.phase, label: null }
                : typingIndicatorState}
              typingStatusLabel={typingStatusLabel}
              typingStatusAriaLabel={typingStatusAriaLabel}
              suppressAssistantStatus={
                showOutOfCreditsNotice || workspaceStartStall.showNotice || stoppedTurnNotice !== null ||
                chatBrowserApprovalAsking
              }
              isThinkingLabelExpanded={isThinkingLabelExpanded}
              onToggleThinkingLabel={() => setIsThinkingLabelExpanded((current) => !current)}
              latestDisplayedMessageId={transcriptTailKey}
              latestDisplayedMessageEndsActiveTurn={transcriptTailEndsActiveTurn}
              typingStatusWraps={typingStatusIsRuntimeBusyNotice}
              renderAssistantAvatar={renderAssistantAvatar}
            />
            {chatBrowserApprovalTarget && turnBrowserApproval.showFallback ? (
              <BrowserApprovalRow
                key={chatBrowserApprovalTarget.runId}
                agentDisplayName={chatBrowserApprovalAgentName}
                approval={chatBrowserApproval.approval}
                onSettled={(settled) => recordBrowserApprovalSettled(chatBrowserApprovalTarget.runId, settled)}
                frame={(row) => (
                  <ChatBubbleRow
                    align="left"
                    // An avatar only when the row above is not the same run's.
                    avatar={fallbackRowContinuesTail(
                      displayedMessages[displayedMessages.length - 1],
                      runs?.[chatBrowserApprovalTarget.runId] ??
                        activeConversationRuns.find((run) => run.id === chatBrowserApprovalTarget.runId),
                    )
                      ? ASSISTANT_AVATAR_GUTTER_PLACEHOLDER
                      : renderAssistantAvatar(chatBrowserApprovalTarget.runMetadata)}
                    testId="browser-approval-fallback"
                  >
                    {row}
                  </ChatBubbleRow>
                )}
              />
            ) : null}
            {stoppedTurnNotice ? <StoppedTurnRow text={stoppedTurnNotice} /> : null}
            {workspaceStartStall.showNotice ? (
              <WorkspaceStartStalledRow
                agentDisplayName={hasMultipleTypingAgents ? null : typingAgentDisplayName}
                onRetry={workspaceStartStall.retry}
                retryPending={workspaceStartStall.retryPending}
              />
            ) : null}
          </ChatColumn>
          </div>
        </OctoScrollMotionScope>
      </ChatTranscriptViewport>
      </ChatScrollSnapshotBoundary>
      </div>
  );
  const resourceContent = <>
      {browserSessionOpen || hasHiddenBrowserSession ? (
        <div
          id={browserPanelId}
          aria-label="Browser"
          role="tabpanel"
          hidden={!browserVisible}
          className={browserVisible ? "flex h-full min-h-0 flex-col" : "hidden"}
          style={
            !splitSurfaces && browserModalBottomInset
              ? { height: `calc(100% - ${browserModalBottomInset})` }
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
                  <BrowserTransportSelector {...browserLocation} compact={compactBrowserBar} />
                </div>
              ) : null}
              <PersonalBrowserSurface
                active={browserTransport === "personal" && browserVisible}
                agentWorking={activeConversationRuns.some((run) =>
                  run.metadata?.browserTransport === "desktop-personal" &&
                  (run.status === "in_progress" || run.status === "queued"))}
                compactChrome={compactBrowserBar}
                historyUserId={currentUserId}
                model={personalBrowser}
                sharingControls={activeProjectId && currentUserId ? (
                  <LocalBrowserTabPublisher
                    key={`${activeProjectId}:${currentUserId}`}
                    projectId={activeProjectId}
                    userId={currentUserId}
                    ownerId={personalBrowser.ownerId}
                    takeoverRequestId={personalBrowser.status?.ownerId === personalBrowser.ownerId && personalBrowser.status?.tabControlActive ? personalBrowser.status.takeoverRequestId : undefined}
                    canShare={browserTransport === "personal" && personalBrowser.status?.state === "ready" && typeof window.instafyDesktop?.browserTabShareStart === "function"}
                  />
                ) : null}
                humanInputIdentityKey={browserHandoff.identityKey}
                onContinueAfterHumanInput={browserHandoff.continuePersonalRun}
                onPauseAgentControl={declineBrowserAutoStart}
                onSendPage={canSendPages ? sendPersonalPage : undefined}
                sendPagePending={sendPagePendingViewer === "personal"}
                locationOptions={browserTransport === "personal" ? browserLocationOptions : null}
              />
              {sharedBrowserActivated ? (
                <div className={browserTransport === "shared" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                  <LazyBrowserSessionModal
                    isOpen={browserSessionOpen}
                    onOpenChange={handleBrowserSessionOpenChange}
                    projectId={activeProjectId ?? null}
                    browserSessionId={sharedBrowserSurfaceSessionId}
                    preferRuntimeId={preferredBrowserRuntimeId}
                    resumeRuntimeId={requestedSharedBrowserRuntimeId ?? exactBrowserRuntimeId}
                    expandRequestToken={browserSessionExpandRequestToken}
                    attachRequestToken={sharedBrowserAttachRequestToken}
                    autoAttachToken={sharedBrowserAutoAttachToken}
                    onConnectionErrorChange={handleSharedBrowserConnectionErrorChange}
                    onViewStateChange={setSharedBrowserViewKind}
                    presentation="docked"
                    fillContainer
                    onBackToChat={handleBackToChat}
                    onApprovalPendingChange={chatViewApproval.onApprovalPendingChange}
                    locationOptions={browserTransport === "shared" ? browserLocationOptions : null}
                    transportActive={
                      browserTransport === "shared" && browserVisible
                    }
                    canControlBrowser={canWriteProject}
                    canClearBrowserData={canWriteProject}
                    controlOwner={sharedBrowserControlOwner}
                    currentUserId={currentUserId}
                    humanInputIdentityKey={browserHandoff.identityKey}
                    humanInputRunIds={browserHumanInputRunIds}
                    onTakeOverAgent={browserHandoff.sharedJobWhileAgentHolds ? takeOverSharedBrowser : null}
                    onContinueAfterHumanInput={browserHandoff.continueSharedRun}
                    onPresenceChange={setSharedBrowserPresence}
                    sharedBrowserChrome={sharedBrowserChromeForView}
                    sharedBrowserViewerKind={sharedBrowserViewerKind}
                    sharedBrowserCapabilitiesResolved={sharedBrowserCapabilitiesResolved}
                    sharedBrowserCapabilitiesAvailable={Boolean(sharedBrowserCapabilities)}
                    sharedBrowserCapabilitiesUnsupported={sharedBrowserCapabilitiesUnsupported}
                    sharedBrowserAvailableViewerKinds={
                      sharedBrowserCapabilities?.viewerKinds
                    }
                    sharedBrowserRfbCapabilities={sharedBrowserCapabilities?.rfb ?? null}
                    sharedBrowserWebRtcCapabilities={
                      sharedBrowserCapabilities?.webrtc ?? null
                    }
                    onRuntimeIdResolved={handleSharedBrowserRuntimeResolved}
                    onStatus={showStatus}
                    ensureSpaceMachine={canWriteProject ? ensureSpaceMachineForBrowser : null}
                    openedByPerson={browserSessionOpenedInPage}
                    attachOnly={browserAttachOnly}
                    conversationRuntimeId={effectiveRuntimeId ?? null}
                    spaceBusy={spaceRunActive}
                    runApproval={browserRunApproval}
                    conversationId={activeConversationId ?? null}
                    chatPageIds={chatViewPageIds}
                    anotherChatTurn={anotherChatBrowserTurn}
                    agentArrival={browserArrival}
                    spaceHasTeammates={spaceHasTeammates}
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    {surfaces.files.length > 0 ? (
      <div id={conversationWorkspace ? "conversation-workspace-file" : `${chatPanelId}-file`} role="tabpanel" aria-label={selectedFile?.path ?? "File"} hidden={!selectedFile} className={selectedFile ? "h-full min-h-0" : "hidden"} style={!splitSurfaces ? { paddingBottom: composerOverlayHeight } : undefined}>
        <FilesPanel previewOwnerId={`conversation:${surfaceScope}`} showExplorer={false} mobileView="viewer" embeddedOpenRequest={fileRequest} />
      </div>
    ) : null}
    {surfaces.previews.length > 0 && activeProjectId ? (
      <SitePreviewPanel id={sitePreviewPanelId} label={selectedPreview?.title ?? "Preview"} projectId={activeProjectId} scope={surfaceScope}
        spaceName={projectList.find(entry => entry.id === activeProjectId)?.name ?? null}
        previews={surfaces.previews} visiblePreviewId={visiblePreviewId} style={!splitSurfaces ? { paddingBottom: composerOverlayHeight } : undefined}
        asks={siteAskHost} />
    ) : null}
  </>;

  return (
    <MultiAgentRunsContext.Provider value={multiAgentRunContext}>
    <ViewerAgentsContext.Provider value={availableAgentById}>
    <WorkerQuestionReplyContext.Provider value={normalizedJobThread ? null : workerQuestionReply.host}>
    <ChatRunStopNoticeProvider value={runStopNoticeContext}>
    <RunFailureRetryProvider value={runFailureRetryContextValue}>
    <ConversationFileContext.Provider value={openSurfaceFile}>
    <ConversationPreviewContext.Provider value={previewOpener}>
    <ChatRuntimeActivityContext.Provider value={chatRuntimeActivityValue}>
    <BrowserRequestHostContext.Provider value={browserRequestHost}>
    <TurnBrowserApprovalContext.Provider value={turnBrowserApproval.value}>
    <TurnBrowserApprovalStateContext.Provider value={chatBrowserApproval.approval}>
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="chat-panel-root"
    >
      <ConversationSurfaceLayout
        showTabs={!conversationWorkspace && !showComposerNavigationButton}
        chatPanelId={chatPanelId}
        activeId={activeSurfaceId} resourceId={resourceId}
        split={splitSurfaces} wide={wideSurfaces} ratio={surfaces.ratio}
        onSelect={handleBrowserSubtabChange}
        onSplitChange={split => updateSurfaces(surfaceScope, state => ({ ...state, split }))}
        onRatioChange={ratio => updateSurfaces(surfaceScope, state => ({ ...state, ratio }))}
        onRatioPreview={previewSurfaceRatio}
        resources={resourceTabs}
        chat={chatSurface}
        content={resourceContent}
      />

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
        composerRunStopController={runStop}
        replyContext={<WorkerQuestionReplyStrip reply={workerQuestionReply} />}
        viewNavigation={hasComposerViewNavigation ? conversationWorkspace ? <ConversationWorkspaceViews placement="composer" /> : <ConversationSurfaceTabs
          presentation="composer" chatPanelId={chatPanelId} resources={resourceTabs}
          activeId={activeSurfaceId} resourceId={resourceId} split={false} wide={false} ratio={surfaces.ratio}
          onSelect={handleBrowserSubtabChange} onSplitChange={split => updateSurfaces(surfaceScope, state => ({ ...state, split }))}
        /> : null}
        overlayWidth={splitSurfaces ? `calc((1 - var(--conversation-resource-ratio, ${surfaces.ratio})) * 100%)` : undefined}
        aboveComposer={hasNewMessages ? <ChatNewMessagesButton onPress={jumpToNewMessages} /> : null}
        mutationDisabled={projectWriteDisabled}
        silenceHintProps={
          octoSilenceHint.visible ? { onDismiss: octoSilenceHint.dismiss } : null
        }
        accessNotice={
          projectReadOnly
            ? "Read-only access. You can review this space, but you can’t send messages or change files."
            : null
        }
        accessChecking={!projectReadOnly && projectCapabilitiesResolved === false}
        pendingNewTab={pendingBrowserLaunchMode === "new_page"
          ? { onCancel: handleClearPendingNewBrowserSession }
          : null}
        composerOverlayRef={composerOverlayRef}
        composerAutoHidden={composerAutoHidden}
        touchLikeInput={touchLikeInput}
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
          mutationDisabled: queueEditPending,
          onToggleExpanded: () => setChatSendQueueExpanded((current) => !current),
          onSendQueuedMessageNow: handleSendQueuedMessageNow,
          onRemoveQueuedItem: removeChatSendQueueItem,
          onReorderQueuedItem: reorderChatSendQueueItem,
          reorderDisabled:
            serverQueueReordering ||
            (serverSendQueueItems.length > 0 && chatSendQueue.length > 0),
          onEditQueuedMessage: (...args) => {
            if (workerQuestionReply.active) {
              showStatus("Finish or cancel your worker reply before editing a queued message.");
              return;
            }
            return handleEditQueuedMessage(...args);
          },
          onCancelQueuedEdit: handleCancelQueuedEdit,
          onRequeueEditedMessage: handleRequeueEditedMessage,
          onSendEditedMessageNow: handleSendEditedMessageNow,
        }}
        stashTrayProps={{
          stashes: messageStashes,
          restoredStashId: restoredMessageStash?.id ?? null,
          busy: messageStashMutating,
          onRestore: (...args) => {
            if (workerQuestionReply.active) {
              showStatus("Finish or cancel your worker reply before restoring a saved message.");
              return;
            }
            return handleRestoreMessageStash(...args);
          },
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
          ghostSuggestionRemainder: workerQuestionReply.active ? null : composerGhostSuggestion?.remainder ?? null,
          recordingIndicatorActive: false,
          recordingIndicatorLabel,
          agentHandles: mentionableAgentHandles,
          agentProfiles: availableAgents,
          mentionableUsers,
          placeholder: workerQuestionReply.active ? "Your reply…" : chatInputPlaceholder,
          ariaLabel: workerQuestionReply.active ? `Reply to ${workerQuestionReply.active.label}` : undefined,
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
        showComposerNavigationButton={showComposerNavigationButton && Boolean(onOpenChatNavigation)}
        composerNavigationDestination="sheet"
        onOpenNavigation={() => onOpenChatNavigation?.()}
        homeAttentionCount={homeAttentionCount}
        homeAttentionBadge={homeAttentionBadge}
        composerActionMenuProps={{
          // The pre-AI lock gates sending, not the "+" actions (import a repo,
          // open a browser, invite), none of which need AI connected. Keeping
          // it enabled here is what makes repo import reachable before setup.
          disabled: sendingAttachment,
          mutationDisabled: projectWriteDisabled,
          ...composerBrowserActions({
            transport: browserTransport,
            browserOpen: browserSessionOpen || hasHiddenBrowserSession,
          }),
          showInviteAction:
            canOpenProjectDeviceHandoff(activeProjectId, projectCapabilitiesResolved),
          inviteActionLabel: projectReadOnly ? "Open on another device" : "Invite or open elsewhere",
          pendingNewBrowser: pendingBrowserLaunchMode === "new_page",
          onOpenBrowser: handleOpenBrowserFromLauncher,
          onOpenNewBrowser: handlePrepareNewBrowserSession,
          onOpenInvite: () => setAddMenuOpen(true),
          onImportGithubRepo: beginGithubImport,
          onSelectConnector: handleSelectConnector,
          onBrowseConnectors: openConnectBrowse,
          installedSkillNames: installedSkills.names,
          onInsertCommand: handleInsertSlashCommand,
          onQueueMessage: () => {
            void invokeSubmitMessage(undefined, { intent: "queue" });
          },
          onStashDraft: () => {
            void handleStashDraft();
          },
          queueDisabled:
            Boolean(workerQuestionReply.active) || submissionPending ||
            !inputValue.trim() ||
            imageAttachments.length > 0 ||
            !activeConversationId ||
            !activeConversationEntry?.controllerId,
          stashDisabled:
            Boolean(workerQuestionReply.active) || messageStashMutating ||
            submissionPending ||
            !inputValue.trim() ||
            imageAttachments.length > 0 ||
            !activeConversationId ||
            !activeConversationEntry?.controllerId,
        }}
        onOpenImagePicker={openImagePicker}
        imageUploadUnavailableReason={chatAttachmentsUnavailableReason}
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
          onVoicePressStart: () => {
            keepComposerTabOpen();
            return handleStartVoiceInputHold();
          },
          onVoicePressEnd: handleStopVoiceInputHold,
          onVoiceTap: () => {
            keepComposerTabOpen();
            handleChatVoiceTap();
          },
        }}
        sendButtonDisabled={projectWriteDisabled || (workerQuestionReply.active
          ? workerQuestionReply.busy || !inputValue.trim() || sendingAttachment || voiceInputStarting || voiceInputListening || voiceInputTranscribing || voiceHoldActive
          : sendButtonDisabled)}
        sendButtonVariant={sendButtonVariant}
        primaryActionMode={composerPrimaryActionMode}
        sendActionLabel={workerQuestionReply.active
          ? workerQuestionReply.active.index < workerQuestionReply.active.request.questions.length - 1 ? "Next question" : "Send answer"
          : undefined}
        primaryActionBlockedStatus={
          !workerQuestionReply.active && sharedBrowserSendBlocker
            ? SHARED_BROWSER_SEND_BLOCKER_STATUS[sharedBrowserSendBlocker]
            : null
        }
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
      <ConnectSheet
        isOpen={connectSheetOpen}
        stage={connectSheet.state?.stage ?? "browse"}
        target={connectSheet.state?.target ?? null}
        showBack={connectSheet.state?.openedFromBrowse ?? false}
        installedSkillNames={installedSkills.names}
        pending={skillsImport.importPending}
        onSelect={handleSelectConnector}
        onBack={backConnectSheet}
        onPasteLink={handleConnectPasteLink}
        onConnect={(connector) => {
          void handleConnectConfirm(connector);
        }}
        onSetUpAgain={handleConnectSetUpAgain}
        onClose={closeConnectSheet}
      />
      <SkillsImportModal
        isOpen={skillsImport.addSkillModalOpen}
        onOpenChange={skillsImport.setAddSkillModalOpen}
        importPending={skillsImport.importPending}
        importSource={skillsImport.importSource}
        onImportSourceChange={skillsImport.setImportSource}
        importName={skillsImport.importName}
        onImportNameChange={skillsImport.setImportName}
        importOverwrite={skillsImport.importOverwrite}
        onImportOverwriteChange={skillsImport.setImportOverwrite}
        hasProject={Boolean(activeProjectId)}
        onBrowseSkills={() => guardNavigation(() => {
          skillsImport.setAddSkillModalOpen(false);
          openConnectBrowse();
        })}
        onSubmitImport={() => {
          void skillsImport.handleSubmitImport({ closeModalOnSuccess: true });
        }}
      />
      {agentProfileModal ? (
        // Event-driven profile opens (mention chips, narrow speaker labels) have
        // no anchor, so the card presents as a centered modal at every width.
        <StudioDialogModal
          isOpen
          isDismissable
          onOpenChange={(open) => {
            if (!open) setAgentProfileTarget(null);
          }}
          className="h-[100dvh] min-h-0 overflow-hidden"
          modalClassName="min-h-0 max-h-full w-full max-w-sm overflow-y-auto overscroll-contain"
          dialogAriaLabel={`Agent profile: @${agentProfileModal.handle}`}
        >
          <AgentProfileCardContent
            {...resolveAgentProfileCardProps(agentProfileModal.handle, agentProfileCardIdentity)}
            agentTextOnly={!agentProfileCardIdentity}
            onRequestClose={() => setAgentProfileTarget(null)}
          />
        </StudioDialogModal>
      ) : null}
        </div>
    </TurnBrowserApprovalStateContext.Provider>
    </TurnBrowserApprovalContext.Provider>
    </BrowserRequestHostContext.Provider>
    </ChatRuntimeActivityContext.Provider>
    </ConversationPreviewContext.Provider>
    </ConversationFileContext.Provider>
    </RunFailureRetryProvider>
    </ChatRunStopNoticeProvider>
    </WorkerQuestionReplyContext.Provider>
    </ViewerAgentsContext.Provider>
    </MultiAgentRunsContext.Provider>
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
