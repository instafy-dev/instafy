import { BUILT_IN_EXTENSION_PROVIDER_FAMILIES } from "@instafy/provider-contract/builtins";

const KNOWN_EXTENSION_PROVIDER_FAMILY_IDS: ReadonlySet<string> = new Set([
  ...BUILT_IN_EXTENSION_PROVIDER_FAMILIES.map((family) => family.id),
]);

export type ExtensionProviderIdentity = {
  providerId: string;
  familyId: string;
  instanceId: string | null;
  isInstance: boolean;
};

function normalizeProviderId(value: string | null | undefined) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function parseExtensionProviderId(
  value: string | null | undefined,
): ExtensionProviderIdentity | null {
  const providerId = normalizeProviderId(value);
  if (!providerId) {
    return null;
  }

  const [candidateFamilyId, ...instanceParts] = providerId.split(":");
  if (
    instanceParts.length > 0 &&
    candidateFamilyId &&
    KNOWN_EXTENSION_PROVIDER_FAMILY_IDS.has(candidateFamilyId)
  ) {
    const instanceId = instanceParts.join(":").trim();
    return {
      providerId,
      familyId: candidateFamilyId,
      instanceId: instanceId || null,
      isInstance: instanceId.length > 0,
    };
  }

  return {
    providerId,
    familyId: providerId,
    instanceId: null,
    isInstance: false,
  };
}

export function resolveExtensionFamilyId(value: string | null | undefined) {
  return parseExtensionProviderId(value)?.familyId ?? null;
}

export function matchesExtensionProviderFamily(
  providerId: string | null | undefined,
  familyId: string | null | undefined,
) {
  const normalizedFamilyId = normalizeProviderId(familyId);
  return normalizedFamilyId.length > 0 && resolveExtensionFamilyId(providerId) === normalizedFamilyId;
}

export function createExtensionProviderInstanceId(
  familyId: string | null | undefined,
  instanceId: string | null | undefined,
) {
  const normalizedFamilyId = normalizeProviderId(familyId);
  const normalizedInstanceId = normalizeProviderId(instanceId);
  if (!normalizedFamilyId || !normalizedInstanceId) {
    return null;
  }
  return `${normalizedFamilyId}:${normalizedInstanceId}`;
}
