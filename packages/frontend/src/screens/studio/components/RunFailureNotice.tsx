import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { RunFailurePresentation } from "../../../conversations/runFailurePresentation";
import type { ChatMessage } from "../types";

export type RunFailureRetryContextValue = {
  /** Message id of the failure whose resend is currently in flight, if any. */
  pendingRetryKey: string | null;
  requestRetry: (failureMessage: ChatMessage) => void | Promise<void>;
  /**
   * Message id of the failure that is currently being re-dispatched
   * automatically, if any. When it matches a failure card, that card shows the
   * calm "trying again automatically" state instead of the manual controls.
   */
  autoRetryingKey: string | null;
  /**
   * Opens the AI connect/settings surface. Rendered as a "Connect AI" action on
   * failures whose cause is a missing credential (kind === "needs_ai").
   */
  onConnectAi?: () => void;
};

const RunFailureRetryContext = createContext<RunFailureRetryContextValue | null>(null);

export function RunFailureRetryProvider({
  value,
  children,
}: {
  value: RunFailureRetryContextValue | null;
  children: ReactNode;
}) {
  return <RunFailureRetryContext.Provider value={value}>{children}</RunFailureRetryContext.Provider>;
}

export function useRunFailureRetry(): RunFailureRetryContextValue | null {
  return useContext(RunFailureRetryContext);
}

/**
 * Friendly body for a failed-run assistant message: one plain sentence, a
 * quiet actions row ("Try again" + "Details"), and the raw technical text
 * collapsed behind the Details toggle. The stored message keeps the raw text.
 */
export function RunFailureMessageBody({
  message,
  presentation,
}: {
  message: ChatMessage;
  presentation: RunFailurePresentation;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const retryContext = useRunFailureRetry();
  const retryInFlight = retryContext !== null && retryContext.pendingRetryKey !== null;
  const autoRetrying = retryContext?.autoRetryingKey === message.id;
  const needsAi = presentation.kind === "needs_ai";
  const onConnectAi = retryContext?.onConnectAi;
  const handleRetry = useCallback(() => {
    if (!retryContext || retryContext.pendingRetryKey !== null) {
      return;
    }
    void retryContext.requestRetry(message);
  }, [message, retryContext]);

  return (
    <div className="min-w-0 space-y-1.5" data-testid="run-failure-body">
      <p className="whitespace-pre-wrap break-words text-sm">{presentation.friendlyText}</p>
      {autoRetrying ? (
        <p
          data-testid="run-failure-auto-retrying"
          className="text-xs text-slate-500 dark:text-slate-400"
        >
          Trying again automatically…
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        {needsAi && onConnectAi && !autoRetrying ? (
          <button
            type="button"
            data-testid="run-failure-connect-ai"
            onClick={onConnectAi}
            className="inline-flex flex-none items-center rounded-full border border-primary-500/30 bg-primary-600 px-2 py-0.5 text-xxs font-semibold leading-none text-white hover:bg-primary-700"
          >
            Connect AI
          </button>
        ) : null}
        {retryContext && !autoRetrying && !needsAi ? (
          <button
            type="button"
            data-testid="run-failure-retry"
            onClick={handleRetry}
            disabled={retryInFlight}
            aria-busy={retryContext.pendingRetryKey === message.id || undefined}
            className="inline-flex flex-none items-center rounded-full border border-slate-200/70 bg-white/70 px-2 py-0.5 text-xxs font-semibold leading-none text-slate-600 hover:text-slate-800 disabled:opacity-60 dark:border-slate-700/80 dark:bg-slate-900/70 dark:text-slate-300 dark:hover:text-slate-100"
          >
            Try again
          </button>
        ) : null}
        <button
          type="button"
          data-testid="run-failure-details-toggle"
          onClick={() => setDetailsOpen((current) => !current)}
          aria-expanded={detailsOpen}
          className="text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
        >
          Details
        </button>
      </div>
      {detailsOpen ? (
        <div
          data-testid="run-failure-details"
          className="whitespace-pre-wrap break-words text-xs text-slate-500 dark:text-slate-400"
        >
          {presentation.rawText}
        </div>
      ) : null}
    </div>
  );
}
