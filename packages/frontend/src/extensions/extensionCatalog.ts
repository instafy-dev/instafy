import type { ProviderSummary } from "@instafy/provider-contract";
import {
  BUILT_IN_EXTENSION_PROVIDER_FAMILIES,
  type BuiltInProviderFamilyDefinition,
} from "@instafy/provider-contract/builtins";
import {
  parseExtensionProviderId,
  resolveExtensionFamilyId,
} from "../providers/extensionProviderId";

type ExtensionCatalogInput = {
  provider?: {
    id?: string;
    title?: string;
    description?: string;
    kind?: string;
    providerType?: string;
    capabilityIds?: string[];
    manifest?: ProviderSummary["manifest"];
  } | null;
  capabilityIds?: Iterable<string> | null;
  integrationProviderId?: string | null;
};

export type ExtensionDefinition = {
  familyId: string;
  title: string;
  listDescription: string;
  kind: string | null;
  providerType: string | null;
  nativeRuntimeProvider?: ProviderSummary | null;
};

const KNOWN_EXTENSION_DEFINITIONS: Record<string, ExtensionDefinition> = {
  ...Object.fromEntries(
    BUILT_IN_EXTENSION_PROVIDER_FAMILIES.map((family) => [
      family.id,
      createBuiltInExtensionDefinition(family),
    ]),
  ),
};

function normalizeString(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCapabilityIds(values: Iterable<string> | null | undefined) {
  return new Set(
    Array.from(values ?? [])
      .map((value) => normalizeString(value))
      .filter(Boolean),
  );
}

function findManifestHostSurface(
  family: BuiltInProviderFamilyDefinition,
  surfaceId: string,
) {
  return family.manifest.hostSurfaces?.find(
    (surface) => normalizeString(surface?.surface).toLowerCase() === surfaceId,
  );
}

function createBuiltInExtensionDefinition(
  family: BuiltInProviderFamilyDefinition,
): ExtensionDefinition {
  const extensionTile = findManifestHostSurface(family, "extension_tile");
  const kindFromMetadata =
    extensionTile?.metadata &&
    typeof extensionTile.metadata === "object" &&
    !Array.isArray(extensionTile.metadata)
      ? normalizeString((extensionTile.metadata as { kind?: string }).kind)
      : "";

  return {
    familyId: family.id,
    title: family.title,
    listDescription:
      family.extension?.listDescription ||
      normalizeString(extensionTile?.description) ||
      summarizeExtensionDescription(family.description, family.title),
    kind: family.extension?.kind || kindFromMetadata || family.kind || null,
    providerType: family.providerType,
    nativeRuntimeProvider: family.extension?.nativeRuntimeProvider ?? null,
  };
}

function resolveManifestExtensionDefinition(input: ExtensionCatalogInput): ExtensionDefinition | null {
  const manifest = input.provider?.manifest;
  const extensionTile = manifest?.hostSurfaces?.find(
    (surface) => normalizeString(surface?.surface).toLowerCase() === "extension_tile",
  );
  if (!extensionTile) {
    return null;
  }

  const title =
    normalizeString(extensionTile.title) ||
    normalizeString(input.provider?.title) ||
    formatExtensionTitleFromId(input.provider?.id ?? input.integrationProviderId);
  const description =
    normalizeString(extensionTile.description) ||
    summarizeExtensionDescription(input.provider?.description, title);
  const kindFromMetadata =
    extensionTile.metadata && typeof extensionTile.metadata === "object" && !Array.isArray(extensionTile.metadata)
      ? normalizeString((extensionTile.metadata as { kind?: string }).kind)
      : "";

  return {
    familyId:
      normalizeString(manifest?.familyId) ||
      normalizeString(input.provider?.id) ||
      normalizeString(input.integrationProviderId) ||
      "extension",
    title,
    listDescription: description,
    kind: kindFromMetadata || normalizeString(input.provider?.kind) || null,
    providerType: normalizeString(input.provider?.providerType) || null,
    nativeRuntimeProvider: null,
  };
}

export function formatExtensionTitleFromId(value: string | null | undefined) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return "Extension";
  }
  return normalized
    .split(/[_-]+/)
    .filter(Boolean)
    .map((segment) => segment.slice(0, 1).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function summarizeExtensionDescription(
  description: string | null | undefined,
  fallbackTitle: string,
) {
  const normalized = normalizeString(description).replace(/\s+/g, " ");
  if (!normalized) {
    return `${fallbackTitle} extension.`;
  }

  const firstSentence = normalized.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? normalized;
  if (firstSentence.length <= 96) {
    return firstSentence;
  }
  return `${firstSentence.slice(0, 93).trimEnd()}...`;
}

function resolveKnownExtensionFamily(input: ExtensionCatalogInput) {
  const providerId = resolveExtensionFamilyId(input.provider?.id) ?? normalizeString(input.provider?.id).toLowerCase();
  const providerType = normalizeString(input.provider?.providerType).toLowerCase();
  const integrationProviderId =
    resolveExtensionFamilyId(input.integrationProviderId) ??
    normalizeString(input.integrationProviderId).toLowerCase();
  const capabilityIds = normalizeCapabilityIds([
    ...(input.provider?.capabilityIds ?? []),
    ...(input.capabilityIds ?? []),
  ]);

  for (const family of BUILT_IN_EXTENSION_PROVIDER_FAMILIES) {
    if (
      providerId === family.id ||
      providerType === family.providerType ||
      integrationProviderId === family.id ||
      family.capabilityIds.some((capabilityId) => capabilityIds.has(capabilityId))
    ) {
      return KNOWN_EXTENSION_DEFINITIONS[family.id] ?? null;
    }
  }

  return null;
}

export function resolveExtensionDefinition(input: ExtensionCatalogInput): ExtensionDefinition {
  const manifestDefined = resolveManifestExtensionDefinition(input);
  if (manifestDefined) {
    return manifestDefined;
  }

  const known = resolveKnownExtensionFamily(input);
  if (known) {
    return known;
  }

  const title =
    normalizeString(input.provider?.title) ||
    formatExtensionTitleFromId(input.provider?.id ?? input.integrationProviderId);

  return {
    familyId: normalizeString(input.provider?.id) || normalizeString(input.integrationProviderId) || "extension",
    title,
    listDescription: summarizeExtensionDescription(input.provider?.description, title),
    kind: normalizeString(input.provider?.kind) || null,
    providerType: normalizeString(input.provider?.providerType) || null,
    nativeRuntimeProvider: null,
  };
}

export function getRegisteredExtensionDefinition(
  providerId: string | null | undefined,
): ExtensionDefinition | null {
  const normalized = resolveExtensionFamilyId(providerId) ?? normalizeString(providerId).toLowerCase();
  if (!normalized) {
    return null;
  }
  return KNOWN_EXTENSION_DEFINITIONS[normalized] ?? null;
}

export function getRegisteredNativeRuntimeProvider(
  providerId: string | null | undefined,
): ProviderSummary | null {
  const definition = getRegisteredExtensionDefinition(providerId);
  const nativeRuntimeProvider = definition?.nativeRuntimeProvider ?? null;
  if (!nativeRuntimeProvider) {
    return null;
  }

  const identity = parseExtensionProviderId(providerId);
  if (!identity || identity.providerId === nativeRuntimeProvider.id) {
    return nativeRuntimeProvider;
  }

  return {
    ...nativeRuntimeProvider,
    id: identity.providerId,
  };
}

export function formatExtensionKindLabel(kind: string | null | undefined) {
  const normalized = normalizeString(kind);
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, 1).toUpperCase() + normalized.slice(1);
}
