import {
  createLocalProviderRegistry,
  getLocalProviderRegistryHealthDetails as readLocalProviderRegistryHealthDetails,
  readLocalProviderRegistryConfig,
} from "./local-provider-registry.mjs";
import {
  APPLICATION_LOCAL_PROVIDER_CONFIG_FILE,
  APPLICATION_LOCAL_PROVIDER_DEFAULT_CONFIG,
  APPLICATION_LOCAL_PROVIDER_FEATURE_MODULES,
} from "./public-local-provider-feature-manifest.mjs";

export const CURRENT_LOCAL_PROVIDER_FEATURE_MODULES =
  APPLICATION_LOCAL_PROVIDER_FEATURE_MODULES;
export const CURRENT_LOCAL_PROVIDER_DEFAULT_CONFIG =
  APPLICATION_LOCAL_PROVIDER_DEFAULT_CONFIG;

export const CURRENT_LOCAL_PROVIDER_REGISTRY = createLocalProviderRegistry({
  featureModules: CURRENT_LOCAL_PROVIDER_FEATURE_MODULES,
  defaultConfig: CURRENT_LOCAL_PROVIDER_DEFAULT_CONFIG,
  configResult: readLocalProviderRegistryConfig({
    defaultConfig: CURRENT_LOCAL_PROVIDER_DEFAULT_CONFIG,
    configFile: APPLICATION_LOCAL_PROVIDER_CONFIG_FILE,
  }),
});

export const LOCAL_PROVIDER_HOST_CONFIG_PATH =
  CURRENT_LOCAL_PROVIDER_REGISTRY.configPath;
export const LOCAL_PROVIDER_HOST_CONFIG_ERROR =
  CURRENT_LOCAL_PROVIDER_REGISTRY.configError;
export const DEFAULT_LOCAL_PROVIDER_ID =
  CURRENT_LOCAL_PROVIDER_REGISTRY.defaultProviderId;
export const LOCAL_PROVIDER_REGISTRATIONS =
  CURRENT_LOCAL_PROVIDER_REGISTRY.providers;

export function getLocalProviderRegistryHealthDetails() {
  return readLocalProviderRegistryHealthDetails(CURRENT_LOCAL_PROVIDER_REGISTRY);
}
