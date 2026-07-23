export const DEFAULT_PROVIDER_HOST_BASE_URL = "http://127.0.0.1:8797";

function normalizeTrimmedString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function trimTrailingSlash(value) {
  return value.replace(/\/$/, "");
}

function normalizeStringArray(values) {
  return Array.from(
    new Set(
      Array.from(values)
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  );
}

const PROVIDER_PROJECT_CAPABILITIES = new Set([
  "project_content_read",
  "project_content_write",
]);

function normalizeOptionalNullableString(value, fieldName) {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`provider initialization ${fieldName} must be a non-empty string or null`);
  }
  return value.trim();
}

export function normalizeProviderInitializationContext(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("provider initialization must be an object");
  }

  const normalized = {};
  for (const fieldName of ["projectId", "rootUri", "grantedPrefix"]) {
    const fieldValue = normalizeOptionalNullableString(value[fieldName], fieldName);
    if (fieldValue !== undefined) {
      normalized[fieldName] = fieldValue;
    }
  }

  if (value.grantedCapabilities !== undefined) {
    if (!Array.isArray(value.grantedCapabilities)) {
      throw new Error("provider initialization grantedCapabilities must be an array");
    }
    normalized.grantedCapabilities = Array.from(
      new Set(
        value.grantedCapabilities.map((capability) => {
          if (
            typeof capability !== "string" ||
            !PROVIDER_PROJECT_CAPABILITIES.has(capability)
          ) {
            throw new Error(
              `unsupported provider initialization capability: ${String(capability)}`,
            );
          }
          return capability;
        }),
      ),
    );
  }

  return normalized;
}

function collectProviderResourceUris(provider, discoveredProvider) {
  const advertisedAliases =
    provider?.resourceAliases &&
    typeof provider.resourceAliases === "object" &&
    !Array.isArray(provider.resourceAliases)
      ? Object.values(provider.resourceAliases)
      : [];
  const discoveredResourceUris = Array.isArray(discoveredProvider?.resources)
    ? discoveredProvider.resources
        .map((resource) =>
          resource && typeof resource === "object" && typeof resource.uri === "string"
            ? resource.uri.trim()
            : "",
        )
        .filter(Boolean)
    : [];
  return normalizeStringArray([
    ...advertisedAliases,
    ...(provider?.resourceUris ?? []),
    ...discoveredResourceUris,
  ]);
}

function resolvePreferredHealthResourceUri(resourceUris) {
  const normalized = normalizeStringArray(resourceUris);
  if (normalized.length === 0) {
    return null;
  }

  const preferredPatterns = [/status/i, /health/i, /summary/i, /state/i];
  const discouragedPatterns = [/manifest/i, /profile/i, /replay/i, /session/i];

  const preferred = normalized.find(
    (uri) =>
      preferredPatterns.some((pattern) => pattern.test(uri)) &&
      !discouragedPatterns.some((pattern) => pattern.test(uri)),
  );
  return preferred ?? normalized[0] ?? null;
}

export function normalizeProviderHostBaseUrl(baseUrl) {
  const normalized = normalizeTrimmedString(baseUrl);
  return normalized ? trimTrailingSlash(normalized) : DEFAULT_PROVIDER_HOST_BASE_URL;
}

function resolveFetchImplementation(fetchImpl) {
  if (typeof fetchImpl === "function") {
    return fetchImpl;
  }

  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }

  throw new Error("Provider host client requires a fetch implementation.");
}

export function createProviderHostClient(options = {}) {
  const fetchImpl = resolveFetchImplementation(options.fetch);
  const baseUrl = normalizeProviderHostBaseUrl(options.baseUrl);

  async function jsonRequest(path, init) {
    const response = await fetchImpl(`${baseUrl}${path}`, init);
    const json = await response.json();

    if (!response.ok || json?.ok === false) {
      throw new Error(
        json?.error || json?.stderr || `provider host request failed for ${path}`,
      );
    }

    return json;
  }

  return {
    baseUrl,
    fetch: fetchImpl,
    jsonRequest,
    listProviders() {
      return jsonRequest("/providers");
    },
    discoverProvider(providerId) {
      return jsonRequest(`/providers/${encodeURIComponent(providerId)}/discover`);
    },
    readProviderResource(providerId, uri, options = {}) {
      const initialization = normalizeProviderInitializationContext(options.initialization);
      return jsonRequest(`/providers/${encodeURIComponent(providerId)}/resources/read`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          uri,
          ...(initialization ? { initialization } : {}),
        }),
      });
    },
    callProviderTool(providerId, name, argumentsValue = {}, options = {}) {
      const initialization = normalizeProviderInitializationContext(options.initialization);
      return jsonRequest(`/providers/${encodeURIComponent(providerId)}/tools/call`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name,
          arguments: argumentsValue,
          ...(initialization ? { initialization } : {}),
        }),
      });
    },
    postProviderTransportProbe(providerId, body = {}) {
      return jsonRequest(`/providers/${encodeURIComponent(providerId)}/transport/probe`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    },
  };
}

export async function resolveProviderHealthSnapshot(client, provider) {
  const checkedAt = new Date().toISOString();

  if (!provider || typeof provider !== "object") {
    return {
      ok: false,
      source: "error",
      checkedAt,
      error: "provider summary is required",
    };
  }

  if (provider.discoverable === false) {
    return {
      ok: false,
      source: "availability",
      checkedAt,
      error: provider.error || "live extension discovery is unavailable",
    };
  }

  let discoveredProvider = null;
  let resourceUris = normalizeStringArray(provider.resourceUris ?? []);
  let transportProbeSupported = provider.transportProbeSupported === true;

  if (resourceUris.length === 0 || !transportProbeSupported) {
    try {
      const discovery = await client.discoverProvider(provider.id);
      discoveredProvider =
        discovery.provider &&
        typeof discovery.provider === "object" &&
        !Array.isArray(discovery.provider)
          ? discovery.provider
          : null;
      resourceUris = collectProviderResourceUris(provider, discoveredProvider);
      transportProbeSupported =
        typeof discoveredProvider?.transport_probe_supported === "boolean"
          ? discoveredProvider.transport_probe_supported
          : transportProbeSupported;
    } catch (error) {
      if (!transportProbeSupported && resourceUris.length === 0) {
        return {
          ok: false,
          source: "error",
          checkedAt,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  const preferredResourceUri = resolvePreferredHealthResourceUri(resourceUris);
  if (preferredResourceUri) {
    try {
      const result = await client.readProviderResource(provider.id, preferredResourceUri);
      return {
        ok: true,
        source: "resource",
        checkedAt,
        resourceUri: preferredResourceUri,
        value: result.value,
        discoveredProvider,
      };
    } catch (error) {
      if (!transportProbeSupported) {
        return {
          ok: false,
          source: "error",
          checkedAt,
          resourceUri: preferredResourceUri,
          error: error instanceof Error ? error.message : String(error),
          discoveredProvider,
        };
      }
    }
  }

  if (transportProbeSupported) {
    try {
      const result = await client.postProviderTransportProbe(provider.id, {
        readStatus: true,
        drainPending: true,
        skipCommand: true,
      });
      return {
        ok: true,
        source: "transport_probe",
        checkedAt,
        value: result?.value ?? result,
        discoveredProvider,
      };
    } catch (error) {
      return {
        ok: false,
        source: "error",
        checkedAt,
        error: error instanceof Error ? error.message : String(error),
        discoveredProvider,
      };
    }
  }

  return {
    ok: true,
    source: "availability",
    checkedAt,
    discoveredProvider,
  };
}

export function providerHostJsonRequest(baseUrl, path, init, options = {}) {
  const client = createProviderHostClient({
    baseUrl,
    fetch: options.fetch,
  });
  return client.jsonRequest(path, init);
}
