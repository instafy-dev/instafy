import { Xmark } from "iconoir-react";
import { useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { UNSAFE_PortalProvider } from "@react-aria/overlays";
import { StatusConfirmationContext, StatusUpdateContext, type StatusToast } from "./StatusProvider";
import {
  UNSTABLE_Toast,
  UNSTABLE_ToastContent,
  UNSTABLE_ToastList,
  UNSTABLE_ToastRegion,
  type UNSTABLE_ToastQueue,
} from "react-aria-components";
import { Button, IconButton } from "../components/Button";
import { FeedbackNotice } from "../components/FeedbackNotice";
import { useStatus } from "./useStatus";
import { useToastPlacement } from "./useToastPlacement";
import { useStatusDock, useStatusPortal } from "./StatusDock";
import { useVisibleReadingTimer } from "./useVisibleReadingTimer";

export function Status() {
  const { queue } = useStatus();
  const confirmation = useContext(StatusConfirmationContext);
  useContext(StatusUpdateContext);

  if (!queue) {
    return null;
  }

  return <StatusRegion queue={queue} confirmation={confirmation} />;
}

function StatusRegion({ queue, confirmation }: { queue: UNSTABLE_ToastQueue<StatusToast>; confirmation?: StatusToast | null }) {
  const dock = useStatusDock();
  // Keep the React portal target stable when a native pane opens/closes. Moving
  // our own container preserves toast instances, timers and focus bookkeeping.
  const [portal] = useState(() => typeof document === "undefined" ? null : document.createElement("div"));
  const getPortal = useCallback(() => portal, [portal]);
  useStatusPortal(portal);
  const placement = useToastPlacement(queue, Boolean(confirmation));
  const position = dock ? undefined : {
    ...placement,
    paddingLeft: "max(var(--instafy-safe-area-inset-left), 1rem)",
    paddingRight: "max(var(--instafy-safe-area-inset-right), 1rem)",
  };
  return <>
    {portal ? createPortal(
      <div className={dock ? `pointer-events-none flex justify-center ${confirmation ? "p-2" : ""}` : "pointer-events-none fixed inset-x-0 z-[1100] flex justify-center overflow-y-auto py-1"} style={position} data-react-aria-top-layer="true">
        <div role="status" aria-live="polite" aria-atomic="true" className="min-w-0 max-w-sm">
          {confirmation ? <FeedbackNotice
            tone="success" compact
            className="toast-fade-in"
            data-testid="status-toast" data-presentation="confirmation"
          >{confirmation.message}</FeedbackNotice> : null}
        </div>
      </div>, portal,
    ) : null}
    <UNSAFE_PortalProvider getContainer={getPortal}>
    <UNSTABLE_ToastRegion
      queue={queue}
      className={dock ? "pointer-events-none flex justify-center p-2" : "pointer-events-none fixed inset-x-0 z-[1100] flex justify-center overflow-y-auto py-1"}
      style={position}
    >
      <UNSTABLE_ToastList<StatusToast> className="m-0 flex w-full min-w-0 max-w-md list-none flex-col items-center gap-2 p-0">
        {({ toast }) => <StatusToastItem toast={toast} queue={queue} />}
      </UNSTABLE_ToastList>
    </UNSTABLE_ToastRegion>
    </UNSAFE_PortalProvider>
  </>;
}

function StatusToastItem({ toast, queue }: { toast: UNSTABLE_ToastQueue<StatusToast>["visibleToasts"][number]; queue: UNSTABLE_ToastQueue<StatusToast> }) {
  const content = toast.content;
  const timer = useVisibleReadingTimer(content.readingDuration, () => queue.close(toast.key), false, content.revision);
  const timerRef = timer.ref;
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const registerNode = useCallback((node: HTMLDivElement | null) => {
    nodeRef.current = node;
    timerRef(node);
  }, [timerRef]);
  useLayoutEffect(() => {
    content.hasFocus = timer.hasFocus;
    return () => { delete content.hasFocus; };
  }, [content, timer.hasFocus]);
  useLayoutEffect(() => {
    // An owner update may remove the action that had focus. Keep the remaining
    // dismiss control reachable, without overriding an intentional external move.
    if (content.restoreFocus && document.activeElement === document.body) {
      nodeRef.current?.querySelector<HTMLButtonElement>('button[slot="close"]')?.focus({ preventScroll: true });
    }
    content.restoreFocus = false;
  }, [content, content.revision]);
  const handleAction = () => {
    const revision = content.revision;
    content.onAction?.();
    // The action may publish progress under the same owner ID. That update
    // keeps its queue key, so only close the message whose action was invoked.
    if (content.revision === revision) queue.close(toast.key);
  };
  return <UNSTABLE_Toast<StatusToast>
              toast={toast}
              ref={registerNode}
              {...timer.interactionProps}
              aria-label={content.message}
              data-testid="status-toast"
              data-presentation={content.presentation}
              className="pointer-events-auto w-full min-w-0 max-w-full rounded-xl toast-fade-in"
            >
              <UNSTABLE_ToastContent className="min-w-0 max-w-full">
                <FeedbackNotice
                  tone={content.intent === "error" ? "danger" : content.intent === "info" ? "neutral" : content.intent}
                  actions={content.actionLabel && content.onAction ? (
                    <Button
                      onPress={handleAction}
                      variant="ghost"
                      preset="inline"
                      className="max-w-full [overflow-wrap:anywhere]"
                    >
                      {content.actionLabel}
                    </Button>
                  ) : undefined}
                  dismiss={<IconButton
                    slot="close"
                    variant="ghost"
                    size="sm"
                    radius="lg"
                    aria-label="Dismiss notification"
                  >
                    <Xmark className="h-4 w-4" aria-hidden="true" />
                  </IconButton>}
                >{content.message}</FeedbackNotice>
              </UNSTABLE_ToastContent>
            </UNSTABLE_Toast>;
}
