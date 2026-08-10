import type {
  ChangeEventHandler,
  ComponentProps,
  DragEventHandler,
  FormEventHandler,
  PointerEventHandler,
  RefObject,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archery,
  MagicWand,
  MediaImage,
  Microphone,
  NavArrowDown,
  Pause,
  Play,
  Send,
  WarningTriangle,
  Xmark,
} from "iconoir-react";
import { HomeIcon } from "../../../components/AppIcons";
import { IconButton } from "../../../components/Button";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import {
  DARK_PANEL_BORDER_CLASS,
  DARK_PANEL_SHADOW_CLASS,
  DARK_PANEL_SOFT_BG_CLASS,
  DARK_RAISED_CONTROL_BG_CLASS,
  DARK_RAISED_CONTROL_CLASS,
} from "../../../theme/darkSurfaces";
import { ComposerActionMenu } from "./ComposerActionMenu";
import { ComposerInviteModal } from "./ComposerInviteModal";
import { ChatBrowserDock } from "./ChatBrowserDock";
import { ChatInput, type ChatInputHandle } from "./chat-input/ChatInput";
import { ChatSendQueueSurface } from "./ChatSendQueueSurface";
import { OctoAgentChip } from "./OctoAgentChip";
import { OctoSilenceHint } from "./OctoSilenceHint";
import { StatusPill, StatusPillButton, type StatusPillTone } from "./StatusPill";
import { VoiceConversationActionStrip } from "./VoiceConversationActionStrip";
import { ProviderTriggerNotice } from "../../../extensions/ProviderTriggerNotice";
import {
  normalizeConversationGoalProgressSummaryForDisplay,
  type ConversationGoal,
  type ConversationGoalHealth,
} from "../../../conversations/conversationGoals";
import type { PendingChatImageAttachment } from "./useChatComposerAttachments";
import { CHAT_COMPOSER_COLUMN_CLASS_NAME } from "./ChatColumn";

type ChatComposerSurfaceProps = {
  browserDockProps: ComponentProps<typeof ChatBrowserDock>;
  composerOverlayRef: RefObject<HTMLDivElement | null>;
  composerAutoHidden: boolean;
  browserModeActive?: boolean;
  compactBrowserViewport: boolean;
  onSubmit: FormEventHandler<HTMLFormElement>;
  queueSurfaceProps: ComponentProps<typeof ChatSendQueueSurface>;
  activeGoal: ConversationGoal | null;
  activeGoalHealth: ConversationGoalHealth | null;
  onPauseGoal: () => void;
  onResumeGoal: () => void;
  onClearGoal: () => void;
  onHelpUnblockGoal: () => void;
  goalDetailsCollapseToken: number;
  nativeKeyboardOpen: boolean;
  onboardingInputLocked: boolean;
  onDragOver: DragEventHandler<HTMLDivElement>;
  onDrop: DragEventHandler<HTMLDivElement>;
  chatInputRef: RefObject<ChatInputHandle | null>;
  chatInputProps: ComponentProps<typeof ChatInput>;
  imageInputRef: RefObject<HTMLInputElement | null>;
  onImageInputChange: ChangeEventHandler<HTMLInputElement>;
  imageAttachments: PendingChatImageAttachment[];
  onOpenImage: (src: string, alt: string) => void;
  onRemoveImageAttachment: (attachmentId: string) => void;
  showVoiceStatus: boolean;
  voiceStatusMessage: string;
  providerTriggerNoticeProps: ComponentProps<typeof ProviderTriggerNotice> | null;
  showComposerHomeButton: boolean;
  onOpenHome: () => void;
  homeAttentionCount: number;
  homeAttentionBadge: string;
  octoAgentChipProps: ComponentProps<typeof OctoAgentChip>;
  composerActionMenuProps: ComponentProps<typeof ComposerActionMenu>;
  onOpenImagePicker: () => void;
  sendingAttachment: boolean;
  showMobileGhostSuggestionAcceptButton: boolean;
  onAcceptGhostSuggestion: () => void;
  showVoicePrimaryAction: boolean;
  voiceConversationActionStripProps: ComponentProps<typeof VoiceConversationActionStrip>;
  sendButtonDisabled: boolean;
  sendButtonVariant: ComponentProps<typeof IconButton>["variant"];
  onSendButtonPointerDown: PointerEventHandler<HTMLButtonElement>;
  onSendButtonPointerUp: PointerEventHandler<HTMLButtonElement>;
  onSendButtonPointerCancel: PointerEventHandler<HTMLButtonElement>;
  onSendButtonPressStart: ComponentProps<typeof IconButton>["onPressStart"];
  onSendButtonPressEnd: ComponentProps<typeof IconButton>["onPressEnd"];
  onSendButtonPress: ComponentProps<typeof IconButton>["onPress"];
  composerOutlinedActionClass: string;
  composerPrimaryActionClass: string;
  composerActionIconClass: string;
  composerActionButtonClass: string;
  inviteModalProps: ComponentProps<typeof ComposerInviteModal>;
  mutationDisabled?: boolean;
  accessNotice?: string | null;
  silenceHintProps?: ComponentProps<typeof OctoSilenceHint> | null;
};

function resolveGoalStatusPillTone(tone: ConversationGoalHealth["tone"]): StatusPillTone {
  if (tone === "blocked") {
    return "danger";
  }
  if (tone === "warning") {
    return "warning";
  }
  if (tone === "paused") {
    return "neutral";
  }
  return "primary";
}

export function ChatComposerSurface({
  browserDockProps,
  composerOverlayRef,
  composerAutoHidden,
  browserModeActive = false,
  compactBrowserViewport,
  onSubmit,
  queueSurfaceProps,
  activeGoal,
  activeGoalHealth,
  onPauseGoal,
  onResumeGoal,
  onClearGoal,
  onHelpUnblockGoal,
  goalDetailsCollapseToken,
  nativeKeyboardOpen,
  onboardingInputLocked,
  onDragOver,
  onDrop,
  chatInputRef,
  chatInputProps,
  imageInputRef,
  onImageInputChange,
  imageAttachments,
  onOpenImage,
  onRemoveImageAttachment,
  showVoiceStatus,
  voiceStatusMessage,
  providerTriggerNoticeProps,
  showComposerHomeButton,
  onOpenHome,
  homeAttentionCount,
  homeAttentionBadge,
  octoAgentChipProps,
  composerActionMenuProps,
  onOpenImagePicker,
  sendingAttachment,
  showMobileGhostSuggestionAcceptButton,
  onAcceptGhostSuggestion,
  showVoicePrimaryAction,
  voiceConversationActionStripProps,
  sendButtonDisabled,
  sendButtonVariant,
  onSendButtonPointerDown,
  onSendButtonPointerUp,
  onSendButtonPointerCancel,
  onSendButtonPressStart,
  onSendButtonPressEnd,
  onSendButtonPress,
  composerOutlinedActionClass,
  composerPrimaryActionClass,
  composerActionIconClass,
  composerActionButtonClass,
  inviteModalProps,
  mutationDisabled = false,
  accessNotice = null,
  silenceHintProps = null,
}: ChatComposerSurfaceProps) {
  const showVoiceSecondaryStatus = showVoicePrimaryAction && showVoiceStatus;
  const showVoiceActiveStrip = showVoicePrimaryAction && showVoiceSecondaryStatus;
  const showActiveGoal =
    activeGoal !== null &&
    (activeGoal.status === "active" ||
      activeGoal.status === "paused" ||
      activeGoal.status === "blocked");
  const goalHealthTone = activeGoalHealth?.tone ?? "active";
  const goalStatusPillTone = resolveGoalStatusPillTone(goalHealthTone);
  const goalMarkerClass =
    goalHealthTone === "blocked"
      ? "bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200"
      : goalHealthTone === "warning"
        ? "bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200"
        : goalHealthTone === "paused"
          ? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
          : "bg-primary-50 text-primary-700 dark:bg-primary-400/10 dark:text-primary-200";
  const sendPressHandledRef = useRef(false);
  const [goalDetailsExpanded, setGoalDetailsExpanded] = useState(false);
  const goalDetail =
    normalizeConversationGoalProgressSummaryForDisplay(activeGoalHealth?.detail) ?? "";
  const hasGoalDetails = goalDetail.length > 0;
  const goalDetailsId = activeGoal ? `chat-active-goal-details-${activeGoal.id}` : undefined;
  const goalDetailsToggleLabel = goalDetailsExpanded
    ? "Hide goal details"
    : "Show goal details";
  const showGoalStatusWarningIcon =
    goalHealthTone === "blocked" || goalHealthTone === "warning";
  const showGoalHelpAction = goalHealthTone === "blocked";
  const browserComposerCondensed =
    browserModeActive &&
    chatInputProps.value.trim().length === 0 &&
    imageAttachments.length === 0 &&
    !showActiveGoal &&
    !showVoiceActiveStrip &&
    !providerTriggerNoticeProps &&
    queueSurfaceProps.totalQueuedCount === 0 &&
    !queueSurfaceProps.editingQueuedItem;

  useEffect(() => {
    setGoalDetailsExpanded(false);
  }, [activeGoal?.id]);

  useEffect(() => {
    setGoalDetailsExpanded(false);
  }, [goalDetailsCollapseToken]);

  const markSendPressHandled = useCallback(() => {
    sendPressHandledRef.current = true;
    if (typeof window === "undefined") {
      sendPressHandledRef.current = false;
      return;
    }
    window.setTimeout(() => {
      sendPressHandledRef.current = false;
    }, 0);
  }, []);

  const handleSendPress = useCallback<NonNullable<ComponentProps<typeof IconButton>["onPress"]>>(
    (event) => {
      markSendPressHandled();
      onSendButtonPress?.(event);
    },
    [markSendPressHandled, onSendButtonPress],
  );

  const handleSendClick = useCallback<NonNullable<ComponentProps<typeof IconButton>["onClick"]>>(
    (event) => {
      if (sendButtonDisabled || sendPressHandledRef.current) {
        return;
      }
      event.preventDefault();
      onSendButtonPress?.({ pointerType: "mouse" } as never);
    },
    [onSendButtonPress, sendButtonDisabled],
  );
  const toggleGoalDetails = useCallback(() => {
    if (!hasGoalDetails) {
      return;
    }
    setGoalDetailsExpanded((current) => !current);
  }, [hasGoalDetails]);
  const handleHelpUnblockGoal = useCallback<NonNullable<ComponentProps<"button">["onClick"]>>(
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      setGoalDetailsExpanded(false);
      if (typeof window === "undefined") {
        onHelpUnblockGoal();
        return;
      }
      window.setTimeout(() => {
        onHelpUnblockGoal();
      }, 0);
    },
    [onHelpUnblockGoal],
  );

  return (
    <>
      <ChatBrowserDock {...browserDockProps} />

      <div
        ref={composerOverlayRef}
        className={`pointer-events-none absolute inset-x-0 bottom-0 z-20 transition-transform duration-200 ease-out ${
          composerAutoHidden ? "translate-y-full" : "translate-y-0"
        }`}
        data-testid="chat-composer-overlay"
        data-browser-session-safe-zone="true"
        style={
          composerAutoHidden && compactBrowserViewport
            ? {
                transform: "translateY(calc(100% - max(var(--instafy-safe-area-inset-bottom), 0.75rem)))",
              }
            : undefined
        }
      >
        <form
          onSubmit={onSubmit}
          className={
            browserModeActive || compactBrowserViewport
              ? "pointer-events-auto px-0 pb-0"
              : `pointer-events-auto ${CHAT_COMPOSER_COLUMN_CLASS_NAME} px-3 pb-0 sm:px-4`
          }
        >
          <div className="space-y-2">
            {showActiveGoal ? (
              <div
                className={`pointer-events-auto flex min-w-0 flex-col gap-2 rounded-2xl border border-slate-200/70 bg-white/95 px-3 py-2 text-sm shadow-sm dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel-strong)] ${
                  compactBrowserViewport ? "mx-2" : "mx-1 sm:mx-2"
                }`}
                data-testid="chat-active-goal"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={`flex h-7 w-7 flex-none items-center justify-center rounded-full ${goalMarkerClass}`}
                    aria-label="Goal"
                    title="Goal"
                  >
                    <Archery className="h-4 w-4" aria-hidden="true" />
                  </span>
                  {hasGoalDetails ? (
                    <button
                      type="button"
                      aria-controls={goalDetailsId}
                      aria-expanded={goalDetailsExpanded}
                      onClick={toggleGoalDetails}
                      className="-m-1 min-w-0 flex-1 rounded-xl p-1 text-left transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 dark:hover:bg-slate-900/40"
                      data-testid="chat-active-goal-summary"
                    >
                      <span className="block truncate font-medium text-slate-700 dark:text-slate-200">
                        {activeGoal.objective}
                      </span>
                      <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                        {goalDetail}
                      </span>
                      {activeGoalHealth && activeGoalHealth.turnCount > 0 ? (
                        <span className="mt-1 block h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                          <span
                            className={`block h-full rounded-full ${
                              goalHealthTone === "blocked"
                                ? "bg-rose-500"
                                : goalHealthTone === "warning"
                                  ? "bg-amber-500"
                                  : "bg-primary-500"
                            }`}
                            style={{ width: `${Math.max(4, activeGoalHealth.progressRatio * 100)}%` }}
                          />
                        </span>
                      ) : null}
                    </button>
                  ) : (
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-slate-700 dark:text-slate-200">
                        {activeGoal.objective}
                      </span>
                      {activeGoalHealth && activeGoalHealth.turnCount > 0 ? (
                        <span className="mt-1 block h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                          <span
                            className={`block h-full rounded-full ${
                              goalHealthTone === "blocked"
                                ? "bg-rose-500"
                                : goalHealthTone === "warning"
                                  ? "bg-amber-500"
                                  : "bg-primary-500"
                            }`}
                            style={{ width: `${Math.max(4, activeGoalHealth.progressRatio * 100)}%` }}
                          />
                        </span>
                      ) : null}
                    </span>
                  )}
                  {activeGoalHealth ? (
                    hasGoalDetails ? (
                      <StatusPillButton
                        type="button"
                        aria-controls={goalDetailsId}
                        aria-expanded={goalDetailsExpanded}
                        aria-label={`${goalDetailsToggleLabel}: ${activeGoalHealth.label}`}
                        onClick={toggleGoalDetails}
                        className="flex-none"
                        tone={goalStatusPillTone}
                        icon={showGoalStatusWarningIcon ? WarningTriangle : null}
                      >
                        {activeGoalHealth.label}
                      </StatusPillButton>
                    ) : (
                      <StatusPill
                        className="flex-none"
                        tone={goalStatusPillTone}
                        icon={showGoalStatusWarningIcon ? WarningTriangle : null}
                      >
                        {activeGoalHealth.label}
                      </StatusPill>
                    )
                  ) : null}
                  <div className="flex flex-none items-center gap-1">
                    {hasGoalDetails ? (
                      <IconButton
                        aria-controls={goalDetailsId}
                        aria-expanded={goalDetailsExpanded}
                        aria-label={goalDetailsToggleLabel}
                        title={goalDetailsToggleLabel}
                        type="button"
                        variant="ghost"
                        radius="full"
                        size="xs"
                        onClick={toggleGoalDetails}
                        className="text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                      >
                        <NavArrowDown
                          className={`h-4 w-4 transition-transform ${goalDetailsExpanded ? "rotate-180" : ""}`}
                          aria-hidden="true"
                        />
                      </IconButton>
                    ) : null}
                    {activeGoal.status === "active" ? (
                      <IconButton
                        aria-label="Pause goal"
                        title="Pause goal"
                        type="button"
                        variant="ghost"
                        radius="full"
                        size="xs"
                        onClick={onPauseGoal}
                        isDisabled={mutationDisabled}
                        className="text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                      >
                        <Pause className="h-4 w-4" aria-hidden="true" />
                      </IconButton>
                    ) : (
                      <IconButton
                        aria-label="Resume goal"
                        title="Resume goal"
                        type="button"
                        variant="ghost"
                        radius="full"
                        size="xs"
                        onClick={onResumeGoal}
                        isDisabled={mutationDisabled}
                        className="text-primary-700 hover:bg-primary-50 dark:text-primary-200 dark:hover:bg-primary-400/10"
                      >
                        <Play className="h-4 w-4" aria-hidden="true" />
                      </IconButton>
                    )}
                    <IconButton
                      aria-label="Clear goal"
                      title="Clear goal"
                      type="button"
                      variant="ghost"
                      radius="full"
                      size="xs"
                      onClick={onClearGoal}
                      isDisabled={mutationDisabled}
                      className="text-slate-500 hover:bg-rose-50 hover:text-rose-700 dark:text-slate-400 dark:hover:bg-rose-950/30 dark:hover:text-rose-200"
                    >
                      <Xmark className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                  </div>
                </div>
                {hasGoalDetails && goalDetailsExpanded ? (
                  <div
                    id={goalDetailsId}
                    data-testid="chat-active-goal-details"
                    className="rounded-xl bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600 dark:bg-slate-900/40 dark:text-slate-300"
                  >
                    <p>{goalDetail}</p>
                    {showGoalHelpAction ? (
                      <button
                        type="button"
                        onClick={handleHelpUnblockGoal}
                        disabled={mutationDisabled}
                        className="mt-2 rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 dark:bg-slate-950/60 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-800"
                      >
                        Help unblock
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            {accessNotice ? (
              <div
                className="mx-1 rounded-xl border border-amber-300/60 bg-amber-50/95 px-3 py-2 text-xs font-medium text-amber-900 shadow-sm dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-100 sm:mx-2"
                data-testid="project-read-only-notice"
                role="status"
              >
                {accessNotice}
              </div>
            ) : null}
            {silenceHintProps ? <OctoSilenceHint {...silenceHintProps} /> : null}
            <ChatSendQueueSurface {...queueSurfaceProps} mutationDisabled={mutationDisabled} />
            <Surface
              tone="default"
              radius="2xl"
              shadow="none"
              // The composer keeps the raised-control background but borrows the
              // panel border tier: raised-control (13%) is meant for small
              // controls, and reads too hard along a full-width composer edge.
              className={
                browserComposerCondensed
                  ? `grid grid-cols-[minmax(0,1fr)_auto] items-center overflow-hidden rounded-none border-x-0 border-b-0 border-t border-slate-200/70 bg-slate-50/90 px-3 py-1 ${DARK_RAISED_CONTROL_BG_CLASS} ${DARK_PANEL_BORDER_CLASS}`
                  : browserModeActive || compactBrowserViewport
                  ? `flex flex-col overflow-hidden rounded-none border-x-0 border-b-0 border-t border-slate-200/70 bg-slate-50/90 px-3 pb-0 pt-2 ${DARK_RAISED_CONTROL_BG_CLASS} ${DARK_PANEL_BORDER_CLASS}`
                  : `flex flex-col overflow-hidden rounded-t-3xl rounded-b-none border border-b-0 border-slate-200/70 bg-slate-50/90 px-3 pb-0 pt-2.5 sm:px-4 sm:pt-3 ${DARK_RAISED_CONTROL_BG_CLASS} ${DARK_PANEL_BORDER_CLASS}`
              }
              data-browser-composer-condensed={browserComposerCondensed ? "true" : undefined}
              style={{
                paddingBottom:
                  // The software keyboard covers the home-indicator area on
                  // web mobile browsers too, so the safe-area padding drops
                  // whenever the keyboard is up — not only in native shells.
                  nativeKeyboardOpen
                    ? "0"
                    : browserModeActive || compactBrowserViewport
                      ? "max(var(--instafy-safe-area-inset-bottom), 0.5rem)"
                      : "max(var(--instafy-safe-area-inset-bottom), 0px)",
              }}
            >
              <div
                className={`relative ${browserComposerCondensed ? "pb-0" : "pb-1.5"}`}
                onDragOver={onDragOver}
                onDrop={onDrop}
              >
                <ChatInput
                  ref={chatInputRef}
                  {...chatInputProps}
                  compact={browserComposerCondensed}
                  readOnly={mutationDisabled}
                />
              </div>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={onImageInputChange}
                className="hidden"
                data-testid="chat-image-upload-input"
              />
              {imageAttachments.length > 0 ? (
                <div
                  className={`mb-2 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-2 ${DARK_PANEL_SOFT_BG_CLASS} dark:border-[color:var(--color-studio-dark-raised-control-border)]`}
                  data-testid="chat-image-upload-preview"
                >
                  {imageAttachments.map((attachment, index) => (
                    <div key={attachment.id} className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => onOpenImage(attachment.previewUrl, attachment.file.name)}
                        className={`flex h-12 w-12 flex-none items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm ${DARK_RAISED_CONTROL_CLASS} ${DARK_PANEL_SHADOW_CLASS}`}
                        aria-label={`Preview uploaded image ${index + 1}`}
                        data-testid={`chat-image-upload-preview-item-${index}`}
                      >
                        <img
                          src={attachment.previewUrl}
                          alt={attachment.file.name}
                          className="h-full w-full object-cover"
                        />
                      </button>
                      <div className="min-w-0 flex-1">
                        <Text as="div" variant="caption" tone="secondary" className="truncate text-xs font-medium">
                          {attachment.file.name}
                        </Text>
                        <Text as="div" variant="caption" tone="muted" className="text-xxs">
                          {Math.max(1, Math.round(attachment.file.size / 1024))} KB
                        </Text>
                      </div>
                      <IconButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        radius="full"
                        onPress={() => onRemoveImageAttachment(attachment.id)}
                        aria-label="Remove image"
                        data-testid="chat-image-upload-remove"
                      >
                        <Xmark className="h-4 w-4" aria-hidden="true" />
                      </IconButton>
                    </div>
                  ))}
                </div>
              ) : null}
              {showVoiceStatus ? (
                <div
                  data-testid="chat-voice-input-status"
                  role="status"
                  aria-live="polite"
                  className="sr-only"
                >
                  {voiceStatusMessage}
                </div>
              ) : null}
              {providerTriggerNoticeProps ? <ProviderTriggerNotice {...providerTriggerNoticeProps} /> : null}
              <div
                className={browserComposerCondensed
                  ? "m-0 p-0 pl-2"
                  : `-mx-3 mt-0 px-3 pb-1 pt-1 max-[375px]:pb-0.5 max-[375px]:pt-0.5 sm:-mx-4 sm:px-4 sm:pb-2.5 sm:pt-1.5`
                }
              >
                <div className="space-y-2">
                  {showVoiceActiveStrip ? (
                    <div
                      className="flex min-h-[3.5rem] items-center justify-between gap-3 rounded-2xl border border-slate-200/70 bg-slate-50/90 px-3 py-2 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel-soft)]"
                      data-testid="chat-voice-active-strip"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="relative inline-flex h-9 w-9 flex-none items-center justify-center rounded-full border border-primary-300/70 bg-primary-500/10 text-primary-600 shadow-[0_0_0_10px_rgba(59,130,246,0.08)] dark:border-primary-400/50 dark:bg-primary-400/10 dark:text-primary-200 dark:shadow-[0_0_0_8px_rgba(96,165,250,0.06)]">
                          <span className="absolute inset-0 rounded-full bg-primary-500/20 animate-ping dark:bg-primary-400/20" />
                          <Microphone className="relative h-4.5 w-4.5" aria-hidden="true" />
                        </span>
                        <Text
                          as="div"
                          variant="body"
                          tone="secondary"
                          className="min-w-0 truncate text-sm font-medium text-slate-700 dark:text-slate-200"
                          data-testid="chat-voice-active-strip-status"
                        >
                          {voiceStatusMessage}
                        </Text>
                      </div>
                      <div className="flex flex-none items-center gap-1.5 sm:gap-2">
                        <VoiceConversationActionStrip
                          {...voiceConversationActionStripProps}
                          showVoiceRepliesToggle={false}
                        />
                      </div>
                    </div>
                  ) : (
                    <div
                      className={`flex items-center justify-between gap-1.5 sm:gap-2 ${
                        browserComposerCondensed
                          ? "min-h-10 flex-nowrap"
                          : "min-h-[3.5rem] flex-wrap max-[375px]:min-h-11"
                      }`}
                    >
                      <div className={`flex min-w-0 items-stretch gap-1.5 sm:gap-2 ${browserComposerCondensed ? "flex-nowrap" : "flex-wrap"}`}>
                        {showComposerHomeButton ? (
                          <IconButton
                            type="button"
                            onPress={onOpenHome}
                            variant="outline"
                            size="md"
                            radius="xl"
                            aria-label="Open home"
                            data-testid="chat-home-button-mobile"
                            className={composerOutlinedActionClass}
                          >
                            <span className="relative flex h-full w-full items-center justify-center">
                              <HomeIcon className={composerActionIconClass} aria-hidden="true" />
                              {homeAttentionCount > 0 ? (
                                <span
                                  aria-hidden="true"
                                  data-testid="chat-home-badge-mobile"
                                  className="absolute right-[1px] top-[1px] flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full bg-primary-600 px-1 text-3xs font-semibold leading-none text-white ring-2 ring-white translate-x-[16%] -translate-y-[16%] dark:bg-primary-500 dark:ring-[color:var(--color-studio-dark-panel)]"
                                >
                                  {homeAttentionBadge}
                                </span>
                              ) : null}
                            </span>
                          </IconButton>
                        ) : null}
                        <OctoAgentChip {...octoAgentChipProps} />
                      </div>
                      <div className={`flex flex-none items-stretch justify-end gap-1.5 sm:gap-2 ${browserComposerCondensed ? "flex-nowrap" : "flex-wrap"}`}>
                        <ComposerActionMenu {...composerActionMenuProps} mutationDisabled={mutationDisabled} />
                        <IconButton
                          type="button"
                          onPress={onOpenImagePicker}
                          variant="outline"
                          size="md"
                          radius="xl"
                          aria-label="Upload image"
                          isDisabled={mutationDisabled || sendingAttachment || onboardingInputLocked}
                          data-testid="chat-image-upload-button"
                          className={composerOutlinedActionClass}
                        >
                          <span className="sr-only">Upload image</span>
                          <MediaImage className={composerActionIconClass} aria-hidden="true" />
                        </IconButton>
                        {showMobileGhostSuggestionAcceptButton ? (
                          <IconButton
                            type="button"
                            onPress={onAcceptGhostSuggestion}
                            variant="outline"
                            size="md"
                            radius="xl"
                            aria-label="Insert suggestion"
                            title="Insert suggestion"
                            data-testid="chat-accept-suggestion-button"
                            className={`${composerOutlinedActionClass} text-primary-600 dark:text-primary-300 sm:hidden`}
                          >
                            <span className="sr-only">Insert suggestion</span>
                            <MagicWand className={composerActionIconClass} aria-hidden="true" />
                          </IconButton>
                        ) : null}
                        {showVoicePrimaryAction ? (
                          <VoiceConversationActionStrip {...voiceConversationActionStripProps} />
                        ) : (
                          <IconButton
                            type="button"
                            onPointerDown={onSendButtonPointerDown}
                            onPointerUp={onSendButtonPointerUp}
                            onPointerCancel={onSendButtonPointerCancel}
                            onPressStart={onSendButtonPressStart}
                            onPressEnd={onSendButtonPressEnd}
                            onPress={handleSendPress}
                            onClick={handleSendClick}
                            isDisabled={mutationDisabled || sendButtonDisabled}
                            aria-label="Send message"
                            variant={sendButtonVariant}
                            size="md"
                            radius="xl"
                            className={[
                              composerActionButtonClass,
                              sendButtonVariant === "primary"
                                ? composerPrimaryActionClass
                                : "border-slate-200/70 bg-transparent shadow-none dark:border-[color:var(--color-studio-dark-panel-border)]",
                              sendingAttachment ? "opacity-70" : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            data-testid="chat-send-button"
                          >
                            <span className="sr-only">Send message</span>
                            <Send className={composerActionIconClass} aria-hidden="true" />
                          </IconButton>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </Surface>
          </div>
        </form>
        <ComposerInviteModal {...inviteModalProps} />
      </div>
    </>
  );
}
