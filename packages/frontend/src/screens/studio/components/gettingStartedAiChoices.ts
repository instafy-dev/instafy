type ManagedAiRequirement = {
  enabled: boolean;
  available: boolean;
  label: string;
  dailyPromptLimit: number;
  remainingPrompts: number | null;
};

export type CredentialInventoryStatus =
  | "unknown"
  | "loading"
  | "ready"
  | "missing"
  | "needs_default"
  | "error";

export type GettingStartedAiViewState = "resolving" | "choice" | "workspace";

export function resolveGettingStartedAiChoices({
  runtimeControllerEnabled,
  hasUser,
  requirementsResolved,
  hasDefaultCredential,
  credentialInventoryStatus,
  managedAi,
  managedAiSelected = false,
}: {
  runtimeControllerEnabled: boolean;
  hasUser: boolean;
  requirementsResolved: boolean;
  hasDefaultCredential: boolean;
  credentialInventoryStatus: CredentialInventoryStatus;
  managedAi: ManagedAiRequirement | null;
  managedAiSelected?: boolean;
}) {
  const selectionContextReady = runtimeControllerEnabled && hasUser;
  const connectedAiSelected =
    selectionContextReady &&
    (hasDefaultCredential || credentialInventoryStatus === "ready");
  const credentialInventoryResolved =
    credentialInventoryStatus !== "unknown" && credentialInventoryStatus !== "loading";
  const aiResolutionPending = Boolean(
    runtimeControllerEnabled &&
      (!hasUser ||
        (!connectedAiSelected && (!requirementsResolved || !credentialInventoryResolved))),
  );
  const hasManagedAiSelection = Boolean(
    selectionContextReady &&
      requirementsResolved &&
      credentialInventoryResolved &&
      !connectedAiSelected &&
      managedAiSelected &&
      managedAi?.enabled &&
      managedAi.available,
  );
  const selectedAi: "managed" | "connected" | null = connectedAiSelected
    ? "connected"
    : hasManagedAiSelection
      ? "managed"
      : null;
  const canOfferPersonalAiAction =
    runtimeControllerEnabled &&
    hasUser &&
    requirementsResolved &&
    !hasDefaultCredential;
  const personalAiConnectionState: "missing" | "needs_default" | null = !canOfferPersonalAiAction
    ? null
    : credentialInventoryStatus === "needs_default"
      ? "needs_default"
      : credentialInventoryStatus === "missing" || credentialInventoryStatus === "error"
        ? "missing"
        : null;
  const showAiConnectionChoice =
    personalAiConnectionState !== null && selectedAi === null;
  const viewState: GettingStartedAiViewState = aiResolutionPending
    ? "resolving"
    : showAiConnectionChoice
      ? "choice"
      : "workspace";
  const managedAiOffer =
    selectionContextReady &&
    requirementsResolved &&
    !connectedAiSelected &&
    managedAi?.enabled &&
    (managedAi.available || managedAi.remainingPrompts === 0)
      ? {
          label: managedAi.label,
          dailyPromptLimit: managedAi.dailyPromptLimit,
          remainingPrompts: managedAi.remainingPrompts,
        }
      : null;

  return {
    managedAiOffer,
    selectedAi,
    canChangeAiChoice: selectedAi === "managed",
    personalAiConnectionState: showAiConnectionChoice ? personalAiConnectionState : null,
    viewState,
  };
}

export function canRestorePersistedAiOnboarding({
  runtimeControllerEnabled,
  hasUser,
  requirementsResolved,
  requirementsHasDefaultCredential,
  hydratedDefaultCredentialId,
}: {
  runtimeControllerEnabled: boolean;
  hasUser: boolean;
  requirementsResolved: boolean;
  requirementsHasDefaultCredential: boolean;
  hydratedDefaultCredentialId: string | null;
}): boolean {
  return (
    runtimeControllerEnabled &&
    hasUser &&
    requirementsResolved &&
    !requirementsHasDefaultCredential &&
    !hydratedDefaultCredentialId
  );
}
