import { cloneElement, isValidElement, useState, type ReactNode } from "react";
import { DialogTrigger } from "react-aria-components";
import { ChatLines, Lock, MoreHoriz, NavArrowDown, NavArrowLeft, NavArrowUp, Settings, SidebarExpand } from "iconoir-react";
import { Button, IconButton, type ButtonProps } from "../../../components/Button";
import { EntityRow } from "../../../components/EntityRow";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import type { StudioHistory } from "../../../navigation/useStudioHistory";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";

export interface MobileStudioNavigationHeaderProps {
  history: StudioHistory;
  title: string;
  spaceName: string;
  onOpenPicker: () => void;
  onOpenChats: () => void;
  onOpenSidebar?: () => void;
  sidebarOpen?: boolean;
  onOpenSettings?: () => void;
  onNewChat?: () => void;
  onNewPrivateChat?: () => void;
  parentConversation?: { title: string; onOpen: () => void };
  notificationBell?: ReactNode;
  tabsAction?: ReactNode;
  onMoreOpenChange?: (open: boolean) => void;
}

const TOUCH_TARGET = "!min-h-12 !min-w-12";

/** Touch navigation uses the history owner supplied by Studio, never a second
 * history stack. Secondary actions keep the existing shared popover controls. */
export function MobileStudioNavigationHeader({
  history, title, spaceName, onOpenPicker, onOpenChats,
  onOpenSidebar, sidebarOpen = false, onOpenSettings,
  onNewChat, onNewPrivateChat, parentConversation, notificationBell, tabsAction, onMoreOpenChange,
}: MobileStudioNavigationHeaderProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const changeMoreOpen = (open: boolean) => {
    setMoreOpen(open);
    onMoreOpenChange?.(open);
  };
  useNativeBackButtonAction(moreOpen, () => changeMoreOpen(false));
  const actAndClose = (action: () => void) => {
    changeMoreOpen(false);
    action();
  };
  // Let the supplied bell finish its semantic press before unmounting More.
  // Closing in ancestor click capture interrupts React Aria's touch press.
  const notificationPress = isValidElement<ButtonProps>(notificationBell) ? notificationBell.props.onPress : undefined;
  const mobileNotificationBell = isValidElement<ButtonProps>(notificationBell) && typeof notificationPress === "function"
    ? cloneElement(notificationBell, { onPress: event => {
      notificationPress(event);
      changeMoreOpen(false);
    } })
    : notificationBell;

  return (
    <div className="flex min-w-0 items-center gap-1 px-3 py-1" data-testid="mobile-studio-navigation-header">
      <Button
        variant="ghost"
        size="icon"
        className={`${TOUCH_TARGET} shrink-0 gap-1 px-2`}
        aria-label={history.canGoBack ? "Go back" : "Open chats"}
        data-testid={history.canGoBack ? "mobile-header-back" : "mobile-header-open-chats"}
        onPress={history.canGoBack ? history.goBack : onOpenChats}
      >
        {history.canGoBack ? <NavArrowLeft className="h-5 w-5" aria-hidden="true" /> : <ChatLines className="h-5 w-5" aria-hidden="true" />}
        <span className="text-sm">{history.canGoBack ? "Back" : "Chats"}</span>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={`${TOUCH_TARGET} min-w-0 flex-1 justify-start gap-1 px-2 text-left`}
        aria-label="Switch chat or space"
        aria-haspopup="dialog"
        data-testid="mobile-header-picker"
        onPress={onOpenPicker}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold" data-testid="mobile-header-title">{title}</span>
          <span className="block truncate text-xs font-normal text-slate-500 dark:text-slate-400" data-testid="mobile-header-space">{spaceName}</span>
        </span>
        <NavArrowDown className="h-4 w-4 shrink-0" aria-hidden="true" />
      </Button>
      <DialogTrigger isOpen={moreOpen} onOpenChange={changeMoreOpen}>
        <IconButton
          variant="ghost"
          size="md"
          className={`${TOUCH_TARGET} shrink-0`}
          aria-label="More actions"
          data-testid="mobile-header-more"
        >
          <MoreHoriz className="h-5 w-5" aria-hidden="true" />
        </IconButton>
        <StudioDialogPopover placement="bottom end" offset={4} className="w-72 max-w-[calc(100vw-1.5rem)] p-2" data-testid="mobile-header-actions">
          <div className="flex flex-col gap-1">
            {onNewChat ? <EntityRow title="Public chat" surface="interactive" pressable className={TOUCH_TARGET}
              start={<ChatLines className="h-5 w-5" aria-hidden="true" />} onPress={() => actAndClose(onNewChat)} data-testid="chat-new-chat-public" /> : null}
            {onNewPrivateChat ? <EntityRow title="Private chat" surface="interactive" pressable className={TOUCH_TARGET}
              start={<Lock className="h-5 w-5" aria-hidden="true" />} onPress={() => actAndClose(onNewPrivateChat)} data-testid="chat-new-chat-private" /> : null}
            {parentConversation ? <EntityRow title="Open parent conversation" subtitle={parentConversation.title} surface="interactive" pressable className={TOUCH_TARGET}
              aria-label={`Open parent conversation: ${parentConversation.title}`} start={<NavArrowUp className="h-5 w-5" aria-hidden="true" />}
              onPress={() => actAndClose(parentConversation.onOpen)} data-testid="topbar-parent-conversation-button" /> : null}
            {onOpenSidebar ? <EntityRow title={sidebarOpen ? "Close sidebar" : "Open sidebar"} aria-label="Toggle sidebar" surface="interactive" pressable className={TOUCH_TARGET}
              start={<SidebarExpand className="h-5 w-5" aria-hidden="true" />} onPress={() => actAndClose(onOpenSidebar)} data-testid="topbar-sidebar-toggle" /> : null}
            {onOpenSettings ? <EntityRow title="Space settings" surface="interactive" pressable className={TOUCH_TARGET}
              start={<Settings className="h-5 w-5" aria-hidden="true" />} onPress={() => actAndClose(onOpenSettings)} /> : null}
            {tabsAction}
            {notificationBell ? <div role="group" aria-label="Notifications" className="flex min-h-12 items-center justify-between gap-2 px-3 [&_button]:!min-h-12 [&_button]:!min-w-12">
              <span className="text-sm font-medium">Notifications</span>{mobileNotificationBell}
            </div> : null}
          </div>
        </StudioDialogPopover>
      </DialogTrigger>
    </div>
  );
}
