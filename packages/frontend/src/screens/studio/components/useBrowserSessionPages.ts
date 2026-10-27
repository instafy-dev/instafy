import { useCallback, useEffect, useRef, useState } from "react";
import {
  controllerClient,
  type RuntimeBrowserSessionCapabilities,
  type RuntimeBrowserSessionPageCommandAction,
  type RuntimeBrowserSessionPage,
} from "../../../sdk/instafy";
import type { BrowserSessionPage } from "./browserSessionPages";
import { SHARED_BROWSER_HOST_WAIT_TIMEOUT_MS } from "./sharedBrowserHostAttach";
import { useAdaptivePoll } from "../../../runtime/pollingGate";

const BROWSER_SESSION_POLL_INTERVAL_MS = 2500;
/** Nothing running and the browser not shown, or the person away for three minutes. */
export const BROWSER_SESSION_QUIET_POLL_INTERVAL_MS = 15_000;
/** A page read that has not answered by then is given up, so the next poll can ask again. */
export const BROWSER_SESSION_PAGES_REQUEST_TIMEOUT_MS = 10_000;
/** A capability read that has not answered by then is given up and asked again. */
export const BROWSER_SESSION_CAPABILITIES_REQUEST_TIMEOUT_MS = 10_000;
/**
 * How long an open browser may keep answering `browser_host_not_ready` before
 * the hook says it did not start (the same bound as the browser view's own
 * wait for Instafy's browser).
 */
export const BROWSER_HOST_NOT_READY_TIMEOUT_MS = SHARED_BROWSER_HOST_WAIT_TIMEOUT_MS;
/**
 * The origin's answer while Instafy's browser on the space's own machine is
 * not running yet (or any more). The open modal starts it; until then the
 * pages are simply not there.
 */
const BROWSER_HOST_NOT_READY_CODE = "browser_host_not_ready";

export type LiveBrowserSessionPage = BrowserSessionPage & {
  canGoBack: boolean;
  canGoForward: boolean;
};

function toBrowserSessionPage(
  page: RuntimeBrowserSessionPage,
  index: number,
  total: number,
  activePageId: string | null,
): LiveBrowserSessionPage {
  return {
    id: page.id,
    url: page.url,
    host: page.host,
    label: page.label,
    title: page.title,
    lastReferencedAt: total - index,
    isActive: page.id === activePageId,
    canGoBack: page.canGoBack,
    canGoForward: page.canGoForward,
    ...(page.openedBy ? { openedBy: page.openedBy } : {}),
    ...(page.kept ? { kept: true } : {}),
    ...(page.agentTabNumber ? { agentTabNumber: page.agentTabNumber } : {}),
    ...(page.leftover ? { leftover: true } : {}),
  };
}

export function reconcileBrowserSessionPageOrder(params: {
  currentPages: BrowserSessionPage[];
  livePages: RuntimeBrowserSessionPage[];
  activePageId: string | null;
}): LiveBrowserSessionPage[] {
  const { currentPages, livePages, activePageId } = params;
  const livePageById = new Map(livePages.map((page) => [page.id, page]));
  const orderedIds = currentPages
    .map((page) => page.id)
    .filter((id) => livePageById.has(id));
  const orderedIdSet = new Set(orderedIds);

  for (const page of livePages) {
    if (!orderedIdSet.has(page.id)) {
      orderedIds.push(page.id);
      orderedIdSet.add(page.id);
    }
  }

  return orderedIds
    .map((id, index) => {
      const page = livePageById.get(id);
      if (!page) {
        return null;
      }
      return toBrowserSessionPage(page, index, orderedIds.length, activePageId);
    })
    .filter((page): page is LiveBrowserSessionPage => Boolean(page));
}

export function useBrowserSessionPages(params: {
  enabled: boolean;
  browserSessionId: string;
  projectId: string | null;
  preferRuntimeId: string | null;
  onUnavailable?: (() => void) | null;
  suspendOnUnavailable?: boolean;
  includePlaceholder?: boolean;
  /**
   * Whether the pages are read every 2.5 s. False while the browser view is
   * off, did not open or cannot open: nothing reads the pages of a browser
   * that is not running, and the pages are empty. Capabilities stay as they
   * are, so the attach can go on once the view opens again; a capability read
   * that failed is asked again only then.
   */
  pollPages?: boolean;
  /** A run is active, the agent or another person controls, or others are here. Defaults to true. */
  pollFast?: boolean;
  /** The browser surface is on screen. Defaults to true. */
  surfaceVisible?: boolean;
}) {
  const {
    enabled,
    browserSessionId,
    projectId,
    preferRuntimeId,
    onUnavailable = null,
    suspendOnUnavailable = false,
    includePlaceholder = false,
    pollPages = true,
    pollFast = true,
    surfaceVisible = true,
  } = params;
  const scopeKey = `${enabled ? "enabled" : "disabled"}\u0000${browserSessionId}\u0000${projectId ?? ""}\u0000${preferRuntimeId ?? ""}\u0000${includePlaceholder ? "placeholders" : "pages"}\u0000${suspendOnUnavailable ? "suspend" : "continue"}`;
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const mountedRef = useRef(true);
  const [pageState, setPageState] = useState<{
    scopeKey: string;
    pages: LiveBrowserSessionPage[];
    resolved: boolean;
  }>({ scopeKey, pages: [], resolved: false });
  const [capabilityState, setCapabilityState] = useState<{
    scopeKey: string;
    capabilities: RuntimeBrowserSessionCapabilities | null;
    resolved: boolean;
    retryable: boolean;
    unsupported: boolean;
  }>({ scopeKey, capabilities: null, resolved: false, retryable: false, unsupported: false });
  const [commandState, setCommandState] = useState<{
    scopeKey: string;
    pending: RuntimeBrowserSessionPageCommandAction | null;
    error: string | null;
  }>({ scopeKey, pending: null, error: null });
  const preferredActivePageIdRef = useRef<{ scopeKey: string; pageId: string | null }>({
    scopeKey,
    pageId: null,
  });
  const unavailableSuspendedRef = useRef<{ scopeKey: string; suspended: boolean }>({
    scopeKey,
    suspended: false,
  });
  const pagesInFlightRef = useRef<{
    scopeKey: string;
    promise: Promise<boolean>;
  } | null>(null);
  const capabilitiesInFlightRef = useRef<{
    scopeKey: string;
    promise: Promise<boolean>;
  } | null>(null);
  const commandGenerationRef = useRef(0);
  const commandPendingRef = useRef<{ scopeKey: string; generation: number } | null>(null);
  const focusGenerationRef = useRef(0);

  const pages = pageState.scopeKey === scopeKey ? pageState.pages : [];
  const resolved = pageState.scopeKey === scopeKey ? pageState.resolved : false;
  const capabilities =
    capabilityState.scopeKey === scopeKey ? capabilityState.capabilities : null;
  const capabilitiesResolved =
    capabilityState.scopeKey === scopeKey ? capabilityState.resolved : false;
  const capabilitiesRetryable =
    capabilityState.scopeKey === scopeKey ? capabilityState.retryable : false;
  const capabilitiesUnsupported =
    capabilityState.scopeKey === scopeKey ? capabilityState.unsupported : false;
  const commandPending = commandState.scopeKey === scopeKey ? commandState.pending : null;
  const commandError = commandState.scopeKey === scopeKey ? commandState.error : null;
  // One unbroken run of `browser_host_not_ready` answers for this scope: when
  // it began, and whether it has lasted past the bound. Any page read that
  // succeeds, and any change of scope, ends it. Token and gateway failures
  // neither start nor end it, so a machine that is still starting is not
  // counted.
  const [notReadyState, setNotReadyState] = useState<{
    scopeKey: string;
    sinceMs: number;
    expired: boolean;
  } | null>(null);
  const notReady = notReadyState?.scopeKey === scopeKey ? notReadyState : null;
  const hostNotReadySinceMs = notReady?.sinceMs ?? null;
  const hostNotReady = notReady?.expired === true;

  const scopeIsCurrent = useCallback(
    (requestScope: string) => mountedRef.current && scopeKeyRef.current === requestScope,
    [],
  );

  const handleUnavailable = useCallback(
    (requestScope: string): boolean => {
      if (!scopeIsCurrent(requestScope)) {
        return false;
      }
      preferredActivePageIdRef.current = { scopeKey: requestScope, pageId: null };
      unavailableSuspendedRef.current = {
        scopeKey: requestScope,
        suspended: suspendOnUnavailable,
      };
      setPageState({ scopeKey: requestScope, pages: [], resolved: true });
      onUnavailable?.();
      return false;
    },
    [onUnavailable, scopeIsCurrent, suspendOnUnavailable],
  );

  const refresh = useCallback((): Promise<boolean> => {
    const requestScope = scopeKey;
    if (!enabled || !projectId) {
      if (scopeIsCurrent(requestScope)) {
        setPageState({ scopeKey: requestScope, pages: [], resolved: false });
        preferredActivePageIdRef.current = { scopeKey: requestScope, pageId: null };
        unavailableSuspendedRef.current = { scopeKey: requestScope, suspended: false };
      }
      return Promise.resolve(false);
    }

    if (
      unavailableSuspendedRef.current.scopeKey === requestScope &&
      unavailableSuspendedRef.current.suspended
    ) {
      return Promise.resolve(false);
    }

    const inFlight = pagesInFlightRef.current;
    if (inFlight?.scopeKey === requestScope) {
      return inFlight.promise;
    }

    const request = (async (): Promise<boolean> => {
      let livePages: RuntimeBrowserSessionPage[] | null;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), BROWSER_SESSION_PAGES_REQUEST_TIMEOUT_MS);
      try {
        livePages = await Promise.race([
          controllerClient.browserSessions.fetchPages({
            projectId,
            browserSessionId,
            preferRuntimeId,
            includePlaceholder,
            signal: abort.signal,
          }),
          // Even a read that ignores its signal ends at the bound.
          new Promise<never>((_resolve, reject) => {
            abort.signal.addEventListener("abort", () => reject(new Error("Browser pages did not answer in time.")), { once: true });
          }),
        ]);
      } catch (error) {
        if (!scopeIsCurrent(requestScope)) {
          return false;
        }
        if (controllerClient.browserSessions.isUnavailableError(error)) {
          // An open session waits for the space's machine to start its
          // browser: no unavailable notice and no suspend, so polling goes
          // on. A hidden one suspends as before, so an idle browser behind a
          // hidden tab is never polled and never started.
          if (
            !suspendOnUnavailable &&
            (error as { code?: string | null }).code === BROWSER_HOST_NOT_READY_CODE
          ) {
            preferredActivePageIdRef.current = { scopeKey: requestScope, pageId: null };
            setPageState({ scopeKey: requestScope, pages: [], resolved: false });
            setNotReadyState((current) => current?.scopeKey === requestScope
              ? current
              : { scopeKey: requestScope, sinceMs: Date.now(), expired: false });
            return false;
          }
          return handleUnavailable(requestScope);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }

      if (!scopeIsCurrent(requestScope) || livePages === null) {
        return false;
      }

      unavailableSuspendedRef.current = { scopeKey: requestScope, suspended: false };
      setNotReadyState((current) => current?.scopeKey === requestScope ? null : current);
      const preferredPageId =
        preferredActivePageIdRef.current.scopeKey === requestScope
          ? preferredActivePageIdRef.current.pageId
          : null;
      const resolvedActivePageId =
        livePages.find((page) => page.isActive)?.id ??
        (preferredPageId && livePages.some((page) => page.id === preferredPageId)
          ? preferredPageId
          : livePages.length === 1
            ? livePages[0]?.id ?? null
            : null);

      preferredActivePageIdRef.current = {
        scopeKey: requestScope,
        pageId: resolvedActivePageId,
      };
      setPageState((current) => ({
        scopeKey: requestScope,
        pages: reconcileBrowserSessionPageOrder({
          currentPages: current.scopeKey === requestScope ? current.pages : [],
          livePages,
          activePageId: resolvedActivePageId,
        }),
        resolved: true,
      }));
      return true;
    })();

    pagesInFlightRef.current = { scopeKey: requestScope, promise: request };
    const clearInFlight = () => {
      if (pagesInFlightRef.current?.promise === request) {
        pagesInFlightRef.current = null;
      }
    };
    void request.then(clearInFlight, clearInFlight);
    return request;
  }, [browserSessionId, enabled, handleUnavailable, includePlaceholder, preferRuntimeId, projectId, scopeIsCurrent, scopeKey, suspendOnUnavailable]);

  const refreshAfterMutation = useCallback(async (): Promise<boolean> => {
    const requestScope = scopeKey;
    const existing = pagesInFlightRef.current;
    if (existing?.scopeKey === requestScope) {
      await existing.promise.catch(() => false);
    }
    return scopeIsCurrent(requestScope) ? refresh() : false;
  }, [refresh, scopeIsCurrent, scopeKey]);

  const refreshCapabilities = useCallback((): Promise<boolean> => {
    const requestScope = scopeKey;
    if (!enabled || !projectId) {
      if (scopeIsCurrent(requestScope)) {
        setCapabilityState({
          scopeKey: requestScope,
          capabilities: null,
          resolved: false,
          retryable: false,
          unsupported: false,
        });
      }
      return Promise.resolve(false);
    }

    const inFlight = capabilitiesInFlightRef.current;
    if (inFlight?.scopeKey === requestScope) {
      return inFlight.promise;
    }

    const request = (async (): Promise<boolean> => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), BROWSER_SESSION_CAPABILITIES_REQUEST_TIMEOUT_MS);
      try {
        const nextCapabilities = await Promise.race([
          controllerClient.browserSessions.fetchCapabilities({
            projectId,
            browserSessionId,
            preferRuntimeId,
            signal: abort.signal,
          }),
          // Even a read that ignores its signal ends at the bound, and is
          // retried like any other failed read.
          new Promise<never>((_resolve, reject) => {
            abort.signal.addEventListener("abort", () => reject(new Error("Browser capabilities did not answer in time.")), { once: true });
          }),
        ]);
        if (!scopeIsCurrent(requestScope)) {
          return false;
        }
        setCapabilityState({
          scopeKey: requestScope,
          capabilities: nextCapabilities,
          resolved: true,
          retryable: nextCapabilities === null,
          unsupported: false,
        });
        return nextCapabilities !== null;
      } catch (error) {
        if (!scopeIsCurrent(requestScope)) {
          return false;
        }
        // Missing routes identify stable legacy runtimes. Startup, token and
        // proxy failures are transient so viewport-only Chromium cannot remain
        // stranded without its local controls.
        const isUnavailableError = controllerClient.browserSessions.isUnavailableError;
        const status = isUnavailableError(error)
          ? (error as { status: number }).status
          : null;
        const unsupported =
          controllerClient.browserSessions.isCapabilitiesIncompatibleError(error);
        setCapabilityState({
          scopeKey: requestScope,
          capabilities: null,
          resolved: true,
          retryable: !unsupported && status !== 404 && status !== 410,
          unsupported,
        });
        return false;
      } finally {
        clearTimeout(timer);
      }
    })();

    capabilitiesInFlightRef.current = { scopeKey: requestScope, promise: request };
    const clearInFlight = () => {
      if (capabilitiesInFlightRef.current?.promise === request) {
        capabilitiesInFlightRef.current = null;
      }
    };
    void request.then(clearInFlight, clearInFlight);
    return request;
  }, [browserSessionId, enabled, preferRuntimeId, projectId, scopeIsCurrent, scopeKey]);

  const clearCommandError = useCallback(() => {
    setCommandState((current) =>
      current.scopeKey === scopeKey ? { ...current, error: null } : current,
    );
  }, [scopeKey]);

  const runPageCommand = useCallback(
    async (params: {
      pageId: string;
      action: RuntimeBrowserSessionPageCommandAction;
      url?: string;
    }): Promise<boolean> => {
      const pageId = params.pageId.trim();
      const url = params.url?.trim();
      if (
        !enabled ||
        !projectId ||
        !pageId ||
        (params.action === "navigate" && !url) ||
        commandPendingRef.current?.scopeKey === scopeKey
      ) {
        return false;
      }

      const requestScope = scopeKey;
      const generation = ++commandGenerationRef.current;
      commandPendingRef.current = { scopeKey: requestScope, generation };
      setCommandState({ scopeKey: requestScope, pending: params.action, error: null });
      const commandIsCurrent = () =>
        scopeIsCurrent(requestScope) &&
        commandPendingRef.current?.scopeKey === requestScope &&
        commandPendingRef.current.generation === generation;
      try {
        const commanded = await controllerClient.browserSessions.commandPage({
          projectId,
          browserSessionId,
          pageId,
          action: params.action,
          url,
          preferRuntimeId,
        });
        if (!commandIsCurrent()) {
          return false;
        }
        if (!commanded) {
          setCommandState({
            scopeKey: requestScope,
            pending: params.action,
            error: "Shared browser controls are unavailable.",
          });
        }
        await refreshAfterMutation().catch(() => false);
        return commanded;
      } catch (error) {
        if (!commandIsCurrent()) {
          return false;
        }
        setCommandState({
          scopeKey: requestScope,
          pending: params.action,
          error: error instanceof Error ? error.message : "Shared browser command failed.",
        });
        await refreshAfterMutation().catch(() => false);
        return false;
      } finally {
        if (commandIsCurrent()) {
          commandPendingRef.current = null;
          setCommandState((current) =>
            current.scopeKey === requestScope ? { ...current, pending: null } : current,
          );
        }
      }
    },
    [browserSessionId, enabled, preferRuntimeId, projectId, refreshAfterMutation, scopeIsCurrent, scopeKey],
  );

  const navigatePage = useCallback(
    (pageId: string, url: string) => runPageCommand({ pageId, action: "navigate", url }),
    [runPageCommand],
  );
  const goBack = useCallback(
    (pageId: string) => runPageCommand({ pageId, action: "back" }),
    [runPageCommand],
  );
  const goForward = useCallback(
    (pageId: string) => runPageCommand({ pageId, action: "forward" }),
    [runPageCommand],
  );
  const reloadPage = useCallback(
    (pageId: string) => runPageCommand({ pageId, action: "reload" }),
    [runPageCommand],
  );

  const focusPage = useCallback(
    async (pageId: string): Promise<boolean> => {
      const trimmedPageId = pageId.trim();
      if (!enabled || !projectId || !trimmedPageId) {
        return false;
      }

      const requestScope = scopeKey;
      const generation = ++focusGenerationRef.current;
      const focusIsCurrent = () =>
        scopeIsCurrent(requestScope) && focusGenerationRef.current === generation;
      preferredActivePageIdRef.current = { scopeKey: requestScope, pageId: trimmedPageId };
      setPageState((current) => ({
        scopeKey: requestScope,
        pages: (current.scopeKey === requestScope ? current.pages : []).map((page) => ({
          ...page,
          isActive: page.id === trimmedPageId,
        })),
        resolved: current.scopeKey === requestScope ? current.resolved : false,
      }));

      let focused = false;
      try {
        focused = await controllerClient.browserSessions.focusPage({
          projectId,
          browserSessionId,
          pageId: trimmedPageId,
          preferRuntimeId,
        });
      } catch (error) {
        if (!focusIsCurrent()) {
          return false;
        }
        preferredActivePageIdRef.current = { scopeKey: requestScope, pageId: null };
        await refreshAfterMutation().catch(() => false);
        if (!focusIsCurrent()) {
          return false;
        }
        throw error;
      }

      if (!focusIsCurrent()) {
        return false;
      }

      if (!focused) {
        preferredActivePageIdRef.current = { scopeKey: requestScope, pageId: null };
        await refreshAfterMutation().catch(() => false);
        return false;
      }

      await refreshAfterMutation().catch(() => false);
      return true;
    },
    [browserSessionId, enabled, preferRuntimeId, projectId, refreshAfterMutation, scopeIsCurrent, scopeKey],
  );

  // Keep tab: one of Octo's tabs stays open when its turn ends. Works while
  // Octo has control, so it is not a page command.
  const keepPage = useCallback(
    async (pageId: string): Promise<boolean> => {
      const trimmedPageId = pageId.trim();
      if (!enabled || !projectId || !trimmedPageId) {
        return false;
      }
      const requestScope = scopeKey;
      try {
        const kept = await controllerClient.browserSessions.keepPage({
          projectId,
          browserSessionId,
          pageId: trimmedPageId,
          preferRuntimeId,
        });
        if (scopeIsCurrent(requestScope)) {
          await refreshAfterMutation().catch(() => false);
        }
        return kept;
      } catch (error) {
        if (scopeIsCurrent(requestScope)) {
          setCommandState({
            scopeKey: requestScope,
            pending: null,
            error: error instanceof Error ? error.message : "Keeping the tab failed.",
          });
          await refreshAfterMutation().catch(() => false);
        }
        return false;
      }
    },
    [browserSessionId, enabled, preferRuntimeId, projectId, refreshAfterMutation, scopeIsCurrent, scopeKey],
  );

  useEffect(() => {
    preferredActivePageIdRef.current = { scopeKey, pageId: null };
    unavailableSuspendedRef.current = { scopeKey, suspended: false };
    commandGenerationRef.current += 1;
    focusGenerationRef.current += 1;
    commandPendingRef.current = null;
    setPageState({ scopeKey, pages: [], resolved: false });
    setCapabilityState({
      scopeKey,
      capabilities: null,
      resolved: false,
      retryable: false,
      unsupported: false,
    });
    setCommandState({ scopeKey, pending: null, error: null });
    // Each open counts its own run of not-ready answers: closing the browser
    // and opening it again never brings back an earlier one.
    setNotReadyState(null);
    void refreshCapabilities();
  }, [refreshCapabilities, scopeKey]);

  useEffect(
    () => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        commandGenerationRef.current += 1;
        focusGenerationRef.current += 1;
        commandPendingRef.current = null;
      };
    },
    [],
  );

  // Marks the run of `browser_host_not_ready` answers as past its bound.
  useEffect(() => {
    if (!notReady || notReady.expired) return;
    const { scopeKey: notReadyScope, sinceMs } = notReady;
    const timer = window.setTimeout(() => {
      setNotReadyState((current) =>
        current?.scopeKey === notReadyScope && current.sinceMs === sinceMs ? { ...current, expired: true } : current);
    }, Math.max(0, sinceMs + BROWSER_HOST_NOT_READY_TIMEOUT_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [notReady]);

  // A capability read that may succeed later is asked again every 2.5 s,
  // but not while the pages are not read (the view is off, did not open or
  // cannot open): nothing waits on them then. Once the view opens again it
  // asks at once, so its attach does not wait for the next tick.
  const capabilitiesRetryPausedRef = useRef(false);
  useEffect(() => {
    if (!enabled || !projectId || !capabilitiesRetryable) {
      capabilitiesRetryPausedRef.current = false;
      return;
    }
    if (!pollPages) {
      capabilitiesRetryPausedRef.current = true;
      return;
    }
    if (capabilitiesRetryPausedRef.current) {
      capabilitiesRetryPausedRef.current = false;
      void refreshCapabilities();
    }
    const intervalId = window.setInterval(() => {
      void refreshCapabilities();
    }, BROWSER_SESSION_POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [capabilitiesRetryable, enabled, pollPages, projectId, refreshCapabilities]);

  useEffect(() => {
    if (!enabled || !projectId || !pollPages) {
      setPageState({ scopeKey, pages: [], resolved: false });
      preferredActivePageIdRef.current = { scopeKey, pageId: null };
    }
  }, [enabled, pollPages, projectId, scopeKey]);

  const pollPagesOnce = useCallback(async () => {
    try {
      await refresh();
    } catch {
      if (scopeIsCurrent(scopeKey)) {
        setPageState((current) => ({
          scopeKey,
          pages: current.scopeKey === scopeKey ? current.pages : [],
          resolved: false,
        }));
      }
    }
  }, [refresh, scopeIsCurrent, scopeKey]);
  useAdaptivePoll(pollPagesOnce, {
    enabled: enabled && Boolean(projectId) && pollPages,
    fast: pollFast,
    fastMs: BROWSER_SESSION_POLL_INTERVAL_MS,
    slowMs: surfaceVisible ? BROWSER_SESSION_POLL_INTERVAL_MS : BROWSER_SESSION_QUIET_POLL_INTERVAL_MS,
    slowIdleMs: BROWSER_SESSION_QUIET_POLL_INTERVAL_MS,
  });

  return {
    pages,
    resolved,
    /**
     * Since when the open browser has kept answering that Instafy's browser
     * is not running; null once a page read succeeds.
     */
    hostNotReadySinceMs,
    /** That has lasted past BROWSER_HOST_NOT_READY_TIMEOUT_MS. */
    hostNotReady,
    capabilities,
    capabilitiesResolved,
    capabilitiesUnsupported,
    commandPending,
    commandError,
    refresh,
    refreshCapabilities,
    focusPage,
    keepPage,
    clearCommandError,
    navigatePage,
    goBack,
    goForward,
    reloadPage,
  };
}
