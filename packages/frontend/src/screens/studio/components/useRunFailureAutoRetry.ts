import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  MAX_AUTO_RETRIES_PER_ORIGIN,
  hasFailedRunMetadata,
  isAutoRetryEligibleFailureKind,
  resolveRunFailurePresentation,
  resolveRunFailureRetryPrompt,
  runFailureOriginKey,
} from "../../../conversations/runFailurePresentation";
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

/**
 * Automatically re-dispatch the originating prompt of a TRANSIENT failed run
 * once, showing a calm "trying again automatically" state, before falling back
 * to the manual "Run failed" card.
 *
 * Safety invariants (all enforced with refs so they never trigger a re-render):
 * - Never fires on conversation reload/history: on a `conversationKey` change we
 *   snapshot the ids of every message that already reads as a failed run
 *   (the BASELINE) and never auto-retry any baseline id.
 * - Hard-bounded per originating prompt via {@link MAX_AUTO_RETRIES_PER_ORIGIN}.
 * - Never loops: each failure id fires at most once (already-retried set), a
 *   concurrency flag blocks re-entrant fires, and a conversation-wide backstop
 *   ({@link MAX_AUTO_RETRIES_PER_CONVERSATION}) caps total auto-retries.
 * - Only ever considers the LAST message, and only while `!isBusy`.
 */
export function useRunFailureAutoRetry({
  messages,
  conversationKey,
  isBusy,
  autoRetry,
}: {
  messages: ChatMessage[];
  conversationKey: string | null;
  isBusy: boolean;
  autoRetry: (params: { failureMessage: ChatMessage; promptText: string }) => Promise<void>;
}): { autoRetryingKey: string | null } {
  const [autoRetryingKey, setAutoRetryingKey] = useState<string | null>(null);

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

  // Establish (or reset) the baseline synchronously before paint whenever the
  // conversation changes, so the first render after a switch never fires.
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
    const presentation = resolveFailedRunPresentation(candidate);
    if (!presentation || !isAutoRetryEligibleFailureKind(presentation.kind)) {
      return;
    }
    const promptText = resolveRunFailureRetryPrompt({
      conversationMessages: messages,
      failureMessage: candidate,
    });
    if (!promptText) {
      // No originating prompt to resend; leave the manual card.
      return;
    }
    const originKey = runFailureOriginKey(promptText);
    const originCount = originRetryCountsRef.current.get(originKey) ?? 0;
    if (originCount >= MAX_AUTO_RETRIES_PER_ORIGIN) {
      return;
    }

    // Commit the guards before the async resend so a re-render mid-flight cannot
    // fire the same failure (or exceed the per-origin bound) again.
    alreadyRetriedIdsRef.current.add(candidate.id);
    originRetryCountsRef.current.set(originKey, originCount + 1);
    totalAutoRetriesRef.current += 1;
    autoRetryInFlightRef.current = true;
    pendingSettleRef.current = {
      failureId: candidate.id,
      failureTimestamp: candidate.timestamp,
    };
    setAutoRetryingKey(candidate.id);

    void (async () => {
      try {
        await autoRetry({ failureMessage: candidate, promptText });
        // Keep the indicator up: the resend was accepted but its run is still
        // executing. The settle effect clears it once the run produces a
        // terminal message.
      } catch {
        // The resend never dispatched, so no run will settle it — clear now.
        pendingSettleRef.current = null;
        setAutoRetryingKey(null);
      } finally {
        autoRetryInFlightRef.current = false;
      }
    })();
  }, [autoRetry, conversationKey, isBusy, messages]);

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

  return { autoRetryingKey };
}
