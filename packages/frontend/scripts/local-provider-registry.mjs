import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProviderSummary } from "@instafy/provider-contract";
import { createLocalProviderFeatureComposition } from "./local-provider-feature-module.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_LOCAL_PROVIDER_CONFIG_FILE = path.join(
  __dirname,
  "local-provider-host.config.json",
);

function normalizeString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveConfigPath(configFile) {
  const configuredPath = normalizeString(process.env.LOCAL_PROVIDER_HOST_CONFIG);
  if (!configuredPath) {
    return configFile;
  }
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(process.cwd(), configuredPath);
}

export function readLocalProviderRegistryConfig({
  defaultConfig,
  configFile = DEFAULT_LOCAL_PROVIDER_CONFIG_FILE,
} = {}) {
  const configPath = resolveConfigPath(configFile);
  if (!fs.existsSync(configPath)) {
    return {
      configPath,
      config: defaultConfig,
      error: null,
    };
  }

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      configPath,
      config: parsed,
      error: null,
    };
  } catch (error) {
    return {
      configPath,
      config: defaultConfig,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeProviderEntries(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return [];
  }

  const rawProviders = Array.isArray(config.providers) ? config.providers : [];
  return rawProviders
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry, index) => {
      const providerType = normalizeString(entry.type) ?? "unknown";
      const providerId =
        normalizeString(entry.id) ??
        normalizeString(entry.providerId) ??
        `${providerType}-${index + 1}`;
      const enabled = entry.enabled !== false;
      return {
        ...entry,
        type: providerType,
        id: providerId,
        enabled,
      };
    })
    .filter((entry) => entry.enabled);
}

function createUnavailableProviderRegistration(entry, errorMessage) {
  const providerType = normalizeString(entry.type) ?? "unknown";
  const providerId = normalizeString(entry.id) ?? providerType;
  const summary = createProviderSummary({
    id: providerId,
    title: normalizeString(entry.title) ?? providerId,
    description:
      normalizeString(entry.description) ??
      `Configured local provider "${providerId}" (${providerType}) is unavailable.`,
    kind: normalizeString(entry.kind) ?? "configured_provider",
    rootUri: normalizeString(entry.rootUri) ?? undefined,
    transportProbeSupported: entry.transportProbeSupported === true,
    capabilityIds: Array.isArray(entry.capabilityIds)
      ? entry.capabilityIds.filter((value) => typeof value === "string" && value.trim().length > 0)
      : [],
    configured: true,
    providerType,
    discoverable: false,
    error: errorMessage,
  });

  function unavailableResult(extra = {}) {
    return {
      ok: false,
      statusCode: 503,
      providerId,
      error: errorMessage,
      ...extra,
    };
  }

  return {
    id: providerId,
    summary,
    async getSummary() {
      return summary;
    },
    async discover() {
      return unavailableResult();
    },
    async readResource(uri) {
      return unavailableResult({ uri });
    },
    async callTool(name) {
      return unavailableResult({ name });
    },
    async transportProbe() {
      return unavailableResult();
    },
    async getHealthDetails() {
      return {
        providerType,
        configured: true,
        error: errorMessage,
      };
    },
  };
}

function createProviderRegistration(entry, providerFactories) {
  const factory = providerFactories.get(entry.type);
  if (!factory) {
    return createUnavailableProviderRegistration(
      entry,
      `No local provider factory is registered for provider type "${entry.type}".`,
    );
  }

  try {
    return factory({
      id: entry.id,
      title: normalizeString(entry.title) ?? undefined,
      description: normalizeString(entry.description) ?? undefined,
    });
  } catch (error) {
    return createUnavailableProviderRegistration(
      entry,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function createLocalProviderRegistry({
  featureModules,
  defaultConfig = Object.freeze({ providers: Object.freeze([]) }),
  configResult = readLocalProviderRegistryConfig({ defaultConfig }),
} = {}) {
  const featureComposition = createLocalProviderFeatureComposition(featureModules);
  const configuredProviderEntries = normalizeProviderEntries(configResult.config);
  const providerEntries =
    configuredProviderEntries.length > 0
      ? configuredProviderEntries
      : normalizeProviderEntries(defaultConfig);
  const defaultProviderId =
    normalizeString(configResult.config?.defaultProviderId) ??
    normalizeString(configResult.config?.default_provider_id) ??
    providerEntries[0]?.id ??
    null;
  const providers = providerEntries.map((entry) =>
    createProviderRegistration(entry, featureComposition.providerFactories),
  );

  return Object.freeze({
    configPath: configResult.configPath,
    configError: configResult.error,
    defaultProviderId,
    providerEntries,
    providers,
  });
}

export async function getLocalProviderRegistryHealthDetails(registry) {
  const providerDetails = {};
  for (const provider of registry.providers) {
    if (typeof provider.getHealthDetails !== "function") {
      continue;
    }
    providerDetails[provider.id] = await provider.getHealthDetails();
  }

  return {
    configPath: registry.configPath,
    configError: registry.configError,
    configuredProviderIds: registry.providerEntries.map((entry) => entry.id),
    providerDetails,
  };
}
