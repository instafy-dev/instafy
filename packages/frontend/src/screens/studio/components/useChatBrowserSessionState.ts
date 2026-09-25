import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BUG_REPORT_DIALOG_STATE_EVENT, type BugReportDialogStateDetail } from "./bugReportEvents";

type UseChatBrowserSessionStateOptions = {
  currentUserId: string | null;
  activeConversationControllerId: string | null;
  activeConversationId: string | null;
  activeProjectId: string | null;
  effectiveRuntimeId: string | null;
  preferredRuntimeId: string | null;
  refreshRuntimeStatuses: () => Promise<unknown> | void;
  setSessionRuntimeOverride: (runtimeId: string | null) => void;
};

function sanitizeRuntimeId(runtimeId: string | null | undefined): string | null {
  if (typeof runtimeId !== "string") {
    return null;
  }
  const trimmed = runtimeId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function useChatBrowserSessionState({
  currentUserId,
  activeConversationControllerId,
  activeConversationId,
  activeProjectId,
  effectiveRuntimeId,
  preferredRuntimeId,
  refreshRuntimeStatuses,
  setSessionRuntimeOverride,
}: UseChatBrowserSessionStateOptions) {
  const [browserSessionOpen, setBrowserSessionOpen] = useState(false);
  const [browserSessionRuntimeId, setBrowserSessionRuntimeId] = useState<string | null>(null);
  const [exactBrowserRuntimeId, setExactBrowserRuntimeId] = useState<string | null>(null);
  const browserSessionStateStorageKey = useMemo(() => {
    if (!currentUserId || !activeProjectId || !activeConversationId) {
      return null;
    }
    return `instafy:browser-session:${currentUserId}:${activeProjectId}:${activeConversationId}`;
  }, [activeConversationId, activeProjectId, currentUserId]);
  const currentIdentityRef = useRef(browserSessionStateStorageKey);
  currentIdentityRef.current = browserSessionStateStorageKey;
  const browserSessionStateLoadedKeyRef = useRef<string | null>(null);
  const browserSessionStateScopeKeyRef = useRef<string | null>(null);
  const browserSessionStateDirtyRef = useRef(false);
  const [hydratedStorageKey, setHydratedStorageKey] = useState<string | null>(null);
  const browserSessionStateHydrated = Boolean(browserSessionStateStorageKey && hydratedStorageKey === browserSessionStateStorageKey);

  useLayoutEffect(() => {
    if (browserSessionStateScopeKeyRef.current === browserSessionStateStorageKey) {
      return;
    }
    browserSessionStateScopeKeyRef.current = browserSessionStateStorageKey;
    browserSessionStateLoadedKeyRef.current = null;
    browserSessionStateDirtyRef.current = false;
    setBrowserSessionRuntimeId(null);
    setExactBrowserRuntimeId(null);
    setBrowserSessionOpen(false);
    setHydratedStorageKey(null);
  }, [browserSessionStateStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!browserSessionStateStorageKey) {
      browserSessionStateLoadedKeyRef.current = null;
      setBrowserSessionRuntimeId(null);
      setExactBrowserRuntimeId(null);
      setBrowserSessionOpen(false);
      setHydratedStorageKey(null);
      return;
    }
    if (browserSessionStateLoadedKeyRef.current === browserSessionStateStorageKey) {
      setHydratedStorageKey(browserSessionStateStorageKey);
      return;
    }
    browserSessionStateLoadedKeyRef.current = browserSessionStateStorageKey;
    try {
      // Keep a live tab's selection, but recover the last known binding after
      // the tab/app has closed. These are identifiers only, never cookies or URL
      // snapshots. The controller still verifies availability and access.
      let raw: string | null = null;
      for (const storage of ["sessionStorage", "localStorage"] as const) {
        try { raw = window[storage].getItem(browserSessionStateStorageKey); } catch { /* Try the other store. */ }
        if (raw !== null) break;
      }
      if (!raw) {
        setBrowserSessionRuntimeId(null);
        setExactBrowserRuntimeId(null);
        setBrowserSessionOpen(false);
        setHydratedStorageKey(browserSessionStateStorageKey);
        return;
      }
      const parsed = JSON.parse(raw) as {
        open?: unknown;
        runtimeId?: unknown;
        exactRuntimeId?: unknown;
      };
      const open = typeof parsed?.open === "boolean" ? parsed.open : false;
      const runtimeId =
        typeof parsed?.runtimeId === "string" && parsed.runtimeId.trim().length > 0
          ? parsed.runtimeId.trim()
          : null;
      setBrowserSessionRuntimeId(runtimeId);
      setExactBrowserRuntimeId(parsed.exactRuntimeId === runtimeId ? runtimeId : null);
      setBrowserSessionOpen(open || Boolean(runtimeId));
      setHydratedStorageKey(browserSessionStateStorageKey);
    } catch {
      setBrowserSessionRuntimeId(null);
      setExactBrowserRuntimeId(null);
      setBrowserSessionOpen(false);
      setHydratedStorageKey(browserSessionStateStorageKey);
    }
  }, [browserSessionStateStorageKey]);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !browserSessionStateStorageKey ||
      !browserSessionStateHydrated ||
      !browserSessionStateDirtyRef.current
    ) {
      return;
    }
    const value = JSON.stringify({
      open: browserSessionOpen,
      runtimeId: browserSessionRuntimeId,
      exactRuntimeId: exactBrowserRuntimeId,
    });
    for (const storage of ["sessionStorage", "localStorage"] as const) {
      try { window[storage].setItem(browserSessionStateStorageKey, value); } catch { /* Storage may be unavailable. */ }
    }
  }, [browserSessionOpen, browserSessionRuntimeId, exactBrowserRuntimeId, browserSessionStateHydrated, browserSessionStateStorageKey]);

  const resolvedBrowserRuntimeId = browserSessionRuntimeId ?? null;
  const preferredBrowserRuntimeId =
    resolvedBrowserRuntimeId ?? effectiveRuntimeId ?? preferredRuntimeId ?? null;
  const hasHiddenBrowserSession = !browserSessionOpen && Boolean(resolvedBrowserRuntimeId);
  const [browserSessionExpandRequestToken, setBrowserSessionExpandRequestToken] = useState(0);
  const browserSessionReopenAfterBugReportRef = useRef(false);

  const openBrowserSession = useCallback((runtimeId: string | null) => {
    if (!browserSessionStateStorageKey || currentIdentityRef.current !== browserSessionStateStorageKey) return;
    browserSessionStateDirtyRef.current = true;
    const sanitizedRuntimeId = sanitizeRuntimeId(runtimeId);
    if (sanitizedRuntimeId) {
      setBrowserSessionRuntimeId(sanitizedRuntimeId);
      setExactBrowserRuntimeId((current) => current === sanitizedRuntimeId ? current : null);
    }
    setBrowserSessionOpen(true);
    setBrowserSessionExpandRequestToken((current) => current + 1);
  }, [browserSessionStateStorageKey]);

  const resumeBrowserSession = useCallback((runtimeId: string) => {
    if (!browserSessionStateStorageKey || currentIdentityRef.current !== browserSessionStateStorageKey) return;
    const normalized = sanitizeRuntimeId(runtimeId);
    if (!normalized) return;
    browserSessionStateDirtyRef.current = true;
    setBrowserSessionRuntimeId(normalized);
    setExactBrowserRuntimeId(normalized);
    setBrowserSessionOpen(true);
    setBrowserSessionExpandRequestToken((current) => current + 1);
  }, [browserSessionStateStorageKey]);

  const handleBrowserSessionOpenChange = useCallback((open: boolean) => {
    if (!browserSessionStateStorageKey || currentIdentityRef.current !== browserSessionStateStorageKey) return;
    browserSessionStateDirtyRef.current = true;
    setBrowserSessionOpen(open);
  }, [browserSessionStateStorageKey]);

  const requestBrowserSessionExpand = useCallback(() => {
    setBrowserSessionExpandRequestToken((current) => current + 1);
  }, []);

  const handleToggleBrowserSession = useCallback(() => {
    if (hasHiddenBrowserSession || !browserSessionOpen) {
      openBrowserSession(resolvedBrowserRuntimeId ?? preferredBrowserRuntimeId);
      return;
    }
    handleBrowserSessionOpenChange(false);
  }, [
    browserSessionOpen,
    handleBrowserSessionOpenChange,
    hasHiddenBrowserSession,
    openBrowserSession,
    preferredBrowserRuntimeId,
    resolvedBrowserRuntimeId,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleBugReportDialogState = (event: Event) => {
      const detail = (event as CustomEvent<BugReportDialogStateDetail>).detail;
      if (!detail || typeof detail.open !== "boolean") {
        return;
      }
      if (detail.open) {
        if (browserSessionOpen) {
          browserSessionReopenAfterBugReportRef.current = true;
          handleBrowserSessionOpenChange(false);
        }
        return;
      }
      if (!browserSessionReopenAfterBugReportRef.current) {
        return;
      }
      browserSessionReopenAfterBugReportRef.current = false;
      openBrowserSession(resolvedBrowserRuntimeId ?? preferredBrowserRuntimeId);
    };
    window.addEventListener(BUG_REPORT_DIALOG_STATE_EVENT, handleBugReportDialogState as EventListener);
    return () => {
      window.removeEventListener(BUG_REPORT_DIALOG_STATE_EVENT, handleBugReportDialogState as EventListener);
    };
  }, [
    browserSessionOpen,
    handleBrowserSessionOpenChange,
    openBrowserSession,
    preferredBrowserRuntimeId,
    resolvedBrowserRuntimeId,
  ]);

  const handleHiddenBrowserSessionUnavailable = useCallback(() => {
    if (!hasHiddenBrowserSession || !browserSessionStateStorageKey || currentIdentityRef.current !== browserSessionStateStorageKey) {
      return;
    }
    browserSessionStateDirtyRef.current = true;
    setBrowserSessionRuntimeId(null);
    setExactBrowserRuntimeId(null);
    setBrowserSessionOpen(false);
    void refreshRuntimeStatuses();
  }, [browserSessionStateStorageKey, hasHiddenBrowserSession, refreshRuntimeStatuses]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        args?: unknown[];
        runtimeId?: unknown;
        conversationLocalId?: unknown;
        conversationControllerId?: unknown;
      } | null;
      const conversationLocalIdFromDetail =
        typeof detail?.conversationLocalId === "string" ? detail.conversationLocalId.trim() : "";
      const conversationControllerIdFromDetail =
        typeof detail?.conversationControllerId === "string" ? detail.conversationControllerId.trim() : "";
      const activeControllerId = (activeConversationControllerId ?? "").trim();
      if (conversationLocalIdFromDetail && conversationLocalIdFromDetail !== (activeConversationId ?? "")) {
        return;
      }
      if (conversationControllerIdFromDetail && conversationControllerIdFromDetail !== activeControllerId) {
        return;
      }
      const args = Array.isArray(detail?.args) ? detail.args : [];
      const runtimeIdFromArgs = typeof args[0] === "string" ? args[0].trim() : "";
      const runtimeIdFromDetail = typeof detail?.runtimeId === "string" ? detail.runtimeId.trim() : "";
      const runtimeId = runtimeIdFromArgs || runtimeIdFromDetail;
      if (runtimeId) resumeBrowserSession(runtimeId);
      else openBrowserSession(null);
    };
    window.addEventListener("instafy:browser-open", handler);
    return () => {
      window.removeEventListener("instafy:browser-open", handler);
    };
  }, [activeConversationControllerId, activeConversationId, openBrowserSession, resumeBrowserSession]);

  const handleBrowserRuntimeIdResolved = useCallback(
    (runtimeId: string | null) => {
      if (!browserSessionStateStorageKey || currentIdentityRef.current !== browserSessionStateStorageKey) return;
      browserSessionStateDirtyRef.current = true;
      const sanitizedRuntimeId = sanitizeRuntimeId(runtimeId);
      setBrowserSessionRuntimeId(sanitizedRuntimeId);
      setExactBrowserRuntimeId(sanitizedRuntimeId);
      setSessionRuntimeOverride(sanitizedRuntimeId);
    },
    [browserSessionStateStorageKey, setSessionRuntimeOverride],
  );

  return {
    browserSessionOpen,
    browserSessionStateHydrated: Boolean(browserSessionStateStorageKey) && browserSessionStateHydrated &&
      browserSessionStateLoadedKeyRef.current === browserSessionStateStorageKey &&
      browserSessionStateScopeKeyRef.current === browserSessionStateStorageKey,
    exactBrowserRuntimeId,
    browserSessionExpandRequestToken,
    handleBrowserRuntimeIdResolved,
    handleBrowserSessionOpenChange,
    handleHiddenBrowserSessionUnavailable,
    handleToggleBrowserSession,
    hasHiddenBrowserSession,
    openBrowserSession,
    resumeBrowserSession,
    preferredBrowserRuntimeId,
    requestBrowserSessionExpand,
    resolvedBrowserRuntimeId,
  };
}
