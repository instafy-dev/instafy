import { useEffect, useState } from "react";
import { ChatLoadingPill } from "./ChatLoadingPill";

/** How long a switch may wait in silence before the frame says why. */
export const WORKSPACE_HYDRATING_STATUS_DELAY_MS = 300;

/**
 * The frame a space shows while its chat tabs are rebuilt (see
 * resolveWorkspaceEmptyState). A fast switch stays text-free. A chat route
 * still waiting after a beat says so, in the pill the chat then uses for its
 * messages; any other route keeps the quiet frame, since it is not waiting
 * on chats.
 */
export function WorkspaceHydratingFrame({ loadingChats }: { loadingChats: boolean }) {
  const [statusDue, setStatusDue] = useState(false);
  useEffect(() => {
    if (!loadingChats) {
      setStatusDue(false);
      return;
    }
    const timer = window.setTimeout(() => setStatusDue(true), WORKSPACE_HYDRATING_STATUS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loadingChats]);

  const showStatus = loadingChats && statusDue;
  // Once the status shows, it speaks for the frame. A busy ancestor would let
  // a screen reader hold the announcement until the frame unmounts.
  return (
    <div className="flex h-full" aria-busy={!showStatus} data-testid="workspace-tabs-hydrating">
      {showStatus ? (
        <div className="flex flex-1 items-center justify-center motion-safe:animate-[toast-fade-in_200ms_ease-out_both]">
          <ChatLoadingPill>Loading chats…</ChatLoadingPill>
        </div>
      ) : null}
    </div>
  );
}
