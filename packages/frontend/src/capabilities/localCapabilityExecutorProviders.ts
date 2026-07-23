import {
  createCapabilityExecutorRegistryFromProviders,
  type CapabilityExecutorProviderDefinition,
} from "@instafy/sdk/capabilities";
import type { LocalDeviceToggleCapabilityExecutorContext } from "../devices/deviceToggleCapabilityExecutorProvider";
import { APPLICATION_FRONTEND_REGISTRATION_INPUTS } from "../features/applicationFrontendFeatureComposition";
import { createFrontendFeatureServices } from "../features/frontendFeatureServices";
import { DEVICE_TOGGLE_FEATURE_SERVICE_ID } from "../features/publicCoreFrontendFeatureModule";

export interface LocalCapabilityExecutorProviderContext {
  deviceToggle?: LocalDeviceToggleCapabilityExecutorContext["deviceToggle"] | null;
  featureServices?: Iterable<readonly [serviceId: string, service: unknown]>;
}

export const LOCAL_CAPABILITY_EXECUTOR_PROVIDERS: CapabilityExecutorProviderDefinition<
  ReturnType<typeof createFrontendFeatureServices>
>[] = Array.from(APPLICATION_FRONTEND_REGISTRATION_INPUTS.capabilityExecutorProviders);

export const LOCAL_CAPABILITY_EXECUTOR_PROVIDER_REGISTRY =
  APPLICATION_FRONTEND_REGISTRATION_INPUTS.capabilityExecutorProviderRegistry;

export function createLocalCapabilityExecutorRegistry(
  context: LocalCapabilityExecutorProviderContext,
) {
  const services = createFrontendFeatureServices([
    [DEVICE_TOGGLE_FEATURE_SERVICE_ID, context.deviceToggle],
    ...(context.featureServices ?? []),
  ]);
  return createCapabilityExecutorRegistryFromProviders(
    LOCAL_CAPABILITY_EXECUTOR_PROVIDERS,
    services,
  );
}
