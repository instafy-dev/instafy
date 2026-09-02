import type {
  ChangeEventHandler,
  ComponentProps,
  DragEventHandler,
  FormEventHandler,
  KeyboardEventHandler,
  RefObject,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archery,
  Bookmark,
  Lock,
  MediaImage,
  Microphone,
  NavArrowDown,
  Pause,
  Play,
  Send,
  TaskList,
  WarningTriangle,
  Xmark,
} from "iconoir-react";
import { HomeIcon } from "../../../components/AppIcons";
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
  showComposerHomeButton: boolean;
  onOpenHome: () => void;
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
  // One dress for the rest row: "+", image, mic and Send are all ghost
  // IconButtons at rest wearing composerGhostActionClass; a control that is
  // lit (Send with a payload, the mic while capturing) wears
  // composerPrimaryActionClass.
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

// One dress for the rest row: the composer card is the only surface. At rest,
// Send is exactly what its siblings ("+", image, mic) are — a ghost IconButton
// of the same size and radius with no fill, border or shadow of its own — so
// the row reads as four of the same control. The only thing that says "not
// yet" is the glyph: this class is the ghost family (composerGhostActionClass)
// with a muted tone, and like the family it colours the svg alone. With a
// payload the button flips to the primary dress (composerPrimaryActionClass,
// wired through sendButtonVariant) and the muting comes off; that colour
// change is the only motion the composer has. Exported so the geometry tests
// can name the exact delta they allow.
export const COMPOSER_SEND_REST_CLASS = "[&_svg]:text-slate-400 dark:[&_svg]:text-slate-500";

// The editor wrapper in the one-row composer is exactly as tall as the row's
// controls (IconButton md: h-9 on a fine pointer, min-h-11 on a coarse one —
// the same tokens chatInputGrowth.ts sizes the editor by) and centres the
// editor inside it, so a single line sits on the control centres. It used
// to be min-h-11 on every pointer: 44px centred in a 36px row put the text
// 4px above the icons on desktop.
export const COMPOSER_EDITOR_WRAPPER_CLASS = `flex ${CHAT_INPUT_CONTROL_HEIGHT_CLASS} min-w-0 flex-1 flex-col justify-center`;

// The Browser-session condensed bar is a separate idle layout (see
// renderSendButton) and keeps the rest dress it had before the one-row
// composer went ghost.
const COMPOSER_CONDENSED_SEND_REST_CLASS = `h-11 w-11 rounded-[1.25rem] border-slate-200/70 bg-transparent shadow-none ${DARK_PANEL_BORDER_CLASS}`;

export function ChatComposerSurface({
  browserDockProps,
  composerOverlayRef,
  composerAutoHidden,
  browserModeActive = false,
  compactBrowserViewport,
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
  showComposerHomeButton,
  onOpenHome,
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
    visibleDesktopSendModifierMode === "queue"
      ? "Queue message (Command or Ctrl plus Enter)"
      : visibleDesktopSendModifierMode === "stash"
        ? "Stash draft (Command or Ctrl plus Shift plus Enter)"
        : primaryActionMode === "steer"
          ? "Steer current reply (Enter)"
          : "Send message";
  const primaryActionStatus =
    visibleDesktopSendModifierMode === "queue"
      ? "Queue selected. Press Enter or click to queue the message."
      : visibleDesktopSendModifierMode === "stash"
        ? "Stash selected. Press Enter or click to stash the draft."
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
  // The composer is one row on every viewport. The controls sit beside the
  // editor and never move, re-dress or re-mount as the draft changes; the
  // editor alone grows with the text (line by line, capped per viewport in
  // chatInputGrowth.ts, then scrolling). The only other layouts are the
  // Browser-session condensed idle bar and the active voice strip.
  const composerInlineControlsInTextRow = !browserComposerCondensed && !showVoiceActiveStrip;
  // The breakpoint is decided in JS (compactBrowserViewport, from
  // useBreakpoint("sm") upstream) rather than a Tailwind `sm:` class so the
  // row and the "+" menu fold share one source of truth. Below sm the
  // image-upload control is not rendered inline; it folds into the "+" menu.
  // The insert-suggestion wand lives in the "+" menu on every viewport (Tab
  // accepts the inline ghost suggestion from the keyboard) so no action is
  // lost and no control appears or disappears while typing.
  const foldImageUploadIntoMenu = compactBrowserViewport && !browserComposerCondensed;
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
    primaryDisabled: mutationDisabled || sendButtonDisabled,
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
      if (sendButtonDisabled) {
        return;
      }
      onSendButtonPress?.({ pointerType: "mouse" } as never);
    },
    [
      onQueueMessageFromComposer,
      onSendButtonPress,
      onStashDraftFromComposer,
      resolveAvailableDesktopSendModifierMode,
      sendButtonDisabled,
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
      mutationDisabled={mutationDisabled}
      onUploadImage={foldImageUploadIntoMenu ? onOpenImagePicker : undefined}
      uploadImageDisabled={imageUploadDisabled}
      onInsertSuggestion={foldSuggestionIntoMenu ? onAcceptGhostSuggestion : undefined}
      triggerClassName={composerGhostActionClass}
      triggerIconClassName={composerActionIconClass}
    />
  );
  const imageUploadButtonNode = (
    <IconButton
      type="button"
      onPress={onOpenImagePicker}
      variant="ghost"
      size="md"
      radius="xl"
      aria-label="Upload image"
      isDisabled={imageUploadDisabled}
      data-testid="chat-image-upload-button"
      className={composerGhostActionClass}
    >
      <span className="sr-only">Upload image</span>
      <MediaImage className={composerActionIconClass} aria-hidden="true" />
    </IconButton>
  );
  const homeButtonNode = showComposerHomeButton ? (
      <IconButton
        type="button"
        onPress={onOpenHome}
        variant="ghost"
        size="md"
        radius="xl"
        aria-label="Open home"
        data-testid="chat-home-button-mobile"
        className={composerGhostActionClass}
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
    ) : null;
  // The mic is present whenever voice capture is supported (the view state
  // always raises one of the two flags then), and it is the same control with
  // the same test id and the same siblings whether or not there is a draft.
  // It used to switch to a "secondary" test id and drop the replies toggle
  // once a draft existed; nothing about the row may change with the text.
  const voiceInputAvailable = showVoicePrimaryAction || showVoiceSecondaryAction;
  // The mic wears the same two dresses as Send: ghost at rest, primary while
  // it is the active control.
  const voiceStripDressProps = {
    primaryActionClassName: composerPrimaryActionClass,
    ghostActionClassName: composerGhostActionClass,
    actionIconClassName: composerActionIconClass,
  };
  const voiceStripNode = voiceInputAvailable ? (
    <VoiceConversationActionStrip {...voiceConversationActionStripProps} {...voiceStripDressProps} />
  ) : null;
  // Send is always mounted in the one-row composer and lights up in place.
  // `quiet` names that row, which never adds or removes a control as the
  // draft changes. On voice-capable clients (web speech — Chromium) the mic
  // used to stand in for Send while the draft was empty, so the first
  // keystroke mounted Send beside it and the trailing group widened by one
  // button: exactly the "something changes when I type" this composer exists
  // to remove. The Browser-session condensed bar (non-quiet) keeps its
  // mic-only rest; it is a separate idle layout that keeps its earlier dress
  // and re-expands on a draft. In the one-row composer Send at rest is the
  // same ghost IconButton as "+", image and mic with a muted glyph; the glyph
  // fades with the button when the dress flips to primary.
  const sendIconClass = `${composerActionIconClass} transition-colors duration-150 ease-out`;
  const renderSendButton = ({ quiet }: { quiet: boolean }) =>
    quiet || !showVoicePrimaryAction ? (
      <>
        <span
          role="status"
          aria-atomic="true"
          aria-live="polite"
          className="sr-only"
          data-testid="chat-primary-action-status"
        >
          {primaryActionStatus}
        </span>
        <IconButton
          type="button"
          {...touchSendModePicker.triggerProps}
          onPress={handleSendPress}
          onClick={handleSendClick}
          isDisabled={
            mutationDisabled ||
            (visibleDesktopSendModifierMode === null && sendButtonDisabled)
          }
          aria-label={primaryActionLabel}
          title={primaryActionLabel}
          style={{ touchAction: "none" }}
          variant={sendButtonVariant === "primary" ? "primary" : quiet ? "ghost" : "outline"}
          size="md"
          radius="xl"
          className={[
            sendButtonVariant === "primary"
              ? composerPrimaryActionClass
              : quiet
                ? COMPOSER_SEND_REST_CLASS
                : COMPOSER_CONDENSED_SEND_REST_CLASS,
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
      </>
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
              radius="2xl"
              shadow="none"
              // The composer keeps the raised-control background but borrows the
              // panel border tier: raised-control (13%) is meant for small
              // controls, and reads too hard along a full-width composer edge.
              className={
                browserComposerCondensed
                  ? `grid grid-cols-[minmax(0,1fr)_auto] items-center overflow-hidden rounded-none border-x-0 border-b-0 border-t border-slate-200/70 bg-slate-50/90 px-3 py-1 ${DARK_RAISED_CONTROL_BG_CLASS} ${DARK_PANEL_BORDER_CLASS}`
                  : browserModeActive || compactBrowserViewport
                  ? `flex flex-col overflow-hidden rounded-none border-x-0 border-b-0 border-t border-slate-200/70 bg-slate-50/90 px-3 pb-0 pt-1.5 ${DARK_RAISED_CONTROL_BG_CLASS} ${DARK_PANEL_BORDER_CLASS}`
                  : `flex flex-col overflow-hidden rounded-t-3xl rounded-b-none border border-b-0 border-slate-200/70 bg-slate-50/90 px-3 pb-0 pt-1.5 sm:px-4 ${DARK_RAISED_CONTROL_BG_CLASS} ${DARK_PANEL_BORDER_CLASS}`
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
              {/*
                The text row is one flex row: leading controls, the editor,
                trailing controls — bottom-aligned (items-end) so the controls
                stay pinned to the row's bottom edge while the editor grows
                line by line. Nothing here depends on whether there is text:
                inputs (things that put content into the message: home when
                applicable, "+", image at sm+) sit on the left, commit actions
                (the mic when voice is supported, and Send, always mounted and
                lighting up in place) sit on the right. The editor wrapper keeps
                the same tree position in every mode so Lexical never remounts.

                Alignment with the text ("Ask for something…"): the four
                glyphs share one size and stroke (composerActionIconClass);
                the editor wrapper is as tall as the controls and centres the
                editor, whose own padding keeps the last line centred as it
                grows (COMPOSER_EDITOR_WRAPPER_CLASS, chatInputGrowth.ts); and
                the row's own gap is 4px — the text starts 4px after the last
                leading box and ends 4px before the first trailing one — while
                the groups keep the button rhythm (gap-1.5 sm:gap-2). With the
                glyphs inset 7px in their boxes, 4px reads as glyph-to-text
                11px against a glyph-to-glyph 25px; the previous 8px read as
                15px and pushed the text away from the image icon.
              */}
              <div
                className={
                  browserComposerCondensed
                    ? "relative pb-0"
                    : `relative flex items-end gap-1 ${
                        composerInlineControlsInTextRow &&
                        !(browserModeActive || compactBrowserViewport)
                          ? "pb-1.5"
                          : "pb-0"
                      }`
                }
                data-testid="chat-composer-text-row"
                onDragOver={onDragOver}
                onDrop={onDrop}
              >
                {composerInlineControlsInTextRow ? (
                  <div
                    className="flex flex-none items-center gap-1.5 sm:gap-2"
                    data-testid="chat-composer-leading-controls"
                  >
                    {homeButtonNode}
                    {actionMenuNode}
                    {compactBrowserViewport ? null : imageUploadButtonNode}
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
                    className="flex flex-none items-center justify-end gap-1.5 sm:gap-2"
                    data-testid="chat-composer-trailing-controls"
                  >
                    {voiceStripNode}
                    {renderSendButton({ quiet: true })}
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
              {browserComposerCondensed ? (
                <div className="m-0 p-0 pl-2">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-1.5 sm:gap-2 min-h-10 flex-nowrap">
                      <div className="flex min-w-0 items-stretch gap-1.5 sm:gap-2 flex-nowrap">
                        {homeButtonNode}
                      </div>
                      <div className="flex flex-none items-stretch justify-end gap-1.5 sm:gap-2 flex-nowrap">
                        {actionMenuNode}
                        {imageUploadButtonNode}
                        {voiceStripNode}
                        {renderSendButton({ quiet: false })}
                      </div>
                    </div>
                  </div>
                </div>
              ) : showVoiceActiveStrip ? (
                <div className="-mx-3 mt-0 px-3 pb-1 pt-1 max-[375px]:pb-0.5 max-[375px]:pt-0.5 sm:-mx-4 sm:px-4 sm:pb-2.5 sm:pt-1.5">
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
                          {voiceStatusMessage}
                        </Text>
                      </div>
                      <div className="flex flex-none items-center gap-1.5 sm:gap-2">
                        <VoiceConversationActionStrip
                          {...voiceConversationActionStripProps}
                          {...voiceStripDressProps}
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
