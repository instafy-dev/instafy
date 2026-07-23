import { useId, useRef, type KeyboardEvent } from "react";
import { ChatBubble, Globe } from "iconoir-react";

export type ChatBrowserSubtab = "chat" | "browser";

export function ChatBrowserSubtabs({
  activeTab,
  browserPanelId,
  browserAttention = false,
  chatPanelId,
  onTabChange,
}: {
  activeTab: ChatBrowserSubtab;
  browserPanelId: string;
  browserAttention?: boolean;
  chatPanelId: string;
  onTabChange: (tab: ChatBrowserSubtab) => void;
}) {
  const id = useId();
  const chatTabRef = useRef<HTMLButtonElement | null>(null);
  const browserTabRef = useRef<HTMLButtonElement | null>(null);

  const selectFromKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentTab: ChatBrowserSubtab,
  ) => {
    let nextTab: ChatBrowserSubtab | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      nextTab = currentTab === "chat" ? "browser" : "chat";
    } else if (event.key === "Home") {
      nextTab = "chat";
    } else if (event.key === "End") {
      nextTab = "browser";
    }
    if (!nextTab) {
      return;
    }
    event.preventDefault();
    onTabChange(nextTab);
    (nextTab === "chat" ? chatTabRef : browserTabRef).current?.focus();
  };

  const tabClassName = (tab: ChatBrowserSubtab) =>
    [
      "flex items-center gap-1.5 rounded-[0.4rem] px-2.5 py-1 text-xs font-medium transition",
      "touch-manipulation max-[540px]:h-10 max-[540px]:px-3 pointer-coarse:min-h-11",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50",
      activeTab === tab
        ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-slate-100"
        : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200",
    ].join(" ");

  return (
    <div
      className="flex items-center px-3 py-1.5 sm:px-4"
      data-browser-session-safe-zone="true"
      data-testid="conversation-subtabs"
    >
      <div
        aria-label="Conversation views"
        className="inline-flex items-center gap-0.5 rounded-lg bg-slate-100/70 p-0.5 dark:bg-slate-800/50"
        role="tablist"
      >
        <button
          ref={chatTabRef}
          id={`${id}-chat`}
          type="button"
          role="tab"
          aria-controls={chatPanelId}
          aria-selected={activeTab === "chat"}
          tabIndex={activeTab === "chat" ? 0 : -1}
          className={tabClassName("chat")}
          data-testid="conversation-subtab-chat"
          onClick={() => onTabChange("chat")}
          onKeyDown={(event) => selectFromKeyboard(event, "chat")}
        >
          <ChatBubble className="h-3.5 w-3.5" aria-hidden="true" />
          Chat
        </button>
        <button
          ref={browserTabRef}
          id={`${id}-browser`}
          type="button"
          role="tab"
          aria-controls={browserPanelId}
          aria-selected={activeTab === "browser"}
          aria-label={browserAttention ? "Browser, approval needed" : "Browser"}
          tabIndex={activeTab === "browser" ? 0 : -1}
          className={tabClassName("browser")}
          data-testid="conversation-subtab-browser"
          onClick={() => onTabChange("browser")}
          onKeyDown={(event) => selectFromKeyboard(event, "browser")}
        >
          <Globe className="h-3.5 w-3.5" aria-hidden="true" />
          Browser
          {browserAttention ? (
            <span
              className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-amber-800 dark:bg-amber-400/15 dark:text-amber-200"
              data-testid="shared-browser-approval-attention"
            >
              Approve
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}
