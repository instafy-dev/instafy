type ManagedAiRequirement = {
  enabled: boolean;
  available: boolean;
  label: string;
  dailyPromptLimit: number;
  remainingPrompts: number | null;
  /** Credits one free prompt costs. Omitted by older controllers: treated as 1. */
  creditBurnAmount?: number;
};

/**
 * The free tier as the getting-started card shows it. Non-null whenever the
 * controller has the tier enabled, so the card can still explain it when it
 * is paused ("paused": enabled but not available, and not merely exhausted
 * for today) or exhausted (remainingPrompts === 0).
 */
export type GettingStartedManagedAiOffer = {
  label: string;
  dailyPromptLimit: number;
  remainingPrompts: number | null;
  creditBurnAmount: number;
  paused: boolean;
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
  const managedAiOffer: GettingStartedManagedAiOffer | null =
    selectionContextReady && requirementsResolved && !connectedAiSelected && managedAi?.enabled
      ? {
          label: managedAi.label,
          dailyPromptLimit: managedAi.dailyPromptLimit,
          remainingPrompts: managedAi.remainingPrompts,
          creditBurnAmount:
            typeof managedAi.creditBurnAmount === "number" && managedAi.creditBurnAmount > 0
              ? managedAi.creditBurnAmount
              : 1,
          // Exhausted for today is its own state (remainingPrompts === 0);
          // any other unavailability is the tier being paused.
          paused: !managedAi.available && managedAi.remainingPrompts !== 0,
        }
      : null;

  return {
    managedAiOffer,
    selectedAi,
    // A settled choice can always be revisited: the managed choice resets to
    // the card's AI step, a saved credential routes to the AI panel.
    canChangeAiChoice: selectedAi !== null,
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
