import { useCallback, useRef, useState } from "react";
import type { AiCredentialsGateState } from "./AiCredentialsStatusBubble";

function buildAmbientAiGateDraftKey(
  conversationId: string | null,
  inputValue: string,
  fallbackSuggestion: string | null | undefined,
  canRunAmbientParticipationPreflight: boolean,
) {
  const effectiveInput = inputValue.trim() || (fallbackSuggestion ?? "").trim();
  return JSON.stringify([
    conversationId,
    effectiveInput,
    canRunAmbientParticipationPreflight,
  ]);
}

export function useAmbientCredentialGatePresentation({
  activeConversationId,
  credentialGateState,
  credentialGateStateForBubble,
  fallbackSuggestion,
  inputCanRunAmbientParticipationPreflight,
  inputValue,
  pinCredentialGateToBottom,
}: {
  activeConversationId: string | null;
  credentialGateState: AiCredentialsGateState | null;
  credentialGateStateForBubble: AiCredentialsGateState | null;
  fallbackSuggestion: string | null | undefined;
  inputCanRunAmbientParticipationPreflight: boolean;
  inputValue: string;
  pinCredentialGateToBottom: () => void;
}) {
  const currentDraftKey = buildAmbientAiGateDraftKey(
    activeConversationId,
    inputValue,
    fallbackSuggestion,
    inputCanRunAmbientParticipationPreflight,
  );
  const currentDraftKeyRef = useRef(currentDraftKey);
  currentDraftKeyRef.current = currentDraftKey;
  const [revealedDraftKey, setRevealedDraftKey] = useState<string | null>(null);
  const shouldDeferAiGates =
    inputCanRunAmbientParticipationPreflight && revealedDraftKey !== currentDraftKey;

  const revealAiGatesForCurrentDraft = useCallback(() => {
    // Participation can finish after the sender edits the draft or switches
    // conversations. A stale result must not reveal or scroll the current chat.
    if (currentDraftKeyRef.current !== currentDraftKey) {
      return false;
    }
    if (inputCanRunAmbientParticipationPreflight) {
      setRevealedDraftKey(currentDraftKey);
    }
    return true;
  }, [currentDraftKey, inputCanRunAmbientParticipationPreflight]);

  const showCredentialsGate = useCallback(() => {
    if (!revealAiGatesForCurrentDraft()) {
      return;
    }
    pinCredentialGateToBottom();
  }, [pinCredentialGateToBottom, revealAiGatesForCurrentDraft]);

  return {
    deferAiGatesForAmbientParticipation: shouldDeferAiGates,
    credentialGateState: shouldDeferAiGates ? null : credentialGateState,
    credentialGateStateForBubble: shouldDeferAiGates
      ? null
      : credentialGateStateForBubble,
    revealAiGatesForCurrentDraft,
    showCredentialsGate,
  };
}
