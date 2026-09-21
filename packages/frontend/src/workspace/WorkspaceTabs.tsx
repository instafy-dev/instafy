import { isWorkspacePreviewTab } from "./workspacePreviewTabs";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { desktopTitleBarFree } from "../lib/desktopShell";
import { NavArrowLeft, NavArrowRight, Pin, Trash, Xmark } from "iconoir-react";
import { useEffect, useMemo, useCallback, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "../components/Button";
import { Surface } from "../components/Surface";
import { StudioMenu, StudioMenuItem, StudioMenuSeparator } from "../components/aria/StudioMenu";
import { HorizontalTabStrip } from "../components/tabs/HorizontalTabStrip";
import { useConversations, type ConversationLifecycleStatus } from "../conversations/ConversationsProvider";
import { controllerClient } from "../sdk/instafy";
import { useStatus } from "../status/useStatus";
import {
  DARK_CANVAS_CLASS,
  DARK_DIVIDER_CLASS,
  DARK_FLOATING_SURFACE_CLASS,
  DARK_PANEL_SHADOW_CLASS,
  DARK_RAIL_HOVER_CLASS,
} from "../theme/darkSurfaces";
import { useProject } from "../projects/useProject";
import { isUUID } from "../utils/uuid";
import {
  addFloatingSurfaceViewportChangeListener,
  clampFloatingSurfacePositionToStudioViewport,
} from "../utils/floatingSurfacePosition";
import { useWorkspaceTabs } from "./WorkspaceTabsProvider";
import { useWorkspaceUi } from "./useWorkspace";

type WorkspaceTabKind = "panel" | "file" | "conversation" | "jobThread" | "explorer" | "gitDiff" | "gitReview";

export interface WorkspaceTabsProps {
  className?: string;
  leading?: ReactNode;
  emptyStateContent?: ReactNode;
  tabStripActions?: ReactNode;
  actions?: ReactNode;
}

const CONVERSATION_MENU_WIDTH = 240;
const CONVERSATION_MENU_HEIGHT_ESTIMATE = 280;
const CONVERSATION_MENU_PADDING = 12;

function getWorkspaceTabBaseClassName(showBaseline: boolean): string {
  return showBaseline
    ? "inline-flex h-[48px] items-center gap-2 rounded-t-xl rounded-b-none border border-transparent px-4 text-sm font-medium"
    : "inline-flex h-10 items-center gap-2 rounded-xl border border-transparent px-3.5 text-sm font-medium";
}

function getInactiveWorkspaceTabClassName(showBaseline: boolean): string {
  return showBaseline
    ? `!bg-transparent !border-transparent text-slate-500 hover:text-slate-900 data-[hovered]:text-slate-900 dark:text-slate-300 dark:hover:text-slate-50 dark:data-[hovered]:text-slate-50 ${DARK_RAIL_HOVER_CLASS}`
    : `!bg-transparent text-slate-600 hover:bg-slate-100/80 hover:text-slate-900 hover:border-slate-200/70 data-[hovered]:bg-slate-100/80 data-[hovered]:border-slate-200/70 dark:text-slate-300 dark:hover:text-slate-50 dark:hover:border-[color:var(--color-studio-dark-panel-border)] dark:data-[hovered]:border-[color:var(--color-studio-dark-panel-border)] ${DARK_RAIL_HOVER_CLASS}`;
}

function getActiveWorkspaceTabClassName(showBaseline: boolean): string {
  return showBaseline
    ? "relative z-10 -mb-px !bg-white !text-slate-950 !border-slate-200/70 !border-b-white shadow-none after:pointer-events-none after:absolute after:-bottom-px after:left-0 after:right-0 after:h-[2px] after:bg-white dark:!bg-[var(--color-studio-dark-panel)] dark:!text-slate-50 dark:!border-[color:var(--color-studio-dark-panel-border)] dark:!border-b-transparent dark:after:bg-[var(--color-studio-dark-panel)]"
    : "z-10 !bg-slate-100 !text-slate-950 !border-slate-200/70 shadow-none dark:!bg-[var(--color-studio-dark-active)] dark:!text-slate-50 dark:!border-transparent";
}

function getWorkspaceTabRailActionClassName(showBaseline: boolean): string {
  return showBaseline
    ? `h-[48px] w-12 flex-none rounded-none border border-transparent px-0 text-slate-500 transition-colors hover:bg-slate-100/80 hover:text-slate-900 data-[hovered]:bg-slate-100/80 data-[hovered]:text-slate-900 focus-visible:ring-black/10 focus-visible:ring-offset-0 dark:text-slate-300 dark:hover:text-slate-50 dark:data-[hovered]:text-slate-50 dark:focus-visible:ring-white/12 ${DARK_RAIL_HOVER_CLASS}`
    : `h-10 w-10 flex-none rounded-xl border border-transparent text-slate-400 transition-colors hover:bg-slate-100/80 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-50 ${DARK_RAIL_HOVER_CLASS}`;
}

function clampConversationMenuPosition(clientX: number, clientY: number) {
  return clampFloatingSurfacePositionToStudioViewport({
    clientX,
    clientY,
    surfaceWidth: CONVERSATION_MENU_WIDTH,
    surfaceHeight: CONVERSATION_MENU_HEIGHT_ESTIMATE,
    padding: CONVERSATION_MENU_PADDING,
  });
}

export function WorkspaceTabs({
  className,
  leading,
  emptyStateContent,
  tabStripActions,
  actions,
}: WorkspaceTabsProps) {
  // Integrated macOS title bar: the strip sits on row zero and must clear
  // the window buttons. False on every other target and on older shells.
  const titleBarFree = desktopTitleBarFree();
  const { tabs, activeTabId, focusTab, closeTab, keepTabOpen, moveTab, openConversationTab, requestUrlPush } = useWorkspaceTabs();
  const {
    conversations,
    createConversation,
    setConversationControllerId,
    setConversationTitle,
    setConversationLifecycleStatus,
  } = useConversations();
  const { showStatus } = useStatus();
  const { requestConversationInvite } = useWorkspaceUi();
  const { activeProjectId } = useProject();
  const [conversationMenu, setConversationMenu] = useState<{
    tabId: string;
    conversationId?: string;
    x: number;
    y: number;
    maxHeight: number;
  } | null>(null);
  const [conversationRename, setConversationRename] = useState<{
    tabId: string;
    conversationId: string;
    draft: string;
  } | null>(null);
  const [pendingThreadOpenId, setPendingThreadOpenId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameIgnoreBlurRef = useRef(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!conversationMenu) {
      return;
    }
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (menuRef.current?.contains(target)) {
        return;
      }
      setConversationMenu(null);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setConversationMenu(null);
        menuTriggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    const removeViewportChangeListener = addFloatingSurfaceViewportChangeListener(() => {
      setConversationMenu(null);
    });
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      removeViewportChangeListener();
    };
  }, [conversationMenu]);

  useEffect(() => {
    if (!pendingThreadOpenId) {
      return;
    }
    const target = pendingThreadOpenId;
    setPendingThreadOpenId(null);
    requestUrlPush();
    openConversationTab(target);
  }, [openConversationTab, pendingThreadOpenId, requestUrlPush]);

  useEffect(() => {
    const conversationId = conversationRename?.conversationId;
    if (!conversationId) {
      return;
    }
    const node = renameInputRef.current;
    if (!node) {
      return;
    }
    node.focus();
    node.select();
  }, [conversationRename?.conversationId]);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }
      const activeId = String(active.id);
      const overId = String(over.id);
      const nextIndex = tabs.findIndex((tab) => tab.id === overId);
      if (nextIndex < 0) {
        return;
      }
      const currentIndex = tabs.findIndex((tab) => tab.id === activeId);
      if (currentIndex < 0 || currentIndex === nextIndex) {
        return;
      }
      moveTab(activeId, nextIndex);
    },
    [moveTab, tabs]
  );

  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const showTabBaseline = true;
  const openConversationTabIdByConversationId = useMemo(() => {
    return new Map(
      tabs
        .filter((tab): tab is Extract<(typeof tabs)[number], { kind: "conversation" }> => tab.kind === "conversation")
        .map((tab) => [tab.conversationId, tab.id] as const),
    );
  }, [tabs]);
  const conversationChildrenById = useMemo(() => {
    const childrenById = new Map<string, string[]>();
    const indexById = new Map(conversations.map((conversation, index) => [conversation.localId, index] as const));
    const localIdByControllerId = new Map<string, string>();

    conversations.forEach((conversation) => {
      if (conversation.controllerId) {
        localIdByControllerId.set(conversation.controllerId, conversation.localId);
      }
    });

    conversations.forEach((conversation) => {
      const parentControllerId = conversation.parentConversationId;
      if (!parentControllerId) {
        return;
      }
      const parentLocalId = localIdByControllerId.get(parentControllerId) ?? null;
      if (!parentLocalId || parentLocalId === conversation.localId) {
        return;
      }
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

    return childrenById;
  }, [conversations]);
  const collectConversationSubtreeIds = useCallback(
    (rootId: string): string[] => {
      const result: string[] = [];
      const stack: string[] = [rootId];
      const seen = new Set<string>();

      while (stack.length > 0) {
        const id = stack.pop();
        if (!id || seen.has(id)) {
          continue;
        }
        seen.add(id);
        result.push(id);
        const children = conversationChildrenById.get(id) ?? [];
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push(children[index]);
        }
      }

      return result;
    },
    [conversationChildrenById],
  );

  const handleSelectTab = useCallback(
    (tabId: string) => {
      if (tabId === activeTabId) {
        focusTab(tabId);
        return;
      }
      requestUrlPush();
      focusTab(tabId);
    },
    [activeTabId, focusTab, requestUrlPush],
  );

  const handleOpenConversationMenu = (params: ConversationMenuTrigger) => {
    const { x, y, maxHeight } = clampConversationMenuPosition(params.clientX, params.clientY);
    menuTriggerRef.current = params.trigger;
    setConversationMenu({
      tabId: params.tabId,
      conversationId: params.conversationId,
      x,
      y,
      maxHeight,
    });
  };

  const beginConversationRename = useCallback(
    (tabId: string, conversationId: string) => {
      const conversation = conversations.find((entry) => entry.localId === conversationId) ?? null;
      renameIgnoreBlurRef.current = false;
      setConversationRename({ tabId, conversationId, draft: conversation?.title ?? "" });
    },
    [conversations],
  );

  const cancelConversationRename = useCallback((options?: { ignoreBlur?: boolean }) => {
    if (options?.ignoreBlur) {
      renameIgnoreBlurRef.current = true;
    } else {
      renameIgnoreBlurRef.current = false;
    }
    setConversationRename(null);
  }, []);

  const commitConversationRename = useCallback(async () => {
    if (!conversationRename) {
      return;
    }
    const nextTitle = conversationRename.draft.trim();
    if (!nextTitle) {
      showStatus("Conversation name can't be empty.", "error", 4000);
      return;
    }
    const conversation = conversations.find((entry) => entry.localId === conversationRename.conversationId) ?? null;
    if (!conversation) {
      setConversationRename(null);
      return;
    }
    if (nextTitle === conversation.title) {
      setConversationRename(null);
      return;
    }

    const previousTitle = conversation.title;
    setConversationTitle(conversation.localId, nextTitle);
    renameIgnoreBlurRef.current = false;
    setConversationRename(null);

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
  }, [conversationRename, conversations, setConversationTitle, showStatus]);

  const handleRenameBlur = useCallback(() => {
    if (renameIgnoreBlurRef.current) {
      renameIgnoreBlurRef.current = false;
      return;
    }
    void commitConversationRename();
  }, [commitConversationRename]);

  const handleConversationMenuRename = useCallback(() => {
    if (!conversationMenu?.conversationId) {
      return;
    }
    beginConversationRename(conversationMenu.tabId, conversationMenu.conversationId);
    setConversationMenu(null);
  }, [beginConversationRename, conversationMenu]);

  const handleConversationMenuNewThread = useCallback(() => {
    if (!conversationMenu) {
      return;
    }
    const parentConversation =
      conversations.find((entry) => entry.localId === conversationMenu.conversationId) ?? null;
    if (!parentConversation) {
      return;
    }
    setConversationMenu(null);

    const projectId = activeProjectId && isUUID(activeProjectId) ? activeProjectId : null;
    if (!projectId) {
      return;
    }

    void (async () => {
      let parentControllerId = parentConversation.controllerId;
      if (!parentControllerId) {
        const parentResponse = await controllerClient.conversations.createBlank({
          projectId,
          metadata: {
            title: parentConversation.title,
            localId: parentConversation.localId,
            visibility: parentConversation.visibility,
          },
        });
        if (!parentResponse?.conversationId) {
          showStatus("Controller unavailable. Try again shortly.", "error", 4000);
          return;
        }
        parentControllerId = parentResponse.conversationId;
        setConversationControllerId(parentConversation.localId, parentControllerId);
      }

      const existingThreads = conversations.filter(
        (entry) =>
          entry.parentConversationId === parentControllerId &&
          (entry.threadKind ?? "thread") === "thread",
      ).length;
      const threadTitle = `Thread ${existingThreads + 1}`;
      const threadConversation = createConversation({
        title: threadTitle,
        visibility: parentConversation.visibility,
        parentConversationId: parentControllerId,
        threadKind: "thread",
        select: false
      });
      setPendingThreadOpenId(threadConversation.localId);

      const response = await controllerClient.conversations.createBlank({
        projectId,
        metadata: {
          title: threadTitle,
          localId: threadConversation.localId,
          visibility: threadConversation.visibility,
        },
        parentConversationId: parentControllerId,
        threadKind: "thread",
      });
      if (response?.conversationId) {
        setConversationControllerId(threadConversation.localId, response.conversationId);
      }
    })();
  }, [
    activeProjectId,
    conversationMenu,
    conversations,
    createConversation,
    setConversationControllerId,
    showStatus
  ]);

  const handleConversationMenuClose = useCallback(() => {
    if (!conversationMenu) {
      return;
    }
    closeTab(conversationMenu.tabId);
    setConversationMenu(null);
  }, [closeTab, conversationMenu]);

  const handleConversationMenuKeepOpen = useCallback(() => {
    if (!conversationMenu) {
      return;
    }
    keepTabOpen(conversationMenu.tabId);
    setConversationMenu(null);
    menuTriggerRef.current?.focus();
  }, [conversationMenu, keepTabOpen]);

  const handleConversationMenuInvite = useCallback(() => {
    if (!conversationMenu?.conversationId) {
      return;
    }
    const tabId = conversationMenu.tabId;
    const conversationId = conversationMenu.conversationId;
    setConversationMenu(null);
    requestUrlPush();
    focusTab(tabId);
    requestConversationInvite(conversationId);
  }, [conversationMenu, focusTab, requestConversationInvite, requestUrlPush]);

  const handleConversationMenuDelete = useCallback(() => {
    if (!conversationMenu) {
      return;
    }
    const conversation = conversations.find((entry) => entry.localId === conversationMenu.conversationId) ?? null;
    if (!conversation) {
      setConversationMenu(null);
      return;
    }

    if (typeof window !== "undefined") {
      const confirmed = window.confirm("Delete this conversation? You can restore it from Trash.");
      if (!confirmed) {
        return;
      }
    }

    const subtreeIds = collectConversationSubtreeIds(conversation.localId);
    const previousStatuses = new Map<string, ConversationLifecycleStatus>();
    subtreeIds.forEach((id) => {
      const entry = conversations.find((candidate) => candidate.localId === id) ?? null;
      if (entry) {
        previousStatuses.set(id, entry.lifecycleStatus);
      }
    });

    subtreeIds.forEach((id) => {
      const tabId = openConversationTabIdByConversationId.get(id);
      if (tabId) {
        closeTab(tabId);
      }
    });
    subtreeIds.forEach((id) => setConversationLifecycleStatus(id, "deleted"));
    setConversationMenu(null);

    const affectedLabel =
      subtreeIds.length > 1 ? ` (${subtreeIds.length - 1} thread${subtreeIds.length === 2 ? "" : "s"})` : "";

    showStatus(`Moved conversation to Trash.${affectedLabel}`, "warning", 6000, {
      actionLabel: "Undo",
      onAction: () => {
        previousStatuses.forEach((status, id) => {
          setConversationLifecycleStatus(id, status);
        });
      },
    });
  }, [
    closeTab,
    collectConversationSubtreeIds,
    conversationMenu,
    conversations,
    openConversationTabIdByConversationId,
    setConversationLifecycleStatus,
    showStatus,
  ]);

  if (tabs.length === 0 && !emptyStateContent && !tabStripActions && !actions && !leading) {
    return null;
  }

  const menuConversation =
    conversationMenu && conversationMenu.conversationId
      ? conversations.find((entry) => entry.localId === conversationMenu.conversationId) ?? null
      : null;
  const menuTab = tabs.find((tab) => tab.id === conversationMenu?.tabId);

  const conversationMenuPortal =
    conversationMenu && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={menuRef}
            className="fixed z-[80] w-60 overflow-y-auto"
            style={{
              left: conversationMenu.x,
              top: conversationMenu.y,
              maxHeight: conversationMenu.maxHeight,
            }}
            data-testid="conversation-tab-menu"
          >
            <Surface
              tone="default"
              radius="xl"
              shadow="lg"
              className={`p-1 ${DARK_FLOATING_SURFACE_CLASS} ${DARK_PANEL_SHADOW_CLASS}`}
            >
              <StudioMenu aria-label={menuTab?.kind === "conversation" ? "Conversation tab actions" : "Tab actions"} autoFocus="first">
                {isWorkspacePreviewTab(menuTab) ? (
                  <StudioMenuItem
                    className="justify-start gap-2 pointer-coarse:min-h-11"
                    onAction={handleConversationMenuKeepOpen}
                    id="keep-open"
                    textValue="Keep open"
                    data-testid="conversation-tab-menu-keep-open"
                  >
                    <Pin className="h-4 w-4" aria-hidden="true" />
                    <span>Keep open</span>
                  </StudioMenuItem>
                ) : null}
                {menuTab?.kind === "conversation" ? <>
                <StudioMenuItem
                  className="justify-start gap-2 pointer-coarse:min-h-11"
                  onAction={handleConversationMenuNewThread}
                  id="new-thread"
                  data-testid="conversation-tab-menu-new-thread"
                >
                  New thread
                </StudioMenuItem>
                <StudioMenuItem
                  className="justify-start gap-2 pointer-coarse:min-h-11"
                  onAction={handleConversationMenuRename}
                  id="rename"
                  data-testid="conversation-tab-menu-rename"
                >
                  Rename
                </StudioMenuItem>
                </> : null}
                {menuConversation?.visibility === "private" ? (
                  <StudioMenuItem
                    className="justify-start gap-2 pointer-coarse:min-h-11"
                    onAction={handleConversationMenuInvite}
                    id="invite"
                    data-testid="conversation-tab-menu-invite"
                  >
                    Invite teammate…
                  </StudioMenuItem>
                ) : null}
                <StudioMenuItem
                  className="justify-start gap-2 pointer-coarse:min-h-11"
                  onAction={handleConversationMenuClose}
                  id="close"
                  data-testid="conversation-tab-menu-close"
                >
                  Close tab
                </StudioMenuItem>
                {menuTab?.kind === "conversation" ? <>
                <StudioMenuSeparator />
                <StudioMenuItem
                  className="justify-start gap-2 pointer-coarse:min-h-11 text-rose-600 hover:text-rose-700 dark:text-rose-300 dark:hover:text-rose-200"
                  onAction={handleConversationMenuDelete}
                  id="delete"
                  textValue="Delete…"
                  data-testid="conversation-tab-menu-delete"
                >
                  <Trash className="h-4 w-4" aria-hidden="true" />
                  <span>Delete…</span>
                </StudioMenuItem>
                </> : null}
              </StudioMenu>
            </Surface>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <div
        className={[
          `relative flex max-w-full flex-none items-end gap-2 bg-white pr-2 pb-0 pt-0 ${DARK_CANVAS_CLASS}`,
          // Offset every interactive child, including leading Back/Forward and
          // overflow controls, past the integrated macOS drag corner. Padding
          // only the scrolling tab content leaves leading controls underneath it.
          // pl-6 equals DESKTOP_TITLE_BAR_TAB_OFFSET_PX (24px).
          titleBarFree ? "pl-6" : "",
          className ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-testid="workspace-tabs"
      >
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-0 bottom-0 z-0 h-px bg-slate-200/70 ${DARK_DIVIDER_CLASS}`}
        />
        {leading ? <div className="relative z-10 flex flex-none items-end empty:hidden">{leading}</div> : null}
        <HorizontalTabStrip
          className="relative z-10"
          testId="workspace-tabs-strip"
          overflowActions={tabStripActions}
          inlineOverflowActionsTestId="workspace-tabs-inline-actions"
          overflowActionsTestId="workspace-tabs-inline-actions"
          activeItemId={activeTabId}
          activeItemAttribute="data-workspace-tab-trigger"
          renderScrollControl={({ direction, canScroll, scrollByDirection }) => (
            <IconButton
              key={direction}
              variant="ghost"
              radius={showTabBaseline ? "none" : "xl"}
              size="sm"
              aria-label={direction === -1 ? "Scroll tabs left" : "Scroll tabs right"}
              data-testid={
                direction === -1
                  ? "workspace-tabs-scroll-left"
                  : "workspace-tabs-scroll-right"
              }
              onPress={() => scrollByDirection(direction)}
              isDisabled={!canScroll}
              className={getWorkspaceTabRailActionClassName(showTabBaseline)}
            >
              {direction === -1 ? (
                <NavArrowLeft className="h-4 w-4" aria-hidden="true" />
              ) : (
                <NavArrowRight className="h-4 w-4" aria-hidden="true" />
              )}
            </IconButton>
          )}
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
              {tabs.length > 0
                ? tabs.map((tab, index) => (
                    <WorkspaceSortableTab
                      key={tab.id}
                      tabId={tab.id}
                      kind={tab.kind}
                      conversationId={tab.kind === "conversation" ? tab.conversationId : undefined}
                      title={tab.title}
                      icon={tab.icon}
                      dirty={tab.dirty}
                      preview={isWorkspacePreviewTab(tab)}
                      closable={tab.closable}
                      isActive={tab.id === activeTabId}
                      isFirstTab={index === 0}
                      previousTabIsActive={tabs[index - 1]?.id === activeTabId}
                      nextTabIsActive={tabs[index + 1]?.id === activeTabId}
                      badge={tab.badge ?? null}
                      draggable={tab.draggable}
                      showBaseline={showTabBaseline}
                      isRenaming={conversationRename?.tabId === tab.id}
                      renameDraft={conversationRename?.tabId === tab.id ? conversationRename.draft : ""}
                      renameInputRef={conversationRename?.tabId === tab.id ? renameInputRef : undefined}
                      onRenameDraftChange={(value) => {
                        if (conversationRename?.tabId !== tab.id) {
                          return;
                        }
                        setConversationRename({ ...conversationRename, draft: value });
                      }}
                      onRenameCommit={commitConversationRename}
                      onRenameCancel={cancelConversationRename}
                      onRenameBlur={handleRenameBlur}
                      onOpenConversationMenu={handleOpenConversationMenu}
                      onSelect={handleSelectTab}
                      onClose={closeTab}
                      onKeepOpen={keepTabOpen}
                    />
                  ))
                : emptyStateContent}
            </SortableContext>
          </DndContext>
        </HorizontalTabStrip>
        {actions ? (
          <div className="relative z-20 ml-2 flex flex-none items-center self-end pl-2.5">
            {actions}
          </div>
        ) : null}
      </div>
      {conversationMenuPortal}
    </>
  );
}

interface ConversationMenuTrigger {
  tabId: string;
  conversationId?: string;
  clientX: number;
  clientY: number;
  trigger: HTMLElement;
}

interface WorkspaceSortableTabProps {
  tabId: string;
  kind: WorkspaceTabKind;
  conversationId?: string;
  title: string;
  icon?: ReactNode;
  dirty: boolean;
  preview?: boolean;
  closable: boolean;
  isActive: boolean;
  isFirstTab: boolean;
  previousTabIsActive: boolean;
  nextTabIsActive: boolean;
  badge: string | null;
  draggable?: boolean;
  showBaseline: boolean;
  isRenaming?: boolean;
  renameDraft?: string;
  renameInputRef?: React.RefObject<HTMLInputElement | null>;
  onRenameDraftChange?: (value: string) => void;
  onRenameCommit?: () => void;
  onRenameCancel?: (options?: { ignoreBlur?: boolean }) => void;
  onRenameBlur?: () => void;
  onOpenConversationMenu?: (params: ConversationMenuTrigger) => void;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onKeepOpen: (tabId: string) => void;
}

function WorkspaceSortableTab({
  tabId,
  kind,
  conversationId,
  title,
  icon,
  dirty,
  preview = false,
  closable,
  isActive,
  isFirstTab,
  previousTabIsActive,
  nextTabIsActive,
  badge,
  draggable = true,
  showBaseline,
  isRenaming = false,
  renameDraft = "",
  renameInputRef,
  onRenameDraftChange,
  onRenameCommit,
  onRenameCancel,
  onRenameBlur,
  onOpenConversationMenu,
  onSelect,
  onClose,
  onKeepOpen,
}: WorkspaceSortableTabProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: tabId
  });

  const horizontalTransform = useMemo(() => {
    if (!transform) {
      return null;
    }
    return { ...transform, y: 0 };
  }, [transform]);

  const style = useMemo(
    () => ({
      transform: CSS.Transform.toString(horizontalTransform),
      transition
    }),
    [horizontalTransform, transition]
  );

  const dragListeners = draggable ? listeners : undefined;
  const {
    onPointerDown: onSortablePointerDown,
    onKeyDown: onSortableKeyDown,
    ...restSortableListeners
  } = dragListeners ?? {};
  const sortableActivatorAttributes = draggable ? attributes : {};
  const handleSelect = useCallback(() => {
    onSelect(tabId);
  }, [onSelect, tabId]);

  const hasContextMenu = kind === "conversation" || kind === "panel" || kind === "file";
  const handleContextMenu = useCallback(
    (event: MouseEvent) => {
      if (!hasContextMenu) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onOpenConversationMenu?.({
        tabId,
        conversationId,
        clientX: event.clientX,
        clientY: event.clientY,
        trigger: event.currentTarget.querySelector<HTMLElement>("[data-workspace-tab-trigger]") ?? event.currentTarget as HTMLElement,
      });
    },
    [conversationId, hasContextMenu, onOpenConversationMenu, tabId],
  );

  const handleClose = useCallback(() => {
    if (!closable) {
      return;
    }
    onClose(tabId);
  }, [closable, onClose, tabId]);
  const handleShellKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if ((event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) && hasContextMenu) {
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        onOpenConversationMenu?.({ tabId, conversationId, clientX: bounds.left, clientY: bounds.bottom, trigger: event.currentTarget });
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleSelect();
      }
    },
    [conversationId, handleSelect, hasContextMenu, onOpenConversationMenu, tabId],
  );
  const handleShellPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      handleSelect();
      onSortablePointerDown?.(event);
    },
    [handleSelect, onSortablePointerDown],
  );
  const handleShellCombinedKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      onSortableKeyDown?.(event);
      if (event.defaultPrevented) {
        return;
      }
      handleShellKeyDown(event);
    },
    [handleShellKeyDown, onSortableKeyDown],
  );

  const cursorClass = isDragging ? "cursor-grabbing" : "cursor-pointer";
  const closeButtonTone = isActive
    ? "text-slate-500 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:bg-white/[0.08]"
    : "text-slate-400 hover:bg-slate-200/70 dark:text-slate-500 dark:hover:bg-white/[0.08]";
  const tabBaseClassName = getWorkspaceTabBaseClassName(showBaseline);
  const activeClassName = getActiveWorkspaceTabClassName(showBaseline);
  const inactiveClassName = getInactiveWorkspaceTabClassName(showBaseline);
  // Radius belongs only on free edges. The first tab is normally attached:
  // it starts at exactly the rail's right edge (rail is w-[4rem]), so squaring
  // the top-left lets the rail's vertical divider run straight into a flat
  // edge instead of a curve pulling away from it. Applied to every first tab,
  // not just the active one, so the hover shape lines up too.
  //
  // The integrated macOS title bar offsets the whole strip to clear the
  // traffic lights, which makes that edge free -- so the same rule now
  // demands the opposite result, and the tab keeps its radius and its left
  // border like any other. Gate on whether the tab is actually flush rather
  // than on being first, or this becomes a platform exception bolted onto a
  // geometric rule.
  const startEdgeIsFlush = isFirstTab && !desktopTitleBarFree();
  const startEdgeClassName = [
    showBaseline && startEdgeIsFlush ? "!rounded-tl-none" : "",
    showBaseline && isActive && startEdgeIsFlush
      ? "!border-l-transparent dark:!border-l-transparent"
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group/tab relative inline-flex self-stretch ${showBaseline ? "items-end" : "items-start"} gap-2 ${isDragging ? "z-10" : ""}`}
      onContextMenu={handleContextMenu}
    >
      {!showBaseline && (isActive || !isRenaming) ? (
        <>
          <span
            aria-hidden="true"
            className={[
              `pointer-events-none absolute left-0 w-px bg-slate-200/70 transition-opacity ${DARK_DIVIDER_CLASS}`,
              "top-0 bottom-3",
              isActive
                ? "opacity-100"
                : !previousTabIsActive
                  ? "opacity-0 group-hover/tab:opacity-100"
                  : "opacity-0",
            ].join(" ")}
          />
          <span
            aria-hidden="true"
            className={[
              `pointer-events-none absolute right-0 w-px bg-slate-200/70 transition-opacity ${DARK_DIVIDER_CLASS}`,
              "top-0 bottom-3",
              isActive
                ? "opacity-100"
                : !nextTabIsActive
                  ? "opacity-0 group-hover/tab:opacity-100"
                  : "opacity-0",
            ].join(" ")}
          />
        </>
      ) : null}
      <div
        ref={setActivatorNodeRef}
        className={[
          "group outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/10 focus-visible:ring-offset-0 dark:focus-visible:ring-white/12",
          tabBaseClassName,
          isActive ? activeClassName : inactiveClassName,
          startEdgeClassName,
          isRenaming ? "opacity-0" : "",
          cursorClass,
        ]
          .filter(Boolean)
          .join(" ")}
        role="button"
        tabIndex={0}
        data-workspace-tab-trigger={tabId}
        data-workspace-tab-active={isActive || undefined}
        title={preview ? `${title} · Preview — double-click to keep open` : title}
        aria-label={preview ? `${title}, preview tab${badge ? `, ${badge} unread messages` : ""}` : undefined}
        aria-haspopup={hasContextMenu ? "menu" : undefined}
        onPointerDown={handleShellPointerDown}
        onClick={handleSelect}
        onDoubleClick={(event) => {
          if (preview && !(event.target as HTMLElement).closest("button")) {
            onKeepOpen(tabId);
          }
        }}
        onKeyDown={handleShellCombinedKeyDown}
        {...sortableActivatorAttributes}
        {...restSortableListeners}
        >
        <div
          className="min-w-0 flex flex-1 items-center justify-start gap-1.5 text-inherit"
          data-tab-id={tabId}
          data-tab-kind={kind}
          data-conversation-id={conversationId}
          data-preview={preview || undefined}
          aria-current={isActive ? "page" : undefined}
        >
          {icon ? (
            <span aria-hidden="true" className="shrink-0">
              {icon}
            </span>
          ) : null}
          <span className={`min-w-0 flex-1 truncate ${preview ? "italic" : ""}`}>{title}</span>
          {badge ? (
            <span
              className={[
                "inline-flex h-4 min-w-[1rem] shrink-0 items-center justify-center rounded-full px-1 text-3xs font-semibold leading-none text-white",
                isActive ? "bg-primary-600 dark:bg-primary-500" : "bg-primary-500/90 dark:bg-primary-500/85",
              ].join(" ")}
              aria-label={`${badge} unread messages`}
            >
              {badge}
            </span>
          ) : null}
          {dirty ? <span className="text-xs text-rose-400">●</span> : null}
        </div>
        {closable && !isRenaming ? (
          <IconButton
            type="button"
            aria-label={`Close ${title}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              handleClose();
            }}
            variant="ghost"
            size="xs"
            radius="full"
            className={`${closeButtonTone} focus-visible:ring-offset-0`}
          >
            <Xmark className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
        ) : null}
      </div>
    
      {isRenaming ? (
        <div
          className={`absolute inset-x-0 ${showBaseline ? "bottom-0" : "top-0"} z-10 flex`}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div
            className={[
              tabBaseClassName,
              "w-full items-center text-base sm:text-sm",
              isActive ? activeClassName : inactiveClassName,
              startEdgeClassName,
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <input
              ref={renameInputRef}
              value={renameDraft}
              onChange={(event) => onRenameDraftChange?.(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onRenameCommit?.();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  onRenameCancel?.({ ignoreBlur: true });
                }
              }}
              onBlur={() => onRenameBlur?.()}
              data-testid="conversation-tab-rename-input"
              className="min-w-0 flex-1 bg-transparent font-medium text-inherit outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500"
              aria-label="Rename conversation"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
