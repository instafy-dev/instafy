import { useLayoutEffect, useRef, useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { ArrowLeft, NavArrowRight, Xmark } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { StudioDialogBody, StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { StudioMenuAction, StudioMenuSeparator, moveStudioMenuActionFocus } from "../../../components/aria/StudioMenu";
import { StudioModalNativeOcclusion } from "../../../components/aria/studioModalOcclusion";
import { formatPromptContextModeLabel, formatTokenCountLabel, resolveTokenUsageForMessage } from "./chatMessageDetailHelpers";
import { formatSpeakerTimestamp } from "./chatSpeakerTimestamp";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";
import { clampFloatingSurfacePositionToStudioViewport, type FloatingSurfacePlacement } from "../../../utils/floatingSurfacePosition";

type MessageMenuLike = {
  kind: "message" | "conversation";
  messageId: string | null;
  x: number;
  y: number;
  maxHeight: number;
  view: "actions" | "token_usage";
};

type SelectedMessageTokenUsage = ReturnType<typeof resolveTokenUsageForMessage>;

function MessageStats({ usage }: { usage: NonNullable<SelectedMessageTokenUsage> }) {
  const context = usage.context;
  const counts: Array<[string, string | number | null]> = [
    ["Input", formatTokenCountLabel(usage.inputTokens)],
    ["Cached", formatTokenCountLabel(usage.cachedInputTokens)],
    ["Output", formatTokenCountLabel(usage.outputTokens)],
  ];
  const details: Array<[string, string | number | null]> = context ? [
    ["Prompt", context.estimatedPromptTokens === null ? null : formatTokenCountLabel(context.estimatedPromptTokens)],
    ["History", context.estimatedHistoryTokens === null ? null : formatTokenCountLabel(context.estimatedHistoryTokens)],
    ["Window", context.modelContextWindow === null ? null : formatTokenCountLabel(context.modelContextWindow)],
    ["Window used", context.estimatedPromptUsagePercent === null ? null : `${context.estimatedPromptUsagePercent}%`],
    ["Turns", context.totalTurns === null ? context.includedTurns : `${context.includedTurns ?? 0}/${context.totalTurns}`],
    ["Summarized", context.summarizedTurns && context.summarizedTurns > 0 ? context.summarizedTurns : null],
    ["Omitted", context.omittedTurns && context.omittedTurns > 0 ? context.omittedTurns : null],
  ] : [];
  return <div className="space-y-3 px-2.5 py-2">
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2">
      {counts.map(([label, value]) => <div key={label} className="contents">
        <Text as="dt" variant="bodyCompact" tone="muted">{label}</Text>
        <Text as="dd" variant="bodyCompact" tone="primary" className="text-right tabular-nums">{value}</Text>
      </div>)}
    </dl>
    {context ? <>
      <StudioMenuSeparator />
      <Text variant="bodyCompact" tone="primary">{formatPromptContextModeLabel(context)}</Text>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2">
        {details.filter(([, value]) => value !== null).map(([label, value]) => <div key={label} className="contents">
          <Text as="dt" variant="bodyCompact" tone="muted">{label}</Text>
          <Text as="dd" variant="bodyCompact" tone="primary" className="text-right tabular-nums">{value}</Text>
        </div>)}
      </dl>
    </> : null}
  </div>;
}

export function ChatMessageMenuOverlay({
  messageMenu,
  selectedMessageTokenUsage,
  selectedMessageTimestamp = null,
  onClose,
  onShowActionsView,
  onShowTokenUsageView,
  onCopySelectedMessage,
  onCopyConversation,
  onCopyTokenUsage,
  selectedTextAvailable = false,
  onReplyToSelection,
  onSummarizeSelection,
  onExplainSelection,
  onOpenThread,
  openThreadLabel,
}: {
  messageMenu: MessageMenuLike | null;
  selectedMessageTokenUsage: SelectedMessageTokenUsage;
  selectedMessageTimestamp?: number | null;
  onClose: () => void;
  onShowActionsView: () => void;
  onShowTokenUsageView: () => void;
  onCopySelectedMessage: () => void;
  onCopyConversation: () => void;
  onCopyTokenUsage: () => void;
  selectedTextAvailable?: boolean;
  onReplyToSelection?: () => void;
  onSummarizeSelection?: () => void;
  onExplainSelection?: () => void;
  // When the selected message is an agent run, opens its run thread in a workspace tab.
  onOpenThread?: (() => void) | null;
  openThreadLabel?: string;
}) {
  const backRef = useRef<HTMLButtonElement>(null);
  const statsRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const [measuredPosition, setMeasuredPosition] = useState<({ menu: MessageMenuLike } & FloatingSurfacePlacement) | null>(null);
  useLayoutEffect(() => {
    if (!messageMenu || !modalRef.current) return;
    const { width, height } = modalRef.current.getBoundingClientRect();
    if (!width) return;
    // The opener estimates the size. Use the content's full height so menus
    // near the bottom move upward before shrinking their readable scroll area.
    const scroller = scrollRef.current;
    const overflow = scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0;
    const position = clampFloatingSurfacePositionToStudioViewport({
      clientX: messageMenu.x, clientY: messageMenu.y, surfaceWidth: width, surfaceHeight: height + overflow, padding: 12,
    });
    setMeasuredPosition({ menu: messageMenu, ...position });
  }, [messageMenu, selectedMessageTokenUsage]);
  const previousView = useRef(messageMenu?.view);
  useLayoutEffect(() => {
    if (messageMenu?.view === "token_usage") backRef.current?.focus({ preventScroll: true });
    else if (previousView.current === "token_usage" && messageMenu?.view === "actions") {
      const button = statsRef.current;
      const scroller = actionsRef.current;
      button?.focus({ preventScroll: true });
      if (button && scroller) {
        // Reveal the restored action inside its menu without moving the chat underneath.
        const row = button.getBoundingClientRect();
        const bounds = scroller.getBoundingClientRect();
        if (row.bottom > bounds.bottom) scroller.scrollTop += row.bottom - bounds.bottom;
        else if (row.top < bounds.top) scroller.scrollTop += row.top - bounds.top;
      }
    }
    previousView.current = messageMenu?.view;
  }, [messageMenu?.view]);
  const back = () => {
    if (messageMenu?.view === "token_usage") onShowActionsView();
    else onClose();
  };
  useNativeBackButtonAction(Boolean(messageMenu), back);
  if (!messageMenu) return null;
  const position = measuredPosition?.menu === messageMenu ? measuredPosition : messageMenu;
  const sentTime = messageMenu.kind === "message" ? formatSpeakerTimestamp(selectedMessageTimestamp) : null;

  return <ModalOverlay isOpen isDismissable onOpenChange={(open) => { if (!open) onClose(); }}
    className="fixed inset-0 z-[80]" onContextMenu={(event) => event.preventDefault()}>
    <Modal ref={modalRef} className="w-64 outline-none"
      style={{ position: "fixed", left: position.x,
        top: position.y, maxHeight: position.maxHeight,
        maxWidth: "calc(100vw - var(--instafy-safe-area-inset-left, 0px) - var(--instafy-safe-area-inset-right, 0px) - 24px)" }}>
      <Surface tone="floating" radius="2xl" shadow="none" className="flex max-h-[inherit] min-h-0 flex-col overflow-hidden p-2"
          onKeyDownCapture={(event) => {
            if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            back();
          }}>
        <Dialog aria-label={messageMenu.view === "token_usage" ? "Message stats" : messageMenu.kind === "message" ? "Message actions" : "Conversation actions"}
          className="flex min-h-0 flex-col outline-none">
          <StudioModalNativeOcclusion enabled />
          {messageMenu.view === "token_usage" ? <>
            <div className="flex shrink-0 items-center gap-2 pb-1">
              <IconButton ref={backRef} variant="ghost" tone="neutral" aria-label="Back to message actions" title="Back" onPress={onShowActionsView}>
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              </IconButton>
              <Text as="h2" variant="bodyStrong" tone="primary">Message stats</Text>
            </div>
            <div ref={scrollRef} className="studio-scrollbar min-h-0 overflow-y-auto overscroll-contain">
              {selectedMessageTokenUsage ? <MessageStats usage={selectedMessageTokenUsage} />
                : <Text variant="bodyCompact" tone="muted" className="px-2.5 py-2">No message stats are available.</Text>}
            </div>
            {selectedMessageTokenUsage ? <div className="shrink-0 pt-1">
              <StudioMenuAction onPress={() => void onCopyTokenUsage()}><MenuItemContent>Copy stats</MenuItemContent></StudioMenuAction>
            </div> : null}
          </> : <div ref={(node) => { actionsRef.current = node; scrollRef.current = node; }} className="studio-scrollbar min-h-0 overflow-y-auto overscroll-contain" onKeyDown={moveStudioMenuActionFocus}>
            {sentTime ? <Text variant="caption" tone="muted" className="px-2.5 py-2" data-testid="chat-message-sent-time">
              Sent <time dateTime={sentTime.dateTime}>{sentTime.title}</time>
            </Text> : null}
            {messageMenu.kind === "message" && selectedTextAvailable ? <>
              <StudioMenuAction onPress={() => void onReplyToSelection?.()}><MenuItemContent>Reply to selection</MenuItemContent></StudioMenuAction>
              <StudioMenuAction onPress={() => void onSummarizeSelection?.()}><MenuItemContent>Summarize selection</MenuItemContent></StudioMenuAction>
              <StudioMenuAction onPress={() => void onExplainSelection?.()}><MenuItemContent>Explain more</MenuItemContent></StudioMenuAction>
              <StudioMenuSeparator />
            </> : null}
            {messageMenu.kind === "message" && onOpenThread ? <StudioMenuAction onPress={() => { onOpenThread(); onClose(); }}>
              <MenuItemContent>{openThreadLabel ?? "Open thread"}</MenuItemContent>
            </StudioMenuAction> : null}
            {messageMenu.kind === "message" ? <StudioMenuAction onPress={() => void onCopySelectedMessage()}>
              <MenuItemContent>Copy message</MenuItemContent>
            </StudioMenuAction> : null}
            <StudioMenuAction onPress={() => void onCopyConversation()}><MenuItemContent>Copy conversation</MenuItemContent></StudioMenuAction>
            {messageMenu.kind === "message" && selectedMessageTokenUsage ? <StudioMenuAction ref={statsRef} onPress={onShowTokenUsageView}>
              <MenuItemContent end={<NavArrowRight aria-hidden="true" />}>Message stats…</MenuItemContent>
            </StudioMenuAction> : null}
          </div>}
        </Dialog>
      </Surface>
    </Modal>
  </ModalOverlay>;
}

type ImageLightboxLike = {
  src: string;
  alt: string;
};

export function ChatImageLightboxOverlay({
  imageLightbox,
  onClose,
}: {
  imageLightbox: ImageLightboxLike | null;
  onClose: () => void;
}) {
  if (!imageLightbox) {
    return null;
  }

  return (
    <StudioDialogModal
      isOpen
      isDismissable
      onOpenChange={(open) => { if (!open) onClose(); }}
      size="media"
      layout="editor"
      gutter="responsive"
      dialogAriaLabel="Image preview"
      data-testid="chat-image-lightbox"
    >
      <StudioDialogHeader title={imageLightbox.alt || "Image preview"} trailing={
        <IconButton
          type="button"
          variant="ghost"
          tone="muted"
          size="sm"
          onPress={onClose}
          aria-label="Close image preview"
          data-testid="chat-image-lightbox-close"
        >
          <Xmark className="h-4 w-4" aria-hidden="true" />
        </IconButton>
      } />
      <StudioDialogBody scrollable>
        <img
          src={imageLightbox.src}
          alt={imageLightbox.alt}
          className="mx-auto block max-h-[70dvh] max-w-full object-contain"
          data-testid="chat-image-lightbox-image"
        />
      </StudioDialogBody>
    </StudioDialogModal>
  );
}

export { ChatInvitePromptOverlay } from "./ChatInvitePromptOverlay";
