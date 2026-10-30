import { useCallback, useEffect, useMemo, useState } from "react";
import type { RunRecord } from "../../../types";
import { sharedBrowserFollowUp, type SharedBrowserFollowUp } from "./browserHandoffRouting";

/**
 * The browser turn the chat's next message would continue in Instafy's
 * browser (sharedBrowserFollowUp), for the composer and for the send.
 *
 * A browser turn has only the browser's tools, so a message never goes there
 * silently: while `followUp` is set the composer says so, and the person can
 * keep the next message in the chat (`dismiss`), where Octo can also build.
 * That holds until a newer browser turn ends. `followUp` clears by itself
 * once the window ends, and `resolve` reads the same at send time.
 */
export function useSharedBrowserFollowUp<Page extends { id: string; leftByRun?: string }>(input: {
  /** Instafy's browser is open or hidden in this conversation. */
  enabled: boolean;
  runs: readonly RunRecord[];
  conversationId: string | null;
  runtimeId: string | null;
  userId: string | null;
  pages: readonly Page[];
  /**
   * Whether another chat took a tab after a time (chatBrowserTab.ts): the
   * follow-up then stays in the chat, since a browser turn uses only its own
   * chat's tab.
   */
  takenByAnotherChat?: ((pageId: string, sinceMs: number) => boolean) | null;
}): {
  followUp: SharedBrowserFollowUp<Page> | null;
  resolve: () => SharedBrowserFollowUp<Page> | null;
  dismiss: () => void;
} {
  const { enabled, runs, conversationId, runtimeId, userId, pages, takenByAnotherChat } = input;
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
  // Bumped when the window ends, so `followUp` is read again then.
  const [clock, setClock] = useState(0);

  const read = useCallback((nowMs: number) => {
    if (!enabled) return null;
    const followUp = sharedBrowserFollowUp(runs, { conversationId, runtimeId, userId, pages, nowMs, takenByAnotherChat });
    return followUp && followUp.runId !== dismissedRunId ? followUp : null;
  }, [conversationId, dismissedRunId, enabled, pages, runs, runtimeId, takenByAnotherChat, userId]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const followUp = useMemo(() => read(Date.now()), [read, clock]);

  useEffect(() => {
    if (!followUp) return;
    const timer = window.setTimeout(() => setClock((value) => value + 1), Math.max(0, followUp.endsAtMs - Date.now()) + 1);
    return () => window.clearTimeout(timer);
  }, [followUp]);

  const resolve = useCallback(() => read(Date.now()), [read]);
  const dismiss = useCallback(() => {
    const current = read(Date.now());
    if (current) setDismissedRunId(current.runId);
  }, [read]);

  return { followUp, resolve, dismiss };
}
