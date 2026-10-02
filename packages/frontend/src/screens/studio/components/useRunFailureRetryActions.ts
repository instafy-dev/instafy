import { useCallback, useMemo, useRef, useState } from "react";
import {
  buildRunFailureRetryMetadata,
  isRunFailureRetryQueued,
  isRunFailureRetrySuperseded,
  resolveRunFailureRetrySource,
} from "../../../conversations/runFailurePresentation";
import {
  claimAutoRetryForPromptSentFromThisPage,
  didSendFailForPromptSentFromThisPage,
  readRetrySentFromThisPage,
} from "../../../conversations/sentPromptRegistry";
import type { StatusIntent } from "../../../status/StatusProvider";
import type { ChatMessage } from "../types";
import type { ChatSubmitOverride } from "./chatSubmitPlanning";
import type { RunFailureRetryContextValue } from "./RunFailureNotice";
import { useRunFailureAutoRetry } from "./useRunFailureAutoRetry";

const NO_QUEUED_SENDS: ReadonlyArray<{ metadata?: Record<string, unknown> | null }> = [];

/** How a resend asks the panel's submit to behave. */
export type RunFailureResendOptions = {
  /**
   * Set on the automatic resend: the send leaves the composer, its staged
   * attachments, focus, the scroll position and browser targeting alone.
   */
  automatic?: boolean;
  /** Called when the resend was queued behind a busy agent instead of sent. */
  onQueued?: () => void;
};

/**
 * What the failed-run cards in a chat panel act on: the manual "Try again",
 * the automatic retry and its countdown, and whether a card was already
 * retried.
 *
 * "Try again" re-submits the triggering user prompt through the normal submit
 * flow, so a busy agent naturally routes the resend into the server send
 * queue. Every resend names the failure it retries in its metadata
 * ({@link buildRunFailureRetryMetadata}), which is what retires that card's
 * "Try again", also after a reload. A resend still waiting in a send queue
 * (`queuedSends`, whose items keep that metadata, also after a reload) counts
 * too. The local set covers the moment between an accepted resend (sent, or
 * queued behind a busy agent) and the resent message showing up in
 * `messages` or `queuedSends`. A resend the controller did not take (its
 * dispatch failed) retires nothing: its local copy keeps the link, but the
 * card keeps its "Try again".
 */
export function useRunFailureRetryActions({
  messages,
  queuedSends = NO_QUEUED_SENDS,
  conversationKey,
  currentUserId,
  chatClientSessionId,
  isAssistantTyping,
  autoRetryEnabled = true,
  submit,
  showStatus,
  onConnectAi,
}: {
  messages: ChatMessage[];
  /** Sends waiting in the local and controller send queues. */
  queuedSends?: ReadonlyArray<{ metadata?: Record<string, unknown> | null }>;
  conversationKey: string | null;
  currentUserId: string | null;
  chatClientSessionId: string | null;
  isAssistantTyping: boolean;
  /**
   * False where the cards cannot show a countdown, its Cancel or the
   * "Trying again automatically" state (the read-only run trace): nothing is
   * resent automatically there, and a countdown already running is dropped.
   */
  autoRetryEnabled?: boolean;
  /**
   * The panel's submit. Resolves to whether the message was sent; a message
   * queued behind a busy agent resolves `false` and calls `onQueued` first.
   */
  submit: (override: ChatSubmitOverride, options?: RunFailureResendOptions) => Promise<boolean>;
  showStatus: (message: string, intent?: StatusIntent, durationMs?: number) => void;
  onConnectAi?: () => void;
}): RunFailureRetryContextValue {
  const [pendingRetryKey, setPendingRetryKey] = useState<string | null>(null);
  const retryInFlightRef = useRef(false);
  const [retriedFailureIds, setRetriedFailureIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const markRetried = useCallback((failureMessageId: string) => {
    setRetriedFailureIds((current) =>
      current.has(failureMessageId) ? current : new Set(current).add(failureMessageId),
    );
  }, []);
  // The failed send is recorded in the registry, which React does not watch:
  // a new set makes the cards ask isRetrySuperseded again.
  const markNotRetried = useCallback((failureMessageId: string) => {
    setRetriedFailureIds((current) => {
      const next = new Set(current);
      next.delete(failureMessageId);
      return next;
    });
  }, []);

  /**
   * Resolves to whether the resend can still start a run: it was sent and
   * started one, or it was queued to go out later. Every resend that went
   * out (sent or queued) retires the card; one the controller did not take
   * leaves its "Try again".
   */
  const resend = useCallback(
    async (
      failureMessage: ChatMessage,
      promptText: string,
      { automatic = false }: { automatic?: boolean } = {},
    ) => {
      let queued = false;
      const submitted = await submit(
        {
          message: promptText,
          editorState: null,
          metadata: buildRunFailureRetryMetadata(failureMessage),
        },
        {
          automatic,
          onQueued: () => {
            queued = true;
          },
        },
      );
      if (queued) {
        markRetried(failureMessage.id);
        return true;
      }
      if (!submitted) {
        return false;
      }
      // Sent: the submit path recorded what became of it. Its dispatch (or
      // recording) may have failed, and group participation may have only
      // recorded it, which starts no run.
      const outcome = readRetrySentFromThisPage(failureMessage.id);
      if (outcome === "failed") {
        markNotRetried(failureMessage.id);
        return false;
      }
      markRetried(failureMessage.id);
      return outcome === "started_run";
    },
    [markNotRetried, markRetried, submit],
  );

  const isRetrySuperseded = useCallback(
    (failureMessage: ChatMessage) =>
      retriedFailureIds.has(failureMessage.id) ||
      isRunFailureRetryQueued({ queuedSends, failureMessage }) ||
      isRunFailureRetrySuperseded({
        conversationMessages: messages,
        failureMessage,
        isUnsent: didSendFailForPromptSentFromThisPage,
      }),
    [messages, queuedSends, retriedFailureIds],
  );

  const requestRetry = useCallback(
    async (failureMessage: ChatMessage) => {
      // A second press before the pending state renders, or on a card whose
      // prompt was already sent or queued again, must not send it twice.
      if (retryInFlightRef.current || isRetrySuperseded(failureMessage)) {
        return;
      }
      const promptMessage = resolveRunFailureRetrySource({
        conversationMessages: messages,
        failureMessage,
      });
      if (!promptMessage) {
        showStatus("Couldn't find the original message to send again.", "info", 4000);
        return;
      }
      // Retried by hand, so never also automatically: this uses up the
      // prompt's automatic retry for the page, which a remount or another
      // panel does not get back.
      claimAutoRetryForPromptSentFromThisPage(promptMessage);
      retryInFlightRef.current = true;
      setPendingRetryKey(failureMessage.id);
      try {
        await resend(failureMessage, promptMessage.content);
      } finally {
        retryInFlightRef.current = false;
        setPendingRetryKey(null);
      }
    },
    [isRetrySuperseded, messages, resend, showStatus],
  );

  // The automatic re-dispatch shares the resend but deliberately does NOT touch
  // pendingRetryKey; that state is the manual "Try again" in-flight signal, and
  // the auto path presents its own calm states via the hook below.
  const autoRetry = useCallback(
    ({ failureMessage, promptText }: { failureMessage: ChatMessage; promptText: string }) =>
      resend(failureMessage, promptText, { automatic: true }),
    [resend],
  );
  const { autoRetryingKey, scheduledAutoRetry, cancelScheduledAutoRetry } = useRunFailureAutoRetry({
    messages,
    conversationKey,
    currentUserId,
    chatClientSessionId,
    // Busy while the assistant is producing output or a manual resend is in
    // flight; do not stack an automatic retry on top of an active run. Off
    // entirely where the cards cannot show or cancel a countdown.
    isBusy: !autoRetryEnabled || isAssistantTyping || pendingRetryKey !== null,
    isRetrySuperseded,
    autoRetry,
  });

  return useMemo<RunFailureRetryContextValue>(
    () => ({
      pendingRetryKey,
      requestRetry,
      autoRetryingKey,
      scheduledAutoRetry,
      cancelAutoRetry: cancelScheduledAutoRetry,
      isRetrySuperseded,
      onConnectAi,
    }),
    [
      autoRetryingKey,
      cancelScheduledAutoRetry,
      isRetrySuperseded,
      onConnectAi,
      pendingRetryKey,
      requestRetry,
      scheduledAutoRetry,
    ],
  );
}
