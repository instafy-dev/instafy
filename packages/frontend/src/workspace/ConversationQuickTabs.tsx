import { useLayoutEffect, useRef } from "react";
import { ChatBubble, NavArrowLeft, NavArrowRight, Pin, Plus } from "iconoir-react";
import { IconButton } from "../components/Button";
import { HorizontalTabStrip } from "../components/tabs/HorizontalTabStrip";
import { TabCloseButton, TAB_FOCUS_CLASS } from "../components/tabs/TabPresentation";
export type ConversationQuickTab = {
  id: string;
  title: string;
  preview?: boolean;
  dirty?: boolean;
  badge?: string | null;
  spaceName?: string;
  projectId?: string;
};
import "./ConversationQuickTabs.css";

/** Open chats are shortcuts; the Chats explorer remains the full directory. */
export function ConversationQuickTabs({ tabs, activeId, scopeName, onSelect, onClose, onKeep, newChat }: {
  tabs: ConversationQuickTab[];
  activeId: string | null;
  scopeName: string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onKeep: (tabId: string) => void;
  newChat?: { spaceName: string; onCreate: () => void };
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const restoreFocus = useRef(false);
  const multipleSpaces = new Set(tabs.map(tab => tab.projectId).filter(Boolean)).size > 1;
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    (buttons.current.get(activeId ?? "") ?? buttons.current.values().next().value)?.focus();
  }, [activeId, tabs.length]);
  return <nav aria-label={`Open chats in ${scopeName}`} className="conversation-quick-tabs min-w-0 flex-1" data-testid="conversation-quick-tabs">
    <HorizontalTabStrip activeItemId={activeId ?? null} className="min-w-0" contentClassName="conversation-quick-tab-content flex w-max items-end gap-1" testId="conversation-quick-tab-strip"
      overflowActions={newChat ? <IconButton variant="ghost" size="sm" radius="full"
        className="mb-1 h-9 w-9 shrink-0 text-slate-600 dark:text-slate-300"
        aria-label={`New chat in ${newChat.spaceName}`} title={`New chat in ${newChat.spaceName}`}
        data-testid="conversation-quick-tabs-new-chat" onPress={newChat.onCreate}>
        <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
      </IconButton> : null}
      renderScrollControl={({ direction, canScroll, scrollByDirection }) => <IconButton variant="ghost" size="sm" radius="none" className="h-11 w-8"
        aria-label={direction === -1 ? "Scroll chats left" : "Scroll chats right"} isDisabled={!canScroll} onPress={() => scrollByDirection(direction)}>
        {direction === -1 ? <NavArrowLeft className="h-4 w-4" /> : <NavArrowRight className="h-4 w-4" />}
      </IconButton>}>
      {tabs.map((tab, index) => <div key={tab.id} data-tab-id={tab.id} data-active={tab.id === activeId}
        className="conversation-quick-tab">
        <button type="button" ref={node => { if (node) buttons.current.set(tab.id, node); else buttons.current.delete(tab.id); }}
          aria-current={tab.id === activeId ? "page" : undefined}
          aria-label={`${tab.title}${tab.spaceName ? ` · ${tab.spaceName}` : ""}`}
          title={`${tab.title}${tab.spaceName ? ` · ${tab.spaceName}` : ""}${tab.preview ? " — preview; double-click to keep open" : ""}`}
          className={`flex h-11 min-w-0 items-center gap-2 px-3 text-sm ${tab.preview ? "italic" : "font-medium"} ${TAB_FOCUS_CLASS}`}
          onClick={() => onSelect(tab.id)} onDoubleClick={() => onKeep(tab.id)}
          onKeyDown={event => {
            const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : null;
            if (next === null) return;
            event.preventDefault();
            buttons.current.get(tabs[next].id)?.focus();
          }}>
          <ChatBubble className="h-4 w-4 shrink-0" aria-hidden="true" /><span className="flex min-w-0 max-w-44 flex-col items-start text-left leading-4"><span className="w-full truncate">{tab.title}</span>
            {multipleSpaces && tab.spaceName ? <span className="w-full truncate text-[10px] font-normal not-italic opacity-75">{tab.spaceName}</span> : null}</span>
          {tab.badge ? <span className="text-[10px] not-italic" aria-label={`${tab.badge} unread`}>{tab.badge}</span> : null}
          {tab.dirty ? <span aria-label="Unsaved draft" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" /> : null}
        </button>
        {tab.preview ? <IconButton variant="ghost" size="xs" radius="full" aria-label={`Keep ${tab.title}${tab.spaceName ? ` · ${tab.spaceName}` : ""} open`} title="Keep chat open" onPress={() => onKeep(tab.id)} className="shrink-0"><Pin className="h-3.5 w-3.5" /></IconButton> : null}
        <TabCloseButton label={`Close ${tab.title}${tab.spaceName ? ` · ${tab.spaceName}` : ""} tab`} className="mr-1 shrink-0 text-inherit" onClose={() => { restoreFocus.current = true; onClose(tab.id); }} />
      </div>)}
    </HorizontalTabStrip>
  </nav>;
}
