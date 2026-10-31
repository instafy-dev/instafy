import { useCallback, useRef, useState } from "react";
import type { AiCredentialsGateState } from "./AiCredentialsStatusBubble";

function buildAmbientAiGateDraftKey(
  conversationId: string | null,
  inputValue: string,
  canRunAmbientParticipationPreflight: boolean,
) {
  return JSON.stringify([
    conversationId,
    inputValue.trim(),
    canRunAmbientParticipationPreflight,
  ]);
}

export function useAmbientCredentialGatePresentation({
  activeConversationId,
  credentialGateState,
  credentialGateStateForBubble,
  inputCanRunAmbientParticipationPreflight,
  inputValue,
  pinCredentialGateToBottom,
}: {
  activeConversationId: string | null;
  credentialGateState: AiCredentialsGateState | null;
  credentialGateStateForBubble: AiCredentialsGateState | null;
  inputCanRunAmbientParticipationPreflight: boolean;
  inputValue: string;
  pinCredentialGateToBottom: () => void;
}) {
  const currentDraftKey = buildAmbientAiGateDraftKey(
    activeConversationId,
    inputValue,
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
