import type { ProviderExecutionContext } from "@instafy/provider-contract";
import type { LocalProviderSummary } from "../capabilities/localProviderHostClient";
import type { ProjectProviderSelectedDevice } from "../capabilities/projectProviderAccess";

export type NativeCapabilityRuntimeEvent = Record<string, unknown>;

export type NativeCapabilityRuntimeSelection = {
  transportTarget: string;
  selectedDevice: ProjectProviderSelectedDevice | null;
};

export type NativeCapabilityRuntimeProbeResult = {
  connected: boolean;
  events: NativeCapabilityRuntimeEvent[];
  executionContext?: ProviderExecutionContext;
};

export type NativeCapabilityRuntimeRegistration = {
  familyId: string;
  matchesProvider: (input: {
    providerId?: string | null;
    provider?: Pick<LocalProviderSummary, "id" | "providerType"> | null;
  }) => boolean;
  resolveSelection: (input: {
    providerId: string;
    selectedDevice: ProjectProviderSelectedDevice | null;
  }) => Promise<NativeCapabilityRuntimeSelection | null>;
  postProbe: (
    body: Record<string, unknown>,
    selection: NativeCapabilityRuntimeSelection & { providerId: string },
  ) => Promise<NativeCapabilityRuntimeProbeResult>;
};
