import { Xmark } from "iconoir-react";
import type { StatusIntent, StatusToast } from "./StatusProvider";
import { UNSTABLE_Toast, UNSTABLE_ToastContent, UNSTABLE_ToastList, UNSTABLE_ToastRegion } from "react-aria-components";
import { Button } from "../components/Button";
import { useStatus } from "./useStatus";

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

  return (
    <UNSTABLE_ToastRegion
      queue={queue}
      className="pointer-events-none fixed inset-x-0 top-[calc(3.75rem+var(--instafy-safe-area-inset-top))] z-[1100] flex justify-center"
      style={{
        paddingLeft: "var(--instafy-safe-area-inset-left)",
        paddingRight: "var(--instafy-safe-area-inset-right)",
      }}
    >
      <UNSTABLE_ToastList<StatusToast> className="m-0 flex list-none flex-col items-center gap-2 px-4 sm:px-6">
        {({ toast }) => {
          const content = toast.content;
          const isErrorLike = content.intent === "error" || content.intent === "warning";
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
              } ${isErrorLike ? "toast-slide-in-top" : "toast-fade-in"} ${intentStyles}`}
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
