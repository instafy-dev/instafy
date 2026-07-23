import type { CapabilityId } from "@instafy/sdk/capabilities";
import { Capacitor } from "@capacitor/core";
import {
  CAMERA_PROVIDER_FAMILY,
} from "@instafy/provider-contract/builtins";
import type { LocalProviderSummary } from "../capabilities/localProviderHostClient";
import {
  buildNativeCameraRuntimeProvider,
  isCameraProviderId,
  resolveNativeCameraProviderId,
} from "../camera/cameraProviderIdentity";
import {
  getNativeCameraStatus,
  supportsCurrentClientNativeCameraBridge,
} from "../camera/nativeCameraBridge";
import { getRegisteredNativeRuntimeProvider } from "./extensionCatalog";
import { resolveExtensionFamilyId } from "../providers/extensionProviderId";
import { APPLICATION_FRONTEND_FEATURES } from "../features/applicationFrontendFeatureComposition";
import type { NativeRuntimeFamilyRegistration } from "./nativeRuntimeProviderTypes";

function normalizeString(value: string | null | undefined) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function inferNativeRuntimeFallbackCapabilityIds(providerId: string): CapabilityId[] {
  return (
    getRegisteredNativeRuntimeProvider(providerId)?.capabilityIds?.filter(
      (capabilityId): capabilityId is CapabilityId => typeof capabilityId === "string",
    ) ?? []
  );
}

function getCurrentPlatform() {
  return Capacitor.getPlatform();
}

function getNativeRuntimeFallbackProviderForRegistration(
  registration: NativeRuntimeFamilyRegistration,
  providerId: string,
): LocalProviderSummary | null {
  const normalizedProviderId = normalizeString(providerId);
  const provider = getRegisteredNativeRuntimeProvider(normalizedProviderId || registration.familyId);
  if (!provider) {
    return null;
  }
  return {
    ...provider,
    id: normalizedProviderId || provider.id,
    capabilityIds:
      provider.capabilityIds && provider.capabilityIds.length > 0
        ? provider.capabilityIds
        : Array.from(registration.capabilityIds.length > 0
            ? registration.capabilityIds
            : inferNativeRuntimeFallbackCapabilityIds(normalizedProviderId || registration.familyId)),
  };
}

async function resolveCurrentClientNativeCameraProvider(
  providerId: string,
): Promise<LocalProviderSummary | null> {
  if (!isCameraProviderId(providerId)) {
    return null;
  }

  const status = await getNativeCameraStatus().catch(() => null);
  const currentProviderId = resolveNativeCameraProviderId(status);
  if (
    normalizeString(providerId) !== CAMERA_PROVIDER_FAMILY.id &&
    (!currentProviderId || currentProviderId !== normalizeString(providerId))
  ) {
    return null;
  }

  return buildNativeCameraRuntimeProvider(status, providerId);
}

async function resolveCurrentClientNativeCameraProviderId(providerId: string) {
  if (!isCameraProviderId(providerId)) {
    return null;
  }
  const status = await getNativeCameraStatus().catch(() => null);
  return resolveNativeCameraProviderId(status);
}

const NATIVE_RUNTIME_FAMILY_REGISTRATIONS: readonly NativeRuntimeFamilyRegistration[] = [
  {
    familyId: CAMERA_PROVIDER_FAMILY.id,
    capabilityIds: CAMERA_PROVIDER_FAMILY.capabilityIds,
    supportsOnClient() {
      return supportsCurrentClientNativeCameraBridge();
    },
    resolveCurrentProvider(providerId) {
      return resolveCurrentClientNativeCameraProvider(providerId);
    },
    resolveCurrentProviderId(providerId) {
      return resolveCurrentClientNativeCameraProviderId(providerId);
    },
    supportsRemoteNativeExtension: true,
  },
  ...APPLICATION_FRONTEND_FEATURES.nativeRuntimeFamilyRegistrations,
];

export function resolveNativeRuntimeFamilyRegistration(input: {
  providerId?: string | null;
  capabilityId?: CapabilityId | null;
}) {
  const familyId =
    resolveExtensionFamilyId(input.providerId) ?? normalizeString(input.providerId);
  if (familyId) {
    return (
      NATIVE_RUNTIME_FAMILY_REGISTRATIONS.find(
        (registration) => registration.familyId === familyId,
      ) ?? null
    );
  }

  const capabilityId = normalizeString(input.capabilityId);
  if (!capabilityId) {
    return null;
  }
  return (
    NATIVE_RUNTIME_FAMILY_REGISTRATIONS.find((registration) =>
      registration.capabilityIds.some((candidate) => candidate === capabilityId),
    ) ?? null
  );
}

export function supportsNativeProviderRuntimeOnThisClient(providerId?: string | null) {
  const registration = resolveNativeRuntimeFamilyRegistration({ providerId });
  return registration ? registration.supportsOnClient(getCurrentPlatform()) : false;
}

export function providerSupportsRemoteNativeExtension(providerId?: string | null) {
  return (
    resolveNativeRuntimeFamilyRegistration({ providerId })?.supportsRemoteNativeExtension === true
  );
}

export function getNativeRuntimeFallbackProvider(
  providerId: string,
): LocalProviderSummary | null {
  const registration = resolveNativeRuntimeFamilyRegistration({ providerId });
  if (!registration || !registration.supportsOnClient(getCurrentPlatform())) {
    return null;
  }
  return getNativeRuntimeFallbackProviderForRegistration(registration, providerId);
}

export function getNativeRuntimeFallbackProviderForCapability(
  capabilityId: CapabilityId | null | undefined,
): LocalProviderSummary | null {
  const registration = resolveNativeRuntimeFamilyRegistration({ capabilityId });
  if (!registration) {
    return null;
  }
  return getNativeRuntimeFallbackProvider(registration.familyId);
}

export async function resolveCurrentClientNativeRuntimeProviderForCapability(
  capabilityId: CapabilityId | null | undefined,
): Promise<LocalProviderSummary | null> {
  const registration = resolveNativeRuntimeFamilyRegistration({ capabilityId });
  if (!registration) {
    return null;
  }
  const resolvedProviderId =
    (registration.resolveCurrentProviderId
      ? await registration.resolveCurrentProviderId(registration.familyId)
      : null) ?? registration.familyId;
  return resolveCurrentClientNativeRuntimeProvider(resolvedProviderId);
}

export async function resolveCurrentClientNativeRuntimeProvider(
  providerId: string,
): Promise<LocalProviderSummary | null> {
  const registration = resolveNativeRuntimeFamilyRegistration({ providerId });
  if (!registration || !registration.supportsOnClient(getCurrentPlatform())) {
    return null;
  }
  return registration.resolveCurrentProvider(providerId);
}

export async function resolveCurrentClientNativeRuntimeProviderId(
  providerId: string,
) {
  const registration = resolveNativeRuntimeFamilyRegistration({ providerId });
  if (!registration || !registration.resolveCurrentProviderId) {
    return null;
  }
  if (!registration.supportsOnClient(getCurrentPlatform())) {
    return null;
  }
  return registration.resolveCurrentProviderId(providerId);
}

export async function listCurrentClientNativeRuntimeProviders(): Promise<LocalProviderSummary[]> {
  const platform = getCurrentPlatform();
  const providers = await Promise.all(
    NATIVE_RUNTIME_FAMILY_REGISTRATIONS.map(async (registration) => {
      if (!registration.supportsOnClient(platform)) {
        return null;
      }
      const resolvedProviderId =
        (registration.resolveCurrentProviderId
          ? await registration.resolveCurrentProviderId(registration.familyId)
          : null) ?? registration.familyId;
      return registration.resolveCurrentProvider(resolvedProviderId);
    }),
  );
  return providers.filter((provider): provider is LocalProviderSummary => Boolean(provider));
}
