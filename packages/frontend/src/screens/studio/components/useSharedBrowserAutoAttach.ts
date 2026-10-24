import { useCallback, useEffect, useRef, useState } from "react";
import type { SharedBrowserHostSnapshot } from "../../../services/runtimeController/browserSession";
import {
  hostedBrowserAttachAfterLateMachine,
  hostedBrowserAttachWhileOff,
  type HostedBrowserViewKind,
} from "./hostedBrowserViewState";
import type { SharedBrowserHostRefresh } from "./useSharedBrowserHostSnapshot";
import type { BrowserTransport } from "./usePersonalBrowserBridge";

type SharedBrowserView = { kind: HostedBrowserViewKind | null; error: { message: string; atMs: number } | null };

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
  /** What the open view shows: its kind, and the sentence of its error with when that came. */
  view?: SharedBrowserView;
  /** The conversation's machine while it is a live host (conversationBrowserHostId), else null. */
  hostRuntimeId?: string | null;
};

/**
 * ChatPanel's `view` and `hostRuntimeId` for useSharedBrowserAutoAttach: what
 * Instafy's browser view shows and the conversation's machine while it is a
 * live host, only while Instafy's browser is the one shown.
 */
export function sharedBrowserLateAttachInputs(input: {
  transport: BrowserTransport;
  kind: HostedBrowserViewKind | null;
  error: { message: string; atMs: number } | null;
  hostRuntimeId: string | null;
}): { view: SharedBrowserView | undefined; hostRuntimeId: string | null } {
  if (input.transport !== "shared") return { view: undefined, hostRuntimeId: null };
  return { view: { kind: input.kind, error: input.error }, hostRuntimeId: input.hostRuntimeId };
}

/**
 * Studio asking the browser view to attach by itself (its `autoAttachToken`).
 * `requestAutoAttach()` asks at once, as Studio does when it opens the
 * browser for a card. While the view is off, it reads the browser at once
 * and asks when a reading asked for since then shows an agent or another
 * viewer running it (hands-free), once per run of the browser. After a press
 * gave up on the space's machine, it asks once when that machine comes up
 * within a few minutes (hostedBrowserAttachAfterLateMachine).
 */
export function useSharedBrowserAutoAttach({ open, off, host, view, hostRuntimeId = null }: Options) {
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
  // The machine a press gave up on came up later. Runtime status refreshes
  // (registration, health) are what make it a live host, so this reads
  // nothing by itself.
  const viewKind = view?.kind ?? null;
  const viewError = view?.error ?? null;
  const lateMachineAttachedForRef = useRef<number | null>(null);
  useEffect(() => {
    if (!open || !hostedBrowserAttachAfterLateMachine({
      kind: viewKind,
      error: viewError,
      hostRuntimeId,
      nowMs: Date.now(),
      attachedForAtMs: lateMachineAttachedForRef.current,
    })) return;
    lateMachineAttachedForRef.current = viewError!.atMs;
    requestAutoAttach();
  }, [hostRuntimeId, open, requestAutoAttach, viewError, viewKind]);
  return { autoAttachToken, requestAutoAttach };
}
