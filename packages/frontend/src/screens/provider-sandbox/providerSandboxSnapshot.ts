import { createProviderUiSurfaceSandboxCapabilityProfile } from "@instafy/provider-contract";
import {
  readProviderSandboxHostData,
  readProviderSandboxHostMutations,
  type ProviderSandboxHostStatePayload,
} from "../../utils/providerSandboxBridge";

// Internal sandbox snapshot used at the page/runtime boundary.
// It is the grouped, provider-facing view of host state plus route fallbacks.
export type ProviderSandboxSnapshot = {
  providerId: string | null;
  providerTitle: string | null;
  familyId: string | null;
  surfaceId: string | null;
  resolvedTheme: "light" | "dark" | null;
  stateToken: string | null;
  hostState: ProviderSandboxHostStatePayload | null;
  pendingInvalidatedResourceIds: string[];
  hostData: ReturnType<typeof readProviderSandboxHostData>;
  hostMutations: ReturnType<typeof readProviderSandboxHostMutations>;
  capabilityProfile: ReturnType<typeof createProviderUiSurfaceSandboxCapabilityProfile>;
};

export function createProviderSandboxSnapshot(input: {
  hostState: ProviderSandboxHostStatePayload | null;
  fallbackProviderId?: string | null;
  fallbackSurfaceId?: string | null;
  pendingInvalidatedResourceIds?: string[];
}): ProviderSandboxSnapshot {
  const { hostState, fallbackProviderId, fallbackSurfaceId, pendingInvalidatedResourceIds } = input;
  return {
    providerId: hostState?.providerId ?? fallbackProviderId ?? null,
    providerTitle: hostState?.providerTitle ?? null,
    familyId: hostState?.familyId ?? null,
    surfaceId: hostState?.surfaceId ?? fallbackSurfaceId ?? null,
    resolvedTheme: hostState?.resolvedTheme ?? null,
    stateToken: hostState?.stateToken ?? null,
    hostState,
    pendingInvalidatedResourceIds: pendingInvalidatedResourceIds ?? [],
    hostData: readProviderSandboxHostData(hostState),
    hostMutations: readProviderSandboxHostMutations(hostState),
    capabilityProfile: createProviderUiSurfaceSandboxCapabilityProfile(hostState),
  };
}
