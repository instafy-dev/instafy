import { useId, useState, type ReactNode } from "react";
import { DialogTrigger, Heading } from "react-aria-components";
import { NavArrowDown, NavArrowRight } from "iconoir-react";
import { Button } from "../../../components/Button";
import { EntityRow } from "../../../components/EntityRow";
import { SearchInput } from "../../../components/SearchInput";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";
import { OpenChatList, type OpenChatListOptions } from "./OpenChatList";

export type MobileConversationSwitcherOptions = OpenChatListOptions & {
  onSwitchSpace?: () => void;
};

/** Uses the desktop open-chat references; it does not own another tab/history store. */
export function MobileConversationSwitcher({
  title, contextCaption, spaceName, tabs, activeId, onSelect, onBrowseChats, onSwitchSpace,
}: MobileConversationSwitcherOptions & { title: string; contextCaption: ReactNode; spaceName: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchId = useId();
  const changeOpen = (value: boolean) => {
    setQuery("");
    setOpen(value);
  };
  useNativeBackButtonAction(open, () => changeOpen(false));
  const showSearch = tabs.length > 6;
  const normalizedQuery = showSearch ? query.trim().toLocaleLowerCase() : "";
  const visibleTabs = tabs.filter(tab => !normalizedQuery ||
    tab.title.toLocaleLowerCase().includes(normalizedQuery) || tab.spaceName.toLocaleLowerCase().includes(normalizedQuery));

  return (
    <DialogTrigger isOpen={open} onOpenChange={changeOpen}>
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
      <StudioDialogPopover placement="bottom start" offset={4} className="w-96 max-w-[calc(100vw-1.5rem)] p-2" data-testid="mobile-chat-switcher">
        <Heading slot="title" className="sr-only">Switch chat</Heading>
        {showSearch ? <div className="mb-2 px-1">
          <SearchInput id={searchId} label="Filter open chats" placeholder="Filter open chats"
            inputTestId="mobile-chat-switcher-search" value={query} onChange={event => setQuery(event.target.value)} />
        </div> : null}
        <OpenChatList tabs={visibleTabs} activeId={activeId} spaceName={spaceName} testIdPrefix="mobile-chat-switcher"
          emptyMessage={normalizedQuery ? "No open chats match your search." : undefined}
          onSelect={id => { changeOpen(false); if (id !== activeId) onSelect(id); }}
          onBrowseChats={onBrowseChats ? () => { changeOpen(false); onBrowseChats(); } : undefined} />
        {onSwitchSpace ? <div className={onBrowseChats ? "mt-1" : "mt-2 border-t border-slate-200/70 pt-2 dark:border-white/10"}>
          <EntityRow title="Switch space" surface="interactive" pressable
            className="!min-h-12" end={<NavArrowRight className="h-4 w-4" aria-hidden="true" />}
            data-testid="mobile-chat-switcher-spaces" onPress={() => { changeOpen(false); onSwitchSpace(); }} />
        </div> : null}
      </StudioDialogPopover>
    </DialogTrigger>
  );
}
