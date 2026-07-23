import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatMessage } from "../types";
import type { StatusIntent } from "../../../status/useStatus";
import { shouldShowBrowserSessionPageStrip } from "./browserSessionLayout";
import {
  browserSessionPageIsPlaceholder,
  resolveBrowserSessionPages,
  resolvePreferredBrowserSessionPage,
  type BrowserSessionPage,
} from "./browserSessionPages";
import { useBrowserSessionPages } from "./useBrowserSessionPages";
import type { BrowserTransport } from "./usePersonalBrowserBridge";

type UseChatComposerBrowserTargetingOptions = {
  activeConversationId: string | null;
  activeProjectId: string | null;
  browserSessionOpen: boolean;
  browserSessionId: string;
  sharedBrowserActivated: boolean;
  browserTransport: BrowserTransport;
  compactBrowserViewport: boolean;
  focusInput: (options?: { force?: boolean }) => void;
  hasHiddenBrowserSession: boolean;
  messages: ChatMessage[];
  onHiddenBrowserSessionUnavailable: () => void;
  openBrowserSession: (runtimeId: string | null) => void;
  preferredBrowserRuntimeId: string | null;
  requestBrowserSessionExpand: () => void;
  resolvedBrowserRuntimeId: string | null;
  showStatus: (message: string, intent?: StatusIntent, durationMs?: number) => void;
};

export function useChatComposerBrowserTargeting({
  activeConversationId,
  activeProjectId,
  browserSessionOpen,
  browserSessionId,
  sharedBrowserActivated,
  browserTransport,
  compactBrowserViewport,
  focusInput,
  hasHiddenBrowserSession,
  messages,
  onHiddenBrowserSessionUnavailable,
  openBrowserSession,
  preferredBrowserRuntimeId,
  requestBrowserSessionExpand,
  resolvedBrowserRuntimeId,
  showStatus,
}: UseChatComposerBrowserTargetingOptions) {
  const sharedBrowserTargetingEnabled = browserTransport === "shared";
  const inferredBrowserSessionPages = useMemo(() => resolveBrowserSessionPages(messages), [messages]);
  const [pendingBrowserLaunchMode, setPendingBrowserLaunchMode] = useState<"new_page" | null>(null);
  const effectivePendingBrowserLaunchMode = sharedBrowserTargetingEnabled
    ? pendingBrowserLaunchMode
    : null;
  const {
    pages: liveBrowserSessionPages,
    resolved: liveBrowserSessionPagesResolved,
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
  });
  const targetableLiveBrowserSessionPages = useMemo(
    () => liveBrowserSessionPages.filter((page) => !browserSessionPageIsPlaceholder(page)),
    [liveBrowserSessionPages],
  );
  const browserSessionPages =
    sharedBrowserTargetingEnabled && liveBrowserSessionPagesResolved
      ? targetableLiveBrowserSessionPages
      : [];
  const preferredBrowserPage = useMemo<BrowserSessionPage | null>(
    () =>
      sharedBrowserTargetingEnabled
          ? resolvePreferredBrowserSessionPage(
            liveBrowserSessionPagesResolved
              ? targetableLiveBrowserSessionPages
              : inferredBrowserSessionPages,
          )
        : null,
    [
      inferredBrowserSessionPages,
      liveBrowserSessionPagesResolved,
      sharedBrowserTargetingEnabled,
      targetableLiveBrowserSessionPages,
    ],
  );
  const handleSelectBrowserSessionPage = useCallback(
    async (pageId: string) => {
      if (!sharedBrowserTargetingEnabled) {
        return;
      }
      if (hasHiddenBrowserSession || !browserSessionOpen) {
        openBrowserSession(resolvedBrowserRuntimeId ?? preferredBrowserRuntimeId);
      }

      try {
        const focused = await focusBrowserSessionPage(pageId);
        if (!focused) {
          showStatus("Unable to focus that browser tab right now.", "error", 3500);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(message || "Unable to focus that browser tab right now.", "error", 4000);
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
  const showBrowserSessionPageStrip =
    sharedBrowserTargetingEnabled &&
    shouldShowBrowserSessionPageStrip({
      browserHidden: hasHiddenBrowserSession,
      browserOpen: browserSessionOpen,
      hasPages: browserSessionPages.length > 0,
      pendingNewBrowser: effectivePendingBrowserLaunchMode === "new_page",
      smallViewport: compactBrowserViewport,
    });

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
      "Next browser request will open another site while keeping the current browser available.",
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
    showStatus("New-site browser targeting cleared.", "info", 2500);
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
    browserSessionPages,
    clearPendingBrowserLaunchMode,
    handleClearPendingNewBrowserSession,
    handleOpenBrowserFromLauncher,
    handlePrepareNewBrowserSession,
    handleSelectBrowserSessionPage,
    pendingBrowserLaunchMode: effectivePendingBrowserLaunchMode,
    preferredBrowserPage,
    sharedBrowserCapabilities,
    sharedBrowserCapabilitiesResolved,
    sharedBrowserCapabilitiesUnsupported,
    sharedBrowserChromePages: sharedBrowserActivated ? liveBrowserSessionPages : [],
    sharedBrowserChromeResolved: sharedBrowserActivated && liveBrowserSessionPagesResolved,
    sharedBrowserCommandPending,
    sharedBrowserCommandError,
    clearSharedBrowserCommandError,
    navigateSharedBrowserPage,
    goBackInSharedBrowser,
    goForwardInSharedBrowser,
    reloadSharedBrowserPage,
    setPendingBrowserLaunchMode: updatePendingBrowserLaunchMode,
    showBrowserSessionPageStrip,
  };
}
