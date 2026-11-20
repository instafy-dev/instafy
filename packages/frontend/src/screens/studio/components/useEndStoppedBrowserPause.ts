import { useEffect } from "react";
import { controllerClient } from "../../../sdk/instafy";

/**
 * A Stop ended the turn that paused on the person's fields or step. The
 * outlines that pause drew are on the page itself, in Instafy's browser, so
 * Studio asks the browser to take them off, once for each such pause it
 * shows. The Stop came first and stopped the turn; this sends the page
 * nothing else. An older browser has no such call and keeps the outlines
 * until the page is next read, as before.
 */
export function useEndStoppedBrowserPause(options: {
  /** The pause whose turn a Stop ended; null while there is none. */
  request: { handoffId: string; browserPageId: string } | null;
  projectId: string | null;
  browserSessionId: string;
  preferRuntimeId: string | null;
  end?: typeof controllerClient.browserSessions.endHumanInput;
}): void {
  const { projectId, browserSessionId, preferRuntimeId, end = controllerClient.browserSessions.endHumanInput } = options;
  const handoffId = options.request?.handoffId ?? null;
  const pageId = options.request?.browserPageId ?? null;
  useEffect(() => {
    if (!handoffId || !pageId || !projectId) return;
    void end({ projectId, browserSessionId, preferRuntimeId, pageId, handoffId }).catch(() => false);
  }, [browserSessionId, end, handoffId, pageId, preferRuntimeId, projectId]);
}
