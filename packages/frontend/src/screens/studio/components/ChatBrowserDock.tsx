import { LazyBrowserSessionModal } from "./LazyBrowserSessionModal";
import { BrowserSessionPageStrip } from "./BrowserSessionPageStrip";
import type { BrowserSessionPage } from "./browserSessionPages";

export function ChatBrowserDock({
  browserModalBottomInset,
  browserSessionOpen,
  onBrowserSessionOpenChange,
  projectId,
  preferredRuntimeId,
  showBrowserSessionPageStrip,
  browserSessionExpandRequestToken,
  onBrowserRuntimeIdResolved,
  browserPageStripBottomInset,
  browserSessionPages,
  onSelectBrowserSessionPage,
  onToggleBrowserSession,
  onClearPendingNewBrowserSession,
  hasHiddenBrowserSession,
  pendingBrowserLaunchMode,
  renderModal = true,
}: {
  browserModalBottomInset?: string;
  browserSessionOpen: boolean;
  onBrowserSessionOpenChange: (open: boolean) => void;
  projectId: string | null;
  preferredRuntimeId: string | null;
  showBrowserSessionPageStrip: boolean;
  browserSessionExpandRequestToken: number;
  onBrowserRuntimeIdResolved: (runtimeId: string) => void;
  browserPageStripBottomInset?: string;
  browserSessionPages: BrowserSessionPage[];
  onSelectBrowserSessionPage: (pageId: string) => void;
  onToggleBrowserSession: () => void;
  onClearPendingNewBrowserSession: () => void;
  hasHiddenBrowserSession: boolean;
  pendingBrowserLaunchMode: "new_page" | null;
  renderModal?: boolean;
}) {
  return (
    <>
      {renderModal ? (
        <div
          className="relative z-30"
          style={browserSessionOpen && browserModalBottomInset ? { marginBottom: browserModalBottomInset } : undefined}
        >
          <LazyBrowserSessionModal
            isOpen={browserSessionOpen}
            onOpenChange={onBrowserSessionOpenChange}
            projectId={projectId}
            preferRuntimeId={preferredRuntimeId}
            hideCollapsedConnectedCard={showBrowserSessionPageStrip}
            expandRequestToken={browserSessionExpandRequestToken}
            presentation="docked"
            onRuntimeIdResolved={onBrowserRuntimeIdResolved}
          />
        </div>
      ) : null}

      {showBrowserSessionPageStrip ? (
        <div
          className="relative z-30"
          style={browserPageStripBottomInset ? { marginBottom: browserPageStripBottomInset } : undefined}
        >
          <BrowserSessionPageStrip
            pages={browserSessionPages}
            onSelectPage={onSelectBrowserSessionPage}
            onToggleBrowser={onToggleBrowserSession}
            onClearPendingNewBrowser={onClearPendingNewBrowserSession}
            browserHidden={hasHiddenBrowserSession}
            browserOpen={browserSessionOpen}
            pendingNewBrowser={pendingBrowserLaunchMode === "new_page"}
          />
        </div>
      ) : null}
    </>
  );
}
