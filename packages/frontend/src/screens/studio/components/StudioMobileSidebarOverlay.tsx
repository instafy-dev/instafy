import { Capacitor } from "@capacitor/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMobileSidebarViewport } from "./useMobileSidebarViewport";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { DARK_RAIL_SURFACE_CLASS } from "../../../theme/darkSurfaces";
import { Button } from "../../../components/Button";
import { NavArrowDown } from "iconoir-react";

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
function useSidebarStatusBarOverlay(enabled: boolean) {
  useEffect(() => {
    if (!enabled || Capacitor.getPlatform() !== "ios") {
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
  }, [enabled]);
}

export function StudioMobileSidebarOverlay({
  children,
  onClose,
  presentation = "side",
  compact = false,
  showCloseFooter = true,
}: {
  children: ReactNode;
  onClose: () => void;
  presentation?: "side" | "bottom";
  compact?: boolean;
  showCloseFooter?: boolean;
}) {
  const bottomSheet = presentation === "bottom";
  useSidebarStatusBarOverlay(!bottomSheet);
  const { controlsRef, style, sheetStyle } = useMobileSidebarViewport();
  const dragOrigin = useRef<{ id: number; y: number } | null>(null);
  const suppressHandleClick = useRef(false);
  const [dragOffset, setDragOffset] = useState(0);
  const Handle = showCloseFooter ? "div" : "button";

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => { if (!open) onClose(); }}
      isDismissable
      className="fixed inset-0 z-[70] bg-slate-900/30 backdrop-blur-sm"
      data-testid="mobile-sidebar-overlay"
    >
      <Modal
        className={`${bottomSheet
          ? "absolute inset-x-0 bottom-0 mx-auto h-[min(36rem,78dvh)] w-full max-w-lg overflow-hidden rounded-t-[1.75rem] border border-b-0 border-slate-200/70 shadow-2xl"
          : "absolute inset-y-0 left-0 max-w-[calc(100vw-2rem)] border-r border-slate-200/70"} bg-slate-50 outline-none ${DARK_RAIL_SURFACE_CLASS}`}
        data-testid="mobile-sidebar-surface"
        data-presentation={presentation}
        style={bottomSheet ? {
          ...sheetStyle,
          maxHeight: compact ? "24rem" : undefined,
          paddingBottom: "var(--instafy-safe-area-inset-bottom)",
          paddingLeft: "var(--instafy-safe-area-inset-left)",
          paddingRight: "var(--instafy-safe-area-inset-right)",
          transform: dragOffset ? `translateY(${dragOffset}px)` : undefined,
        } : {
          // Inset controls, never the painted surface (including the home-indicator area).
          paddingTop: "var(--instafy-safe-area-inset-top)",
          paddingBottom: "var(--instafy-safe-area-inset-bottom)",
          paddingLeft: "var(--instafy-safe-area-inset-left)",
        }}
      >
        <Dialog aria-label="Navigation" className="h-full outline-none">
          <div ref={controlsRef} className="relative flex h-full min-h-0 flex-col" style={bottomSheet ? undefined : style} data-testid="mobile-sidebar-controls">
            {bottomSheet ? <Handle type={showCloseFooter ? undefined : "button"}
              aria-hidden={showCloseFooter || undefined} aria-label={showCloseFooter ? undefined : "Close navigation"}
              title={showCloseFooter ? undefined : "Close navigation"}
              className={`flex ${showCloseFooter ? "h-7" : "h-11 w-full rounded-t-[1.75rem] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-400"} shrink-0 touch-none items-center justify-center`}
              data-testid="mobile-navigation-sheet-handle"
              onClick={showCloseFooter ? undefined : () => { if (!suppressHandleClick.current) onClose(); }}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") suppressHandleClick.current = false; }}
              onPointerDown={(event) => {
                if (!event.isPrimary || event.button !== 0) return;
                suppressHandleClick.current = false;
                dragOrigin.current = { id: event.pointerId, y: event.clientY };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (dragOrigin.current?.id === event.pointerId) {
                  if (Math.abs(event.clientY - dragOrigin.current.y) > 8) suppressHandleClick.current = true;
                  setDragOffset(Math.max(0, event.clientY - dragOrigin.current.y));
                }
              }}
              onPointerUp={(event) => {
                if (dragOrigin.current?.id !== event.pointerId) return;
                const dismiss = event.clientY - dragOrigin.current.y > 48;
                if (Math.abs(event.clientY - dragOrigin.current.y) > 8) suppressHandleClick.current = true;
                dragOrigin.current = null; setDragOffset(0);
                if (dismiss) onClose();
              }}
              onPointerCancel={() => { suppressHandleClick.current = true; dragOrigin.current = null; setDragOffset(0); }}>
              <span className="h-1 w-9 rounded-full bg-slate-300 dark:bg-slate-600" />
            </Handle> : null}
            <div className="min-h-0 flex-1">{children}</div>
            {bottomSheet && showCloseFooter ? <div className="shrink-0 border-t border-slate-200/70 px-3 py-1 dark:border-white/10">
              <Button variant="ghost" className="!min-h-12 w-full gap-2" onPress={onClose} aria-label="Close navigation" data-testid="mobile-navigation-sheet-close">
                <NavArrowDown className="h-5 w-5" aria-hidden="true" /> Close
              </Button>
            </div> : null}
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
