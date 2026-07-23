import {
  createElement,
  lazy,
  type ComponentType,
  type ReactNode,
} from "react";
import type { AssistantProviderDefinition } from "@instafy/sdk/agents";
import type {
  CapabilityExecutorProviderDefinition,
  CapabilityProviderDefinition,
} from "@instafy/sdk/capabilities";
import {
  collectInstafyFeatureModuleContributions,
  validateInstafyFeatureModules,
  type InstafyFeatureModule,
} from "@instafy/sdk/feature-modules";
import type { NativeExtensionRegistration } from "../extensions/nativeExtensionTypes";
import type { NativeRuntimeFamilyRegistration } from "../extensions/nativeRuntimeProviderTypes";
import type {
  LocalCapabilityArtifactRegistration,
  LocalCapabilityRouteDefinition,
} from "../capabilities/localCapabilityContributions";
import type { NativeCapabilityRuntimeRegistration } from "../extensions/nativeCapabilityRuntimeTypes";
import type { VisionClassifierRegistration } from "../camera/visionTypes";
import type { FrontendFeatureServices } from "./frontendFeatureServices";

export interface TrustedFrontendRouteContribution {
  id: string;
  path: string;
  element: ReactNode;
}

export function createLazyFrontendRouteElement(
  load: () => Promise<{ default: ComponentType }>,
): ReactNode {
  const RouteComponent = lazy(load);
  return createElement(RouteComponent);
}

export interface FrontendFeatureContributions {
  assistantProviders?: readonly AssistantProviderDefinition[];
  capabilityAssistantProviders?: readonly AssistantProviderDefinition[];
  capabilityProviders?: readonly CapabilityProviderDefinition[];
  executorProviders?: readonly CapabilityExecutorProviderDefinition<FrontendFeatureServices>[];
  routes?: readonly TrustedFrontendRouteContribution[];
  nativeExtensionRegistrations?: readonly NativeExtensionRegistration[];
  nativeRuntimeFamilyRegistrations?: readonly NativeRuntimeFamilyRegistration[];
  nativeCapabilityRuntimeRegistrations?: readonly NativeCapabilityRuntimeRegistration[];
  localCapabilityRoutes?: readonly LocalCapabilityRouteDefinition[];
  localCapabilityArtifactRegistrations?: readonly LocalCapabilityArtifactRegistration[];
  visionClassifierRegistrations?: readonly VisionClassifierRegistration[];
}

export type FrontendFeatureModule = InstafyFeatureModule<FrontendFeatureContributions>;

export interface FrontendFeatureComposition {
  modules: readonly FrontendFeatureModule[];
  assistantProviders: readonly AssistantProviderDefinition[];
  capabilityAssistantProviders: readonly AssistantProviderDefinition[];
  capabilityProviders: readonly CapabilityProviderDefinition[];
  executorProviders: readonly CapabilityExecutorProviderDefinition<FrontendFeatureServices>[];
  routes: readonly TrustedFrontendRouteContribution[];
  nativeExtensionRegistrations: readonly NativeExtensionRegistration[];
  nativeRuntimeFamilyRegistrations: readonly NativeRuntimeFamilyRegistration[];
  nativeCapabilityRuntimeRegistrations: readonly NativeCapabilityRuntimeRegistration[];
  localCapabilityRoutes: readonly LocalCapabilityRouteDefinition[];
  localCapabilityArtifactRegistrations: readonly LocalCapabilityArtifactRegistration[];
  visionClassifierRegistrations: readonly VisionClassifierRegistration[];
}

function assertUniqueContributionIds<TContribution>(
  kind: string,
  contributions: readonly TContribution[],
  getId: (contribution: TContribution) => string,
) {
  const seenIds = new Set<string>();
  for (const contribution of contributions) {
    const id = getId(contribution);
    if (
      typeof id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(id)
    ) {
      throw new Error(
        `Frontend feature ${kind} contribution has invalid id ${JSON.stringify(id)}.`,
      );
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate frontend feature ${kind} contribution id "${id}".`);
    }
    seenIds.add(id);
  }
}

export function createFrontendFeatureComposition(
  modules: readonly FrontendFeatureModule[],
): FrontendFeatureComposition {
  const validatedModules = validateInstafyFeatureModules(modules);
  const assistantProviders = collectInstafyFeatureModuleContributions(
    validatedModules,
    "assistantProviders",
  );
  const capabilityAssistantProviders = collectInstafyFeatureModuleContributions(
    validatedModules,
    "capabilityAssistantProviders",
  );
  const capabilityProviders = collectInstafyFeatureModuleContributions(
    validatedModules,
    "capabilityProviders",
  );
  const executorProviders = collectInstafyFeatureModuleContributions(
    validatedModules,
    "executorProviders",
  );
  const routes = collectInstafyFeatureModuleContributions(validatedModules, "routes");
  const nativeExtensionRegistrations = collectInstafyFeatureModuleContributions(
    validatedModules,
    "nativeExtensionRegistrations",
  );
  const nativeRuntimeFamilyRegistrations =
    collectInstafyFeatureModuleContributions(
      validatedModules,
      "nativeRuntimeFamilyRegistrations",
    );
  const nativeCapabilityRuntimeRegistrations =
    collectInstafyFeatureModuleContributions(
      validatedModules,
      "nativeCapabilityRuntimeRegistrations",
    );
  const localCapabilityRoutes = collectInstafyFeatureModuleContributions(
    validatedModules,
    "localCapabilityRoutes",
  );
  const localCapabilityArtifactRegistrations =
    collectInstafyFeatureModuleContributions(
      validatedModules,
      "localCapabilityArtifactRegistrations",
    );
  const visionClassifierRegistrations =
    collectInstafyFeatureModuleContributions(
      validatedModules,
      "visionClassifierRegistrations",
    );

  assertUniqueContributionIds("assistant provider", assistantProviders, (provider) => provider.id);
  assertUniqueContributionIds(
    "capability assistant provider",
    capabilityAssistantProviders,
    (provider) => provider.id,
  );
  assertUniqueContributionIds("capability provider", capabilityProviders, (provider) => provider.id);
  assertUniqueContributionIds("executor provider", executorProviders, (provider) => provider.id);
  assertUniqueContributionIds("route", routes, (route) => route.id);
  assertUniqueContributionIds(
    "native extension",
    nativeExtensionRegistrations,
    (registration) => registration.definition.familyId,
  );
  assertUniqueContributionIds(
    "native runtime family",
    nativeRuntimeFamilyRegistrations,
    (registration) => registration.familyId,
  );
  assertUniqueContributionIds(
    "native capability runtime",
    nativeCapabilityRuntimeRegistrations,
    (registration) => registration.familyId,
  );
  assertUniqueContributionIds(
    "local capability route",
    localCapabilityRoutes,
    (route) => route.id,
  );
  assertUniqueContributionIds(
    "local capability artifact",
    localCapabilityArtifactRegistrations,
    (registration) => registration.id,
  );
  assertUniqueContributionIds(
    "vision classifier",
    visionClassifierRegistrations,
    (registration) => registration.id,
  );

  const seenPaths = new Set<string>();
  for (const route of routes) {
    if (
      !route.path ||
      route.path !== route.path.trim() ||
      route.path.startsWith("/") ||
      route.path.split("/").includes("..")
    ) {
      throw new Error(
        `Frontend feature route "${route.id}" requires a non-empty relative path.`,
      );
    }
    if (seenPaths.has(route.path)) {
      throw new Error(`Duplicate frontend feature route path "${route.path}".`);
    }
    seenPaths.add(route.path);
  }

  return Object.freeze({
    modules: validatedModules,
    assistantProviders,
    capabilityAssistantProviders,
    capabilityProviders,
    executorProviders,
    routes,
    nativeExtensionRegistrations,
    nativeRuntimeFamilyRegistrations,
    nativeCapabilityRuntimeRegistrations,
    localCapabilityRoutes,
    localCapabilityArtifactRegistrations,
    visionClassifierRegistrations,
  });
}
