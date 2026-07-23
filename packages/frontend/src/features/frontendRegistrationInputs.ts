import {
  createAssistantProviderRegistry,
  createBuiltInAssistantRegistryFromProviders,
  listBuiltInAssistantDefinitionsFromProviders,
} from "@instafy/sdk/agents";
import {
  createCapabilityExecutorProviderRegistry,
  createCapabilityProviderRegistry,
  listCapabilityDefinitionsFromProviders,
} from "@instafy/sdk/capabilities";
import type { NativeExtensionRegistration } from "../extensions/nativeExtensionTypes";
import type { FrontendFeatureComposition } from "./frontendFeatureModule";

export function createFrontendRegistrationInputs(
  featureComposition: FrontendFeatureComposition,
) {
  const assistantProviderRegistry = createAssistantProviderRegistry(
    featureComposition.assistantProviders,
  );
  const builtInAssistantRegistry = createBuiltInAssistantRegistryFromProviders(
    featureComposition.assistantProviders,
  );
  const capabilityAssistantRegistry = createBuiltInAssistantRegistryFromProviders(
    featureComposition.capabilityAssistantProviders,
  );
  const capabilityProviderRegistry = createCapabilityProviderRegistry(
    featureComposition.capabilityProviders,
  );
  const capabilityExecutorProviderRegistry = createCapabilityExecutorProviderRegistry(
    featureComposition.executorProviders,
  );
  const nativeExtensionRegistrations: Record<string, NativeExtensionRegistration> =
    Object.fromEntries(
      featureComposition.nativeExtensionRegistrations.map((registration) => [
        registration.definition.familyId,
        registration,
      ]),
    );

  return Object.freeze({
    assistantProviders: featureComposition.assistantProviders,
    assistantProviderRegistry,
    builtInAssistantDefinitions: listBuiltInAssistantDefinitionsFromProviders(
      featureComposition.assistantProviders,
    ),
    builtInAssistantRegistry,
    capabilityAssistantRegistry,
    capabilityProviders: featureComposition.capabilityProviders,
    capabilityProviderRegistry,
    capabilityDefinitions: listCapabilityDefinitionsFromProviders(
      capabilityProviderRegistry.values(),
    ),
    capabilityExecutorProviders: featureComposition.executorProviders,
    capabilityExecutorProviderRegistry,
    nativeExtensionRegistrations: Object.freeze(nativeExtensionRegistrations),
  });
}
