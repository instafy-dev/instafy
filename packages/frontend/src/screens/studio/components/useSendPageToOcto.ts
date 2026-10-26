import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusIntent } from "../../../status/useStatus";
import { BrowserSessionPageCaptureError } from "../../../services/runtimeController/browserSession";
import {
  SENT_PAGE_STATUS,
  buildSentPageAttachment,
  type SentPageAttachmentInfo,
  type SentPageRead,
  type SentPageViewer,
} from "./sentPageAttachment";

type ShowStatus = (message: string, intent?: StatusIntent, durationMs?: number) => void;

/** Plain copy for a page that could not be read. Browser error text is never shown. */
export function sentPageFailureMessage(error: unknown): string {
  if (error instanceof BrowserSessionPageCaptureError) {
    if (error.reason === "not_web_page") return SENT_PAGE_STATUS.notWebPage;
    if (error.reason === "changed") return SENT_PAGE_STATUS.changed;
    // An origin that predates the route, or a proxy that does not know it.
    if (error.status === 404) return SENT_PAGE_STATUS.unsupported;
    if (error.status === 401 || error.status === 403) return SENT_PAGE_STATUS.notAllowed;
    return SENT_PAGE_STATUS.unreadable;
  }
  // Desktop's own fixed messages, wrapped by Electron's IPC.
  const message = error instanceof Error ? error.message : "";
  if (/Open a web page first\./.test(message)) return SENT_PAGE_STATUS.notWebPage;
  if (/changed while it was read/.test(message)) return SENT_PAGE_STATUS.changed;
  return SENT_PAGE_STATUS.unreadable;
}

/**
 * Send page to Octo. `send(viewer, read)` runs `read` once, for this press
 * only, and stages the page in the composer; the person's next message
 * carries it. Nothing reads a page except a press, and nothing is kept that
 * could read it again. One send runs at a time.
 */
export function useSendPageToOcto({
  attachSentPage,
  showStatus,
  unavailableReason = null,
  identityKey,
}: {
  attachSentPage: (file: File, page: SentPageAttachmentInfo) => boolean;
  showStatus: ShowStatus;
  /** Set when this server cannot store attachments. */
  unavailableReason?: string | null;
  /** The person, space and chat the composer belongs to; a send that outlives it is dropped. */
  identityKey: string;
}) {
  const [pendingViewer, setPendingViewer] = useState<SentPageViewer | null>(null);
  const pendingRef = useRef(false);
  const identityRef = useRef(identityKey);
  identityRef.current = identityKey;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const send = useCallback(
    async (viewer: SentPageViewer, read: () => Promise<SentPageRead | null>): Promise<boolean> => {
      if (pendingRef.current) return false;
      if (unavailableReason) {
        showStatus(unavailableReason, "info", 4000);
        return false;
      }
      const identity = identityRef.current;
      pendingRef.current = true;
      setPendingViewer(viewer);
      try {
        const page = await read();
        if (!mountedRef.current || identityRef.current !== identity) return false;
        if (!page) {
          showStatus(SENT_PAGE_STATUS.unsupported, "info", 4500);
          return false;
        }
        const attachment = buildSentPageAttachment(page, viewer);
        if (!attachment) {
          showStatus(SENT_PAGE_STATUS.notWebPage, "info", 4000);
          return false;
        }
        if (attachment.kind === "withheld") {
          showStatus(SENT_PAGE_STATUS.withheld, "warning", 5000);
          return false;
        }
        if (!attachSentPage(attachment.file, attachment.info)) return false;
        showStatus(SENT_PAGE_STATUS.attached, "success", 3500);
        return true;
      } catch (error) {
        if (mountedRef.current && identityRef.current === identity) {
          showStatus(sentPageFailureMessage(error), "error", 4500);
        }
        return false;
      } finally {
        pendingRef.current = false;
        if (mountedRef.current) setPendingViewer(null);
      }
    },
    [attachSentPage, showStatus, unavailableReason],
  );

  return { send, pendingViewer };
}
