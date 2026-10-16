import { ChatBubble, Check, NavArrowRight } from "iconoir-react";
import { EntityRow } from "../../../components/EntityRow";

export interface OpenChatListOptions {
  tabs: { id: string; title: string; spaceName: string; badge?: string | null }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onBrowseChats?: () => void;
}

/** Shared by the title picker and thumb-reachable sheet, using the same open tabs. */
export function OpenChatList({
  tabs, activeId, onSelect, onBrowseChats, spaceName, testIdPrefix, emptyMessage = "No open chats yet.",
}: OpenChatListOptions & { spaceName: string; testIdPrefix: string; emptyMessage?: string }) {
  const showSpaces = tabs.some(tab => tab.spaceName !== spaceName);
  return <>
    {tabs.length ? <ul className="flex flex-col gap-1" aria-label="Open chats">
      {tabs.map(tab => <li key={tab.id}>
        <EntityRow title={tab.title} subtitle={showSpaces ? tab.spaceName : undefined}
          start={<ChatBubble className="h-5 w-5" aria-hidden="true" />}
          end={<span className="flex items-center gap-2">
            {tab.badge ? <span className="text-xs" aria-label={`${tab.badge} unread messages`}>{tab.badge}</span> : null}
            {tab.id === activeId ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
          </span>}
          surface={tab.id === activeId ? "selected" : "interactive"} pressable
          aria-label={[tab.title, showSpaces ? tab.spaceName : null, tab.id === activeId ? "Current" : null,
            tab.badge ? `${tab.badge} unread messages` : null].filter(Boolean).join(", ")}
          aria-current={tab.id === activeId ? "page" : undefined}
          titleClassName="!whitespace-normal line-clamp-2 [overflow-wrap:anywhere]"
          className="!min-h-12" data-testid={`${testIdPrefix}-tab-${tab.id}`}
          onPress={() => onSelect(tab.id)} />
      </li>)}
    </ul> : <p className="px-3 py-3 text-sm text-slate-500 dark:text-slate-400">{emptyMessage}</p>}
    {onBrowseChats ? <div className="mt-2 border-t border-slate-200/70 pt-2 dark:border-white/10">
      <EntityRow title="All chats in this space" subtitle={`In ${spaceName}`} surface="interactive" pressable
        aria-label={`All chats in this space, ${spaceName}`}
        className="!min-h-12" end={<NavArrowRight className="h-4 w-4" aria-hidden="true" />}
        data-testid={`${testIdPrefix}-browse`} onPress={onBrowseChats} />
    </div> : null}
  </>;
}
