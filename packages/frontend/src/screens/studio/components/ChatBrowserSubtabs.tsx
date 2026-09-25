import { ConversationSurfaceTabs } from "../../../workspace/ConversationSurfaceLayout";
export type ChatBrowserSubtab = "chat" | "browser";

/** Compatibility for standalone browser surfaces using the workspace tab primitive. */
export function ChatBrowserSubtabs({ activeTab, browserPanelId, browserAttention = false, chatPanelId, onTabChange }: {
  activeTab: ChatBrowserSubtab;
  browserPanelId: string;
  browserAttention?: boolean;
  chatPanelId: string;
  onTabChange: (tab: ChatBrowserSubtab) => void;
}) {
  return <ConversationSurfaceTabs
    activeId={activeTab} resourceId="browser" chatPanelId={chatPanelId}
    split={false} wide={false} ratio={0.55} onSplitChange={() => {}}
    onSelect={id => onTabChange(id as ChatBrowserSubtab)}
    resources={[{ id: "browser", label: "Browser", panelId: browserPanelId,
      attention: browserAttention ? <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-400/15 dark:text-amber-200" data-testid="shared-browser-approval-attention">Approve</span> : undefined,
    }]}
  />;
}
