import {
  type CapabilityDefinition,
  type CapabilityProviderDefinition,
} from "@instafy/sdk/capabilities";
import { APPLICATION_FRONTEND_REGISTRATION_INPUTS } from "../features/applicationFrontendFeatureComposition";

export const LOCAL_CAPABILITY_PROVIDERS: CapabilityProviderDefinition[] = Array.from(
  APPLICATION_FRONTEND_REGISTRATION_INPUTS.capabilityProviders,
);

export const LOCAL_CAPABILITY_PROVIDER_REGISTRY =
  APPLICATION_FRONTEND_REGISTRATION_INPUTS.capabilityProviderRegistry;

export const LOCAL_CAPABILITY_DEFINITIONS: CapabilityDefinition[] = Array.from(
  APPLICATION_FRONTEND_REGISTRATION_INPUTS.capabilityDefinitions,
);
