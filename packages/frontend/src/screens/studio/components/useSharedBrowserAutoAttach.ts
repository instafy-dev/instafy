import { useCallback, useEffect, useRef, useState } from "react";
import type { SharedBrowserHostSnapshot } from "../../../services/runtimeController/browserSession";
import { hostedBrowserAttachWhileOff } from "./hostedBrowserViewState";
import type { SharedBrowserHostRefresh } from "./useSharedBrowserHostSnapshot";

type Options = {
  /** Whether the browser view is open. Closing it forgets the run it attached to. */
  open: boolean;
  /** Whether the open view shows Instafy's browser on the conversation's machine as off. */
  off: boolean;
  /** The ten-second reading of that browser (useSharedBrowserHostSnapshot). */
  host: {
    snapshot: SharedBrowserHostSnapshot | null;
    fetchedAtMs: number | null;
    refresh: SharedBrowserHostRefresh;
  };
};

/**
 * Studio asking the browser view to attach by itself (its `autoAttachToken`).
 * `requestAutoAttach()` asks at once, as Studio does when it opens the
 * browser for a card. While the view is off, it reads the browser at once
 * and asks when a reading asked for since then shows an agent or another
 * viewer running it (hands-free), once per run of the browser.
 */
export function useSharedBrowserAutoAttach({ open, off, host }: Options) {
  const [autoAttachToken, setAutoAttachToken] = useState(0);
  const requestAutoAttach = useCallback(() => {
    setAutoAttachToken((current) => current + 1);
  }, []);
  // The run of the browser (its generation) the view last attached to by
  // itself, so a view that goes off again does not keep trying it.
  const attachedGenerationRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!open) attachedGenerationRef.current = undefined;
  }, [open]);
  // When the view went off. The reading it already has may be older (from
  // before the machine restarted, or from a run that has ended), so it reads
  // again now and decides on that.
  const [offSinceMs, setOffSinceMs] = useState<number | null>(null);
  const refreshHost = host.refresh;
  useEffect(() => {
    if (!off) {
      setOffSinceMs(null);
      return;
    }
    setOffSinceMs(Date.now());
    void refreshHost({ force: true });
  }, [off, refreshHost]);
  const { snapshot, fetchedAtMs } = host;
  useEffect(() => {
    if (!hostedBrowserAttachWhileOff({
      off,
      snapshot,
      fetchedAtMs,
      offSinceMs,
      attachedGeneration: attachedGenerationRef.current,
    })) return;
    attachedGenerationRef.current = snapshot?.generation ?? null;
    requestAutoAttach();
  }, [fetchedAtMs, off, offSinceMs, requestAutoAttach, snapshot]);
  return { autoAttachToken, requestAutoAttach };
}
