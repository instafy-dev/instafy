import { useEffect, useMemo, useRef, useState } from "react";
import { Lock, MoreHoriz, Plus, Search, Trash, Xmark } from "iconoir-react";
import { MenuTrigger } from "react-aria-components";
import { ChatsIcon } from "../components/AppIcons";
import { IconButton } from "../components/Button";
import { EntityRow } from "../components/EntityRow";
import { Input } from "../components/Input";
import { ToolbarMenuSelect } from "../components/ToolbarMenuSelect";
import { TreeDisclosureButton, TreeRowMarkerSlot } from "../components/TreeDisclosureButton";
import { useConversations } from "../conversations/ConversationsProvider";
import type { ConversationLifecycleStatus } from "../conversations/ConversationsProvider";
import { MenuItemContent } from "../components/MenuItemContent";
import { StudioPopover } from "../components/aria/StudioPopover";
import { StudioMenu, StudioMenuItem, StudioMenuSeparator } from "../components/aria/StudioMenu";
import { DRAWER_ICON_BUTTON_TONE_CLASS } from "../components/listRowStyles";
import { controllerClient } from "../sdk/instafy";
import { useWorkspaceTabs } from "./WorkspaceTabsProvider";
import { useStatus } from "../status/useStatus";
import { useBreakpoint } from "../hooks/useBreakpoint";
import { useTouchLikeInput } from "../hooks/useTouchLikeInput";
import { DrawerHeader } from "../components/DrawerHeader";
import { SearchInput } from "../components/SearchInput";

export interface ConversationHistoryTabProps {
  onRequestClose?: () => void;
  onStartNewConversation?: () => void;
}

export function ConversationHistoryTab({
  onRequestClose,
  onStartNewConversation,
}: ConversationHistoryTabProps = {}) {
  const { conversations, activeConversationId, setConversationLifecycleStatus, setConversationTitle } = useConversations();
  const { tabs, closeTab, openConversationTab, requestUrlPush } = useWorkspaceTabs();
  const { showStatus } = useStatus();
  const isLargeScreen = useBreakpoint("lg");
  const touchDrawer = useTouchLikeInput() && !isLargeScreen;
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ConversationLifecycleStatus>("active");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [mobileSearchOpen, setMobileSearchOpen] = useState(() => query.trim().length > 0);
  // Inline rename is only reachable through the row's "…" menu: the edit state
  // borrows the real Input look (border + focus ring) so it reads as editable,
  // while plain selection stays a fill (EntityRow selected) — see #139.
  const [rename, setRename] = useState<{ conversationId: string; draft: string } | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameIgnoreBlurRef = useRef(false);

  useEffect(() => {
    const renamingConversationId = rename?.conversationId;
    if (!renamingConversationId) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [rename?.conversationId]);

  useEffect(() => {
    if (isLargeScreen) {
      setMobileSearchOpen(false);
      return;
    }
    if (query.trim().length > 0) {
      setMobileSearchOpen(true);
    }
  }, [isLargeScreen, query]);

  useEffect(() => {
    if (isLargeScreen || !mobileSearchOpen) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [isLargeScreen, mobileSearchOpen]);

  const openConversationTabs = useMemo(() => {
    const conversationTabs = tabs.filter(
      (tab): tab is Extract<(typeof tabs)[number], { kind: "conversation" }> => tab.kind === "conversation"
    );
    const openIds = new Set(conversationTabs.map((tab) => tab.conversationId));
    const tabIdByConversationId = new Map(conversationTabs.map((tab) => [tab.conversationId, tab.id]));
    return { openIds, tabIdByConversationId };
  }, [tabs]);

  const conversationTreeIndex = useMemo(() => {
    const byId = new Map(conversations.map((conversation) => [conversation.localId, conversation] as const));
    const indexById = new Map(conversations.map((conversation, index) => [conversation.localId, index] as const));
    const localIdByControllerId = new Map<string, string>();
    conversations.forEach((conversation) => {
      if (conversation.controllerId) {
        localIdByControllerId.set(conversation.controllerId, conversation.localId);
      }
    });
    const childrenById = new Map<string, string[]>();
    const parentLocalIdById = new Map<string, string | null>();

    conversations.forEach((conversation) => {
      const parentControllerId = conversation.parentConversationId;
      if (!parentControllerId) {
        parentLocalIdById.set(conversation.localId, null);
        return;
      }
      const parentLocalId = localIdByControllerId.get(parentControllerId) ?? null;
      if (!parentLocalId || parentLocalId === conversation.localId) {
        parentLocalIdById.set(conversation.localId, null);
        return;
      }
      parentLocalIdById.set(conversation.localId, parentLocalId);
      const existing = childrenById.get(parentLocalId) ?? [];
      existing.push(conversation.localId);
      childrenById.set(parentLocalId, existing);
    });

    childrenById.forEach((children, parentId) => {
      const sorted = [...children].sort((a, b) => {
        const aIndex = indexById.get(a) ?? Number.POSITIVE_INFINITY;
        const bIndex = indexById.get(b) ?? Number.POSITIVE_INFINITY;
        return aIndex - bIndex;
      });
      childrenById.set(parentId, sorted);
    });

    const roots = conversations
      .filter((conversation) => {
        return parentLocalIdById.get(conversation.localId) === null;
      })
      .map((conversation) => conversation.localId)
      .sort((a, b) => {
        const aIndex = indexById.get(a) ?? Number.POSITIVE_INFINITY;
        const bIndex = indexById.get(b) ?? Number.POSITIVE_INFINITY;
        return aIndex - bIndex;
      });

    return { byId, childrenById, roots, parentLocalIdById };
  }, [conversations]);

  const activeThreadPath = useMemo(() => {
    const path = new Set<string>();
    if (!activeConversationId) {
      return path;
    }
    let current: string | null = activeConversationId;
    while (current) {
      if (path.has(current)) {
        break;
      }
      path.add(current);
      const parentConversationId: string | null = conversationTreeIndex.parentLocalIdById.get(current) ?? null;
      current = parentConversationId && parentConversationId !== current ? parentConversationId : null;
    }
    return path;
  }, [activeConversationId, conversationTreeIndex.parentLocalIdById]);

  const collectConversationSubtreeIds = useMemo(() => {
    const childrenById = conversationTreeIndex.childrenById;
    return (rootId: string): string[] => {
      const result: string[] = [];
      const stack: string[] = [rootId];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const id = stack.pop();
        if (!id) {
          continue;
        }
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        result.push(id);
        const children = childrenById.get(id) ?? [];
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push(children[index]);
        }
      }
      return result;
    };
  }, [conversationTreeIndex.childrenById]);

  type ConversationTreeNode = { id: string; children: ConversationTreeNode[] };

  const filteredTree = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const { byId, childrenById, roots } = conversationTreeIndex;

    const walk = (id: string): ConversationTreeNode | null => {
      const conversation = byId.get(id) ?? null;
      if (!conversation) {
        return null;
      }
      if (conversation.lifecycleStatus !== filter) {
        return null;
      }
      const nextChildren = (childrenById.get(id) ?? [])
        .map((childId) => walk(childId))
        .filter((child): child is ConversationTreeNode => child !== null);
      const matches = needle.length === 0 ? true : conversation.title.toLowerCase().includes(needle);
      if (needle.length > 0 && !matches && nextChildren.length === 0) {
        return null;
      }
      return { id, children: nextChildren };
    };

    return roots.map((id) => walk(id)).filter((node): node is ConversationTreeNode => node !== null);
  }, [conversationTreeIndex, filter, query]);

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const forceExpand = needle.length > 0;
    const rows: Array<{ id: string; depth: number; hasChildren: boolean; expanded: boolean }> = [];

    const walk = (node: ConversationTreeNode, depth: number) => {
      const isExpanded = forceExpand || activeThreadPath.has(node.id) || Boolean(expanded[node.id]);
      rows.push({
        id: node.id,
        depth,
        hasChildren: node.children.length > 0,
        expanded: isExpanded
      });
      if (node.children.length === 0 || !isExpanded) {
        return;
      }
      node.children.forEach((child) => walk(child, depth + 1));
    };

    filteredTree.forEach((node) => walk(node, 0));
    return rows;
  }, [activeThreadPath, expanded, filteredTree, query]);

  // The marker gutter exists for structure (disclosure arrows, nesting, the
  // private-chat lock). A flat list of public chats — the common case — should
  // not pay a whole column for it; the active dot alone never reserves the
  // gutter and is overlaid on the row edge instead (#139).
  const showMarkerGutter = useMemo(
    () =>
      visibleRows.some((row) => {
        if (row.hasChildren || row.depth > 0) {
          return true;
        }
        const conversation = conversationTreeIndex.byId.get(row.id);
        return conversation?.visibility === "private";
      }),
    [conversationTreeIndex.byId, visibleRows],
  );

  const handleCloseConversationTab = (conversationId: string) => {
    const tabId = openConversationTabs.tabIdByConversationId.get(conversationId);
    if (!tabId) {
      return;
    }
    closeTab(tabId);
  };

  const counts = useMemo(() => {
    const totals: Record<ConversationLifecycleStatus, number> = {
      active: 0,
      archived: 0,
      hidden: 0,
      deleted: 0
    };
    conversations.forEach((conversation) => {
      totals[conversation.lifecycleStatus] += 1;
    });
    return totals;
  }, [conversations]);

  const filterOptions = useMemo(
    () => [
      { value: "active" as const, label: `Active (${counts.active})` },
      { value: "archived" as const, label: `Archived (${counts.archived})` },
      { value: "hidden" as const, label: `Hidden (${counts.hidden})` },
      { value: "deleted" as const, label: `Trash (${counts.deleted})` },
    ],
    [counts.active, counts.archived, counts.hidden, counts.deleted],
  );
  const filterHeaderLabel: Record<ConversationLifecycleStatus, string> = {
    active: "Active conversations",
    archived: "Archived conversations",
    hidden: "Hidden conversations",
    deleted: "Trash",
  };

  const handleConversationLifecycleChange = (
    conversationId: string,
    nextStatus: ConversationLifecycleStatus,
    options?: { confirmDelete?: boolean }
  ) => {
    const conversation = conversations.find((entry) => entry.localId === conversationId) ?? null;
    if (!conversation) {
      return;
    }
    if (conversation.lifecycleStatus === nextStatus) {
      return;
    }

    if (options?.confirmDelete && typeof window !== "undefined") {
      const confirmed = window.confirm("Delete this conversation? You can restore it from Trash.");
      if (!confirmed) {
        return;
      }
    }

    const subtreeIds = collectConversationSubtreeIds(conversationId);
    const previousStatuses = new Map<string, ConversationLifecycleStatus>();
    subtreeIds.forEach((id) => {
      const entry = conversations.find((candidate) => candidate.localId === id) ?? null;
      if (entry) {
        previousStatuses.set(id, entry.lifecycleStatus);
      }
    });

    if (nextStatus === "archived" || nextStatus === "hidden" || nextStatus === "deleted") {
      subtreeIds.forEach((id) => handleCloseConversationTab(id));
    }

    subtreeIds.forEach((id) => setConversationLifecycleStatus(id, nextStatus));

    const nextLabel =
      nextStatus === "archived"
        ? "Archived conversation."
        : nextStatus === "hidden"
          ? "Hidden conversation."
          : nextStatus === "deleted"
            ? "Moved conversation to Trash."
            : "Restored conversation.";

    const affectedLabel = subtreeIds.length > 1 ? ` (${subtreeIds.length - 1} thread${subtreeIds.length === 2 ? "" : "s"})` : "";

    showStatus(`${nextLabel}${affectedLabel}`, nextStatus === "deleted" ? "warning" : "info", 6000, {
      actionLabel: "Undo",
      onAction: () => {
        previousStatuses.forEach((status, id) => {
          setConversationLifecycleStatus(id, status);
        });
      }
    });
  };

  const beginRename = (conversationId: string) => {
    const conversation = conversations.find((entry) => entry.localId === conversationId) ?? null;
    if (!conversation) {
      return;
    }
    renameIgnoreBlurRef.current = false;
    setRename({ conversationId, draft: conversation.title });
  };

  const cancelRename = (options?: { ignoreBlur?: boolean }) => {
    if (options?.ignoreBlur) {
      renameIgnoreBlurRef.current = true;
    }
    setRename(null);
  };

  const commitRename = async () => {
    if (!rename) {
      return;
    }
    const nextTitle = rename.draft.trim();
    if (!nextTitle) {
      showStatus("Conversation name can't be empty.", "error", 4000);
      return;
    }
    const conversation = conversations.find((entry) => entry.localId === rename.conversationId) ?? null;
    if (!conversation) {
      setRename(null);
      return;
    }
    if (nextTitle === conversation.title) {
      setRename(null);
      return;
    }

    const previousTitle = conversation.title;
    setConversationTitle(conversation.localId, nextTitle);
    renameIgnoreBlurRef.current = false;
    setRename(null);

    if (!conversation.controllerId) {
      return;
    }

    const updated = await controllerClient.conversations.updateMetadata({
      conversationId: conversation.controllerId,
      metadata: { title: nextTitle },
    });

    if (!updated) {
      setConversationTitle(conversation.localId, previousTitle);
      showStatus("Unable to rename conversation. Try again.", "error", 4000);
    }
  };

  const handleRenameBlur = () => {
    if (renameIgnoreBlurRef.current) {
      renameIgnoreBlurRef.current = false;
      return;
    }
    void commitRename();
  };

  const handleToggleMobileSearch = () => {
    if (mobileSearchOpen) {
      if (query.trim().length > 0) {
        setQuery("");
      }
      setMobileSearchOpen(false);
      return;
    }
    setMobileSearchOpen(true);
  };

  const showSearchInput = isLargeScreen || mobileSearchOpen || touchDrawer;
  const showCollapsedHeaderFilter = !isLargeScreen && !mobileSearchOpen && !touchDrawer;

  const renderFilterSelect = (className: string) => (
    <ToolbarMenuSelect
      options={filterOptions.map((option) => ({ id: option.value, label: option.label }))}
      value={filter}
      onSelect={(value) => setFilter(value as ConversationLifecycleStatus)}
      ariaLabel="Filter conversations by status"
      triggerTestId="conversation-history-filter"
      className={className}
    />
  );

  return (
    <div className="flex h-full flex-col p-3" data-testid="conversation-history-panel">
      <DrawerHeader
        title="Chats"
        subtitle={touchDrawer ? `${filterHeaderLabel[filter]} · ${counts[filter]}` : undefined}
        density={touchDrawer ? "touch" : "compact"}
        icon={
          <ChatsIcon
            className={[
              touchDrawer ? "h-5 w-5" : "h-4 w-4",
              "text-slate-700 dark:text-slate-200",
            ].join(" ")}
            aria-hidden="true"
          />
        }
        actions={
          <>
            {showCollapsedHeaderFilter ? renderFilterSelect("shrink-0") : null}
            {!isLargeScreen && !mobileSearchOpen && !touchDrawer ? (
              <IconButton
                variant="ghost"
                size="xs"
                radius="full"
                aria-label="Search conversations"
                title="Search conversations"
                onPress={handleToggleMobileSearch}
                data-testid="conversation-history-search-toggle"
                className={`h-10 w-10 lg:h-6 lg:w-6 ${DRAWER_ICON_BUTTON_TONE_CLASS}`}
              >
                <Search className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            ) : null}
            {onStartNewConversation ? (
              <IconButton
                variant="ghost"
                size={touchDrawer ? "lg" : "xs"}
                radius="full"
                aria-label="New chat"
                title="New chat"
                onPress={() => {
                  onStartNewConversation();
                  if (!isLargeScreen) {
                    onRequestClose?.();
                  }
                }}
                data-testid="conversation-history-new-chat"
                className={touchDrawer ? DRAWER_ICON_BUTTON_TONE_CLASS : `h-10 w-10 lg:h-6 lg:w-6 ${DRAWER_ICON_BUTTON_TONE_CLASS}`}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            ) : null}
          </>
        }
      />

      {showSearchInput ? (
        <div className={["mt-3 flex items-center gap-2", touchDrawer ? "flex-wrap" : ""].join(" ")}>
          <div className={touchDrawer ? "w-full" : "min-w-0 flex-1"}>
            <SearchInput
              ref={searchInputRef}
              id="conversation-history-search"
              label="Search conversations"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={touchDrawer ? "Search chats or spaces" : "Search conversations"}
              size={touchDrawer ? "lg" : "sm"}
              radius={touchDrawer ? "full" : "xl"}
              className={touchDrawer ? "bg-white/90 shadow-sm shadow-slate-900/5 dark:bg-[var(--color-studio-dark-raised-control)] dark:shadow-none" : undefined}
              data-testid="conversation-history-search"
            />
          </div>
          {renderFilterSelect(touchDrawer ? "min-w-[9.5rem] flex-1" : "w-[8.5rem] shrink-0")}
          {!isLargeScreen && !touchDrawer ? (
            <IconButton
              variant="ghost"
              size="xs"
              radius="full"
              aria-label="Close conversation search"
              title="Close search"
              onPress={handleToggleMobileSearch}
              data-testid="conversation-history-search-toggle"
              className={`h-10 w-10 ${DRAWER_ICON_BUTTON_TONE_CLASS}`}
            >
              <Xmark className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
      ) : null}

      <div className={["flex-1 overflow-y-auto pr-1", touchDrawer ? "mt-4" : "mt-3"].join(" ")}>
        {visibleRows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 py-10">
            <span className="text-sm text-slate-500 dark:text-slate-400">No conversations found.</span>
          </div>
        ) : (
          <div className={["flex flex-col", touchDrawer ? "gap-1.5" : "gap-1"].join(" ")} data-testid="conversation-history-list">
            {visibleRows.map((row) => {
              const conversation = conversationTreeIndex.byId.get(row.id) ?? null;
              if (!conversation) {
                return null;
              }
              const isOpen = openConversationTabs.openIds.has(conversation.localId);
              const isActive = conversation.localId === activeConversationId;
              const isDeleted = conversation.lifecycleStatus === "deleted";
              const openConversation = () => {
                if (isDeleted) {
                  return;
                }
                const shouldPush = conversation.localId !== activeConversationId;
                if (shouldPush) {
                  requestUrlPush();
                }
                openConversationTab(conversation.localId);
                if (!isLargeScreen) {
                  onRequestClose?.();
                }
              };
              const leadingMarker = showMarkerGutter ? (
                <TreeRowMarkerSlot depth={row.depth} className={touchDrawer ? "h-8 w-8" : undefined}>
                  {row.hasChildren ? (
                    <TreeDisclosureButton
                      expanded={row.expanded}
                      label={row.expanded ? "Collapse threads" : "Expand threads"}
                      title={row.expanded ? "Collapse threads" : "Expand threads"}
                      testId="conversation-history-toggle"
                      className={touchDrawer ? "h-8 w-8" : undefined}
                      onPress={() => {
                        setExpanded((current) => ({
                          ...current,
                          [conversation.localId]: !current[conversation.localId],
                        }));
                      }}
                    />
                  ) : isActive ? (
                    <span className={touchDrawer ? "h-2.5 w-2.5 rounded-full bg-primary-500" : "h-1.5 w-1.5 rounded-full bg-primary-500"} aria-hidden="true" />
                  ) : conversation.visibility === "private" ? (
                    <Lock className={touchDrawer ? "h-5 w-5 text-slate-400 dark:text-slate-500" : "h-4 w-4 text-slate-400 dark:text-slate-500"} aria-hidden="true" />
                  ) : null}
                </TreeRowMarkerSlot>
              ) : null;
              // Without the gutter, the active dot rides the row's own edge so
              // it costs no width. The row's left padding (below) is sized so
              // the title glyphs keep a clear ~6px gap from the dot.
              const overlayActiveDot = !showMarkerGutter && isActive ? (
                <span
                  className={[
                    "absolute left-1 top-1/2 -translate-y-1/2 rounded-full bg-primary-500",
                    touchDrawer ? "h-2 w-2" : "h-1.5 w-1.5",
                  ].join(" ")}
                  aria-hidden="true"
                />
              ) : null;
              if (rename?.conversationId === conversation.localId) {
                return (
                  <div
                    key={conversation.localId}
                    className="flex min-w-0 items-center"
                    data-testid="conversation-history-rename-row"
                  >
                    {leadingMarker ? <div className="flex shrink-0 items-center">{leadingMarker}</div> : null}
                    <Input
                      ref={renameInputRef}
                      value={rename.draft}
                      onChange={(event) => setRename({ ...rename, draft: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void commitRename();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          cancelRename({ ignoreBlur: true });
                        }
                      }}
                      onBlur={handleRenameBlur}
                      size="sm"
                      radius="xl"
                      tone="default"
                      aria-label={`Rename ${conversation.title}`}
                      data-testid="conversation-history-rename-input"
                    />
                  </div>
                );
              }
              return (
                <EntityRow
                  key={conversation.localId}
                  containerClassName="gap-0"
                  leadingAccessory={leadingMarker}
                  title={
                    overlayActiveDot ? (
                      <>
                        {overlayActiveDot}
                        {conversation.title}
                      </>
                    ) : (
                      conversation.title
                    )
                  }
                  pressable
                  selected={isActive}
                  density={touchDrawer ? "rich" : "dense"}
                  onPress={() => openConversation()}
                  isDisabled={isDeleted}
                  data-testid="conversation-history-item"
                  aria-current={isActive ? "page" : undefined}
                  titleClassName={isDeleted ? "line-through text-slate-400 dark:text-slate-500" : ""}
                  className={
                    [
                      showMarkerGutter ? "pl-0" : touchDrawer ? "relative pl-[1.125rem]" : "relative pl-4",
                      touchDrawer ? "rounded-2xl" : "",
                      isDeleted ? "opacity-70" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")
                  }
                  trailingAction={
                    <div className="flex items-center gap-1">
                      <div
                        onClick={(event) => {
                          event.stopPropagation();
                        }}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        <MenuTrigger>
                          <IconButton
                            variant="ghost"
                            radius="full"
                            size={touchDrawer ? "lg" : "xs"}
                            aria-label={`Manage ${conversation.title}`}
                            data-testid={`conversation-history-menu-${conversation.localId}`}
                            className={DRAWER_ICON_BUTTON_TONE_CLASS}
                          >
                            <MoreHoriz className="h-4 w-4" aria-hidden="true" />
                          </IconButton>
                          <StudioPopover placement="left top" offset={8} className="w-56 p-1">
                            <StudioMenu
                              aria-label="Conversation actions"
                              onAction={(key) => {
                                const action = String(key);
                                if (action === "rename") {
                                  beginRename(conversation.localId);
                                } else if (action === "restore") {
                                  handleConversationLifecycleChange(conversation.localId, "active");
                                } else if (action === "archive") {
                                  handleConversationLifecycleChange(conversation.localId, "archived");
                                } else if (action === "hide") {
                                  handleConversationLifecycleChange(conversation.localId, "hidden");
                                } else if (action === "delete") {
                                  handleConversationLifecycleChange(conversation.localId, "deleted", {
                                    confirmDelete: true,
                                  });
                                }
                              }}
                            >
                              {conversation.lifecycleStatus !== "deleted" ? (
                                <StudioMenuItem id="rename" data-testid="conversation-history-menu-rename">
                                  <MenuItemContent>Rename</MenuItemContent>
                                </StudioMenuItem>
                              ) : null}
                              {conversation.lifecycleStatus === "archived" ||
                              conversation.lifecycleStatus === "hidden" ||
                              conversation.lifecycleStatus === "deleted" ? (
                                <StudioMenuItem id="restore">
                                  <MenuItemContent>Restore</MenuItemContent>
                                </StudioMenuItem>
                              ) : null}
                              {conversation.lifecycleStatus !== "archived" && conversation.lifecycleStatus !== "deleted" ? (
                                <StudioMenuItem id="archive">
                                  <MenuItemContent>Archive</MenuItemContent>
                                </StudioMenuItem>
                              ) : null}
                              {conversation.lifecycleStatus !== "hidden" && conversation.lifecycleStatus !== "deleted" ? (
                                <StudioMenuItem id="hide">
                                  <MenuItemContent>Hide</MenuItemContent>
                                </StudioMenuItem>
                              ) : null}
                              <StudioMenuSeparator />
                              {conversation.lifecycleStatus === "deleted" ? (
                                <StudioMenuItem id="delete-forever" isDisabled>
                                  <MenuItemContent start={<Trash aria-hidden="true" />}>Delete forever (soon)</MenuItemContent>
                                </StudioMenuItem>
                              ) : (
                                <StudioMenuItem id="delete">
                                  <MenuItemContent
                                    start={<Trash aria-hidden="true" />}
                                    textClassName="text-rose-600 dark:text-rose-300"
                                  >
                                    Delete…
                                  </MenuItemContent>
                                </StudioMenuItem>
                              )}
                            </StudioMenu>
                          </StudioPopover>
                        </MenuTrigger>
                      </div>
                      {isOpen ? (
                        <div
                          onClick={(event) => {
                            event.stopPropagation();
                          }}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                          }}
                        >
                          <IconButton
                            variant="ghost"
                            radius="full"
                            size={touchDrawer ? "lg" : "xs"}
                            aria-label={`Close ${conversation.title}`}
                            onPress={() => handleCloseConversationTab(conversation.localId)}
                            className={DRAWER_ICON_BUTTON_TONE_CLASS}
                          >
                            <Xmark className="h-3.5 w-3.5" aria-hidden="true" />
                          </IconButton>
                        </div>
                      ) : null}
                    </div>
                  }
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
