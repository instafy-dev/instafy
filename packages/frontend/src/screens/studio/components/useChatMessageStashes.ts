import { useCallback, useEffect, useRef, useState } from "react";
import {
  createMessageStashClientId,
  createMessageStash,
  deleteMessageStash,
  listMessageStashes,
  type ControllerMessageStash,
} from "../../../services/runtimeController/messageStashes";
import { ControllerApiError } from "../../../services/runtimeController/core";

export type CreateChatMessageStashInput = {
  text: string;
  editorState: unknown;
  composerEnvelope: Record<string, unknown>;
};

type MessageStashCreateAttempt = {
  conversationId: string;
  payloadFingerprint: string;
  clientStashId: string;
};

function canonicalizeFingerprintValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeFingerprintValue(item));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizeFingerprintValue(item)]),
    );
  }
  return null;
}

export function createChatMessageStashPayloadFingerprint(
  input: CreateChatMessageStashInput,
): string {
  return JSON.stringify(canonicalizeFingerprintValue(input));
}

export function useChatMessageStashes({
  conversationControllerId,
  enabled,
}: {
  conversationControllerId: string | null;
  enabled: boolean;
}) {
  const [stashes, setStashes] = useState<ControllerMessageStash[]>([]);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const generationRef = useRef(0);
  const createAttemptRef = useRef<MessageStashCreateAttempt | null>(null);
  const conversationIdRef = useRef(conversationControllerId);
  conversationIdRef.current = conversationControllerId;

  const refresh = useCallback(async () => {
    if (!enabled || !conversationControllerId) {
      setStashes([]);
      return;
    }
    const generation = generationRef.current;
    setLoading(true);
    try {
      const next = await listMessageStashes({ conversationId: conversationControllerId });
      if (
        next &&
        generationRef.current === generation &&
        conversationIdRef.current === conversationControllerId
      ) {
        setStashes(next);
      }
    } finally {
      if (
        generationRef.current === generation &&
        conversationIdRef.current === conversationControllerId
      ) {
        setLoading(false);
      }
    }
  }, [conversationControllerId, enabled]);

  useEffect(() => {
    generationRef.current += 1;
    setStashes([]);
    setLoading(false);
    setMutating(false);
    createAttemptRef.current = null;
    if (enabled && conversationControllerId) {
      void refresh().catch((error) => {
        console.warn("[chat] message stash fetch failed:", error);
      });
    }
  }, [conversationControllerId, enabled, refresh]);

  const createStash = useCallback(
    async (input: CreateChatMessageStashInput): Promise<ControllerMessageStash | null> => {
      if (!enabled || !conversationControllerId || mutating) {
        return null;
      }
      const generation = generationRef.current;
      const payloadFingerprint = createChatMessageStashPayloadFingerprint(input);
      const previousAttempt = createAttemptRef.current;
      const attempt =
        previousAttempt?.conversationId === conversationControllerId &&
        previousAttempt.payloadFingerprint === payloadFingerprint
          ? previousAttempt
          : {
              conversationId: conversationControllerId,
              payloadFingerprint,
              clientStashId: createMessageStashClientId(),
            };
      createAttemptRef.current = attempt;
      setMutating(true);
      try {
        const stash = await createMessageStash({
          conversationId: conversationControllerId,
          clientStashId: attempt.clientStashId,
          ...input,
        });
        if (stash && createAttemptRef.current?.clientStashId === attempt.clientStashId) {
          createAttemptRef.current = null;
        }
        if (
          stash &&
          generationRef.current === generation &&
          conversationIdRef.current === conversationControllerId
        ) {
          setStashes((current) => [stash, ...current.filter((item) => item.id !== stash.id)]);
        }
        return stash;
      } catch (error) {
        if (
          error instanceof ControllerApiError &&
          error.code === "message_stash_idempotency_conflict" &&
          createAttemptRef.current?.clientStashId === attempt.clientStashId
        ) {
          createAttemptRef.current = null;
        }
        throw error;
      } finally {
        if (
          generationRef.current === generation &&
          conversationIdRef.current === conversationControllerId
        ) {
          setMutating(false);
        }
      }
    },
    [conversationControllerId, enabled, mutating],
  );

  const removeStash = useCallback(
    async (stashId: string): Promise<boolean> => {
      if (!enabled || !conversationControllerId || mutating) {
        return false;
      }
      const generation = generationRef.current;
      setMutating(true);
      try {
        const removed = await deleteMessageStash({
          conversationId: conversationControllerId,
          stashId,
        });
        if (
          removed &&
          generationRef.current === generation &&
          conversationIdRef.current === conversationControllerId
        ) {
          setStashes((current) => current.filter((stash) => stash.id !== stashId));
        }
        return removed;
      } finally {
        if (
          generationRef.current === generation &&
          conversationIdRef.current === conversationControllerId
        ) {
          setMutating(false);
        }
      }
    },
    [conversationControllerId, enabled, mutating],
  );

  return { createStash, loading, mutating, refresh, removeStash, stashes };
}
