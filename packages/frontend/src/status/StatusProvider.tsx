import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { UNSTABLE_ToastQueue } from "react-aria-components";
import { StatusDockProvider } from "./StatusDock";
import { MAX_PENDING_STATUS_TOASTS, PENDING_INFORMATION_MAX_AGE_MS, readableStatusDuration, type StatusBehavior } from "./statusBehavior";

export { statusBehavior, type StatusBehavior } from "./statusBehavior";

export type StatusIntent = "info" | "success" | "error" | "warning";
export type StatusPresentation = "default" | "confirmation";

export interface StatusToast {
  id?: string;
  message: string;
  intent: StatusIntent;
  presentation: StatusPresentation;
  actionLabel?: string;
  onAction?: (() => void) | null;
  /** App-owned reading timer; absent for persistent and absolute-deadline notices. */
  readingDuration?: number;
  /** Presentation-only update identity and focus registration. */
  revision?: number;
  hasFocus?: () => boolean;
  restoreFocus?: boolean;
}

export interface StatusToastOptions {
  id?: string;
  actionLabel?: string;
  onAction?: () => void;
  onClose?: () => void;
  /** Called only after this toast becomes visible, never while it is queued. */
  onShow?: () => void;
  forceVisible?: boolean;
  /** Explicit lifetime semantics. Omitted behavior preserves legacy durations. */
  behavior?: StatusBehavior;
  /**
   * Queue this toast until the current toast closes instead of replacing it.
   * Use for background notifications that must not hide an active error or
   * warning while still remaining actionable afterward. Errors and actionable
   * notices are protected from ordinary replacement even without this option.
   */
  nonPreemptive?: boolean;
  /**
   * Use for short, transient success acknowledgements such as a completed copy.
   * Confirmations are visible without `forceVisible` and render as a compact,
   * passive notice. They are suppressed while another notification needs
   * attention. Other intents, actions, and persistent durations safely fall
   * back to the default toast presentation.
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
/** Presentation consumers subscribe separately; ordinary status callers stay stable. */
export const StatusConfirmationContext = createContext<StatusToast | null>(null);
export const StatusUpdateContext = createContext(0);

interface PendingStatusToast {
  content: StatusToast;
  onClose: (() => void) | undefined;
  onShow?: () => void;
  sourceAction?: () => void;
  priority: number;
  protected: boolean;
  expiresAt?: number;
  pendingExpiresAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  closed?: boolean;
  key?: string;
}

export function StatusProvider({ children }: { children: ReactNode }) {
  const queue = useMemo(() => new UNSTABLE_ToastQueue<StatusToast>({ maxVisibleToasts: 1 }), []);
  const [confirmation, setConfirmation] = useState<StatusToast | null>(null);
  const [presentationRevision, setPresentationRevision] = useState(0);
  const confirmationRef = useRef<PendingStatusToast | null>(null);
  const confirmationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingToastsRef = useRef<PendingStatusToast[]>([]);
  const suppressPendingFlushRef = useRef(false);
  const activeToastRef = useRef<PendingStatusToast | null>(null);
  const scheduledRef = useRef(new Set<PendingStatusToast>());

  const cancelTimer = useCallback((toast: PendingStatusToast) => {
    if (toast.timer !== undefined) clearTimeout(toast.timer);
    toast.timer = undefined;
    scheduledRef.current.delete(toast);
  }, []);
  const closeEntry = useCallback((toast: PendingStatusToast) => {
    if (toast.closed) return;
    toast.closed = true;
    cancelTimer(toast);
    toast.onClose?.();
  }, [cancelTimer]);

  const clearConfirmation = useCallback(() => {
    if (confirmationTimerRef.current !== null) {
      clearTimeout(confirmationTimerRef.current);
      confirmationTimerRef.current = null;
    }
    const previous = confirmationRef.current;
    confirmationRef.current = null;
    setConfirmation(null);
    if (previous) closeEntry(previous);
  }, [closeEntry]);

  const addToast = useCallback((toast: PendingStatusToast) => {
    if (toast.closed) return;
    if ((toast.expiresAt ?? toast.pendingExpiresAt ?? Infinity) <= Date.now()) {
      closeEntry(toast);
      return;
    }
    // Pending information has a freshness limit, but its displayed lifetime is
    // measured by the shared reading timer. Deadlines keep their original clock.
    if (toast.expiresAt === undefined) cancelTimer(toast);
    toast.pendingExpiresAt = undefined;
    activeToastRef.current = toast;
    toast.key = queue.add(toast.content, {
      onClose: () => {
        if (activeToastRef.current === toast) activeToastRef.current = null;
        closeEntry(toast);
      },
    });
    toast.onShow?.();
  }, [cancelTimer, closeEntry, queue]);

  const flushPendingToast = useCallback(() => {
    if (suppressPendingFlushRef.current || queue.visibleToasts.length > 0) {
      return;
    }
    while (pendingToastsRef.current.length && queue.visibleToasts.length === 0) {
      addToast(pendingToastsRef.current.shift()!);
    }
  }, [addToast, queue]);

  useEffect(() => queue.subscribe(flushPendingToast), [flushPendingToast, queue]);

  const clearVisibleToasts = useCallback(() => {
    suppressPendingFlushRef.current = true;
    try {
      for (const toast of queue.visibleToasts) {
        queue.close(toast.key);
      }
    } finally {
      suppressPendingFlushRef.current = false;
    }
  }, [queue]);

  const scheduleExpiry = useCallback((toast: PendingStatusToast, at: number) => {
    cancelTimer(toast);
    scheduledRef.current.add(toast);
    toast.timer = setTimeout(() => {
      pendingToastsRef.current = pendingToastsRef.current.filter(pending => pending !== toast);
      if (toast.key) queue.close(toast.key);
      else closeEntry(toast);
    }, Math.max(0, at - Date.now()));
  }, [cancelTimer, closeEntry, queue]);

  useEffect(() => {
    // StrictMode may clean up and restart effects while retaining the queue.
    // Rehydrate absolute timers instead of turning a deadline into persistence.
    const scheduled = scheduledRef.current;
    for (const toast of [...scheduled]) {
      scheduleExpiry(toast, toast.expiresAt ?? toast.pendingExpiresAt!);
    }
    const passive = confirmationRef.current;
    if (passive?.expiresAt !== undefined) {
      if (confirmationTimerRef.current !== null) clearTimeout(confirmationTimerRef.current);
      confirmationTimerRef.current = setTimeout(clearConfirmation, Math.max(0, passive.expiresAt - Date.now()));
    }
    return () => {
      if (confirmationTimerRef.current !== null) clearTimeout(confirmationTimerRef.current);
      scheduled.forEach(toast => { if (toast.timer !== undefined) clearTimeout(toast.timer); });
    };
  }, [clearConfirmation, scheduleExpiry]);

  const enqueueToast = useCallback((toast: PendingStatusToast) => {
    pendingToastsRef.current.push(toast);
    // Priority within pending work, FIFO within a priority. The active error or
    // action remains operable until dismissed, expired, or hidden by its owner.
    pendingToastsRef.current.sort((a, b) => b.priority - a.priority);
    if (toast.expiresAt === undefined && toast.content.readingDuration !== undefined && toast.content.intent !== "error") {
      toast.pendingExpiresAt = Date.now() + PENDING_INFORMATION_MAX_AGE_MS;
      scheduleExpiry(toast, toast.pendingExpiresAt);
    }
    const finiteInformation = pendingToastsRef.current.filter(pending => pending.pendingExpiresAt !== undefined);
    if (finiteInformation.length > MAX_PENDING_STATUS_TOASTS) {
      const lowestPriority = finiteInformation.at(-1)!.priority;
      const index = pendingToastsRef.current.findIndex(pending => pending.pendingExpiresAt !== undefined && pending.priority === lowestPriority);
      const [dropped] = pendingToastsRef.current.splice(index, 1);
      closeEntry(dropped);
    }
  }, [closeEntry, scheduleExpiry]);

  const hideStatus = useCallback((id?: string) => {
    if (id) {
      if (confirmationRef.current?.content.id === id) clearConfirmation();
      const retained: PendingStatusToast[] = [];
      for (const toast of pendingToastsRef.current) {
        if (toast.content.id === id) {
          closeEntry(toast);
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

    clearConfirmation();
    for (const toast of pendingToastsRef.current) {
      closeEntry(toast);
    }
    pendingToastsRef.current = [];
    clearVisibleToasts();
  }, [clearConfirmation, clearVisibleToasts, closeEntry, queue]);

  const showStatus = useCallback(
    (
      message: string,
      intent: StatusIntent = "info",
      duration?: number,
      options?: StatusToastOptions
    ) => {
      if (shouldSuppressToast(message)) {
        return;
      }
      const hasAction = Boolean(options?.actionLabel && options?.onAction);
      const behavior = options?.behavior;
      const resolvedDuration = behavior?.kind === "action-required" ? 0
        : duration ?? (behavior?.kind === "acknowledgement" ? 2200
          : behavior?.kind === "informational" ? readableStatusDuration(message) : 5000);
      const expiresAt = behavior?.kind === "deadline" ? behavior.expiresAt : undefined;
      if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) return;
      const confirmationRequested = options?.presentation === "confirmation" || behavior?.kind === "acknowledgement";
      const presentation: StatusPresentation =
        confirmationRequested && intent === "success" && !hasAction && resolvedDuration > 0 && expiresAt === undefined
          ? "confirmation"
          : "default";
      const shouldShowToast =
        intent === "error" ||
        intent === "warning" ||
        hasAction ||
        confirmationRequested ||
        behavior !== undefined ||
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
        readingDuration: resolvedDuration > 0 && expiresAt === undefined ? resolvedDuration : undefined,
      };
      const toast: PendingStatusToast = {
        content,
        onClose: options?.onClose,
        onShow: options?.onShow,
        sourceAction: options?.onAction,
        priority: expiresAt !== undefined ? 4 : intent === "error" || behavior?.kind === "action-required" ? 3 : hasAction ? 2 : intent === "warning" ? 1 : 0,
        protected: intent === "error" || hasAction || behavior?.kind === "action-required" || expiresAt !== undefined,
        expiresAt,
      };
      if (content.onAction) {
        content.onAction = () => {
          if (!toast.closed && (expiresAt === undefined || Date.now() < expiresAt)) toast.sourceAction?.();
        };
      }
      if (presentation === "confirmation") {
        // A delayed copy acknowledgement is stale, and must never remove an
        // error, an Undo action, or a waiting approval from the screen.
        if (queue.visibleToasts.length > 0 || pendingToastsRef.current.length > 0) return;
        clearConfirmation();
        toast.expiresAt = Date.now() + resolvedDuration;
        confirmationRef.current = toast;
        setConfirmation(content);
        confirmationTimerRef.current = setTimeout(() => {
          if (confirmationRef.current === toast) clearConfirmation();
        }, resolvedDuration);
        toast.onShow?.();
        return;
      }
      const sameContent = (entry: PendingStatusToast) => entry.content.message === message
        && entry.content.intent === intent && entry.content.actionLabel === content.actionLabel
        && Boolean(entry.sourceAction) === Boolean(options?.onAction)
        && entry.content.presentation === content.presentation
        && entry.content.readingDuration === content.readingDuration
        && (entry.expiresAt === undefined) === (expiresAt === undefined);
      const sameIdentity = (entry: PendingStatusToast) => content.id
        ? entry.content.id === content.id
        : !entry.content.id && sameContent(entry) && entry.sourceAction === options?.onAction;
      const existing = [activeToastRef.current, ...pendingToastsRef.current].find(entry => entry && sameIdentity(entry));
      if (existing && sameContent(existing)) {
        // New callback identity is not a new message or an extension of an Undo
        // deadline. Idless actions only dedupe when the action itself is equal.
        existing.sourceAction = options?.onAction;
        return;
      }
      const replacesActive = Boolean(existing && existing === activeToastRef.current);
      if (existing && replacesActive) {
        // The queue has no update API. Keep its key and content object while a
        // separate presentation signal refreshes the React tree. This preserves
        // the exact focused button and React Aria's original focus restoration.
        const ownedFocus = existing.content.hasFocus?.();
        closeEntry(existing);
        if (queue.visibleToasts.some(visible => visible.key === existing.key)) {
          const previousContent = existing.content;
          const key = existing.key;
          Object.assign(previousContent, content, { revision: (previousContent.revision ?? 0) + 1, restoreFocus: ownedFocus });
          Object.assign(existing, toast, { content: previousContent, key, closed: false });
          previousContent.onAction = options?.onAction ? () => {
            if (!existing.closed && (existing.expiresAt === undefined || Date.now() < existing.expiresAt)) existing.sourceAction?.();
          } : null;
          if (expiresAt !== undefined) scheduleExpiry(existing, expiresAt);
          setPresentationRevision(revision => revision + 1);
          existing.onShow?.();
          return;
        }
      }
      if (existing && !replacesActive) {
        pendingToastsRef.current = pendingToastsRef.current.filter(pending => pending !== existing);
        closeEntry(existing);
      }
      clearConfirmation();
      if (expiresAt !== undefined) scheduleExpiry(toast, expiresAt);
      if (!replacesActive && queue.visibleToasts.length > 0 && (options?.nonPreemptive || activeToastRef.current?.protected || activeToastRef.current?.content.hasFocus?.())) {
        enqueueToast(toast);
        return;
      }
      if (pendingToastsRef.current.length > 0) {
        enqueueToast(toast);
        clearVisibleToasts();
        flushPendingToast();
        return;
      }
      clearVisibleToasts();
      addToast(toast);
    },
    [addToast, clearConfirmation, clearVisibleToasts, closeEntry, enqueueToast, flushPendingToast, queue, scheduleExpiry]
  );

  const value = useMemo<StatusContextValue>(
    () => ({
      queue,
      showStatus,
      hideStatus
    }),
    [queue, showStatus, hideStatus]
  );

  return <StatusContext.Provider value={value}>
    <StatusConfirmationContext.Provider value={confirmation}><StatusUpdateContext.Provider value={presentationRevision}><StatusDockProvider>{children}</StatusDockProvider></StatusUpdateContext.Provider></StatusConfirmationContext.Provider>
  </StatusContext.Provider>;
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
