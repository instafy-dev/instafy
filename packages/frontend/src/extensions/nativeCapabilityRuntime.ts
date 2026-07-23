import type { LocalProviderSummary } from "../capabilities/localProviderHostClient";
import { APPLICATION_FRONTEND_FEATURES } from "../features/applicationFrontendFeatureComposition";
export type {
  NativeCapabilityRuntimeEvent,
  NativeCapabilityRuntimeProbeResult,
  NativeCapabilityRuntimeRegistration,
  NativeCapabilityRuntimeSelection,
} from "./nativeCapabilityRuntimeTypes";

export function resolveNativeCapabilityRuntimeRegistration(input: {
  providerId?: string | null;
  provider?: Pick<LocalProviderSummary, "id" | "providerType"> | null;
}) {
  return (
    APPLICATION_FRONTEND_FEATURES.nativeCapabilityRuntimeRegistrations.find(
      (registration) => registration.matchesProvider(input),
    ) ?? null
  );
}
