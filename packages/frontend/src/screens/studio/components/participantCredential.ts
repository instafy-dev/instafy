import type { ParticipantCredentialState } from "./chatParticipantsStore";

/** The parts of a controller credential the roster reads. */
export interface RosterCredential {
  id: string;
  revokedAt?: string | null;
}

/** The managed-AI lane as the controller's credential requirements report it. */
export interface RosterManagedAi {
  enabled: boolean;
  available: boolean;
  label: string;
  modelId?: string | null;
  modelLabel?: string | null;
}

export interface RosterCredentialResolution<C extends RosterCredential> {
  credentialState: ParticipantCredentialState;
  /** The credential whose live usage applies; null for broken and managed states. */
  credential: C | null;
  /** The credential named on the row (a revoked one too). */
  labelCredential: C | null;
  /** Shown instead of a credential name for the managed lane. */
  managedLabel: string | null;
  /** The model id the agent pins, or null when it runs on its lane's default. */
  model: string | null;
  /** What to show for the model: the pinned id, the managed lane's model, or the provider default. */
  modelLabel: string | null;
}

/**
 * How an agent in the roster gets its AI: a pinned credential, the workspace default, the credits-funded managed
 * lane, or nothing. Oct 16: a managed-AI space showed "gpt-5.6-sol · No AI credential" (the bring-your-own default
 * and a warning) while every turn ran on the managed model. The managed lane's model is the controller's, never a
 * copy kept here.
 */
export function resolveRosterCredential<C extends RosterCredential>(input: {
  pinnedCredentialId: string | null | undefined;
  pinnedModel: string | null;
  providerDefaultModel: string | null;
  credentialsById: ReadonlyMap<string, C>;
  defaultCredential: C | null;
  managedAi: RosterManagedAi | null | undefined;
}): RosterCredentialResolution<C> {
  const { pinnedCredentialId, pinnedModel, providerDefaultModel, credentialsById, defaultCredential, managedAi } = input;
  const own = (credentialState: ParticipantCredentialState, credential: C | null, labelCredential = credential): RosterCredentialResolution<C> => ({
    credentialState,
    credential,
    labelCredential,
    managedLabel: null,
    model: pinnedModel,
    modelLabel: pinnedModel ?? providerDefaultModel,
  });
  if (pinnedCredentialId) {
    const pinned = credentialsById.get(pinnedCredentialId) ?? null;
    if (!pinned) return own("missing", null);
    if (pinned.revokedAt) return own("revoked", null, pinned);
    return own("pinned", pinned);
  }
  if (defaultCredential) return own("default", defaultCredential);
  if (managedAi?.enabled && managedAi.available) {
    return {
      credentialState: "managed",
      credential: null,
      labelCredential: null,
      managedLabel: managedAi.label,
      model: pinnedModel,
      modelLabel: pinnedModel ?? managedAi.modelLabel ?? managedAi.modelId ?? null,
    };
  }
  return own("none", null);
}
