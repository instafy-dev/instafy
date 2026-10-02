import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check } from "iconoir-react";
import { Button } from "../../../components/Button";
import type { RunFailurePresentation } from "../../../conversations/runFailurePresentation";
import type { ChatMessage } from "../types";
import type { ScheduledRunFailureAutoRetry } from "./useRunFailureAutoRetry";

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
   * The countdown before a failure is sent again automatically. The matching
   * card shows the remaining time and a Cancel control instead of "Try again".
   */
  scheduledAutoRetry?: ScheduledRunFailureAutoRetry | null;
  /** Stops the countdown for that failure and leaves the manual "Try again". */
  cancelAutoRetry?: (failureMessageId: string) => void;
  /**
   * True once the failure's prompt has been sent again, or queued to go out
   * once the agent is free (by its card or automatically). Such a card shows
   * "Retried" instead of "Try again", so the same prompt cannot be sent twice
   * from it.
   */
  isRetrySuperseded?: (failureMessage: ChatMessage) => boolean;
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

// Touch-sized hit area on phones and tablets, the compact desktop height from
// lg up (the same pair the profile popover's "Try again" uses).
const ACTION_HIT_AREA_CLASS = "min-h-11 lg:min-h-9";
// Text-button look on the ghost variant. Its own text colour is emitted later
// in the stylesheet than these shades, so they need the important modifier
// (the same override ToggleIconButton uses). Leading the row, the label lines
// up with the sentence above instead of its padding.
const QUIET_ACTION_CLASS =
  "px-2 first:-ml-2 !text-slate-500 hover:!text-slate-800 data-[hovered]:!text-slate-800 dark:!text-slate-400 dark:hover:!text-slate-100 dark:data-[hovered]:!text-slate-100";

/** Where focus goes once a pressed control leaves the card's actions row. */
type FocusHandOff = { to: "details"; sawPending: boolean } | { to: "retry" };

function secondsUntil(dueAt: number, now: number): number {
  return Math.max(0, Math.ceil((dueAt - now) / 1000));
}

// How often, at most, the spoken countdown changes.
const ANNOUNCEMENT_STEP_SECONDS = 10;

/**
 * The remaining wait as screen readers hear it: the exact starting wait, then
 * whole steps of {@link ANNOUNCEMENT_STEP_SECONDS} ("20", then "10"), so the
 * polite region speaks a few times rather than every second, and someone who
 * reaches the card later does not hear the starting wait.
 */
function announcedSecondsUntil(startSeconds: number, remainingSeconds: number): number {
  const step = Math.ceil(remainingSeconds / ANNOUNCEMENT_STEP_SECONDS) * ANNOUNCEMENT_STEP_SECONDS;
  return Math.min(startSeconds, Math.max(ANNOUNCEMENT_STEP_SECONDS, step));
}

/** The current time, ticking every half second while a countdown shows. */
function useCountdownNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function AutoRetryAnnouncementText({ dueAt }: { dueAt: number }) {
  const now = useCountdownNow();
  const [startSeconds] = useState(() => Math.max(1, secondsUntil(dueAt, Date.now())));
  const seconds = announcedSecondsUntil(startSeconds, secondsUntil(dueAt, now));
  return <>{`Trying again automatically in ${seconds} seconds.`}</>;
}

/**
 * The polite status region a failure card keeps mounted, empty until an
 * automatic retry counts down: a region that appears already filled is not
 * announced by many screen readers. Nothing here takes focus.
 */
function AutoRetryAnnouncement({ dueAt }: { dueAt: number | null }) {
  return (
    <span role="status" className="sr-only" data-testid="run-failure-auto-retry-status">
      {dueAt !== null ? <AutoRetryAnnouncementText key={dueAt} dueAt={dueAt} /> : null}
    </span>
  );
}

/** "Trying again in 20 s" for a pending automatic retry, for sighted readers. */
function AutoRetryCountdown({ dueAt }: { dueAt: number }) {
  const now = useCountdownNow();
  return (
    <span
      aria-hidden="true"
      data-testid="run-failure-auto-retry-countdown"
      className="inline-flex items-center text-xs text-slate-500 dark:text-slate-400"
    >
      <span data-testid="run-failure-auto-retry-countdown-text">
        Trying again in {secondsUntil(dueAt, now)} s
      </span>
    </span>
  );
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
  const retryPending = retryContext !== null && retryContext.pendingRetryKey === message.id;
  const otherRetryInFlight =
    retryContext !== null && retryContext.pendingRetryKey !== null && !retryPending;
  const autoRetrying = retryContext?.autoRetryingKey === message.id;
  const scheduledAutoRetry =
    retryContext?.scheduledAutoRetry?.key === message.id ? retryContext.scheduledAutoRetry : null;
  const isRetrySuperseded = retryContext?.isRetrySuperseded;
  const superseded = useMemo(
    () => isRetrySuperseded?.(message) ?? false,
    [isRetrySuperseded, message],
  );
  const needsAi = presentation.kind === "needs_ai";
  const onConnectAi = retryContext?.onConnectAi;
  const cancelAutoRetry = retryContext?.cancelAutoRetry;
  // Manual controls give way to the automatic states; a pressed "Try again"
  // keeps its pending spinner until the request settles, then reads "Retried".
  const showManualControls = retryContext !== null && !autoRetrying && !scheduledAutoRetry && !needsAi;
  const showRetry = showManualControls && (retryPending || !superseded);
  const showRetried = showManualControls && superseded && !retryPending;

  const retryButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const detailsButtonRef = useRef<HTMLButtonElement | null>(null);
  // When the press here retires its control (Try again turns into "Retried",
  // Cancel turns into Try again), focus follows to the replacement instead of
  // dropping to the page. The hand-off only settles that press: a press that
  // leaves its control in place (a refused resend, a missing prompt) disarms
  // it, so a later change, such as a resend landing minutes after, never moves
  // focus.
  const focusHandOffRef = useRef<FocusHandOff | null>(null);
  // Whether Cancel holds focus. When the countdown ends on its own (the resend
  // goes out, or the countdown is dropped), Cancel goes away under a keyboard
  // or screen reader user; focus then moves to Details, which every card
  // keeps, instead of dropping to the page.
  const cancelFocusedRef = useRef(false);
  useEffect(() => {
    const handOff = focusHandOffRef.current;
    if (!handOff) {
      if (cancelFocusedRef.current && !cancelButtonRef.current) {
        cancelFocusedRef.current = false;
        const active = typeof document === "undefined" ? null : document.activeElement;
        if (!active || active === document.body) {
          detailsButtonRef.current?.focus({ preventScroll: true });
        }
      }
      return;
    }
    cancelFocusedRef.current = false;
    let target: HTMLButtonElement | null = null;
    if (handOff.to === "details") {
      if (retryPending) {
        // The resend is in flight and its spinner keeps Try again in place.
        focusHandOffRef.current = { to: "details", sawPending: true };
        return;
      }
      if (!retryButtonRef.current && handOff.sawPending) {
        target = detailsButtonRef.current;
      }
    } else if (!cancelButtonRef.current) {
      target = retryButtonRef.current;
    }
    focusHandOffRef.current = null;
    const active = typeof document === "undefined" ? null : document.activeElement;
    if (!target || (active && active !== document.body)) {
      return;
    }
    // The card may sit above the fold; keep the transcript where it is.
    target.focus({ preventScroll: true });
  });

  const handleRetry = useCallback(() => {
    if (!retryContext || retryContext.pendingRetryKey !== null) {
      return;
    }
    focusHandOffRef.current = { to: "details", sawPending: false };
    void retryContext.requestRetry(message);
  }, [message, retryContext]);
  const handleCancelAutoRetry = useCallback(() => {
    focusHandOffRef.current = { to: "retry" };
    cancelAutoRetry?.(message.id);
  }, [cancelAutoRetry, message.id]);

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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {needsAi && onConnectAi && !autoRetrying ? (
          <Button
            variant="primary"
            size="sm"
            radius="xl"
            data-testid="run-failure-connect-ai"
            onPress={onConnectAi}
            className={ACTION_HIT_AREA_CLASS}
          >
            Connect AI
          </Button>
        ) : null}
        {scheduledAutoRetry && !autoRetrying ? (
          <>
            <AutoRetryCountdown dueAt={scheduledAutoRetry.dueAt} />
            {cancelAutoRetry ? (
              <Button
                ref={cancelButtonRef}
                variant="ghost"
                size="xs"
                radius="xl"
                data-testid="run-failure-auto-retry-cancel"
                aria-label="Cancel automatic retry"
                onPress={handleCancelAutoRetry}
                onFocusChange={(focused) => {
                  // A blur caused by the button leaving the page keeps the
                  // flag, so the effect above can tell it held focus.
                  if (focused || cancelButtonRef.current?.isConnected) {
                    cancelFocusedRef.current = focused;
                  }
                }}
                className={`${ACTION_HIT_AREA_CLASS} ${QUIET_ACTION_CLASS}`}
              >
                Cancel
              </Button>
            ) : null}
          </>
        ) : null}
        {showRetry ? (
          <Button
            ref={retryButtonRef}
            variant="secondary"
            size="sm"
            radius="xl"
            data-testid="run-failure-retry"
            onPress={handleRetry}
            isPending={retryPending}
            isDisabled={otherRetryInFlight}
            className={ACTION_HIT_AREA_CLASS}
          >
            Try again
          </Button>
        ) : null}
        {showRetried ? (
          <span
            data-testid="run-failure-retried"
            className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400"
          >
            <Check aria-hidden="true" className="h-3.5 w-3.5 flex-none" />
            Retried
          </span>
        ) : null}
        <Button
          ref={detailsButtonRef}
          variant="ghost"
          size="xs"
          radius="xl"
          data-testid="run-failure-details-toggle"
          onPress={() => setDetailsOpen((current) => !current)}
          aria-expanded={detailsOpen}
          className={`${ACTION_HIT_AREA_CLASS} ${QUIET_ACTION_CLASS}`}
        >
          Details
        </Button>
      </div>
      {retryContext !== null ? (
        <AutoRetryAnnouncement
          dueAt={scheduledAutoRetry && !autoRetrying ? scheduledAutoRetry.dueAt : null}
        />
      ) : null}
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
