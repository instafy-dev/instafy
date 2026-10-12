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
  /**
   * Exact provider tool ids that a person's chat prompt on another device may
   * send to the device holding this family's runtime, through the controller's
   * provider-request queue. Core refuses every other tool id before dispatch.
   * A family that lists none cannot be driven from another device this way.
   */
  remoteToolIds?: readonly string[];
};
