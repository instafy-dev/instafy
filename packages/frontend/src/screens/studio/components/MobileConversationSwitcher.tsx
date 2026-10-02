import { useState, type ReactNode } from "react";
import { DialogTrigger, Heading } from "react-aria-components";
import { NavArrowDown } from "iconoir-react";
import { Button } from "../../../components/Button";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";
import { OpenChatList, type OpenChatListOptions } from "./OpenChatList";

export type MobileConversationSwitcherOptions = OpenChatListOptions;

/** Uses the desktop open-chat references; it does not own another tab/history store. */
export function MobileConversationSwitcher({
  title, contextCaption, spaceName, tabs, activeId, onSelect, onBrowseChats,
}: MobileConversationSwitcherOptions & { title: string; contextCaption: ReactNode; spaceName: string }) {
  const [open, setOpen] = useState(false);
  useNativeBackButtonAction(open, () => setOpen(false));

  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <h1 className="min-w-0 flex-1">
        <Button variant="ghost" className="!min-h-12 !min-w-12 w-full justify-start gap-2 px-1 text-left"
          aria-label={`Switch chats: ${title}`} aria-haspopup="dialog" data-testid="mobile-chat-switcher-trigger">
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
              <span className="truncate" data-testid="mobile-header-title">{title}</span>
              <NavArrowDown className="h-3.5 w-3.5 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
            </span>
            {contextCaption}
          </span>
        </Button>
      </h1>
      <StudioDialogPopover placement="bottom start" offset={4} className="w-80 max-w-[calc(100vw-1.5rem)] p-2" data-testid="mobile-chat-switcher">
        <Heading slot="title" className="px-3 py-2 text-xs font-medium text-slate-500 dark:text-slate-400">Chats</Heading>
        <OpenChatList tabs={tabs} activeId={activeId} spaceName={spaceName} testIdPrefix="mobile-chat-switcher"
          onSelect={id => { setOpen(false); if (id !== activeId) onSelect(id); }}
          onBrowseChats={onBrowseChats ? () => { setOpen(false); onBrowseChats(); } : undefined} />
      </StudioDialogPopover>
    </DialogTrigger>
  );
}
