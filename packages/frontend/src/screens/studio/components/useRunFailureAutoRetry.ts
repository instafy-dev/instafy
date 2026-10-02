import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  MAX_AUTO_RETRIES_PER_ORIGIN,
  hasFailedRunMetadata,
  isRunFailurePromptFromThisClient,
  isRunFailurePromptSharedWithOtherRuns,
  isRunFailureRecentForAutoRetry,
  isRunFailureRunSteered,
  readRunFailureRunIds,
  resolveRunFailureAutoRetryDelayMs,
  resolveRunFailurePresentation,
  resolveRunFailureRetrySource,
  runFailureOriginKey,
} from "../../../conversations/runFailurePresentation";
import {
  claimAutoRetryForPromptSentFromThisPage,
  wasRunStartedByPromptSentFromThisPage,
} from "../../../conversations/sentPromptRegistry";
import type { ChatMessage } from "../types";

const TERMINAL_OUTCOMES = new Set([
  "succeeded",
  "success",
  "completed",
  "done",
  "failed",
  "failure",
  "error",
  "canceled",
  "cancelled",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A message that carries a terminal run outcome — the signal that the
 * re-dispatched run has resolved (either the retry succeeded and produced its
 * result, or it failed and produced a new failure message). Used to hold the
 * "trying again automatically" indicator up for the whole retry run rather than
 * only for the dispatch call, which resolves the moment the resend is accepted.
 */
function hasTerminalOutcome(message: ChatMessage): boolean {
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  if (!metadata) {
    return false;
  }
  for (const key of ["outcome", "status"]) {
    const value = metadata[key];
    if (typeof value === "string" && TERMINAL_OUTCOMES.has(value.trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Hard backstop on how many automatic retries a single conversation may ever
 * fire, independent of per-origin bounding. Prevents a pathological message
 * stream from looping even if origin keys keep changing.
 */
export const MAX_AUTO_RETRIES_PER_CONVERSATION = 8;

/**
 * Resolve the failed-run presentation for a message the way the auto-retry
 * logic cares about: only messages whose stored metadata already marks them as
 * a failed run (`assumeFailed` mirrors that metadata so pattern-matched kinds
 * surface, but ordinary text is never treated as a failure).
 */
function resolveFailedRunPresentation(message: ChatMessage) {
  if (!hasFailedRunMetadata(message.metadata)) {
    return null;
  }
  return resolveRunFailurePresentation({
    metadata: message.metadata,
    content: message.content,
    assumeFailed: true,
  });
}

/** A countdown before a failed run's prompt is sent again automatically. */
export type ScheduledRunFailureAutoRetry = {
  /** Message id of the failure the countdown belongs to. */
  key: string;
  /** Epoch milliseconds at which the prompt is sent again. */
  dueAt: number;
};

/**
 * Resolves to `false` when no run will settle the indicator, so it clears:
 * the resend was refused (busy gate, no credits), or it was sent but started
 * no run (group participation only recorded it, or its dispatch failed). A
 * resend that started a run, or was queued behind a busy agent, resolves
 * `true`.
 */
type AutoRetryDispatch = (params: {
  failureMessage: ChatMessage;
  promptText: string;
}) => Promise<boolean | void>;

/**
 * True once someone sent a message after the failure (or the failure left the
 * list): a countdown for it no longer reflects the conversation.
 */
function hasUserMessageAfter(messages: ChatMessage[], failureId: string): boolean {
  const index = messages.findIndex((message) => message.id === failureId);
  if (index < 0) {
    return true;
  }
  return messages.slice(index + 1).some((message) => message.role === "user");
}

/**
 * Automatically re-dispatch the originating prompt of a TRANSIENT failed run
 * once, showing a calm "trying again automatically" state, before falling back
 * to the manual "Run failed" card. Rate-limited runs first wait out a visible
 * countdown ({@link ScheduledRunFailureAutoRetry}) that the person can cancel;
 * see {@link resolveRunFailureAutoRetryDelayMs} for the kinds and delays.
 *
 * Safety invariants:
 * - Only the prompt that started the failed run, sent by THIS page instance,
 *   is resent ({@link wasRunStartedByPromptSentFromThisPage}): an in-memory
 *   record made at submit time, with the run and job ids the controller
 *   returned for it, which a reload, a duplicated tab or another device does
 *   not have. So history, however late it loads, never starts a retry, a
 *   reload during a countdown drops it (the manual "Try again" stays), and a
 *   note sent while the run was going, which started no run of its own, is
 *   never resent in its place. The signed-in person must also be the
 *   prompt's author, from this tab's client session
 *   ({@link isRunFailurePromptFromThisClient}).
 * - Only a recent failure is resent: its timestamp is within ten minutes of
 *   now ({@link isRunFailureRecentForAutoRetry}), checked when the countdown
 *   starts and again when it ends. A failure without a timestamp stays
 *   manual.
 * - A prompt that was itself a retry, carried attachments or a reply
 *   context, or went to more than one agent (or whose other run succeeded)
 *   stays manual (see {@link resolveRunFailureAutoRetryDelayMs} and
 *   {@link isRunFailurePromptSharedWithOtherRuns}), and so does a run someone
 *   steered ({@link isRunFailureRunSteered}).
 * - Never for a card that was already retried (`isRetrySuperseded`: a
 *   manual "Try again" that went out or waits in a send queue), checked
 *   before the retry is claimed and again when a countdown ends.
 * - Once per prompt for the life of the page: the retry is claimed in the same
 *   in-memory record ({@link claimAutoRetryForPromptSentFromThisPage}) when the
 *   countdown starts or the resend goes out, so a cancelled countdown, a
 *   remounted panel or a second panel showing the same conversation never
 *   sends it again. {@link MAX_AUTO_RETRIES_PER_ORIGIN} also bounds it by
 *   prompt text within one mount.
 * - Never loops: each failure id fires at most once (already-retried set), a
 *   concurrency flag blocks re-entrant fires, and a conversation-wide backstop
 *   ({@link MAX_AUTO_RETRIES_PER_CONVERSATION}) caps total auto-retries.
 * - Only ever considers the LAST message, and only while `!isBusy`. A running
 *   countdown is dropped as soon as the conversation gets busy, someone sends
 *   a message after the failure, or the conversation changes.
 * - Failures already shown when the conversation opens (the snapshot taken on
 *   a `conversationKey` change) are never resent. The snapshot only ever
 *   blocks a retry: it is empty while history is still loading, so it cannot
 *   be what allows one.
 */
export function useRunFailureAutoRetry({
  messages,
  conversationKey,
  currentUserId,
  chatClientSessionId,
  isBusy,
  isRetrySuperseded,
  autoRetry,
}: {
  messages: ChatMessage[];
  conversationKey: string | null;
  /** The signed-in person; only their own prompts are resent automatically. */
  currentUserId: string | null;
  /** This tab's chat client session; only prompts sent from it are resent. */
  chatClientSessionId: string | null;
  isBusy: boolean;
  /**
   * True once a card's prompt was sent again or queued to be: a manual
   * "Try again" can go out (or into a send queue) while the panel reads
   * busy, before this hook ever looked at the failure.
   */
  isRetrySuperseded?: (failureMessage: ChatMessage) => boolean;
  autoRetry: AutoRetryDispatch;
}): {
  autoRetryingKey: string | null;
  scheduledAutoRetry: ScheduledRunFailureAutoRetry | null;
  cancelScheduledAutoRetry: (failureMessageId: string) => void;
} {
  const [autoRetryingKey, setAutoRetryingKey] = useState<string | null>(null);
  const [scheduledAutoRetry, setScheduledAutoRetry] =
    useState<ScheduledRunFailureAutoRetry | null>(null);
  // Bumped when a countdown's timer elapses, to re-run the decision effect.
  const [dueTick, setDueTick] = useState(0);

  // Trackers that must not trigger re-render.
  const conversationKeyRef = useRef<string | null | undefined>(undefined);
  const baselineFailureIdsRef = useRef<Set<string>>(new Set());
  const alreadyRetriedIdsRef = useRef<Set<string>>(new Set());
  const originRetryCountsRef = useRef<Map<string, number>>(new Map());
  const totalAutoRetriesRef = useRef(0);
  const autoRetryInFlightRef = useRef(false);
  // The failure whose auto-retry run is still resolving; the indicator stays up
  // until a message newer than this settles it (or the conversation changes).
  const pendingSettleRef = useRef<{ failureId: string; failureTimestamp: number } | null>(null);
  // The countdown in progress, with what it will send when it ends.
  const scheduledRef = useRef<{ failure: ChatMessage; promptText: string; dueAt: number } | null>(
    null,
  );

  const clearScheduled = useCallback(() => {
    scheduledRef.current = null;
    setScheduledAutoRetry(null);
  }, []);

  const cancelScheduledAutoRetry = useCallback(
    (failureMessageId: string) => {
      if (scheduledRef.current?.failure.id !== failureMessageId) {
        return;
      }
      // The per-origin budget stays spent: the card falls back to the manual
      // "Try again" and the countdown never restarts for this prompt.
      clearScheduled();
    },
    [clearScheduled],
  );

  // Establish (or reset) the baseline synchronously before paint whenever the
  // conversation changes, so the first render after a switch never fires. The
  // baseline only blocks retries; eligibility comes from the checks below.
  useLayoutEffect(() => {
    if (conversationKeyRef.current === conversationKey) {
      return;
    }
    conversationKeyRef.current = conversationKey;
    baselineFailureIdsRef.current = new Set(
      messages
        .filter((message) => resolveFailedRunPresentation(message) !== null)
        .map((message) => message.id),
    );
    alreadyRetriedIdsRef.current = new Set();
    originRetryCountsRef.current = new Map();
    totalAutoRetriesRef.current = 0;
    autoRetryInFlightRef.current = false;
    pendingSettleRef.current = null;
    setAutoRetryingKey(null);
    clearScheduled();
    // Baseline snapshot depends only on the conversation identity; the messages
    // read here are the load-time snapshot for that conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationKey]);

  useLayoutEffect(() => {
    // Baseline for this conversation not established yet (first pass handled by
    // the effect above running before this one on the same commit).
    if (conversationKeyRef.current !== conversationKey) {
      return;
    }

    const dispatch = (failure: ChatMessage, promptText: string) => {
      autoRetryInFlightRef.current = true;
      pendingSettleRef.current = {
        failureId: failure.id,
        failureTimestamp: failure.timestamp,
      };
      setAutoRetryingKey(failure.id);

      void (async () => {
        try {
          const accepted = await autoRetry({ failureMessage: failure, promptText });
          if (accepted === false) {
            // Refused, or sent without starting a run: no run will settle it.
            pendingSettleRef.current = null;
            setAutoRetryingKey(null);
          }
          // Otherwise keep the indicator up: the resend was sent (or queued
          // behind a busy agent) and its run has not finished. The settle
          // effect clears it once a run produces a terminal message.
        } catch {
          // The resend never dispatched, so no run will settle it; clear now.
          pendingSettleRef.current = null;
          setAutoRetryingKey(null);
        } finally {
          autoRetryInFlightRef.current = false;
        }
      })();
    };

    const scheduled = scheduledRef.current;
    if (scheduled) {
      if (
        isBusy ||
        autoRetryInFlightRef.current ||
        hasUserMessageAfter(messages, scheduled.failure.id) ||
        (isRetrySuperseded?.(scheduled.failure) ?? false)
      ) {
        // Another run started, someone wrote since the failure, or the
        // prompt was already sent again; leave the manual card instead of
        // resending into the middle of that.
        clearScheduled();
        return;
      }
      if (Date.now() < scheduled.dueAt) {
        return;
      }
      clearScheduled();
      if (!isRunFailureRecentForAutoRetry(scheduled.failure)) {
        // The page slept through the countdown (a closed laptop lid, a frozen
        // background tab): the failure is no longer recent, so leave the
        // manual card rather than sending it now.
        return;
      }
      dispatch(scheduled.failure, scheduled.promptText);
      return;
    }

    if (isBusy || autoRetryInFlightRef.current) {
      return;
    }
    if (totalAutoRetriesRef.current >= MAX_AUTO_RETRIES_PER_CONVERSATION) {
      return;
    }
    const candidate = messages[messages.length - 1];
    if (!candidate) {
      return;
    }
    if (baselineFailureIdsRef.current.has(candidate.id)) {
      return;
    }
    if (alreadyRetriedIdsRef.current.has(candidate.id)) {
      return;
    }
    if (isRetrySuperseded?.(candidate)) {
      // Retried by hand (sent, or waiting in a send queue) before this hook
      // got to it, such as while the panel still read busy.
      return;
    }
    const presentation = resolveFailedRunPresentation(candidate);
    if (!presentation) {
      return;
    }
    if (!isRunFailureRecentForAutoRetry(candidate)) {
      // An old failure (or one without a timestamp) stays manual, whenever it
      // loads.
      return;
    }
    const promptMessage = resolveRunFailureRetrySource({
      conversationMessages: messages,
      failureMessage: candidate,
    });
    if (!promptMessage) {
      // No originating prompt to resend; leave the manual card.
      return;
    }
    if (
      !wasRunStartedByPromptSentFromThisPage(promptMessage, readRunFailureRunIds(candidate)) ||
      !isRunFailurePromptFromThisClient({ promptMessage, currentUserId, chatClientSessionId })
    ) {
      // Sent before a reload, from a duplicated or other tab, from another
      // device or by someone else, or not the prompt that started the failed
      // run (such as a note group participation only recorded): only the
      // page whose prompt started the run may resend it, and this one shows
      // the manual card.
      return;
    }
    const delayMs = resolveRunFailureAutoRetryDelayMs({ presentation, promptMessage });
    if (delayMs === null) {
      return;
    }
    if (isRunFailureRunSteered({ conversationMessages: messages, failureMessage: candidate })) {
      // Resending the prompt would drop what the steer asked for.
      return;
    }
    if (
      isRunFailurePromptSharedWithOtherRuns({
        conversationMessages: messages,
        promptMessage,
        failureMessage: candidate,
      })
    ) {
      // Resending would run every agent on the prompt again.
      return;
    }
    const promptText = promptMessage.content;
    const originKey = runFailureOriginKey(promptText);
    const originCount = originRetryCountsRef.current.get(originKey) ?? 0;
    if (originCount >= MAX_AUTO_RETRIES_PER_ORIGIN) {
      return;
    }
    if (!claimAutoRetryForPromptSentFromThisPage(promptMessage)) {
      // This page already used the prompt's one automatic retry (another
      // panel, or this one before it was remounted).
      return;
    }

    // Commit the guards before the async resend (or the countdown) so a
    // re-render mid-flight cannot fire the same failure (or exceed the
    // per-origin bound) again.
    alreadyRetriedIdsRef.current.add(candidate.id);
    originRetryCountsRef.current.set(originKey, originCount + 1);
    totalAutoRetriesRef.current += 1;

    if (delayMs > 0) {
      const dueAt = Date.now() + delayMs;
      scheduledRef.current = { failure: candidate, promptText, dueAt };
      setScheduledAutoRetry({ key: candidate.id, dueAt });
      return;
    }
    dispatch(candidate, promptText);
  }, [
    autoRetry,
    chatClientSessionId,
    clearScheduled,
    conversationKey,
    currentUserId,
    dueTick,
    isBusy,
    isRetrySuperseded,
    messages,
  ]);

  // Wake the decision effect when the countdown ends. A timer that fires a
  // little early re-arms for the remainder on the next pass.
  useEffect(() => {
    if (!scheduledAutoRetry) {
      return;
    }
    const timer = setTimeout(
      () => setDueTick((tick) => tick + 1),
      Math.max(0, scheduledAutoRetry.dueAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [dueTick, scheduledAutoRetry]);

  // Hold the "trying again automatically" indicator for the duration of the
  // retry RUN (not just the dispatch call). Clear it once a message newer than
  // the retried failure carries a terminal outcome — the retry either succeeded
  // and produced its result, or failed and produced a new failure card.
  useEffect(() => {
    const pending = pendingSettleRef.current;
    if (!pending) {
      return;
    }
    const settled = messages.some(
      (message) =>
        message.timestamp > pending.failureTimestamp && hasTerminalOutcome(message),
    );
    if (settled) {
      pendingSettleRef.current = null;
      setAutoRetryingKey(null);
    }
  }, [messages]);

  return { autoRetryingKey, scheduledAutoRetry, cancelScheduledAutoRetry };
}
