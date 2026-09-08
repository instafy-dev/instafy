import type {
  ChangeEventHandler,
  ComponentProps,
  DragEventHandler,
  FormEventHandler,
  KeyboardEventHandler,
  RefObject,
} from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";
import {
  Archery,
  Bookmark,
  Lock,
  Menu,
  Microphone,
  NavArrowDown,
  Pause,
  Play,
  Send,
  TaskList,
  WarningTriangle,
  Xmark,
} from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import { StudioPopover } from "../../../components/aria/StudioPopover";
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
import { CHAT_INPUT_CONTROL_HEIGHT_CLASS } from "./chat-input/chatInputGrowth";
import {
  resolveComposerSendModifierAction,
  type ComposerSendModifierKeys,
} from "./chat-input/enterBehavior";
import {
  CHAT_SEND_QUEUE_ITEMS_ID,
  ChatSendQueuePanel,
  ChatSendQueueSurface,
  ChatSendQueueTrigger,
} from "./ChatSendQueueSurface";
import {
  CHAT_MESSAGE_STASH_PANEL_ID,
  ChatMessageStashPanel,
  ChatMessageStashTray,
  ChatMessageStashTrigger,
} from "./ChatMessageStashTray";
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
import { useTouchSendModePicker } from "./useTouchSendModePicker";
import type { TouchSendModePickerOutcome } from "./touchSendModePicker";

type ChatComposerSurfaceProps = {
  browserDockProps: ComponentProps<typeof ChatBrowserDock>;
  composerOverlayRef: RefObject<HTMLDivElement | null>;
  composerAutoHidden: boolean;
  browserModeActive?: boolean;
  compactBrowserViewport: boolean;
  touchLikeInput?: boolean;
  onSubmit: FormEventHandler<HTMLFormElement>;
  queueSurfaceProps: ComponentProps<typeof ChatSendQueueSurface>;
  stashTrayProps?: ComponentProps<typeof ChatMessageStashTray> | null;
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
  showComposerNavigationButton: boolean;
  onOpenNavigation: () => void;
  homeAttentionCount: number;
  homeAttentionBadge: string;
  // The surface dresses the "+" trigger and the mic itself (see the class
  // props below) — the box from the ghost family and the glyph from the one
  // icon class — so every rest-row control resolves to the one dress here.
  composerActionMenuProps: Omit<
    ComponentProps<typeof ComposerActionMenu>,
    "triggerClassName" | "triggerIconClassName"
  >;
  onOpenImagePicker: () => void;
  sendingAttachment: boolean;
  showMobileGhostSuggestionAcceptButton: boolean;
  onAcceptGhostSuggestion: () => void;
  showVoicePrimaryAction: boolean;
  showVoiceSecondaryAction: boolean;
  voiceConversationActionStripProps: Omit<
    ComponentProps<typeof VoiceConversationActionStrip>,
    "primaryActionClassName" | "ghostActionClassName" | "actionIconClassName"
  >;
  sendButtonDisabled: boolean;
  sendButtonVariant: ComponentProps<typeof IconButton>["variant"];
  primaryActionMode?: "send" | "steer";
  onSendButtonPress: ComponentProps<typeof IconButton>["onPress"];
  // Shared control geometry keeps the primary slot steady as mic becomes Send.
  composerGhostActionClass: string;
  composerPrimaryActionClass: string;
  composerActionIconClass: string;
  inviteModalProps: ComponentProps<typeof ComposerInviteModal>;
  mutationDisabled?: boolean;
  accessNotice?: string | null;
  accessChecking?: boolean;
  silenceHintProps?: ComponentProps<typeof OctoSilenceHint> | null;
};

// The access check is a pending state, not a warning: neutral, quiet, with the
// product's standard working shimmer instead of an amber slab. If it runs long
// the copy escalates honestly rather than spinning forever.
function AccessCheckingNotice({ flash }: { flash: boolean }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(timer);
  }, []);
  const text = slow
    ? "Still checking your access. The workspace may be slow to respond."
    : "Checking your access…";
  return (
    <div
      className={`mx-2 rounded-lg px-1.5 py-1 text-xs text-slate-500 transition-shadow dark:text-slate-400 ${
        flash ? "ring-2 ring-slate-400/50 dark:ring-slate-500/50" : ""
      }`}
      data-testid="project-access-checking-notice"
      role="status"
      aria-live="polite"
    >
      <span className="instafy-status-sweep" data-sweep-text={text}>
        {text}
      </span>
    </div>
  );
}

type OpenSavedMessagePanel = "stash" | "queue" | null;
type DesktopSendModifierMode = "queue" | "stash" | null;

function composerMenuIsOpen(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return false;
  }
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid="assistant-mention-menu"], [data-testid="chat-slash-command-menu"]',
    ),
  ).some((menu) => {
    const style = window.getComputedStyle(menu);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

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

// Clients without voice capture retain a quiet Send affordance at rest.
export const COMPOSER_SEND_REST_CLASS = "[&_svg]:text-slate-400 dark:[&_svg]:text-slate-500";

// The editor wrapper in the one-row composer is exactly as tall as the row's
// controls (IconButton md: h-9 on a fine pointer, min-h-11 on a coarse one —
// the same tokens chatInputGrowth.ts sizes the editor by) and centres the
// editor inside it, so a single line sits on the control centres. It used
// to be min-h-11 on every pointer: 44px centred in a 36px row put the text
// 4px above the icons on desktop.
export const COMPOSER_EDITOR_WRAPPER_CLASS = `flex ${CHAT_INPUT_CONTROL_HEIGHT_CLASS} min-w-0 flex-1 flex-col justify-center`;

export function ChatComposerSurface({
  browserDockProps,
  composerOverlayRef,
  composerAutoHidden,
  browserModeActive = false,
  compactBrowserViewport,
  touchLikeInput = false,
  onSubmit,
  queueSurfaceProps,
  stashTrayProps = null,
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
  showComposerNavigationButton,
  onOpenNavigation,
  homeAttentionCount,
  homeAttentionBadge,
  composerActionMenuProps,
  onOpenImagePicker,
  sendingAttachment,
  showMobileGhostSuggestionAcceptButton,
  onAcceptGhostSuggestion,
  showVoicePrimaryAction,
  showVoiceSecondaryAction,
  voiceConversationActionStripProps,
  sendButtonDisabled,
  sendButtonVariant,
  primaryActionMode = "send",
  onSendButtonPress,
  composerGhostActionClass,
  composerPrimaryActionClass,
  composerActionIconClass,
  inviteModalProps,
  mutationDisabled = false,
  accessNotice = null,
  accessChecking = false,
  silenceHintProps = null,
}: ChatComposerSurfaceProps) {
  // A read-only composer swallows keystrokes at the Lexical layer; flash the
  // visible notice instead so a blocked attempt never feels like dead input.
  const [blockedInputFlash, setBlockedInputFlash] = useState(false);
  const blockedInputFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleReadOnlyKeyDown = useCallback(() => {
    setBlockedInputFlash(true);
    if (blockedInputFlashTimerRef.current !== null) {
      clearTimeout(blockedInputFlashTimerRef.current);
    }
    blockedInputFlashTimerRef.current = setTimeout(() => setBlockedInputFlash(false), 650);
  }, []);
  useEffect(
    () => () => {
      if (blockedInputFlashTimerRef.current !== null) {
        clearTimeout(blockedInputFlashTimerRef.current);
      }
    },
    [],
  );
  const queueExpandedFromParent = Boolean(queueSurfaceProps.chatSendQueueExpanded);
  const queueEditingItem = queueSurfaceProps.editingQueuedItem;
  const queuedMessageCount = queueSurfaceProps.totalQueuedCount;
  const onToggleQueueExpanded = queueSurfaceProps.onToggleExpanded;
  const {
    onQueueMessage: onQueueMessageFromComposer,
    onStashDraft: onStashDraftFromComposer,
    queueDisabled: queueMessageDisabled,
    stashDisabled: stashDraftDisabled,
  } = composerActionMenuProps;
  const showVoiceSecondaryStatus = showVoicePrimaryAction && showVoiceStatus;
  const composerHasUsablePayload =
    chatInputProps.value.trim().length > 0 || imageAttachments.length > 0;
  const imageOnlyDraft = imageAttachments.length > 0 && chatInputProps.value.trim().length === 0;
  const imageMessageHintId = useId();
  const primarySendDisabled = sendButtonDisabled || imageOnlyDraft;
  const voiceInputAvailable = showVoicePrimaryAction || showVoiceSecondaryAction;
  const voiceCaptureInProgress =
    voiceConversationActionStripProps.voiceActionActive ||
    voiceConversationActionStripProps.voiceListening ||
    voiceConversationActionStripProps.voiceStarting ||
    voiceConversationActionStripProps.voiceTranscribing;
  const [menuDictationActive, setMenuDictationActive] = useState(false);
  const menuDictationDraftKeyRef = useRef(chatInputProps.draftKey);
  const menuDictationObservedCaptureRef = useRef(false);
  const voiceInteractionMode = voiceConversationActionStripProps.voiceInteractionMode ?? "hold";
  const menuDictationCapturing =
    menuDictationActive &&
    voiceInteractionMode === "hold" &&
    menuDictationDraftKeyRef.current === chatInputProps.draftKey &&
    voiceCaptureInProgress;
  useEffect(() => {
    setMenuDictationActive(false);
    menuDictationObservedCaptureRef.current = false;
  }, [chatInputProps.draftKey]);
  useEffect(() => {
    if (!menuDictationActive) return;
    if (voiceCaptureInProgress) {
      menuDictationObservedCaptureRef.current = true;
    } else if (menuDictationObservedCaptureRef.current) {
      setMenuDictationActive(false);
      menuDictationObservedCaptureRef.current = false;
    }
  }, [menuDictationActive, voiceCaptureInProgress]);
  const handleMenuDictationStart = () => {
    menuDictationDraftKeyRef.current = chatInputProps.draftKey;
    menuDictationObservedCaptureRef.current = false;
    setMenuDictationActive(voiceInteractionMode === "hold");
    void voiceConversationActionStripProps.onVoiceTap?.();
  };
  const handleDirectVoicePressStart = () => {
    // An unsuccessful menu start must not change a later hold gesture.
    setMenuDictationActive(false);
    menuDictationObservedCaptureRef.current = false;
    return voiceConversationActionStripProps.onVoicePressStart();
  };
  const effectiveVoiceInteractionMode = menuDictationCapturing
    ? "tap"
    : voiceConversationActionStripProps.voiceInteractionMode;
  const displayedVoiceStatusMessage = menuDictationCapturing
    ? voiceConversationActionStripProps.voiceStarting && !voiceConversationActionStripProps.voiceListening
      ? "Starting dictation. Tap the microphone to stop."
      : voiceConversationActionStripProps.voiceTranscribing
        ? "Transcribing dictation…"
        : voiceStatusMessage.startsWith("Recording. Heard:")
          ? `${voiceStatusMessage.replace("Recording.", "Dictating.")} Tap the microphone to stop.`
          : "Dictating. Tap the microphone to stop."
    : voiceStatusMessage;
  // Keep the microphone through the entire capture lifecycle, even when a
  // partial transcript becomes a draft. In particular, a hold must not lose
  // its pointer-owning DOM node before release.
  const showInlineVoiceAction =
    voiceInputAvailable && (!composerHasUsablePayload || voiceCaptureInProgress);
  const modifierPreviewBaseAvailable =
    !showVoicePrimaryAction &&
    composerHasUsablePayload &&
    !mutationDisabled;
  const queueModifierAvailable =
    modifierPreviewBaseAvailable &&
    queueMessageDisabled !== true &&
    Boolean(onQueueMessageFromComposer);
  const stashModifierAvailable =
    modifierPreviewBaseAvailable &&
    stashDraftDisabled !== true &&
    Boolean(onStashDraftFromComposer);
  const resolveAvailableDesktopSendModifierMode = useCallback(
    (keys: ComposerSendModifierKeys): DesktopSendModifierMode => {
      const requestedMode = resolveComposerSendModifierAction(keys);
      if (requestedMode === "queue") {
        return queueModifierAvailable ? "queue" : null;
      }
      if (requestedMode === "stash") {
        return stashModifierAvailable ? "stash" : null;
      }
      return null;
    },
    [queueModifierAvailable, stashModifierAvailable],
  );
  const [desktopSendModifierMode, setDesktopSendModifierMode] =
    useState<DesktopSendModifierMode>(null);
  const [desktopSendModifierFocusWithin, setDesktopSendModifierFocusWithin] = useState(false);
  const visibleDesktopSendModifierMode =
    desktopSendModifierFocusWithin &&
    desktopSendModifierMode === "queue" &&
    queueModifierAvailable
      ? "queue"
      : desktopSendModifierFocusWithin &&
          desktopSendModifierMode === "stash" &&
          stashModifierAvailable
        ? "stash"
        : null;
  const visiblePrimaryActionMode = visibleDesktopSendModifierMode ?? primaryActionMode;
  const primaryActionLabel =
    imageOnlyDraft
      ? "Add a message to send images"
      : visibleDesktopSendModifierMode === "queue"
      ? "Queue message (Command or Ctrl plus Enter)"
      : visibleDesktopSendModifierMode === "stash"
        ? "Stash draft (Command or Ctrl plus Shift plus Enter)"
        : primaryActionMode === "steer"
          ? touchLikeInput ? "Steer current reply" : "Steer current reply (Enter)"
          : "Send message";
  const primaryActionStatus =
    imageOnlyDraft
      ? "Add a message to send with your images."
      : visibleDesktopSendModifierMode === "queue"
      ? "Queue selected. Press Enter or click to queue the message."
      : visibleDesktopSendModifierMode === "stash"
        ? "Stash selected. Press Enter or click to stash the draft."
        : touchLikeInput
          ? "Enter adds a line. Use the send button to send or steer."
          : primaryActionMode === "steer"
          ? "Enter steers the current reply."
          : "Enter sends the message.";
  // Hold-to-talk must keep the same microphone DOM node from press through
  // release. The richer active strip is reserved for tap/continuous modes;
  // hold mode communicates activity on the stable button itself.
  const showVoiceActiveStrip =
    showVoicePrimaryAction &&
    showVoiceSecondaryStatus &&
    voiceConversationActionStripProps.voiceInteractionMode !== "hold";
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
  const [openSavedMessagePanel, setOpenSavedMessagePanel] = useState<OpenSavedMessagePanel>(
    queueExpandedFromParent ? "queue" : null,
  );
  const [queueDragActive, setQueueDragActive] = useState(false);
  const stashTrayTriggerRef = useRef<HTMLButtonElement | null>(null);
  const queueTriggerRef = useRef<HTMLButtonElement | null>(null);
  const savedMessageDialogRef = useRef<HTMLDivElement | null>(null);
  const savedMessagePopoverContentRef = useRef<HTMLDivElement | null>(null);
  const savedMessagePopoverHadFocusRef = useRef(false);
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
    !queueSurfaceProps.editingQueuedItem &&
    !stashTrayProps?.stashes.length;
  // Keep Lexical in the same tree position while its primary action changes.
  // The editor grows line by line, capped per viewport in chatInputGrowth.ts.
  const composerInlineControlsInTextRow = !browserComposerCondensed && !showVoiceActiveStrip;
  const foldSuggestionIntoMenu = showMobileGhostSuggestionAcceptButton;
  const imageUploadDisabled = mutationDisabled || sendingAttachment || onboardingInputLocked;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const sendModifierFocusIsWithin = (element: Element | null) => {
      const composer = composerOverlayRef.current;
      if (!composer || !element || !composer.contains(element)) {
        return false;
      }
      return Boolean(
        element.closest('[data-testid="chat-input"], [data-testid="chat-send-button"]'),
      );
    };
    const updatePreview = (event: KeyboardEvent) => {
      const focusWithin = sendModifierFocusIsWithin(document.activeElement);
      setDesktopSendModifierFocusWithin(focusWithin);
      setDesktopSendModifierMode(
        focusWithin && !composerMenuIsOpen()
          ? resolveAvailableDesktopSendModifierMode(event)
          : null,
      );
    };
    const clearPreview = () => {
      setDesktopSendModifierFocusWithin(false);
      setDesktopSendModifierMode(null);
    };
    const handleFocusIn = (event: FocusEvent) => {
      setDesktopSendModifierFocusWithin(sendModifierFocusIsWithin(event.target as Element | null));
    };
    const handleFocusOut = (event: FocusEvent) => {
      if (!sendModifierFocusIsWithin(event.relatedTarget as Element | null)) {
        clearPreview();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        clearPreview();
      }
    };
    // Lexical may consume editor keyboard events during bubbling. Observe the
    // modifiers in capture so the button preview still reflects the physical
    // keys the user is holding.
    window.addEventListener("keydown", updatePreview, true);
    window.addEventListener("keyup", updatePreview, true);
    window.addEventListener("blur", clearPreview);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("keydown", updatePreview, true);
      window.removeEventListener("keyup", updatePreview, true);
      window.removeEventListener("blur", clearPreview);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [composerOverlayRef, resolveAvailableDesktopSendModifierMode]);

  useEffect(() => {
    setGoalDetailsExpanded(false);
  }, [activeGoal?.id]);

  useEffect(() => {
    setGoalDetailsExpanded(false);
  }, [goalDetailsCollapseToken]);

  useEffect(() => {
    if (queueEditingItem) {
      setOpenSavedMessagePanel(null);
      return;
    }
    if (queueExpandedFromParent) {
      setOpenSavedMessagePanel("queue");
      return;
    }
    setOpenSavedMessagePanel((current) => (current === "queue" ? null : current));
  }, [queueEditingItem, queueExpandedFromParent]);

  useEffect(() => {
    if (openSavedMessagePanel === "stash" && !stashTrayProps?.stashes.length) {
      const shouldFocusComposer =
        savedMessagePopoverHadFocusRef.current ||
        (typeof document !== "undefined" &&
          savedMessagePopoverContentRef.current?.contains(document.activeElement));
      savedMessagePopoverHadFocusRef.current = false;
      setOpenSavedMessagePanel(null);
      if (shouldFocusComposer && typeof window !== "undefined") {
        window.setTimeout(() => chatInputRef.current?.focus(), 0);
      }
    }
  }, [chatInputRef, openSavedMessagePanel, stashTrayProps?.stashes.length]);

  useEffect(() => {
    if (openSavedMessagePanel !== "queue" || queuedMessageCount > 0) {
      return;
    }
    const shouldFocusComposer =
      savedMessagePopoverHadFocusRef.current ||
      (typeof document !== "undefined" &&
        savedMessagePopoverContentRef.current?.contains(document.activeElement));
    savedMessagePopoverHadFocusRef.current = false;
    setOpenSavedMessagePanel(null);
    if (queueExpandedFromParent) {
      onToggleQueueExpanded?.();
    }
    if (shouldFocusComposer && typeof window !== "undefined") {
      window.setTimeout(() => chatInputRef.current?.focus(), 0);
    }
  }, [
    chatInputRef,
    onToggleQueueExpanded,
    openSavedMessagePanel,
    queuedMessageCount,
    queueExpandedFromParent,
  ]);

  const setExternalQueueExpanded = useCallback(
    (nextExpanded: boolean) => {
      if (queueExpandedFromParent !== nextExpanded) {
        onToggleQueueExpanded?.();
      }
    },
    [onToggleQueueExpanded, queueExpandedFromParent],
  );

  const handleStashTrayExpandedChange = useCallback(
    (nextExpanded: boolean) => {
      if (nextExpanded) {
        setExternalQueueExpanded(false);
        setOpenSavedMessagePanel("stash");
        return;
      }
      setOpenSavedMessagePanel((current) => (current === "stash" ? null : current));
    },
    [setExternalQueueExpanded],
  );

  const handleQueuePanelToggle = useCallback(() => {
    const nextExpanded = openSavedMessagePanel !== "queue";
    setExternalQueueExpanded(nextExpanded);
    setOpenSavedMessagePanel(nextExpanded ? "queue" : null);
  }, [openSavedMessagePanel, setExternalQueueExpanded]);

  const handleSavedMessagePopoverOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen || openSavedMessagePanel === null) {
        return;
      }
      if (openSavedMessagePanel === "queue") {
        setExternalQueueExpanded(false);
      }
      setOpenSavedMessagePanel(null);
    },
    [openSavedMessagePanel, setExternalQueueExpanded],
  );

  const handleSavedMessagePopoverKeyDown = useCallback<KeyboardEventHandler<HTMLDivElement>>(
    (event) => {
      if (
        event.key !== "Escape" ||
        openSavedMessagePanel === null ||
        queueDragActive
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const trigger =
        openSavedMessagePanel === "stash"
          ? stashTrayTriggerRef.current
          : queueTriggerRef.current;
      handleSavedMessagePopoverOpenChange(false);
      if (typeof window !== "undefined") {
        window.setTimeout(() => trigger?.focus(), 0);
      }
    },
    [handleSavedMessagePopoverOpenChange, openSavedMessagePanel, queueDragActive],
  );

  const handleEditQueuedMessageFromPopover = useCallback(
    (id: string) => {
      setExternalQueueExpanded(false);
      setOpenSavedMessagePanel(null);
      queueSurfaceProps.onEditQueuedMessage(id);
    },
    [queueSurfaceProps, setExternalQueueExpanded],
  );

  useNativeBackButtonAction(openSavedMessagePanel !== null && !queueEditingItem, () => {
    // Use the same path as Escape, including cancelling an active keyboard
    // reorder before dismissing the queue, and restoring its trigger focus.
    const content = savedMessagePopoverContentRef.current;
    const focused = document.activeElement;
    const target = content?.contains(focused) ? focused : content;
    target?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  });

  const savedMessagePopoverTriggerRef =
    openSavedMessagePanel === "stash" ? stashTrayTriggerRef : queueTriggerRef;

  useEffect(() => {
    if (openSavedMessagePanel === null || typeof document === "undefined") {
      return;
    }
    const ownerDocument =
      savedMessagePopoverTriggerRef.current?.ownerDocument ?? document;
    const handlePointerDown = (event: PointerEvent) => {
      if (queueDragActive) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (
        stashTrayTriggerRef.current?.contains(target) ||
        queueTriggerRef.current?.contains(target) ||
        savedMessagePopoverContentRef.current?.contains(target)
      ) {
        return;
      }
      handleSavedMessagePopoverOpenChange(false);
    };
    ownerDocument.addEventListener("pointerdown", handlePointerDown, true);
    return () => ownerDocument.removeEventListener("pointerdown", handlePointerDown, true);
  }, [
    handleSavedMessagePopoverOpenChange,
    openSavedMessagePanel,
    queueDragActive,
    savedMessagePopoverTriggerRef,
  ]);

  useEffect(() => {
    if (openSavedMessagePanel === null || typeof window === "undefined") {
      return;
    }
    const focusTimer = window.setTimeout(() => {
      const firstAction = savedMessagePopoverContentRef.current?.querySelector<HTMLElement>(
        '[data-testid="chat-send-queue-reorder"]:not([disabled]), [data-testid="chat-send-queue-send-now"]:not([disabled]), [data-testid="chat-send-queue-steer"]:not([disabled]), [data-testid="chat-message-stash-restore"]:not([disabled]), button:not([disabled])',
      );
      (firstAction ?? savedMessageDialogRef.current)?.focus();
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [openSavedMessagePanel]);

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

  const handleTouchSendModeOutcome = useCallback(
    (outcome: TouchSendModePickerOutcome) => {
      if (outcome.type === "none" || outcome.type === "tap") {
        return;
      }
      // The pointer-up and its synthetic click share one browser task. Reuse
      // the normal one-task duplicate guard so this hold consumes only that
      // activation, never a legitimate follow-up tap.
      markSendPressHandled();
      if (outcome.type !== "commit") {
        return;
      }
      if (outcome.mode === "queue") {
        onQueueMessageFromComposer?.();
        return;
      }
      if (outcome.mode === "stash") {
        onStashDraftFromComposer?.();
        return;
      }
      onSendButtonPress?.({ pointerType: "touch" } as never);
    },
    [
      markSendPressHandled,
      onQueueMessageFromComposer,
      onSendButtonPress,
      onStashDraftFromComposer,
    ],
  );

  const touchSendModePicker = useTouchSendModePicker({
    primaryMode: primaryActionMode,
    primaryDisabled: mutationDisabled || primarySendDisabled,
    queueDisabled:
      mutationDisabled ||
      queueMessageDisabled === true ||
      !onQueueMessageFromComposer,
    stashDisabled:
      mutationDisabled ||
      stashDraftDisabled === true ||
      !onStashDraftFromComposer,
    onOutcome: handleTouchSendModeOutcome,
  });

  const handleSendPress = useCallback<NonNullable<ComponentProps<typeof IconButton>["onPress"]>>(
    (event) => {
      if (sendPressHandledRef.current) {
        return;
      }
      markSendPressHandled();
      if (event.pointerType !== "touch") {
        const eventModifierMode = resolveAvailableDesktopSendModifierMode(event);
        const modifierMode =
          eventModifierMode === visibleDesktopSendModifierMode
            ? visibleDesktopSendModifierMode
            : null;
        if (modifierMode === "queue") {
          onQueueMessageFromComposer?.();
          return;
        }
        if (modifierMode === "stash") {
          onStashDraftFromComposer?.();
          return;
        }
      }
      onSendButtonPress?.(event);
    },
    [
      markSendPressHandled,
      onQueueMessageFromComposer,
      onSendButtonPress,
      onStashDraftFromComposer,
      resolveAvailableDesktopSendModifierMode,
      visibleDesktopSendModifierMode,
    ],
  );

  const handleSendClick = useCallback<NonNullable<ComponentProps<typeof IconButton>["onClick"]>>(
    (event) => {
      if (sendPressHandledRef.current) {
        return;
      }
      event.preventDefault();
      const eventModifierMode = resolveAvailableDesktopSendModifierMode(event);
      const modifierMode =
        eventModifierMode === visibleDesktopSendModifierMode
          ? visibleDesktopSendModifierMode
          : null;
      if (modifierMode === "queue") {
        onQueueMessageFromComposer?.();
        return;
      }
      if (modifierMode === "stash") {
        onStashDraftFromComposer?.();
        return;
      }
      if (primarySendDisabled) {
        return;
      }
      onSendButtonPress?.({ pointerType: "mouse" } as never);
    },
    [
      onQueueMessageFromComposer,
      onSendButtonPress,
      onStashDraftFromComposer,
      resolveAvailableDesktopSendModifierMode,
      primarySendDisabled,
      visibleDesktopSendModifierMode,
    ],
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

  // Each control is rendered once, with one dress, wherever the row puts it.
  const actionMenuNode = (
    <ComposerActionMenu
      {...composerActionMenuProps}
      touchLikeInput={touchLikeInput}
      mutationDisabled={mutationDisabled}
      onUploadImage={onOpenImagePicker}
      uploadImageDisabled={imageUploadDisabled}
      onInsertSuggestion={foldSuggestionIntoMenu ? onAcceptGhostSuggestion : undefined}
      onStartVoiceInput={
        voiceInputAvailable && !showInlineVoiceAction && voiceConversationActionStripProps.onVoiceTap
          ? handleMenuDictationStart
          : undefined
      }
      voiceInputDisabled={
        voiceConversationActionStripProps.disabled || onboardingInputLocked || accessChecking
      }
      onToggleVoiceReplies={
        voiceConversationActionStripProps.showVoiceRepliesToggle
          ? voiceConversationActionStripProps.onToggleVoiceReplies
          : undefined
      }
      voiceRepliesEnabled={voiceConversationActionStripProps.voiceRepliesEnabled}
      voiceRepliesDisabled={voiceConversationActionStripProps.disabled}
      triggerClassName={composerGhostActionClass}
      triggerIconClassName={composerActionIconClass}
    />
  );
  const navigationButtonNode = showComposerNavigationButton ? (
    <IconButton
      type="button"
      onPress={onOpenNavigation}
      variant="ghost"
      size="md"
      radius="xl"
      aria-label="Open navigation and recent chats"
      aria-haspopup="dialog"
      data-testid="chat-composer-navigation-button"
      className={composerGhostActionClass}
    >
      <span className="relative flex h-full w-full items-center justify-center">
        <Menu className={composerActionIconClass} aria-hidden="true" />
        {homeAttentionCount > 0 ? (
          <span
            aria-hidden="true"
            data-testid="chat-composer-navigation-badge"
            className="absolute right-[1px] top-[1px] flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full bg-primary-600 px-1 text-3xs font-semibold leading-none text-white ring-2 ring-white translate-x-[16%] -translate-y-[16%] dark:bg-primary-500 dark:ring-[color:var(--color-studio-dark-panel)]"
          >
            {homeAttentionBadge}
          </span>
        ) : null}
      </span>
    </IconButton>
  ) : null;
  // The mic wears the same two dresses as Send: ghost at rest, primary while
  // it is the active control.
  const voiceStripDressProps = {
    primaryActionClassName: composerPrimaryActionClass,
    ghostActionClassName: composerGhostActionClass,
    actionIconClassName: composerActionIconClass,
  };
  const voiceStripNode = showInlineVoiceAction ? (
    <VoiceConversationActionStrip
      {...voiceConversationActionStripProps}
      {...voiceStripDressProps}
      voiceInteractionMode={effectiveVoiceInteractionMode}
      onVoicePressStart={handleDirectVoicePressStart}
      showVoiceRepliesToggle={false}
    />
  ) : null;
  // Mic and Send share one trailing slot; image upload and dictating into an
  // existing draft remain available in the + menu.
  const sendIconClass = `${composerActionIconClass} transition-colors duration-150 ease-out`;
  const renderSendButton = () =>
    !showInlineVoiceAction ? (
        <IconButton
          type="button"
          {...touchSendModePicker.triggerProps}
          onPress={handleSendPress}
          onClick={handleSendClick}
          isDisabled={
            mutationDisabled ||
            (visibleDesktopSendModifierMode === null && primarySendDisabled)
          }
          aria-label={primaryActionLabel}
          aria-describedby={imageOnlyDraft ? imageMessageHintId : undefined}
          title={primaryActionLabel}
          style={{ touchAction: "none" }}
          variant={sendButtonVariant === "primary" ? "primary" : "ghost"}
          size="md"
          radius="xl"
          className={[
            sendButtonVariant === "primary"
              ? composerPrimaryActionClass
              : COMPOSER_SEND_REST_CLASS,
            sendingAttachment ? "opacity-70" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          data-testid="chat-send-button"
          data-send-mode={visiblePrimaryActionMode}
          data-send-rest={sendButtonVariant === "primary" ? "false" : "true"}
          data-send-modifier-preview={
            visibleDesktopSendModifierMode ?? undefined
          }
          data-send-options-open={touchSendModePicker.isOpen ? "true" : "false"}
        >
          <span className="sr-only">{primaryActionLabel}</span>
          {visibleDesktopSendModifierMode === "queue" ? (
            <TaskList
              className={sendIconClass}
              aria-hidden="true"
              data-testid="chat-queue-action-icon"
            />
          ) : visibleDesktopSendModifierMode === "stash" ? (
            <Bookmark
              className={sendIconClass}
              aria-hidden="true"
              data-testid="chat-stash-action-icon"
            />
          ) : (
            <Send
              className={sendIconClass}
              aria-hidden="true"
              data-testid="chat-send-action-icon"
            />
          )}
        </IconButton>
    ) : null;

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
              ? "pointer-events-auto px-2"
              : `pointer-events-auto ${CHAT_COMPOSER_COLUMN_CLASS_NAME} px-3 sm:px-4`
          }
          style={{
            paddingBottom: nativeKeyboardOpen
              ? "0.5rem"
              : "max(var(--instafy-safe-area-inset-bottom), 0.5rem)",
          }}
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
                className={`mx-1 flex items-center gap-2 rounded-xl border border-secondary-300/70 bg-secondary-50/90 px-3 py-2 text-xs font-medium text-secondary-900 shadow-sm transition-shadow dark:border-secondary-400/30 dark:bg-secondary-400/10 dark:text-secondary-100 sm:mx-2 ${
                  blockedInputFlash ? "ring-2 ring-secondary-400/70 dark:ring-secondary-300/50" : ""
                }`}
                data-testid="project-read-only-notice"
                role="status"
              >
                <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{accessNotice}</span>
              </div>
            ) : accessChecking ? (
              <AccessCheckingNotice flash={blockedInputFlash} />
            ) : null}
            {silenceHintProps ? <OctoSilenceHint {...silenceHintProps} /> : null}
            {stashTrayProps?.stashes.length || queuedMessageCount > 0 || queueEditingItem ? (
              <div
                role="group"
                aria-label="Saved messages"
                className="mx-1 flex flex-wrap items-start justify-end gap-2 sm:mx-2"
                data-testid="chat-saved-message-controls"
              >
                {stashTrayProps && !queueEditingItem ? (
                  <div className="contents" data-testid="chat-message-stashes">
                    <ChatMessageStashTrigger
                      count={stashTrayProps.stashes.length}
                      expanded={openSavedMessagePanel === "stash"}
                      onExpandedChange={handleStashTrayExpandedChange}
                      triggerRef={stashTrayTriggerRef}
                    />
                  </div>
                ) : null}
                {queuedMessageCount > 0 && !queueEditingItem ? (
                  <div className="contents" data-testid="chat-send-queue">
                    <ChatSendQueueTrigger
                      totalQueuedCount={queuedMessageCount}
                      collapsedQueuedMessageSummary={queueSurfaceProps.collapsedQueuedMessageSummary}
                      expanded={openSavedMessagePanel === "queue"}
                      onToggleExpanded={handleQueuePanelToggle}
                      triggerRef={queueTriggerRef}
                    />
                  </div>
                ) : null}
                {openSavedMessagePanel !== "stash" && stashTrayProps?.stashes.length && !queueEditingItem ? (
                  <span id={CHAT_MESSAGE_STASH_PANEL_ID} hidden />
                ) : null}
                {queueEditingItem ? (
                  <div
                    className="contents"
                    data-testid="chat-send-queue"
                  >
                    <ChatSendQueuePanel
                      {...queueSurfaceProps}
                      chatSendQueueExpanded={false}
                      mutationDisabled={mutationDisabled}
                      onToggleExpanded={handleQueuePanelToggle}
                      triggerRef={queueTriggerRef}
                    />
                  </div>
                ) : queuedMessageCount > 0 && openSavedMessagePanel !== "queue" ? (
                  <span id={CHAT_SEND_QUEUE_ITEMS_ID} hidden />
                ) : null}
                {openSavedMessagePanel !== null && !queueEditingItem ? (
                  <StudioPopover
                    key={openSavedMessagePanel}
                    triggerRef={savedMessagePopoverTriggerRef}
                    isOpen
                    onOpenChange={handleSavedMessagePopoverOpenChange}
                    isNonModal
                    isKeyboardDismissDisabled={queueDragActive}
                    placement="top end"
                    offset={8}
                    containerPadding={8}
                    className="max-h-[calc(100dvh-1rem)] w-[min(24rem,calc(100dvw-1rem))] overflow-hidden p-0 [&>div:first-child]:hidden"
                    data-testid="chat-saved-message-popover"
                  >
                    <div
                      ref={savedMessageDialogRef}
                      role="dialog"
                      aria-label={
                        openSavedMessagePanel === "stash" ? "Stashed drafts" : "Queued messages"
                      }
                      tabIndex={-1}
                      className="outline-none"
                      onFocusCapture={() => {
                        savedMessagePopoverHadFocusRef.current = true;
                      }}
                    >
                      <div
                        ref={savedMessagePopoverContentRef}
                        onKeyDown={handleSavedMessagePopoverKeyDown}
                      >
                        {openSavedMessagePanel === "stash" && stashTrayProps ? (
                          <ChatMessageStashPanel
                            stashes={stashTrayProps.stashes}
                            restoredStashId={stashTrayProps.restoredStashId}
                            busy={stashTrayProps.busy}
                            onRestore={(stash) => {
                              stashTrayProps.onRestore(stash);
                              handleStashTrayExpandedChange(false);
                            }}
                            onDelete={stashTrayProps.onDelete}
                          />
                        ) : (
                          <ChatSendQueuePanel
                            {...queueSurfaceProps}
                            chatSendQueueExpanded
                            mutationDisabled={mutationDisabled}
                            reorderDisabled={
                              mutationDisabled || queueSurfaceProps.reorderDisabled
                            }
                            onDraggingChange={setQueueDragActive}
                            onToggleExpanded={handleQueuePanelToggle}
                            onEditQueuedMessage={handleEditQueuedMessageFromPopover}
                            triggerRef={queueTriggerRef}
                          />
                        )}
                      </div>
                    </div>
                  </StudioPopover>
                ) : null}
              </div>
            ) : null}
            <Surface
              tone="default"
              radius="3xl"
              shadow="none"
              // The composer keeps the raised-control background but borrows the
              // panel border tier: raised-control (13%) is meant for small
              // controls, and reads too hard along a full-width composer edge.
              className={
                browserComposerCondensed
                  ? `grid grid-cols-[minmax(0,1fr)_auto] items-center overflow-hidden border-slate-200/70 bg-slate-50 p-1.5 ${DARK_RAISED_CONTROL_BG_CLASS} ${DARK_PANEL_BORDER_CLASS}`
                  : `flex flex-col overflow-hidden border-slate-200/70 bg-slate-50 p-1.5 ${DARK_RAISED_CONTROL_BG_CLASS} ${DARK_PANEL_BORDER_CLASS}`
              }
              data-testid="chat-composer-surface"
              data-browser-composer-condensed={browserComposerCondensed ? "true" : undefined}
            >
              <span
                role="status"
                aria-atomic="true"
                aria-live="polite"
                className="sr-only"
                data-testid="chat-primary-action-status"
              >
                {showInlineVoiceAction
                  ? voiceCaptureInProgress
                    ? ""
                    : "Voice input is available. Type a message to send."
                  : primaryActionStatus}
              </span>
              {/* The editor stays mounted while the primary slot switches from
                  mic to Send. Controls stay bottom-aligned as the text grows. */}
              <div
                className={
                  browserComposerCondensed
                    ? "relative pb-0"
                    : "relative flex items-end gap-2"
                }
                data-testid="chat-composer-text-row"
                onDragOver={onDragOver}
                onDrop={onDrop}
              >
                {composerInlineControlsInTextRow ? (
                  <div
                    className="flex flex-none items-center gap-0.5"
                    data-testid="chat-composer-leading-controls"
                  >
                    {navigationButtonNode}
                    {actionMenuNode}
                  </div>
                ) : null}
                <div
                  className={
                    composerInlineControlsInTextRow
                      ? COMPOSER_EDITOR_WRAPPER_CLASS
                      : "min-w-0 flex-1"
                  }
                >
                  <ChatInput
                    ref={chatInputRef}
                    {...chatInputProps}
                    compact={browserComposerCondensed}
                    compactViewport={compactBrowserViewport}
                    readOnly={mutationDisabled || accessChecking}
                    onReadOnlyKeyDown={handleReadOnlyKeyDown}
                  />
                </div>
                {composerInlineControlsInTextRow ? (
                  <div
                    className="flex flex-none items-center justify-end gap-0.5"
                    data-testid="chat-composer-trailing-controls"
                  >
                    {voiceStripNode}
                    {renderSendButton()}
                  </div>
                ) : null}
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
                  {imageOnlyDraft ? (
                    <p id={imageMessageHintId} className="px-1 text-xs text-slate-600 dark:text-slate-300" data-testid="chat-image-message-required">
                      Add a message to send with your images.
                    </p>
                  ) : null}
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
                  {displayedVoiceStatusMessage}
                </div>
              ) : null}
              {providerTriggerNoticeProps ? <ProviderTriggerNotice {...providerTriggerNoticeProps} /> : null}
              {browserComposerCondensed ? (
                <div className="m-0 p-0 pl-2">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-1.5 sm:gap-2 min-h-10 flex-nowrap">
                      <div className="flex min-w-0 items-stretch gap-1.5 sm:gap-2 flex-nowrap">
                        {navigationButtonNode}
                      </div>
                      <div className="flex flex-none items-stretch justify-end gap-1.5 sm:gap-2 flex-nowrap">
                        {actionMenuNode}
                        {voiceStripNode}
                        {renderSendButton()}
                      </div>
                    </div>
                  </div>
                </div>
              ) : showVoiceActiveStrip ? (
                <div className="pt-1.5">
                  <div className="space-y-2">
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
                          {displayedVoiceStatusMessage}
                        </Text>
                      </div>
                      <div className="flex flex-none items-center gap-1.5 sm:gap-2">
                        <VoiceConversationActionStrip
                          {...voiceConversationActionStripProps}
                          {...voiceStripDressProps}
                          voiceInteractionMode={effectiveVoiceInteractionMode}
                          onVoicePressStart={handleDirectVoicePressStart}
                          showVoiceRepliesToggle={false}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </Surface>
          </div>
        </form>
        <ComposerInviteModal {...inviteModalProps} />
        {touchSendModePicker.overlay}
      </div>
    </>
  );
}
