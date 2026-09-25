import { useId, useRef, type ReactNode } from "react";
import { ChatBubble, ViewColumns3, Xmark } from "iconoir-react";
import { ResizablePanels } from "../components/ResizablePanels";
import { HorizontalTabStrip } from "../components/tabs/HorizontalTabStrip";

export type ConversationSurface = {
  id: string;
  label: string;
  panelId: string;
  icon?: ReactNode;
  attention?: ReactNode;
  onClose?: () => void;
};

export function ConversationSurfaceTabs({
  chatPanelId, resources, activeId, resourceId, split, wide, ratio,
  onSelect, onSplitChange,
}: {
  chatPanelId: string;
  resources: ConversationSurface[];
  activeId: string;
  resourceId: string;
  split: boolean;
  wide: boolean;
  ratio: number;
  onSelect: (id: string) => void;
  onSplitChange: (split: boolean) => void;
}) {
  const id = useId();
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const views: ConversationSurface[] = split ? resources : [
    { id: "chat", label: "Chat", panelId: chatPanelId, icon: <ChatBubble className="h-3.5 w-3.5" /> }, ...resources,
  ];
  const selected = split ? resourceId : activeId;
  return resources.length ? (
    <div className="flex min-w-0 shrink-0 items-center border-b border-slate-200/70 dark:border-slate-800" data-testid="conversation-subtabs" data-browser-session-safe-zone="true">
      {split ? <div className="shrink-0 px-4 text-xs text-slate-500 dark:text-slate-400" style={{ width: `${(1 - ratio) * 100}%` }}>Chat</div> : null}
      <div className="flex min-w-0 flex-1 items-center" role="tablist" aria-label="Conversation views">
        <HorizontalTabStrip activeItemId={selected} className="min-w-0 flex-1" contentClassName="flex w-max items-center" testId="conversation-resource-tabs">
          {views.map((view, index) => (
            <div key={view.id} className={`flex shrink-0 items-center border-b-2 ${selected === view.id ? "border-primary-500 text-slate-900 dark:text-slate-100" : "border-transparent text-slate-500 dark:text-slate-400"}`}>
              <button
                ref={node => { if (node) tabs.current.set(view.id, node); else tabs.current.delete(view.id); }}
                id={`${id}-tab-${index}`} type="button" role="tab" aria-controls={view.panelId}
                aria-selected={selected === view.id} tabIndex={selected === view.id ? 0 : -1}
                aria-label={view.attention ? `${view.label}, approval needed` : view.label}
                data-tab-id={view.id} data-testid={`conversation-subtab-${view.id}`}
                className="flex h-9 max-w-52 items-center gap-1.5 px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 max-[540px]:h-10 pointer-coarse:min-h-11"
                onClick={() => onSelect(view.id)}
                onKeyDown={event => {
                  const next = event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : event.key === "ArrowRight" ? (index + 1) % views.length : event.key === "ArrowLeft" ? (index + views.length - 1) % views.length : null;
                  if (next === null) return;
                  event.preventDefault();
                  onSelect(views[next].id);
                  tabs.current.get(views[next].id)?.focus();
                }}
              >{view.icon}<span className="truncate">{view.label}</span>{view.attention}</button>
              {view.onClose ? <button type="button" className="mr-1 rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label={`Close ${view.label} view`} onClick={view.onClose}><Xmark className="h-3.5 w-3.5" /></button> : null}
            </div>
          ))}
        </HorizontalTabStrip>
      </div>
      {wide ? <button type="button" className="mx-1 shrink-0 rounded p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" title={split ? "Show one view" : "Show side by side"} aria-label={split ? "Show one view" : "Show side by side"} aria-pressed={split} onClick={() => onSplitChange(!split)}><ViewColumns3 className="h-4 w-4" /></button> : null}
    </div>
  ) : null;
}

export function ConversationSurfaceLayout({
  chat, chatPanelId, resources, content, activeId, resourceId, split, wide, ratio,
  onSelect, onSplitChange, onRatioChange,
}: {
  chat: ReactNode;
  chatPanelId: string;
  resources: ConversationSurface[];
  content: ReactNode;
  activeId: string;
  resourceId: string;
  split: boolean;
  wide: boolean;
  ratio: number;
  onSelect: (id: string) => void;
  onSplitChange: (split: boolean) => void;
  onRatioChange: (ratio: number) => void;
}) {
  return <div className="flex min-h-0 flex-1 flex-col" data-testid="conversation-surface-layout" data-layout={split ? "split" : "single"}>
    <ConversationSurfaceTabs chatPanelId={chatPanelId} resources={resources} activeId={activeId} resourceId={resourceId} split={split} wide={wide} ratio={ratio} onSelect={onSelect} onSplitChange={onSplitChange} />
    <div className="min-h-0 flex-1">
      <ResizablePanels main={chat} side={content} sideVisible={split} mode={split ? "split" : activeId === "chat" || !resources.length ? "main" : "side"} ratio={ratio} minRatio={0.35} maxRatio={0.7} onRatioChange={onRatioChange} />
    </div>
  </div>;
}
