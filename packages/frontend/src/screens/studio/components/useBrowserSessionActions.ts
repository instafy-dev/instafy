import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  controllerClient,
  type RuntimeBrowserSessionAction,
} from "../../../sdk/instafy";

// Poll a little faster than the page list (2500ms): the action ticker and the
// AI cursor want to feel live, and the payload is tiny.
const BROWSER_ACTIONS_POLL_INTERVAL_MS = 1000;
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
  browserSessionId: string;
  projectId: string | null;
  preferRuntimeId: string | null;
  onUnavailable?: (() => void) | null;
  suspendOnUnavailable?: boolean;
}) {
  const {
    enabled,
    browserSessionId,
    projectId,
    preferRuntimeId,
    onUnavailable = null,
    suspendOnUnavailable = false,
  } = params;
  const [actions, setActions] = useState<RuntimeBrowserSessionAction[]>([]);
  const cursorRef = useRef<number>(0);
  const unavailableSuspendedRef = useRef(false);

  const handleUnavailable = useCallback((): boolean => {
    unavailableSuspendedRef.current = suspendOnUnavailable;
    cursorRef.current = 0;
    setActions([]);
    onUnavailable?.();
    return false;
  }, [onUnavailable, suspendOnUnavailable]);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!enabled || !projectId) {
      cursorRef.current = 0;
      unavailableSuspendedRef.current = false;
      setActions([]);
      return false;
    }
    if (unavailableSuspendedRef.current) {
      return false;
    }

    let result;
    try {
      result = await controllerClient.browserSessions.fetchActions({
        projectId,
        browserSessionId,
        preferRuntimeId,
        sinceCursor: cursorRef.current,
      });
    } catch (error) {
      if (controllerClient.browserSessions.isUnavailableError(error)) {
        return handleUnavailable();
      }
      throw error;
    }

    if (result === null) {
      return false;
    }
    unavailableSuspendedRef.current = false;

    // A cursor that moved backward means the log was truncated for a new browser
    // session — drop the previous session's buffer instead of interleaving.
    const sessionReset = result.cursor < cursorRef.current;
    cursorRef.current = result.cursor;

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
  }, [browserSessionId, enabled, handleUnavailable, preferRuntimeId, projectId]);

  useEffect(() => {
    unavailableSuspendedRef.current = false;
  }, [browserSessionId, enabled, projectId, preferRuntimeId, suspendOnUnavailable]);

  // Byte offsets are per-runtime: a different project or runtime is a different
  // actions log, so re-sync from the start instead of tailing at a stale offset.
  // Defined before the poll effect so the reset lands before the next fetch.
  useEffect(() => {
    cursorRef.current = 0;
    setActions([]);
  }, [browserSessionId, projectId, preferRuntimeId]);

  useEffect(() => {
    if (!enabled || !projectId) {
      cursorRef.current = 0;
      setActions([]);
      return;
    }

    let cancelled = false;
    const run = async () => {
      try {
        await refresh();
      } catch {
        // Transient poll failures are ignored; the next tick retries.
      }
    };

    void run();
    const intervalId = window.setInterval(() => {
      if (!cancelled) {
        void run();
      }
    }, BROWSER_ACTIONS_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [enabled, projectId, refresh]);

  // The most recent action that carries a click position, for the cursor overlay.
  const latestClick = useMemo(() => {
    for (let index = actions.length - 1; index >= 0; index -= 1) {
      const action = actions[index];
      if (action.type === "click" && action.x !== null && action.y !== null) {
        return action;
      }
    }
    return null;
  }, [actions]);

  return { actions, latestClick, refresh };
}
