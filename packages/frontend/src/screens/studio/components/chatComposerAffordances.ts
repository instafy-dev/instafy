export function resolveChatComposerAffordances({
  compactBrowserViewport,
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
  compactBrowserViewport: boolean;
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
  const showMobileGhostSuggestionAcceptButton =
    compactBrowserViewport &&
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
  const sendButtonVariant: "primary" | "outline" =
    composerHasSendPayload && !sendButtonDisabled ? "primary" : "outline";
  const composerActionButtonClass = "h-11 w-11 rounded-[1.25rem]";
  const composerActionSurfaceClass =
    "border-transparent bg-white/95 text-slate-700 ring-1 ring-slate-900/[0.035] hover:bg-slate-50 data-[hovered]:bg-slate-50 dark:border-transparent dark:bg-white/[0.06] dark:text-slate-100 dark:shadow-none dark:ring-0 dark:hover:bg-white/[0.1] dark:data-[hovered]:bg-white/[0.1]";
  const composerSquareShadowClass =
    "shadow-[0_12px_26px_-10px_rgba(15,23,42,0.38)] hover:shadow-[0_14px_30px_-10px_rgba(15,23,42,0.44)] data-[hovered]:shadow-[0_14px_30px_-10px_rgba(15,23,42,0.44)]";
  const composerPillShadowClass =
    "shadow-[0_7px_16px_-14px_rgba(15,23,42,0.3)] hover:shadow-[0_9px_20px_-15px_rgba(15,23,42,0.38)] data-[hovered]:shadow-[0_9px_20px_-15px_rgba(15,23,42,0.38)]";
  const composerOutlinedActionClass =
    `${composerActionButtonClass} ${composerActionSurfaceClass} ${composerSquareShadowClass}`;
  const composerRuntimeTriggerClass =
    `h-11 min-w-[3.5rem] rounded-[1.25rem] px-3.5 text-sm ${composerActionSurfaceClass} ${composerPillShadowClass}`;
  const composerPrimaryActionClass =
    `${composerActionButtonClass} shadow-[0_10px_24px_-14px_rgba(59,130,246,0.95)]`;
  const composerActionIconClass = "h-[22px] w-[22px]";

  return {
    composerActionButtonClass,
    composerActionIconClass,
    composerOutlinedActionClass,
    composerPrimaryActionClass,
    composerRuntimeTriggerClass,
    queueCanSendNow,
    sendButtonDisabled,
    sendButtonVariant,
    showMobileGhostSuggestionAcceptButton,
  };
}
