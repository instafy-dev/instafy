import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAdaptivePoll } from "../../../runtime/pollingGate";
import {
  controllerClient,
  type RuntimeBrowserSessionAction,
} from "../../../sdk/instafy";

// Poll a little faster than the page list (2500ms): the action ticker and the
// AI cursor want to feel live, and the payload is tiny.
export const BROWSER_ACTIONS_POLL_INTERVAL_MS = 1000;
/**
 * While a run is active but the log has nothing new (the agent is thinking,
 * not acting), each empty read doubles the wait up to this; the first new
 * action brings back the 1 s tail. A turn spends most of its time between
 * actions, so a tail that never slowed down read the empty log every second.
 */
export const BROWSER_ACTIONS_QUIET_MAX_POLL_INTERVAL_MS = 4_000;
// Only the agent writes the log, so with no run and no agent in control it
// only needs a slow safety read.
export const BROWSER_ACTIONS_QUIET_POLL_INTERVAL_MS = 10_000;
export const BROWSER_ACTIONS_QUIET_IDLE_POLL_INTERVAL_MS = 30_000;
// The UI only ever shows the most recent handful; keep a small rolling buffer.
const BROWSER_ACTIONS_BUFFER_LIMIT = 30;

/**
 * Tail the agent's browser action log (navigate/click/type/scroll) so the UI can
 * draw a live AI cursor and an action ticker. The origin endpoint returns events
 * after a byte-offset `cursor`; we advance it each poll and keep a small rolling
 * buffer. The cursor can move backward when a new session truncates the log — we
 * detect that and reset the buffer so one session never shows another's actions.
 */
export function useBrowserSessionActions(params: {
  enabled: boolean;
  /** False when the mounted Shared Browser surface is hidden. */
  transportActive?: boolean;
  /** Omitted for legacy consumers; null means no selected page, not all pages. */
  pageId?: string | null;
  browserSessionId: string;
  projectId: string | null;
  preferRuntimeId: string | null;
  onUnavailable?: (() => void) | null;
  suspendOnUnavailable?: boolean;
  /** A run is active or the agent controls: tail every second. Defaults to true. */
  agentActive?: boolean;
}) {
  const {
    enabled,
    agentActive = true,
    transportActive = true,
    pageId,
    browserSessionId,
    projectId,
    preferRuntimeId,
    onUnavailable = null,
    suspendOnUnavailable = false,
  } = params;
  const pollingEnabled = enabled && transportActive;
  const [actions, setActions] = useState<RuntimeBrowserSessionAction[]>([]);
  // The newest step in the whole log as this surface last read it (any
  // page): 0 for a log read empty, null before the surface has read it.
  const [logSeq, setLogSeq] = useState<number | null>(null);
  const cursorRef = useRef<number>(0);
  const unavailableSuspendedRef = useRef(false);
  const generationRef = useRef(0);
  const inFlightGenerationRef = useRef<number | null>(null);

  const handleUnavailable = useCallback((): boolean => {
    unavailableSuspendedRef.current = suspendOnUnavailable;
    cursorRef.current = 0;
    setActions([]);
    setLogSeq(null);
    onUnavailable?.();
    return false;
  }, [onUnavailable, suspendOnUnavailable]);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!pollingEnabled || !projectId) {
      cursorRef.current = 0;
      unavailableSuspendedRef.current = false;
      setActions([]);
      setLogSeq(null);
      return false;
    }
    if (unavailableSuspendedRef.current) {
      return false;
    }
    const generation = generationRef.current;
    // A slow endpoint must not create overlapping polls with the same cursor.
    if (inFlightGenerationRef.current === generation) {
      return false;
    }
    inFlightGenerationRef.current = generation;

    let result;
    try {
      result = await controllerClient.browserSessions.fetchActions({
        projectId,
        browserSessionId,
        preferRuntimeId,
        sinceCursor: cursorRef.current,
      });
    } catch (error) {
      if (generation !== generationRef.current) {
        return false;
      }
      if (controllerClient.browserSessions.isUnavailableError(error)) {
        return handleUnavailable();
      }
      throw error;
    } finally {
      if (inFlightGenerationRef.current === generation) {
        inFlightGenerationRef.current = null;
      }
    }

    // A late response from a hidden surface or a replaced runtime cannot
    // repopulate the ticker or advance the new session's byte cursor.
    if (generation !== generationRef.current || result === null) {
      return false;
    }
    unavailableSuspendedRef.current = false;

    // A cursor that moved backward means the log was truncated for a new browser
    // session — drop the previous session's buffer instead of interleaving.
    const sessionReset = result.cursor < cursorRef.current;
    cursorRef.current = result.cursor;

    const readSeq = result.actions.reduce((latest, action) => Math.max(latest, action.seq), 0);
    setLogSeq((previous) => Math.max(sessionReset ? 0 : previous ?? 0, readSeq));
    if (result.actions.length === 0) {
      if (sessionReset) {
        setActions([]);
      }
      return true;
    }

    setActions((previous) => {
      const base = sessionReset ? [] : previous;
      const merged = [...base, ...result.actions];
      return merged.length > BROWSER_ACTIONS_BUFFER_LIMIT
        ? merged.slice(merged.length - BROWSER_ACTIONS_BUFFER_LIMIT)
        : merged;
    });
    return true;
  }, [browserSessionId, pollingEnabled, handleUnavailable, preferRuntimeId, projectId]);

  useEffect(() => {
    unavailableSuspendedRef.current = false;
  }, [browserSessionId, pollingEnabled, projectId, preferRuntimeId, suspendOnUnavailable]);

  // Byte offsets are per-runtime: a different project or runtime is a different
  // actions log, so re-sync from the start instead of tailing at a stale offset.
  // Defined before the poll effect so the reset lands before the next fetch.
  useEffect(() => {
    generationRef.current += 1;
    cursorRef.current = 0;
    setActions([]);
    setLogSeq(null);
    return () => {
      generationRef.current += 1;
    };
  }, [browserSessionId, pollingEnabled, projectId, preferRuntimeId]);

  useEffect(() => {
    if (!pollingEnabled || !projectId) {
      cursorRef.current = 0;
      setActions([]);
      setLogSeq(null);
    }
  }, [pollingEnabled, projectId]);

  // Whether the read found anything: the log moved (new actions, or a new
  // session truncated it). An empty or failed read lets the poll back off.
  const poll = useCallback(async (): Promise<boolean> => {
    const before = cursorRef.current;
    try {
      return (await refresh()) && cursorRef.current !== before;
    } catch {
      // Transient poll failures are ignored; the next tick retries.
      return false;
    }
  }, [refresh]);
  useAdaptivePoll(poll, {
    enabled: pollingEnabled && Boolean(projectId),
    fast: agentActive,
    fastMs: BROWSER_ACTIONS_POLL_INTERVAL_MS,
    slowMs: BROWSER_ACTIONS_QUIET_POLL_INTERVAL_MS,
    slowIdleMs: BROWSER_ACTIONS_QUIET_IDLE_POLL_INTERVAL_MS,
    quietMaxMs: BROWSER_ACTIONS_QUIET_MAX_POLL_INTERVAL_MS,
  });

  // The log is runtime-wide, but pixels are page-scoped. Filter at render time
  // so switching tabs immediately removes the old page's cursor and captions
  // without resetting the byte cursor or refetching the log. Older unscoped
  // telemetry is hidden whenever this surface supplies a page selection.
  const visibleActions = useMemo(() => {
    if (!pollingEnabled || !projectId) {
      return [];
    }
    if (pageId === undefined) {
      return actions;
    }
    return pageId ? actions.filter((action) => action.pageId === pageId) : [];
  }, [actions, pageId, pollingEnabled, projectId]);

  // The most recent action that carries a click position, for the cursor overlay.
  const latestClick = useMemo(() => {
    for (let index = visibleActions.length - 1; index >= 0; index -= 1) {
      const action = visibleActions[index];
      if (action.type === "click" && action.x !== null && action.y !== null) {
        return action;
      }
    }
    return null;
  }, [visibleActions]);

  return { actions: visibleActions, latestClick, refresh, logSeq: pollingEnabled && projectId ? logSeq : null };
}
