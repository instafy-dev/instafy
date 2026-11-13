export function resolveChatComposerAffordances({
  composerGhostSuggestionRemainder,
  credentialsReady,
  activeConversationControllerId,
  imageAttachmentCount,
  deferAiGatesForAmbientParticipation,
  inputRequiresAi,
  inputValue,
  onboardingInputLocked,
  outOfCredits,
  runtimeControllerEnabled,
  queueStatusLabel,
  sendingAttachment,
  sharedBrowserSendBlocked,
  submissionPending,
  totalQueuedCount,
  turnEnginePending = false,
  voiceHoldActive,
  voiceInputListening,
  voiceInputStarting,
  voiceInputTranscribing,
}: {
  composerGhostSuggestionRemainder: string | null;
  credentialsReady: boolean;
  activeConversationControllerId: string | null;
  imageAttachmentCount: number;
  deferAiGatesForAmbientParticipation: boolean;
  inputRequiresAi: boolean;
  inputValue: string;
  onboardingInputLocked: boolean;
  outOfCredits: boolean;
  runtimeControllerEnabled: boolean;
  queueStatusLabel: string | null;
  sendingAttachment: boolean;
  /**
   * A send from the browser's own composer would be refused (its browser is
   * still connecting or has no page), see resolveSharedBrowserSendBlocker.
   * Required, so a caller cannot drop it without a compile error.
   */
  sharedBrowserSendBlocked: boolean;
  submissionPending: boolean;
  totalQueuedCount: number;
  /**
   * An engine is chosen for the next message. That message runs on the
   * person's own engine, not on Instafy AI, so the AI connection and credit
   * gates do not hold the send button; the submit flow decides the send.
   */
  turnEnginePending?: boolean;
  voiceHoldActive: boolean;
  voiceInputListening: boolean;
  voiceInputStarting: boolean;
  voiceInputTranscribing: boolean;
}) {
  // The pointer-driven "Insert suggestion" action lives in the composer's "+"
  // menu on every viewport (the composer is one row everywhere); Tab accepts
  // the same ghost suggestion from the keyboard. The name is historical.
  const showMobileGhostSuggestionAcceptButton =
    Boolean(composerGhostSuggestionRemainder) &&
    !onboardingInputLocked &&
    !sendingAttachment;
  const composerHasSendPayload = inputValue.trim().length > 0 || imageAttachmentCount > 0;
  const queueCanUseDurableControllerPath =
    runtimeControllerEnabled &&
    (queueStatusLabel === "Runtime offline" ||
      queueStatusLabel === "Runtime start failed" ||
      queueStatusLabel === "Starting runtime");
  const queueCanSendNow =
    totalQueuedCount > 0 &&
    (queueStatusLabel === "Ready to send" || queueCanUseDurableControllerPath) &&
    !sendingAttachment &&
    Boolean(activeConversationControllerId);
  // An ambient default-Octo turn must reach the asynchronous participation
  // classifier before AI gates are applied. A silent result becomes a human
  // record-only message; any responding result still hits the normal gates in
  // submit preflight before runtime work. Explicit AI targets remain gated here.
  const synchronouslyGateAiIntent =
    inputRequiresAi && !deferAiGatesForAmbientParticipation && !turnEnginePending;
  const sendButtonDisabled =
    submissionPending ||
    sendingAttachment ||
    voiceInputStarting ||
    voiceInputListening ||
    voiceInputTranscribing ||
    voiceHoldActive ||
    (synchronouslyGateAiIntent && !credentialsReady) ||
    (synchronouslyGateAiIntent && outOfCredits) ||
    sharedBrowserSendBlocked;
  const sendButtonVariant: "primary" | "ghost" =
    composerHasSendPayload && !sendButtonDisabled ? "primary" : "ghost";
  const composerActionIconClass = "h-[22px] w-[22px]";

  return {
    composerActionIconClass,
    queueCanSendNow,
    sendButtonDisabled,
    sendButtonVariant,
    showMobileGhostSuggestionAcceptButton,
  };
}
