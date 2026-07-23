import { useEffect } from "react";
import type { BrowserTransport } from "./usePersonalBrowserBridge";

export function useSharedBrowserApprovalTransport({
  pending,
  transport,
  revealSharedBrowser,
}: {
  pending: boolean;
  transport: BrowserTransport;
  revealSharedBrowser: () => void;
}) {
  useEffect(() => {
    if (pending && transport !== "shared") {
      revealSharedBrowser();
    }
  }, [pending, revealSharedBrowser, transport]);
}
