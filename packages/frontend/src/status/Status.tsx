import { Xmark } from "iconoir-react";
import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { StatusIntent, StatusToast } from "./StatusProvider";
import {
  UNSTABLE_Toast,
  UNSTABLE_ToastContent,
  UNSTABLE_ToastList,
  UNSTABLE_ToastRegion,
  type UNSTABLE_ToastQueue,
} from "react-aria-components";
import { Button } from "../components/Button";
import { subscribeToastClearance, toastClearanceBottom } from "./toastClearance";
import { useStatus } from "./useStatus";

/** Where a toast starts when nothing is in its way: under the top bar. */
const TOAST_TOP = "calc(3.75rem + var(--instafy-safe-area-inset-top))";
/** The space between a bar a toast stays below and the toast. */
const TOAST_CLEARANCE_GAP_PX = 8;

/**
 * Where toasts start: under the top bar, or under the view bar when one is
 * on screen (`useToastClearanceRef`), so a toast never covers Chat | Browser.
 * Measured while a toast shows, and again when a bar comes, goes or resizes.
 */
function useToastTop(queue: UNSTABLE_ToastQueue<StatusToast>): string {
  const subscribe = useCallback((onChange: () => void) => queue.subscribe(onChange), [queue]);
  const showing = useSyncExternalStore(subscribe, () => queue.visibleToasts.length > 0, () => false);
  const [clearance, setClearance] = useState(0);
  useLayoutEffect(() => {
    if (!showing) return;
    const measure = () => setClearance(toastClearanceBottom());
    measure();
    const unsubscribe = subscribeToastClearance(measure);
    window.addEventListener("resize", measure);
    return () => {
      unsubscribe();
      window.removeEventListener("resize", measure);
    };
  }, [showing]);
  return clearance > 0 ? `max(${TOAST_TOP}, ${clearance + TOAST_CLEARANCE_GAP_PX}px)` : TOAST_TOP;
}

function getIntentStyles(intent: StatusIntent): string {
  switch (intent) {
    case "success":
      return "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-slate-950 dark:text-emerald-200";
    case "error":
      return "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-slate-950 dark:text-rose-200";
    case "warning":
      return "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-slate-950 dark:text-amber-200";
    default:
      return "border-slate-200 bg-white text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200";
  }
}

export function Status() {
  const { queue } = useStatus();

  if (!queue) {
    return null;
  }

  return <StatusRegion queue={queue} />;
}

function StatusRegion({ queue }: { queue: UNSTABLE_ToastQueue<StatusToast> }) {
  const top = useToastTop(queue);
  return (
    <UNSTABLE_ToastRegion
      queue={queue}
      className="pointer-events-none fixed inset-x-0 z-[1100] flex justify-center"
      style={{
        top,
        paddingLeft: "var(--instafy-safe-area-inset-left)",
        paddingRight: "var(--instafy-safe-area-inset-right)",
      }}
    >
      <UNSTABLE_ToastList<StatusToast> className="m-0 flex list-none flex-col items-center gap-2 px-4 sm:px-6">
        {({ toast }) => {
          const content = toast.content;
          const isConfirmation = content.presentation === "confirmation";
          const intentStyles = getIntentStyles(content.intent);

          const handleAction = () => {
            if (content.onAction) {
              content.onAction();
            }
            queue.close(toast.key);
          };

          return (
            <UNSTABLE_Toast<StatusToast>
              toast={toast}
              aria-label={content.message}
              data-testid="status-toast"
              data-presentation={content.presentation}
              className={`${
                isConfirmation
                  ? "pointer-events-none flex min-h-8 max-w-[calc(100vw-2rem)] items-center rounded-full border px-3 py-1.5 text-xs font-medium shadow-md shadow-slate-900/10 sm:max-w-sm"
                  : "pointer-events-auto flex max-w-md items-start gap-3 rounded-2xl border px-4 py-3 text-sm shadow-lg shadow-slate-900/10"
              } toast-fade-in ${intentStyles}`}
            >
              <UNSTABLE_ToastContent
                className={isConfirmation ? "flex min-w-0 items-center" : "flex flex-1 items-start gap-3"}
              >
                <span className="flex-1">{content.message}</span>
                {content.actionLabel && content.onAction ? (
                  <Button
                    onPress={handleAction}
                    variant="ghost"
                    size="xs"
                    radius="md"
                    className="bg-white/40 text-xs text-slate-700 shadow-sm hover:bg-white/70 data-[hovered]:bg-white/70 dark:bg-slate-950/40 dark:text-slate-100 dark:hover:bg-slate-950/70 dark:data-[hovered]:bg-slate-950/70"
                  >
                    {content.actionLabel}
                  </Button>
                ) : null}
                {!isConfirmation ? (
                  <Button
                    slot="close"
                    variant="ghost"
                    size="xs"
                    radius="md"
                    className="ml-2 text-xs hover:border-slate-200 hover:bg-white/50 data-[hovered]:bg-white/50 dark:hover:border-slate-700 dark:hover:bg-slate-950/70 dark:data-[hovered]:bg-slate-950/70"
                    aria-label="Dismiss notification"
                  >
                    <Xmark className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                ) : null}
              </UNSTABLE_ToastContent>
            </UNSTABLE_Toast>
          );
        }}
      </UNSTABLE_ToastList>
    </UNSTABLE_ToastRegion>
  );
}
