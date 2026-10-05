import { useCallback, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { ChatBubble, NavArrowLeft, NavArrowRight, ViewColumns3 } from "iconoir-react";
import { IconButton } from "../components/Button";
import { ResizablePanels } from "../components/ResizablePanels";
import { HorizontalTabStrip } from "../components/tabs/HorizontalTabStrip";
import { TabLabel, TabCloseButton, TAB_FOCUS_CLASS } from "../components/tabs/TabPresentation";
import { DARK_DIVIDER_BORDER_CLASS, DARK_PANEL_BG_CLASS, DARK_RAIL_HOVER_CLASS } from "../theme/darkSurfaces";

export type ConversationSurface = {
  id: string;
  label: string;
  title?: string;
  panelId: string;
  icon?: ReactNode;
  dirty?: boolean;
  attention?: ReactNode;
  onClose?: () => void;
};

type ConversationSurfaceTabsProps = {
  presentation?: "header" | "composer";
  chatPanelId: string;
  chatActions?: ReactNode;
  resources: ConversationSurface[];
  activeId: string;
  resourceId: string;
  split: boolean;
  wide: boolean;
  ratio: number;
  onSelect: (id: string) => void;
  onSplitChange: (split: boolean) => void;
};

export function ConversationSurfaceTabs({
  chatPanelId, chatActions, resources, activeId, resourceId, split, wide, ratio, onSelect, onSplitChange, presentation = "header",
}: ConversationSurfaceTabsProps) {
  const besideComposer = presentation === "composer";
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const restoreFocus = useRef(false);
  const views: ConversationSurface[] = split ? resources : [
    { id: "chat", label: "Chat", panelId: chatPanelId, icon: <ChatBubble className="h-3.5 w-3.5" /> }, ...resources,
  ];
  const selected = split ? resourceId : activeId;
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    const target = tabs.current.get(selected) ?? document.getElementById(chatPanelId);
    target?.focus();
  }, [selected, resources.length, chatPanelId]);
  const close = (view: ConversationSurface) => {
    if (!view.onClose) return;
    restoreFocus.current = true;
    view.onClose();
  };
  return resources.length || chatActions ? (
    <div className={`flex min-w-0 shrink-0 items-center ${besideComposer ? "rounded-2xl bg-slate-100/90 p-1 dark:bg-slate-800/80" : `border-b border-slate-200/70 bg-white ${DARK_DIVIDER_BORDER_CLASS} ${DARK_PANEL_BG_CLASS}`}`} data-testid="conversation-subtabs" data-presentation={presentation} data-browser-session-safe-zone="true">
      {split || !resources.length ? <div data-testid="conversation-chat-toolbar" className="flex min-w-0 shrink-0 items-center gap-1.5 px-4 text-xs text-slate-500 dark:text-slate-400" style={{ width: split ? `calc((1 - var(--conversation-resource-ratio, ${ratio})) * 100%)` : "100%" }}>
        <ChatBubble className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>Chat</span><div className="ml-auto">{chatActions}</div>
      </div> : null}
      <div hidden={!resources.length} className="flex min-w-0 flex-1 items-center" role="tablist" aria-label="Conversation views">
        <HorizontalTabStrip
          activeItemId={selected} className="min-w-0 flex-1" contentClassName={besideComposer ? "flex w-max min-w-full items-center gap-1" : "flex w-max items-center"} testId="conversation-resource-tabs"
          renderScrollControl={({ direction, canScroll, scrollByDirection }) => (
            <IconButton aria-label={direction === -1 ? "Scroll views left" : "Scroll views right"} variant="ghost" size="sm" radius="none" isDisabled={!canScroll} onPress={() => scrollByDirection(direction)} className="h-9 w-8 max-[540px]:h-10">
              {direction === -1 ? <NavArrowLeft className="h-4 w-4" /> : <NavArrowRight className="h-4 w-4" />}
            </IconButton>
          )}
        >
          {views.map((view, index) => (
            <div key={view.id} data-tab-id={view.id} className={`flex shrink-0 items-center ${besideComposer ? `flex-1 rounded-xl ${selected === view.id ? "bg-white shadow-sm dark:bg-slate-700" : ""}` : ""} ${selected === view.id ? "text-slate-900 dark:text-slate-100" : "text-slate-500 dark:text-slate-400"}`}>
              <button
                ref={node => { if (node) tabs.current.set(view.id, node); else tabs.current.delete(view.id); }}
                type="button" role="tab" aria-controls={view.panelId}
                aria-selected={selected === view.id} tabIndex={selected === view.id ? 0 : -1}
                aria-label={[view.label, view.dirty ? "unsaved changes" : null, view.attention ? "approval needed" : null].filter(Boolean).join(", ")}
                title={view.title ?? view.label}
                data-testid={`conversation-subtab-${view.id}`}
                className={`relative flex min-h-11 max-w-52 items-center gap-1.5 px-3 ${besideComposer ? "flex-1 justify-center rounded-xl text-sm aria-selected:font-medium aria-selected:text-primary-700 dark:aria-selected:text-primary-300 forced-colors:aria-selected:outline" : "text-xs hover:bg-slate-100/80 after:pointer-events-none after:absolute after:inset-x-3 after:bottom-0 after:h-[1.5px] after:rounded-full aria-selected:after:bg-primary-600 dark:aria-selected:after:bg-primary-400 forced-colors:aria-selected:after:bg-[Highlight]"} ${DARK_RAIL_HOVER_CLASS} ${TAB_FOCUS_CLASS} ${besideComposer ? "" : "pointer-coarse:max-w-40"}`}
                onClick={() => onSelect(view.id)}
                onKeyDown={event => {
                  if (event.key === "Delete" && view.onClose) { event.preventDefault(); close(view); return; }
                  const next = event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : event.key === "ArrowRight" ? (index + 1) % views.length : event.key === "ArrowLeft" ? (index + views.length - 1) % views.length : null;
                  if (next === null) return;
                  event.preventDefault();
                  onSelect(views[next].id);
                  tabs.current.get(views[next].id)?.focus();
                }}
              ><span className={besideComposer ? "inline-flex min-w-0 max-w-full items-center gap-1.5" : "contents"}><TabLabel label={view.label} icon={view.icon} dirty={view.dirty}>{view.attention}</TabLabel></span></button>
              {view.onClose ? <TabCloseButton label={`Close ${view.label} view`} onClose={() => close(view)} className="mr-1 text-inherit" /> : null}
            </div>
          ))}
        </HorizontalTabStrip>
      </div>
      {!split && resources.length > 0 && activeId === "chat" ? chatActions : null}
      {wide ? <IconButton variant="ghost" size="sm" radius="none" title={split ? "Show one view" : "Show side by side"} aria-label={split ? "Show one view" : "Show side by side"} aria-pressed={split} onPress={() => onSplitChange(!split)} className="mx-1 shrink-0"><ViewColumns3 className="h-4 w-4" /></IconButton> : null}
    </div>
  ) : null;
}

export function ConversationSurfaceLayout({
  chat, content, onRatioChange, onRatioPreview, showTabs = true, ...tabs
}: ConversationSurfaceTabsProps & {
  showTabs?: boolean;
  chat: ReactNode;
  content: ReactNode;
  onRatioChange: (ratio: number) => void;
  onRatioPreview?: (ratio: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const previewRatio = useCallback((ratio: number) => {
    root.current?.style.setProperty("--conversation-resource-ratio", String(ratio));
    onRatioPreview?.(ratio);
  }, [onRatioPreview]);
  return <div ref={root} className="flex min-h-0 flex-1 flex-col" data-testid="conversation-surface-layout" data-layout={tabs.split ? "split" : "single"} style={{ "--conversation-resource-ratio": tabs.ratio } as CSSProperties}>
    {showTabs ? <ConversationSurfaceTabs {...tabs} /> : null}
    <div className="min-h-0 flex-1">
      <ResizablePanels main={chat} side={content} mode={tabs.split ? "split" : tabs.activeId === "chat" || !tabs.resources.length ? "main" : "side"} ratio={tabs.ratio} minRatio={0.35} maxRatio={0.7} onRatioChange={onRatioChange} onRatioPreview={previewRatio} />
    </div>
  </div>;
}
