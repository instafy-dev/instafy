import { useCallback, useEffect, useState } from "react";
import type { StatusIntent } from "../../../status/useStatus";
import { useBrowserSessionPages } from "./useBrowserSessionPages";
import type { BrowserTransport } from "./usePersonalBrowserBridge";

type UseChatComposerBrowserTargetingOptions = {
  activeConversationId: string | null;
  activeProjectId: string | null;
  browserSessionOpen: boolean;
  browserSessionId: string;
  sharedBrowserActivated: boolean;
  browserTransport: BrowserTransport;
  focusInput: (options?: { force?: boolean }) => void;
  hasHiddenBrowserSession: boolean;
  onHiddenBrowserSessionUnavailable: () => void;
  openBrowserSession: (runtimeId: string | null) => void;
  preferredBrowserRuntimeId: string | null;
  requestBrowserSessionExpand: () => void;
  resolvedBrowserRuntimeId: string | null;
  showStatus: (message: string, intent?: StatusIntent, durationMs?: number) => void;
  /**
   * Whether the open browser view is opening or live (or closed, for a
   * hidden one): only then are its pages read.
   */
  sharedBrowserPagesActive?: boolean;
  /** A run is active, someone else controls, or others are in the browser. */
  sharedBrowserPagesPollFast?: boolean;
  /** The browser surface is on screen. */
  sharedBrowserSurfaceVisible?: boolean;
};

export function useChatComposerBrowserTargeting({
  activeConversationId,
  activeProjectId,
  browserSessionOpen,
  browserSessionId,
  sharedBrowserActivated,
  browserTransport,
  focusInput,
  hasHiddenBrowserSession,
  onHiddenBrowserSessionUnavailable,
  openBrowserSession,
  preferredBrowserRuntimeId,
  requestBrowserSessionExpand,
  resolvedBrowserRuntimeId,
  showStatus,
  sharedBrowserPagesActive = true,
  sharedBrowserPagesPollFast = true,
  sharedBrowserSurfaceVisible = true,
}: UseChatComposerBrowserTargetingOptions) {
  const sharedBrowserTargetingEnabled = browserTransport === "shared";
  const [pendingBrowserLaunchMode, setPendingBrowserLaunchMode] = useState<"new_page" | null>(null);
  const effectivePendingBrowserLaunchMode = sharedBrowserTargetingEnabled
    ? pendingBrowserLaunchMode
    : null;
  const {
    pages: liveBrowserSessionPages,
    resolved: liveBrowserSessionPagesResolved,
    hostNotReady: liveBrowserHostNotReady,
    hostNotReadySinceMs: liveBrowserHostNotReadySinceMs,
    capabilities: sharedBrowserCapabilities,
    capabilitiesResolved: sharedBrowserCapabilitiesResolved,
    capabilitiesUnsupported: sharedBrowserCapabilitiesUnsupported,
    commandPending: sharedBrowserCommandPending,
    commandError: sharedBrowserCommandError,
    clearCommandError: clearSharedBrowserCommandError,
    navigatePage: navigateSharedBrowserPage,
    goBack: goBackInSharedBrowser,
    goForward: goForwardInSharedBrowser,
    reloadPage: reloadSharedBrowserPage,
    focusPage: focusBrowserSessionPage,
    openPage: openSharedBrowserPage,
    keepPage: keepSharedBrowserPage,
  } = useBrowserSessionPages({
    enabled:
      sharedBrowserActivated &&
      (browserSessionOpen || hasHiddenBrowserSession) &&
      Boolean(resolvedBrowserRuntimeId),
    projectId: activeProjectId,
    browserSessionId,
    preferRuntimeId: resolvedBrowserRuntimeId,
    onUnavailable: onHiddenBrowserSessionUnavailable,
    suspendOnUnavailable: hasHiddenBrowserSession,
    includePlaceholder: true,
    pollPages: sharedBrowserPagesActive,
    pollFast: sharedBrowserPagesPollFast,
    surfaceVisible: sharedBrowserSurfaceVisible,
  });
  // The person picks a tab: whether it is the tab on screen now (a browser
  // someone else drives refuses the pick, and says so).
  const handleSelectBrowserSessionPage = useCallback(
    async (pageId: string): Promise<boolean> => {
      if (!sharedBrowserTargetingEnabled) {
        return false;
      }
      if (hasHiddenBrowserSession || !browserSessionOpen) {
        openBrowserSession(resolvedBrowserRuntimeId ?? preferredBrowserRuntimeId);
      }

      try {
        const focused = await focusBrowserSessionPage(pageId);
        if (!focused) {
          showStatus("Unable to focus that browser tab right now.", "error", 3500);
        }
        return focused;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(message || "Unable to focus that browser tab right now.", "error", 4000);
        return false;
      }
    },
    [
      browserSessionOpen,
      focusBrowserSessionPage,
      hasHiddenBrowserSession,
      openBrowserSession,
      preferredBrowserRuntimeId,
      resolvedBrowserRuntimeId,
      sharedBrowserTargetingEnabled,
      showStatus,
    ],
  );
  useEffect(() => {
    setPendingBrowserLaunchMode(null);
  }, [activeConversationId, browserTransport]);

  const handleOpenBrowserFromLauncher = useCallback(() => {
    setPendingBrowserLaunchMode(null);
    if (hasHiddenBrowserSession || !browserSessionOpen) {
      openBrowserSession(resolvedBrowserRuntimeId ?? preferredBrowserRuntimeId);
    } else {
      requestBrowserSessionExpand();
    }
    focusInput({ force: true });
  }, [
    browserSessionOpen,
    focusInput,
    hasHiddenBrowserSession,
    openBrowserSession,
    preferredBrowserRuntimeId,
    requestBrowserSessionExpand,
    resolvedBrowserRuntimeId,
  ]);
  const handlePrepareNewBrowserSession = useCallback(() => {
    if (!sharedBrowserTargetingEnabled) {
      return;
    }
    if (hasHiddenBrowserSession || !browserSessionOpen) {
      openBrowserSession(resolvedBrowserRuntimeId ?? preferredBrowserRuntimeId);
    }
    setPendingBrowserLaunchMode("new_page");
    showStatus(
      "Your next AI message will request a new tab while keeping the existing pages available.",
      "info",
      3000,
    );
    focusInput({ force: true });
  }, [
    browserSessionOpen,
    focusInput,
    hasHiddenBrowserSession,
    openBrowserSession,
    preferredBrowserRuntimeId,
    resolvedBrowserRuntimeId,
    sharedBrowserTargetingEnabled,
    showStatus,
  ]);
  const handleClearPendingNewBrowserSession = useCallback(() => {
    setPendingBrowserLaunchMode(null);
    showStatus("New tab request canceled. Existing browser pages are unchanged.", "info", 2500);
    focusInput({ force: true });
  }, [focusInput, showStatus]);
  const clearPendingBrowserLaunchMode = useCallback(() => {
    setPendingBrowserLaunchMode(null);
  }, []);
  const updatePendingBrowserLaunchMode = useCallback(
    (mode: "new_page" | null) => {
      setPendingBrowserLaunchMode(sharedBrowserTargetingEnabled ? mode : null);
    },
    [sharedBrowserTargetingEnabled],
  );

  return {
    clearPendingBrowserLaunchMode,
    handleClearPendingNewBrowserSession,
    handleOpenBrowserFromLauncher,
    handlePrepareNewBrowserSession,
    handleSelectBrowserSessionPage,
    pendingBrowserLaunchMode: effectivePendingBrowserLaunchMode,
    sharedBrowserCapabilities,
    sharedBrowserCapabilitiesResolved,
    sharedBrowserCapabilitiesUnsupported,
    sharedBrowserChromePages: sharedBrowserActivated ? liveBrowserSessionPages : [],
    sharedBrowserChromeResolved: sharedBrowserActivated && liveBrowserSessionPagesResolved,
    sharedBrowserHostNotReady: sharedBrowserActivated && liveBrowserHostNotReady,
    sharedBrowserHostNotReadySinceMs: sharedBrowserActivated ? liveBrowserHostNotReadySinceMs : null,
    sharedBrowserCommandPending,
    sharedBrowserCommandError,
    clearSharedBrowserCommandError,
    navigateSharedBrowserPage,
    goBackInSharedBrowser,
    goForwardInSharedBrowser,
    reloadSharedBrowserPage,
    keepSharedBrowserPage,
    /** Opens a blank tab behind the one on screen (a chat's own tab); null when it cannot. */
    openSharedBrowserPage,
    /**
     * Whether this browser opens such a tab: false for an older one that does
     * not, null until it said (a reading that failed is not a "no").
     */
    sharedBrowserCanOpenPage: sharedBrowserCapabilitiesUnsupported
      ? false
      : sharedBrowserCapabilities
        ? sharedBrowserCapabilities.controls.newPage === true
        : null,
    /** Brings a tab to the front without a word when it cannot: Studio's own focus, not the person's pick. */
    focusSharedBrowserPageQuietly: focusBrowserSessionPage,
    setPendingBrowserLaunchMode: updatePendingBrowserLaunchMode,
  };
}
