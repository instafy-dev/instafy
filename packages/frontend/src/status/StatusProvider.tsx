import { createContext, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
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
  onClose?: () => void;
  /** Called only after this toast becomes visible, never while it is queued. */
  onShow?: () => void;
  forceVisible?: boolean;
  /**
   * Queue this toast until the current toast closes instead of replacing it.
   * Use for background notifications that must not hide an active error or
   * warning while still remaining actionable afterward. One that also has no
   * timeout waits for the person: a toast that replaces it puts it back at
   * the front of the queue, so it shows again once that toast closes, until
   * the person closes it or its owner hides it.
   */
  nonPreemptive?: boolean;
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

interface PendingStatusToast {
  content: StatusToast;
  timeout: number | undefined;
  onClose: (() => void) | undefined;
  onShow?: () => void;
  /** A background toast with no timeout: see `nonPreemptive`. */
  standing?: boolean;
}

export function StatusProvider({ children }: { children: ReactNode }) {
  const queue = useMemo(() => new UNSTABLE_ToastQueue<StatusToast>({ maxVisibleToasts: 1 }), []);
  const pendingToastsRef = useRef<PendingStatusToast[]>([]);
  const suppressPendingFlushRef = useRef(false);
  // The standing toasts on screen, by their key in the queue.
  const standingToastsRef = useRef(new Map<string, PendingStatusToast>());

  const addToast = useCallback((toast: PendingStatusToast) => {
    let key = "";
    key = queue.add(toast.content, {
      timeout: toast.timeout,
      onClose: () => {
        standingToastsRef.current.delete(key);
        toast.onClose?.();
      },
    });
    if (toast.standing) {
      standingToastsRef.current.set(key, toast);
    }
    toast.onShow?.();
  }, [queue]);

  const flushPendingToast = useCallback(() => {
    if (suppressPendingFlushRef.current || queue.visibleToasts.length > 0) {
      return;
    }
    const next = pendingToastsRef.current.shift();
    if (next) {
      addToast(next);
    }
  }, [addToast, queue]);

  useEffect(() => queue.subscribe(flushPendingToast), [flushPendingToast, queue]);

  /**
   * Closes the toasts on screen. With `keepStanding` (a toast replaces them),
   * a standing one is not closed but goes back to the front of the queue.
   */
  const clearVisibleToasts = useCallback((keepStanding: boolean) => {
    suppressPendingFlushRef.current = true;
    const kept: PendingStatusToast[] = [];
    try {
      for (const toast of queue.visibleToasts) {
        const standing = keepStanding ? standingToastsRef.current.get(toast.key) : undefined;
        if (standing) {
          kept.push(standing);
        } else {
          queue.close(toast.key);
        }
      }
      queue.clear();
      standingToastsRef.current.clear();
    } finally {
      suppressPendingFlushRef.current = false;
    }
    pendingToastsRef.current.unshift(...kept);
  }, [queue]);

  const hideStatus = useCallback((id?: string) => {
    if (id) {
      const retained: PendingStatusToast[] = [];
      for (const toast of pendingToastsRef.current) {
        if (toast.content.id === id) {
          toast.onClose?.();
        } else {
          retained.push(toast);
        }
      }
      pendingToastsRef.current = retained;
      for (const toast of queue.visibleToasts) {
        if (toast.content.id === id) {
          queue.close(toast.key);
        }
      }
      return;
    }

    for (const toast of pendingToastsRef.current) {
      toast.onClose?.();
    }
    pendingToastsRef.current = [];
    clearVisibleToasts(false);
  }, [clearVisibleToasts, queue]);

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
      const content: StatusToast = {
        id: options?.id,
        message,
        intent,
        presentation,
        actionLabel: options?.actionLabel,
        onAction: options?.onAction ?? null,
      };
      const timeout = duration > 0 ? duration : undefined;
      const toast: PendingStatusToast = {
        content,
        timeout,
        onClose: options?.onClose,
        onShow: options?.onShow,
        standing: Boolean(options?.nonPreemptive) && timeout === undefined,
      };
      if (options?.nonPreemptive && queue.visibleToasts.length > 0) {
        if (
          content.id &&
          (queue.visibleToasts.some((visible) => visible.content.id === content.id) ||
            pendingToastsRef.current.some((pending) => pending.content.id === content.id))
        ) {
          return;
        }
        pendingToastsRef.current.push(toast);
        return;
      }
      clearVisibleToasts(true);
      addToast(toast);
    },
    [addToast, clearVisibleToasts, queue]
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
