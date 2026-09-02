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
  // One dress for the rest row: the composer card is the only surface. At
  // rest "+", image, mic and Send are icon-only ghost IconButtons — no fill,
  // no border, no shadow — with the ghost variant's own quiet hover surface
  // and its own box (44px on coarse pointers, md on fine ones). Nothing here
  // may add a box, a radius or a size of its own; the family only tones the
  // glyph. It tones the svg rather than the button because Button
  // concatenates classes without merging, so a button-level text colour
  // would fight the ghost variant's own and win or lose by stylesheet order.
  const composerGhostActionClass = "[&_svg]:text-slate-600 dark:[&_svg]:text-slate-300";
  // The accent dress Send takes once there is a payload (and the mic while it
  // captures): the primary variant's fill plus a soft glow. It shares the
  // ghost box, so lighting up changes colour and nothing else.
  const composerPrimaryActionClass = "shadow-[0_10px_24px_-14px_rgba(59,130,246,0.95)]";
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
