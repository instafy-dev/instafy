import { useState, type ReactNode } from "react";
import { DialogTrigger } from "react-aria-components";
import { ChatLines, Lock, MoreHoriz, NavArrowRight, NavArrowUp, Settings, SidebarCollapse, SidebarExpand } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { EntityRow } from "../../../components/EntityRow";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import type { StudioHistory } from "../../../navigation/useStudioHistory";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";
import { MobileWorkspaceBackButton } from "./MobileWorkspaceBackButton";

export interface MobileStudioNavigationHeaderProps {
  history: StudioHistory;
  title: string;
  titleIcon?: ReactNode;
  spaceName: string;
  showSpaceName?: boolean;
  onOpenPicker: () => void;
  onOpenChats: () => void;
  sidebarOpen?: boolean;
  onOpenSettings?: () => void;
  onNewChat?: () => void;
  onNewPrivateChat?: () => void;
  parentConversation?: { title: string; onOpen: () => void };
  tabsAction?: ReactNode;
  onMoreOpenChange?: (open: boolean) => void;
}

const TOUCH_TARGET = "!min-h-12 !min-w-12";

/** Compact navigation uses the history owner supplied by Studio, never a second
 * history stack. Secondary actions keep the existing shared popover controls. */
export function MobileStudioNavigationHeader({
  history, title, titleIcon, spaceName, showSpaceName = true, onOpenPicker, onOpenChats,
  sidebarOpen = false, onOpenSettings,
  onNewChat, onNewPrivateChat, parentConversation, tabsAction, onMoreOpenChange,
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

  return (
    <div className="flex min-w-0 items-center gap-1 px-1 py-1" data-testid="mobile-studio-navigation-header">
      <Button
        variant="ghost"
        size="icon"
        className={`${TOUCH_TARGET} shrink-0`}
        aria-label={`${sidebarOpen ? "Close" : "Open"} space navigation: ${spaceName}`}
        aria-haspopup="dialog"
        aria-expanded={sidebarOpen}
        data-testid="mobile-header-picker"
        onPress={onOpenPicker}
      >
        {sidebarOpen
          ? <SidebarCollapse className="h-[18px] w-[18px]" aria-hidden="true" />
          : <SidebarExpand className="h-[18px] w-[18px]" aria-hidden="true" />}
      </Button>
      <MobileWorkspaceBackButton history={history} onOpenChats={onOpenChats} />
      <div className="flex min-w-0 flex-1 items-center gap-2 px-1" data-testid="mobile-header-location">
        {titleIcon ? <span className="shrink-0 text-slate-500 dark:text-slate-400 [&_svg]:h-[18px] [&_svg]:w-[18px]" aria-hidden="true" data-testid="mobile-header-location-icon">{titleIcon}</span> : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold" data-testid="mobile-header-title">{title}</span>
          {showSpaceName ? <span className="block truncate text-xs font-normal text-slate-600 dark:text-slate-400" data-testid="mobile-header-space">{spaceName}</span> : null}
        </span>
      </div>
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
            <EntityRow title="Forward" aria-label="Go forward" surface="interactive" pressable className={TOUCH_TARGET}
              isDisabled={!history.canGoForward} start={<NavArrowRight className="h-5 w-5" aria-hidden="true" />}
              onPress={() => actAndClose(history.goForward)} data-testid="mobile-header-forward" />
            {onNewChat ? <EntityRow title="Public chat" surface="interactive" pressable className={TOUCH_TARGET}
              start={<ChatLines className="h-5 w-5" aria-hidden="true" />} onPress={() => actAndClose(onNewChat)} data-testid="chat-new-chat-public" /> : null}
            {onNewPrivateChat ? <EntityRow title="Private chat" surface="interactive" pressable className={TOUCH_TARGET}
              start={<Lock className="h-5 w-5" aria-hidden="true" />} onPress={() => actAndClose(onNewPrivateChat)} data-testid="chat-new-chat-private" /> : null}
            {parentConversation ? <EntityRow title="Open parent conversation" subtitle={parentConversation.title} surface="interactive" pressable className={TOUCH_TARGET}
              aria-label={`Open parent conversation: ${parentConversation.title}`} start={<NavArrowUp className="h-5 w-5" aria-hidden="true" />}
              onPress={() => actAndClose(parentConversation.onOpen)} data-testid="topbar-parent-conversation-button" /> : null}
            {onOpenSettings ? <EntityRow title="Space settings" surface="interactive" pressable className={TOUCH_TARGET}
              start={<Settings className="h-5 w-5" aria-hidden="true" />} onPress={() => actAndClose(onOpenSettings)} /> : null}
            {tabsAction}

          </div>
        </StudioDialogPopover>
      </DialogTrigger>
    </div>
  );
}
