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
  chatPanelId: string;
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
  chatPanelId, resources, activeId, resourceId, split, wide, ratio, onSelect, onSplitChange,
}: ConversationSurfaceTabsProps) {
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
  return resources.length ? (
    <div className={`flex min-w-0 shrink-0 items-center border-b border-slate-200/70 bg-white ${DARK_DIVIDER_BORDER_CLASS} ${DARK_PANEL_BG_CLASS}`} data-testid="conversation-subtabs" data-browser-session-safe-zone="true">
      {split ? <div className="flex shrink-0 items-center gap-1.5 px-4 text-xs text-slate-500 dark:text-slate-400" style={{ width: `calc((1 - var(--conversation-resource-ratio, ${ratio})) * 100%)` }}><ChatBubble className="h-3.5 w-3.5" aria-hidden="true" />Chat</div> : null}
      <div className="flex min-w-0 flex-1 items-center" role="tablist" aria-label="Conversation views">
        <HorizontalTabStrip
          activeItemId={selected} className="min-w-0 flex-1" contentClassName="flex w-max items-center" testId="conversation-resource-tabs"
          renderScrollControl={({ direction, canScroll, scrollByDirection }) => (
            <IconButton aria-label={direction === -1 ? "Scroll views left" : "Scroll views right"} variant="ghost" size="sm" radius="none" isDisabled={!canScroll} onPress={() => scrollByDirection(direction)} className="h-9 w-8 max-[540px]:h-10">
              {direction === -1 ? <NavArrowLeft className="h-4 w-4" /> : <NavArrowRight className="h-4 w-4" />}
            </IconButton>
          )}
        >
          {views.map((view, index) => (
            <div key={view.id} data-tab-id={view.id} className={`flex shrink-0 items-center border-b-2 ${selected === view.id ? "border-current text-slate-900 dark:text-slate-100" : "border-transparent text-slate-500 dark:text-slate-400"}`}>
              <button
                ref={node => { if (node) tabs.current.set(view.id, node); else tabs.current.delete(view.id); }}
                type="button" role="tab" aria-controls={view.panelId}
                aria-selected={selected === view.id} tabIndex={selected === view.id ? 0 : -1}
                aria-label={[view.label, view.dirty ? "unsaved changes" : null, view.attention ? "approval needed" : null].filter(Boolean).join(", ")}
                title={view.title ?? view.label}
                data-testid={`conversation-subtab-${view.id}`}
                className={`flex h-9 max-w-52 items-center gap-1.5 px-3 text-xs hover:bg-slate-100/80 ${DARK_RAIL_HOVER_CLASS} ${TAB_FOCUS_CLASS} max-[540px]:h-10 pointer-coarse:min-h-11 pointer-coarse:max-w-40`}
                onClick={() => onSelect(view.id)}
                onKeyDown={event => {
                  if (event.key === "Delete" && view.onClose) { event.preventDefault(); close(view); return; }
                  const next = event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : event.key === "ArrowRight" ? (index + 1) % views.length : event.key === "ArrowLeft" ? (index + views.length - 1) % views.length : null;
                  if (next === null) return;
                  event.preventDefault();
                  onSelect(views[next].id);
                  tabs.current.get(views[next].id)?.focus();
                }}
              ><TabLabel label={view.label} icon={view.icon} dirty={view.dirty}>{view.attention}</TabLabel></button>
              {view.onClose ? <TabCloseButton label={`Close ${view.label} view`} onClose={() => close(view)} className="mr-1 text-inherit" /> : null}
            </div>
          ))}
        </HorizontalTabStrip>
      </div>
      {wide ? <IconButton variant="ghost" size="sm" radius="none" title={split ? "Show one view" : "Show side by side"} aria-label={split ? "Show one view" : "Show side by side"} aria-pressed={split} onPress={() => onSplitChange(!split)} className="mx-1 shrink-0"><ViewColumns3 className="h-4 w-4" /></IconButton> : null}
    </div>
  ) : null;
}

export function ConversationSurfaceLayout({
  chat, content, onRatioChange, onRatioPreview, ...tabs
}: ConversationSurfaceTabsProps & {
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
    <ConversationSurfaceTabs {...tabs} />
    <div className="min-h-0 flex-1">
      <ResizablePanels main={chat} side={content} mode={tabs.split ? "split" : tabs.activeId === "chat" || !tabs.resources.length ? "main" : "side"} ratio={tabs.ratio} minRatio={0.35} maxRatio={0.7} onRatioChange={onRatioChange} onRatioPreview={previewRatio} />
    </div>
  </div>;
}
