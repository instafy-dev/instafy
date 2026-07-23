import type { CapabilityId } from "@instafy/sdk/capabilities";
import type { LocalProviderSummary } from "../capabilities/localProviderHostClient";

export type NativeRuntimeFamilyRegistration = {
  familyId: string;
  capabilityIds: readonly CapabilityId[];
  supportsOnClient: (platform: string) => boolean;
  resolveCurrentProvider: (
    providerId: string,
  ) => Promise<LocalProviderSummary | null>;
  resolveCurrentProviderId?: (
    providerId: string,
  ) => Promise<string | null>;
  supportsRemoteNativeExtension?: boolean;
};
