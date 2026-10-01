import { useLayoutEffect, useRef, useState } from "react";
import { Globe, Page } from "iconoir-react";
import { useCode } from "../code/useCode";
import { useWorkspaceTabs } from "./WorkspaceTabsProvider";
import { ConversationSurfaceTabs, type ConversationSurface } from "./ConversationSurfaceLayout";
import { closeConversationFile, conversationFileLabel, selectConversationView } from "./conversationSurfaces";

/** One view bar for the selected task, including routes rendered outside ChatPanel. */
export function ConversationWorkspaceViews() {
  const { conversationWorkspace, conversationWorkspaceScope: scope, conversationSurfaces,
    conversationBrowser, activeTab, tabs, openConversationTab, focusTab, closeTab, requestUrlPush } = useWorkspaceTabs();
  const { workspace } = useCode();
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [activeTab?.id, conversationWorkspace, scope]);
  if (!conversationWorkspace || !scope || !activeTab ||
    (activeTab.kind !== "conversation" && !activeTab.workspaceOwner)) return null;
  const conversationId = activeTab.kind === "conversation" ? activeTab.conversationId : activeTab.workspaceOwner!.conversationId;
  const surfaces = conversationSurfaces.read(scope);
  const ownedViews = tabs.filter(tab => tab.workspaceOwner?.conversationId === conversationId);
  const hasBrowser = conversationBrowser.available;
  const dirty = new Set(workspace.files.filter(file => file.modified !== file.generated).map(file => file.path));
  const resources: ConversationSurface[] = [
    ...(hasBrowser ? [{ id: "browser", label: "Browser", panelId: "conversation-workspace-browser", icon: <Globe className="h-3.5 w-3.5" />,
      attention: conversationBrowser.attention ? <span className="text-amber-600">Approve</span> : undefined }] : []),
    ...surfaces.files.map(file => ({ id: file.id, label: conversationFileLabel(file, surfaces.files), title: file.path,
      panelId: "conversation-workspace-file", icon: <Page className="h-3.5 w-3.5" />, dirty: dirty.has(file.path),
      onClose: () => conversationSurfaces.update(scope, state => closeConversationFile(state, file.id, hasBrowser)),
    })),
    ...ownedViews.map(tab => ({ id: tab.id, label: tab.title, panelId: "conversation-workspace-resource", icon: tab.icon,
      dirty: tab.dirty, onClose: () => closeTab(tab.id),
    })),
  ];
  const baseView = activeTab.kind === "conversation";
  const activeId = baseView ? (surfaces.activeId === "browser" && !hasBrowser ? "chat" : surfaces.activeId) : activeTab.id;
  const resourceId = surfaces.resourceId === "browser" && !hasBrowser ? surfaces.files[0]?.id ?? "browser" : surfaces.resourceId;
  const canSplit = baseView && width >= 1024 && (hasBrowser || surfaces.files.length > 0);
  return <div ref={root} className="min-w-0 shrink-0" data-testid="conversation-workspace-views">
    <ConversationSurfaceTabs chatPanelId="conversation-workspace-chat" resources={resources}
      activeId={activeId} resourceId={resourceId} split={canSplit && surfaces.split} wide={canSplit} ratio={surfaces.ratio}
      onSelect={id => {
        requestUrlPush();
        if (ownedViews.some(tab => tab.id === id)) { focusTab(id); return; }
        conversationSurfaces.update(scope, state => selectConversationView(state, id));
        openConversationTab(conversationId);
      }}
      onSplitChange={split => conversationSurfaces.update(scope, state => ({ ...state, split }))} />
  </div>;
}
