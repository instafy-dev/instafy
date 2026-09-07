import { Capacitor } from "@capacitor/core";
import { useEffect, useRef, type ReactNode } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";

interface SidebarStatusBarSession {
  users: number;
  revision: number;
  bridge: Promise<{
    StatusBar: typeof import("@capacitor/status-bar")["StatusBar"];
    initialOverlay: boolean;
  }>;
  pending: Promise<void>;
}

let sidebarStatusBarSession: SidebarStatusBarSession | null = null;

function acquireSidebarStatusBar() {
  // Keep the original state until every queued restore finishes. A quick reopen
  // (or StrictMode remount) must not snapshot our temporary overlay as the baseline.
  const session = sidebarStatusBarSession ??= {
    users: 0,
    revision: 0,
    bridge: import("@capacitor/status-bar").then(async ({ StatusBar }) => {
      const initial = await StatusBar.getInfo().catch(() => null);
      return { StatusBar, initialOverlay: initial?.overlays ?? false };
    }),
    pending: Promise.resolve(),
  };
  session.users += 1;

  const applyOverlay = () => {
    const revision = ++session.revision;
    session.pending = session.pending
      .then(async () => {
        const { StatusBar, initialOverlay } = await session.bridge;
        // Resolve the latest ownership after async work, not at request time.
        await StatusBar.setOverlaysWebView({ overlay: session.users > 0 ? true : initialOverlay });
      })
      .catch(() => undefined)
      .finally(() => {
        if (session.users === 0 && revision === session.revision && sidebarStatusBarSession === session) {
          sidebarStatusBarSession = null;
        }
      });
  };
  applyOverlay();

  return {
    applyOverlay,
    release: () => {
      session.users -= 1;
      applyOverlay();
    },
  };
}

/** The sidebar alone paints behind iOS system chrome; normal screens keep the native bar. */
function useSidebarStatusBarOverlay() {
  useEffect(() => {
    if (Capacitor.getPlatform() !== "ios") {
      return;
    }

    let active = true;
    let appStateListener: { remove: () => Promise<void> } | undefined;
    const { applyOverlay, release } = acquireSidebarStatusBar();
    // Capacitor restores the static (non-overlay) bar when its view reappears.
    window.addEventListener("focus", applyOverlay);
    void import("@capacitor/app")
      .then(({ App }) =>
        App.addListener("appStateChange", ({ isActive }) => {
          if (active && isActive) {
            applyOverlay();
          }
        }),
      )
      .then((listener) => {
        if (!active) {
          void listener.remove();
        } else {
          appStateListener = listener;
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
      window.removeEventListener("focus", applyOverlay);
      void appStateListener?.remove();
      release();
    };
  }, []);
}

export function StudioMobileSidebarOverlay({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  useSidebarStatusBarOverlay();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useNativeBackButtonAction(true, () => {
    // Use the same dismissal path as Escape: a focused Team & spaces drill-in
    // consumes it first, and React Aria dismisses only the topmost modal. Native
    // Back must not fall through to WebView history while navigation is open.
    const target = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : dialogRef.current;
    target?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => { if (!open) onClose(); }}
      isDismissable
      className="fixed inset-0 z-50 bg-slate-900/30 backdrop-blur-sm"
      data-testid="mobile-sidebar-overlay"
    >
      <Modal
        className="absolute inset-y-0 left-0 max-w-[calc(100vw-2rem)] border-r border-slate-200/70 bg-slate-50/80 outline-none dark:border-[color:var(--color-studio-dark-divider)] dark:bg-[var(--color-studio-dark-rail)]"
        data-testid="mobile-sidebar-surface"
        style={{
          // Inset controls, never the painted surface (including the home-indicator area).
          paddingTop: "var(--instafy-safe-area-inset-top)",
          paddingBottom: "var(--instafy-safe-area-inset-bottom)",
          paddingLeft: "var(--instafy-safe-area-inset-left)",
        }}
      >
        <Dialog ref={dialogRef} aria-label="Navigation and recent chats" className="h-full outline-none">
          {children}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
