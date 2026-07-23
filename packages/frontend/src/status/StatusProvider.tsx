import { createContext, useCallback, useMemo, type ReactNode } from "react";
import { UNSTABLE_ToastQueue } from "react-aria-components";

export type StatusIntent = "info" | "success" | "error" | "warning";
export type StatusPresentation = "default" | "confirmation";

export interface StatusToast {
  id?: string;
  message: string;
  intent: StatusIntent;
  presentation: StatusPresentation;
  actionLabel?: string;
  onAction?: (() => void) | null;
}

export interface StatusToastOptions {
  id?: string;
  actionLabel?: string;
  onAction?: () => void;
  forceVisible?: boolean;
  /**
   * Use for short, transient success acknowledgements such as a completed copy.
   * Confirmations are visible without `forceVisible` and render as a compact,
   * non-interactive pill. Other intents, actions, and persistent durations
   * safely fall back to the default toast presentation.
   */
  presentation?: StatusPresentation;
}

export interface StatusContextValue {
  queue: UNSTABLE_ToastQueue<StatusToast> | null;
  showStatus: (
    message: string,
    intent?: StatusIntent,
    duration?: number,
    options?: StatusToastOptions
  ) => void;
  hideStatus: (id?: string) => void;
}

const defaultContext: StatusContextValue = {
  queue: null,
  showStatus: () => {},
  hideStatus: () => {}
};

export const StatusContext = createContext<StatusContextValue>(defaultContext);

export function StatusProvider({ children }: { children: ReactNode }) {
  const queue = useMemo(() => new UNSTABLE_ToastQueue<StatusToast>({ maxVisibleToasts: 1 }), []);

  const hideStatus = useCallback((id?: string) => {
    if (queue.visibleToasts.length === 0) {
      return;
    }

    if (id) {
      for (const toast of queue.visibleToasts) {
        if (toast.content.id === id) {
          queue.close(toast.key);
        }
      }
      return;
    }

    for (const toast of queue.visibleToasts) {
      queue.close(toast.key);
    }
    queue.clear();
  }, [queue]);

  const showStatus = useCallback(
    (
      message: string,
      intent: StatusIntent = "info",
      duration = 5000,
      options?: StatusToastOptions
    ) => {
      if (shouldSuppressToast(message)) {
        return;
      }
      const hasAction = Boolean(options?.actionLabel && options?.onAction);
      const confirmationRequested = options?.presentation === "confirmation";
      const presentation: StatusPresentation =
        confirmationRequested && intent === "success" && !hasAction && duration > 0
          ? "confirmation"
          : "default";
      const shouldShowToast =
        intent === "error" ||
        intent === "warning" ||
        hasAction ||
        confirmationRequested ||
        options?.forceVisible === true;
      if (!shouldShowToast) {
        return;
      }
      hideStatus();
      queue.add(
        {
          id: options?.id,
          message,
          intent,
          presentation,
          actionLabel: options?.actionLabel,
          onAction: options?.onAction ?? null
        },
        {
          timeout: duration > 0 ? duration : undefined
        }
      );
    },
    [hideStatus, queue]
  );

  const value = useMemo<StatusContextValue>(
    () => ({
      queue,
      showStatus,
      hideStatus
    }),
    [queue, showStatus, hideStatus]
  );

  return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>;
}

function shouldSuppressToast(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) {
    return false;
  }
  const lowered = normalized.toLowerCase();
  const looksLikeRuntimeDebugPayload =
    lowered.includes("status=") &&
    (lowered.includes("lastseen=") || lowered.includes("idlettl=") || lowered.includes("endpoint="));

  return looksLikeRuntimeDebugPayload;
}
