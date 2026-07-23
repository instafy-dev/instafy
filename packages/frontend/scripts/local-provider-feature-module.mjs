import {
  collectInstafyFeatureModuleContributions,
  validateInstafyFeatureModules,
} from "@instafy/sdk/feature-modules";

const PROVIDER_TYPE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function createLocalProviderFeatureComposition(featureModules) {
  const modules = validateInstafyFeatureModules(featureModules);
  const entries = collectInstafyFeatureModuleContributions(modules, "providerFactories");
  const providerFactories = new Map();

  for (const entry of entries) {
    const providerType = typeof entry?.type === "string" ? entry.type : "";
    if (!PROVIDER_TYPE_PATTERN.test(providerType)) {
      throw new Error(`Invalid local provider type ${JSON.stringify(entry?.type)}.`);
    }
    if (typeof entry.create !== "function") {
      throw new TypeError(
        `Local provider type "${providerType}" requires a provider factory function.`,
      );
    }
    if (providerFactories.has(providerType)) {
      throw new Error(`Duplicate local provider factory type "${providerType}".`);
    }
    providerFactories.set(providerType, entry.create);
  }

  return Object.freeze({
    modules,
    providerFactories,
  });
}
