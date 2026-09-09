import { useEffect, useId, useState } from "react";
import { DialogTrigger, Heading } from "react-aria-components";
import { EditPencil } from "iconoir-react";
import { ChatsIcon } from "../../../components/AppIcons";
import { AttentionBadge } from "../../../components/AttentionBadge";
import { Button } from "../../../components/Button";
import { ControlChevron } from "../../../components/ControlChevron";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import type { ConversationState } from "../../../conversations/conversationState";
import { DARK_ACTIVE_BG_CLASS } from "../../../theme/darkSurfaces";

export const SIDEBAR_RECENT_CHAT_LIMIT = 3;

export interface StudioRecentChatsProps {
  conversations: ConversationState[];
  activeConversationId?: string | null;
  openConversationIds?: ReadonlySet<string>;
  onSelectConversation: (id: string) => void;
  onBrowseAll?: () => void;
  isHistoryActive?: boolean;
  collapsed: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  active: boolean;
  rowClassName: string;
  iconClassName: string;
}

export function StudioRecentChats({
  conversations,
  activeConversationId,
  openConversationIds,
  onSelectConversation,
  onBrowseAll,
  isHistoryActive = false,
  collapsed,
  expanded,
  onExpandedChange,
  active,
  rowClassName,
  iconClassName,
}: StudioRecentChatsProps) {
  const listId = useId();
  const [popoverOpen, setPopoverOpen] = useState(false);
  useEffect(() => {
    // Switching rail width replaces the popover with the inline list. Do not
    // reopen an old popover when the user later collapses the sidebar again.
    setPopoverOpen(false);
  }, [collapsed]);
  const priority = (conversation: ConversationState) => conversation.pendingRunIds.length > 0 || conversation.awaitingLeaseRunIds.length > 0
    ? 2 : conversation.localId === activeConversationId ? 1 : 0;
  const visibleConversations = [...conversations].sort((a, b) => priority(b) - priority(a)).slice(0, SIDEBAR_RECENT_CHAT_LIMIT);

  const recentList = (
    <div id={listId} data-testid="sidebar-recent-chats-list">
      {visibleConversations.length > 0 ? (
        <ul aria-label="Recent chats" className="space-y-1">
          {visibleConversations.map((conversation) => {
            const selected = conversation.localId === activeConversationId;
            const openInTab = openConversationIds?.has(conversation.localId) ?? false;
            const queued = conversation.awaitingLeaseRunIds.length > 0;
            const running = conversation.pendingRunIds.some((id) => !conversation.awaitingLeaseRunIds.includes(id));
            const status = running ? "Running" : queued ? "Queued" : conversation.draft.trim() ? "Draft" : null;
            const title = conversation.title.trim() || "Untitled chat";
            const unreadCount = conversation.unreadCount;
            const details = [status, unreadCount > 0 ? `${unreadCount} unread` : null, openInTab ? "Open in tab" : null].filter(Boolean);
            return (
              <li key={conversation.localId}>
                <Button
                  variant="ghost"
                  size="sm"
                  radius="lg"
                  fullWidth
                  data-testid={`sidebar-recent-chat-${conversation.localId}`}
                  aria-label={[title, ...details].join(", ")}
                  aria-current={selected ? "page" : undefined}
                  title={[title, ...details].join(" · ")}
                  onPress={() => {
                    setPopoverOpen(false);
                    onSelectConversation(conversation.localId);
                  }}
                  className={[
                    "min-h-9 min-w-0 gap-2 px-2.5 text-left focus-visible:ring-offset-0",
                    selected
                      ? `bg-white text-slate-900 ${DARK_ACTIVE_BG_CLASS} dark:text-slate-50`
                      : "text-slate-600 dark:text-slate-300",
                  ].join(" ")}
                >
                  <span className={`min-w-0 flex-1 truncate text-sm ${unreadCount > 0 ? "font-semibold" : selected ? "font-medium" : "font-normal"} ${selected ? "text-slate-900 dark:text-slate-50" : "text-slate-700 dark:text-slate-300"}`}>{title}</span>
                  {status === "Draft" ? (
                    <span title="Draft" aria-hidden="true" className="shrink-0 text-slate-600 dark:text-slate-400">
                      <EditPencil className="h-4 w-4" />
                    </span>
                  ) : status ? <span aria-hidden="true" className="shrink-0 text-xs font-normal text-slate-600 dark:text-slate-400">{status}</span> : null}
                  <AttentionBadge count={unreadCount} aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-2.5 py-3 text-xs text-slate-500 dark:text-slate-400">No recent chats in this space.</p>
      )}
      {onBrowseAll ? (
        <Button
          variant="ghost"
          size="sm"
          radius="lg"
          fullWidth
          data-testid="sidebar-browse-all-chats"
          aria-current={isHistoryActive ? "page" : undefined}
          className={`mt-1 min-h-9 px-2.5 text-left focus-visible:ring-offset-0 ${isHistoryActive ? `bg-white ${DARK_ACTIVE_BG_CLASS}` : ""}`}
          onPress={() => {
            setPopoverOpen(false);
            onBrowseAll();
          }}
        >
          <span className={`flex w-full min-w-0 items-center justify-between gap-2 text-sm font-normal ${isHistoryActive ? "text-slate-900 dark:text-slate-50" : "text-slate-600 dark:text-slate-400"}`}>
            <span className="truncate">Browse all chats</span>
            <ControlChevron direction="right" />
          </span>
        </Button>
      ) : null}
    </div>
  );

  const trigger = (
    <Button
      variant="ghost"
      size="sm"
      radius="lg"
      fullWidth
      data-testid="sidebar-nav-history"
      aria-label={collapsed ? "Open chats" : "Chats"}
      title={collapsed ? "Open chats" : undefined}
      aria-expanded={collapsed ? popoverOpen : expanded}
      aria-controls={!collapsed && expanded ? listId : undefined}
      onPress={collapsed ? undefined : () => onExpandedChange(!expanded)}
      className={`group/item relative min-w-0 py-1.5 transition focus-visible:ring-offset-0 data-[pressed]:translate-y-0 data-[pressed]:scale-100 ${rowClassName}`}
    >
      <span className={iconClassName}>
        <ChatsIcon className="text-base" aria-hidden="true" />
      </span>
      {!collapsed ? (
        <span className="flex min-w-0 flex-1 items-center justify-between gap-2 text-sm font-medium">
          <span>Chats</span>
          <ControlChevron direction={expanded ? "down" : "right"} />
        </span>
      ) : null}
    </Button>
  );

  if (collapsed) {
    return (
      <DialogTrigger isOpen={popoverOpen} onOpenChange={setPopoverOpen}>
        {trigger}
        <StudioDialogPopover
          placement="right top"
          offset={8}
          className="w-72 max-w-[calc(100vw-1rem)] p-2"
          data-testid="sidebar-recent-chats-popover"
        >
          <div className="mb-2 px-2.5 py-1">
            <Heading slot="title" className="text-sm font-semibold text-slate-900 dark:text-slate-100">Chats</Heading>
          </div>
          {recentList}
        </StudioDialogPopover>
      </DialogTrigger>
    );
  }

  return (
    <section aria-label="Chats" data-active={active || undefined}>
      {trigger}
      {expanded ? <div className="ml-6 mr-3 py-2">{recentList}</div> : null}
    </section>
  );
}
