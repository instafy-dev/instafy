import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, NavArrowDown, NavArrowRight } from "iconoir-react";
import { Button } from "../../../components/Button";
import type { RunFailurePresentation } from "../../../conversations/runFailurePresentation";
import type { ChatMessage } from "../types";
import { TurnActivityLine } from "./TurnActivityLine";
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

/** The run's AI access ("managed" or "byoc") its final message names. */
function readAiAccessMode(message: ChatMessage): string {
  const metadata = message.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return "";
  }
  const mode = (metadata as Record<string, unknown>)["aiAccessMode"];
  return typeof mode === "string" ? mode.trim().toLowerCase() : "";
}

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

const NO_DETAILS = () => {};

// The failed turn whose block held focus when the chat folded it into the
// turn that replaced it (automaticRetryFold). That turn mounts in the same
// commit and takes focus (takeFoldedRetryFocus), so a keyboard or screen
// reader user resting on the block never lands on the page. The note lasts
// only for that commit.
let foldedRetryFocusFrom: string | null = null;

/**
 * True, once, when the block of one of these failures held focus as the chat
 * folded it away: the turn that replaced it takes focus.
 */
export function takeFoldedRetryFocus(failureIds: readonly (string | null)[]): boolean {
  const from = foldedRetryFocusFrom;
  if (from === null || !failureIds.includes(from)) {
    return false;
  }
  foldedRetryFocusFrom = null;
  return true;
}

/** The words of the one line a turn shows while Instafy tries it again by itself. */
export const AUTO_RETRY_LINE_TEXT = "Trying again…";

/**
 * True while Instafy tries this failed turn again by itself: a countdown runs
 * for it, its resend is going out, or its resend went out and the retry has
 * not shown anything yet (`autoRetryPending`, from the transcript). The turn
 * then shows one quiet line instead of its failure.
 */
export function useRunFailureAutoRetryActive(
  message: Pick<ChatMessage, "id"> | null,
  autoRetryPending = false,
): boolean {
  const retryContext = useRunFailureRetry();
  if (!message) {
    return false;
  }
  return (
    autoRetryPending ||
    retryContext?.autoRetryingKey === message.id ||
    retryContext?.scheduledAutoRetry?.key === message.id
  );
}

/**
 * Friendly body for a failed-run assistant message: one plain sentence, a
 * quiet actions row ("Try again" + "Details"), and the raw technical text
 * collapsed behind the Details toggle. The stored message keeps the raw text.
 * A failed turn has this one Details: it also lists the turn's steps.
 */
/** The same sentence, whatever its spacing: Details never repeats the block's own words. */
function sameSentence(a: string, b: string): boolean {
  const words = (text: string) => text.replace(/\s+/gu, " ").trim();
  return words(a) === words(b);
}

export function RunFailureMessageBody({
  message,
  presentation,
  steps = null,
  autoRetryPending = false,
}: {
  message: ChatMessage;
  presentation: RunFailurePresentation;
  /** The turn's steps (TurnActivityDetails), listed under the error text. */
  steps?: ReactNode;
  /** Its automatic resend went out, and the retry has shown nothing yet. */
  autoRetryPending?: boolean;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const retryContext = useRunFailureRetry();
  const retryPending = retryContext !== null && retryContext.pendingRetryKey === message.id;
  const otherRetryInFlight =
    retryContext !== null && retryContext.pendingRetryKey !== null && !retryPending;
  const autoRetrying = retryContext?.autoRetryingKey === message.id || autoRetryPending;
  const scheduledAutoRetry =
    retryContext?.scheduledAutoRetry?.key === message.id && !autoRetrying
      ? retryContext.scheduledAutoRetry
      : null;
  const isRetrySuperseded = retryContext?.isRetrySuperseded;
  const superseded = useMemo(
    () => isRetrySuperseded?.(message) ?? false,
    [isRetrySuperseded, message],
  );
  const needsAi = presentation.kind === "needs_ai";
  // A spent usage window reopens in hours or days, so a resend now would fail
  // the same way. Instafy AI's own limit leaves the person nothing to do; on
  // their own account they can switch to another AI connection.
  const usageLimit = presentation.kind === "provider_usage_limit";
  // The person's own AI connection can fix it in AI settings: a spent usage
  // window, or a sign-in or account the AI refused (presentation.manageAi).
  const offersManageAi =
    (usageLimit && readAiAccessMode(message) === "byoc") || presentation.manageAi === true;
  const onConnectAi = retryContext?.onConnectAi;
  const cancelAutoRetry = retryContext?.cancelAutoRetry;
  // While Instafy tries the turn again by itself it is one quiet line, with no
  // failure sentence and no actions; a countdown keeps its Cancel. A pressed
  // "Try again" keeps its pending spinner until the request settles, then
  // reads "Retried".
  const quiet = autoRetrying || scheduledAutoRetry !== null;
  // Details opens what the sentence above it leaves out: the raw text, unless
  // it is that same sentence, and the turn's steps.
  const detailsText = sameSentence(presentation.rawText, presentation.friendlyText) ? null : presentation.rawText;
  const hasDetails = Boolean(detailsText?.trim()) || Boolean(steps);
  const showManualControls = retryContext !== null && !quiet && !needsAi && !usageLimit;
  const showRetry = showManualControls && (retryPending || !superseded);
  const showRetried = showManualControls && superseded && !retryPending;

  const retryButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const detailsButtonRef = useRef<HTMLButtonElement | null>(null);
  const retriedRef = useRef<HTMLSpanElement | null>(null);
  const autoRetryLineRef = useRef<HTMLDivElement | null>(null);
  // When the press here retires its control (Try again turns into "Retried",
  // Cancel turns into Try again), focus follows to the replacement instead of
  // dropping to the page. The hand-off only settles that press: a press that
  // leaves its control in place (a refused resend, a missing prompt) disarms
  // it, so a later change, such as a resend landing minutes after, never moves
  // focus.
  const focusHandOffRef = useRef<FocusHandOff | null>(null);
  // Whether Cancel holds focus. When the countdown ends on its own, Cancel goes
  // away under a keyboard or screen reader user; focus then moves to the
  // "Trying again…" line that replaces it (or to Details, when the countdown
  // was dropped, else to Try again), instead of dropping to the page.
  const cancelFocusedRef = useRef(false);
  useEffect(() => {
    const handOff = focusHandOffRef.current;
    if (!handOff) {
      if (cancelFocusedRef.current && !cancelButtonRef.current) {
        cancelFocusedRef.current = false;
        const active = typeof document === "undefined" ? null : document.activeElement;
        if (!active || active === document.body) {
          (detailsButtonRef.current ?? autoRetryLineRef.current ?? retryButtonRef.current)?.focus({
            preventScroll: true,
          });
        }
      }
      return;
    }
    cancelFocusedRef.current = false;
    let target: HTMLElement | null = null;
    if (handOff.to === "details") {
      if (retryPending) {
        // The resend is in flight and its spinner keeps Try again in place.
        focusHandOffRef.current = { to: "details", sawPending: true };
        return;
      }
      if (!retryButtonRef.current && handOff.sawPending) {
        // With no Details, "Retried" itself takes it; once the resend went
        // out and the turn is one quiet line, that line does.
        target = detailsButtonRef.current ?? retriedRef.current ?? autoRetryLineRef.current;
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

  // Runs before React takes the block off the page, so focus is still in it.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const messageId = message.id;
  useLayoutEffect(() => {
    const blockRoot = rootRef.current;
    return () => {
      if (!blockRoot || typeof document === "undefined" || !blockRoot.contains(document.activeElement)) {
        return;
      }
      foldedRetryFocusFrom = messageId;
      queueMicrotask(() => {
        if (foldedRetryFocusFrom === messageId) {
          foldedRetryFocusFrom = null;
        }
      });
    };
  }, [messageId]);

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

  // The polite region stays mounted, first, in both states: a region that
  // appears already filled is not announced by many screen readers.
  return (
    <div ref={rootRef} className="min-w-0" data-testid={quiet ? "run-failure-auto-retry" : "run-failure-body"}>
      {retryContext !== null ? <AutoRetryAnnouncement dueAt={scheduledAutoRetry?.dueAt ?? null} /> : null}
      {scheduledAutoRetry ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <AutoRetryCountdown dueAt={scheduledAutoRetry.dueAt} />
          {cancelAutoRetry ? (
            <Button
              ref={cancelButtonRef}
              variant="text"
              tone="muted"
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
            >
              Cancel
            </Button>
          ) : null}
        </div>
      ) : autoRetrying ? (
        <div
          ref={autoRetryLineRef}
          // Takes focus only from the Cancel or Try again it replaces; never a tab stop.
          tabIndex={-1}
          className="min-w-0 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 dark:focus-visible:ring-primary-300/80"
          data-testid="run-failure-auto-retrying"
        >
          <TurnActivityLine
            text={AUTO_RETRY_LINE_TEXT}
            live
            animate
            interactive={false}
            detailsOpen={false}
            detailsId={detailsId}
            onToggleDetails={NO_DETAILS}
          />
        </div>
      ) : (
        <div className="min-w-0 space-y-1.5">
          <p className="whitespace-pre-wrap break-words text-sm">{presentation.friendlyText}</p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {needsAi && onConnectAi ? (
              <Button
                variant="primary"
                size="sm"
                radius="xl"
                data-testid="run-failure-connect-ai"
                onPress={onConnectAi}
              >
                Connect AI
              </Button>
            ) : null}
            {offersManageAi && onConnectAi ? (
              <Button
                variant="secondary"
                size="sm"
                radius="xl"
                data-testid="run-failure-manage-ai"
                onPress={onConnectAi}
              >
                Manage AI
              </Button>
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
              >
                Try again
              </Button>
            ) : null}
            {showRetried ? (
              <span
                ref={retriedRef}
                // Takes focus only from the Try again it replaces, when there
                // is no Details to take it; never a tab stop.
                tabIndex={-1}
                data-testid="run-failure-retried"
                className="inline-flex items-center gap-1 rounded-md text-xs text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 dark:text-slate-400 dark:focus-visible:ring-primary-300/80"
              >
                <Check aria-hidden="true" className="h-3.5 w-3.5 flex-none" />
                Retried
              </span>
            ) : null}
            {hasDetails ? (
              <Button
                ref={detailsButtonRef}
                variant="text"
                tone="muted"
                size="xs"
                radius="xl"
                data-testid="run-failure-details-toggle"
                onPress={() => setDetailsOpen((current) => !current)}
                aria-expanded={detailsOpen}
                aria-controls={detailsOpen ? detailsId : undefined}
              >
                <span className="inline-flex items-center gap-0.5">
                  {detailsOpen ? "Hide details" : "Details"}
                  {detailsOpen ? (
                    <NavArrowDown aria-hidden="true" className="h-3 w-3" />
                  ) : (
                    <NavArrowRight aria-hidden="true" className="h-3 w-3" />
                  )}
                </span>
              </Button>
            ) : null}
          </div>
          {detailsOpen && hasDetails ? (
            <div id={detailsId} className="min-w-0 space-y-1.5">
              {detailsText ? (
                <div
                  data-testid="run-failure-details"
                  className="whitespace-pre-wrap break-words text-xs text-slate-500 dark:text-slate-400"
                >
                  {detailsText}
                </div>
              ) : null}
              {steps ? <div className="min-w-0">{steps}</div> : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
