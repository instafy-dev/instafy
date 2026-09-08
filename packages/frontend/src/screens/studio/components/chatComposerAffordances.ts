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
  submissionPending,
  totalQueuedCount,
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
  submissionPending: boolean;
  totalQueuedCount: number;
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
    inputRequiresAi && !deferAiGatesForAmbientParticipation;
  const sendButtonDisabled =
    (imageAttachmentCount > 0 && inputValue.trim().length === 0) ||
    submissionPending ||
    sendingAttachment ||
    voiceInputStarting ||
    voiceInputListening ||
    voiceInputTranscribing ||
    voiceHoldActive ||
    (synchronouslyGateAiIntent && !credentialsReady) ||
    (synchronouslyGateAiIntent && outOfCredits);
  const sendButtonVariant: "primary" | "ghost" =
    composerHasSendPayload && !sendButtonDisabled ? "primary" : "ghost";
  // The composer owns the surface. Ghost controls only tone the glyph,
  // retaining the shared 36px fine-pointer / 44px touch target geometry.
  const composerGhostActionClass = "[&_svg]:text-slate-600 dark:[&_svg]:text-slate-300";
  // A single primary action supplies the accent without a second shadow.
  const composerPrimaryActionClass = "shadow-none";
  const composerActionIconClass = "h-[22px] w-[22px]";

  return {
    composerActionIconClass,
    composerGhostActionClass,
    composerPrimaryActionClass,
    queueCanSendNow,
    sendButtonDisabled,
    sendButtonVariant,
    showMobileGhostSuggestionAcceptButton,
  };
}
