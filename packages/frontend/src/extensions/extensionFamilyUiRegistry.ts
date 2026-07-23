import type { BuiltInProviderFamilyDefinition } from "@instafy/provider-contract/builtins";
import {
  BUILT_IN_PROVIDER_FAMILIES,
} from "@instafy/provider-contract/builtins";
import type { LocalProviderSummary } from "../capabilities/localProviderHostClient";
import type { CameraStatusSnapshot } from "../camera/types";
import { CAMERA_EXTENSION_FAMILY_UI_ADAPTER } from "./cameraExtensionFamilyUiAdapter";
import type { ExtensionFamilyUiAdapter } from "./extensionFamilyUiAdapters";

function normalizeString(value: string | null | undefined) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function getExtensionShellUiDefinition(family: BuiltInProviderFamilyDefinition) {
  return family.extension?.shellUi ?? null;
}

function resolveProviderFamilyUiAdapter(
  providerId: string | null | undefined,
) {
  return (
    EXTENSION_FAMILY_UI_ADAPTERS.find((adapter) =>
      adapter.matchesProviderId(providerId),
    ) ?? null
  );
}

function resolveProviderFamilyDefinition(
  providerId: string | null | undefined,
) {
  const familyId = resolveProviderFamilyUiAdapter(providerId)?.familyId;
  if (!familyId) {
    return null;
  }
  return (
    BUILT_IN_PROVIDER_FAMILIES.find((family) => family.id === familyId) ?? null
  );
}

function resolveExtensionFamilyUiDefaults(
  providerId: string | null | undefined,
) {
  const family = resolveProviderFamilyDefinition(providerId);
  if (!family) {
    return null;
  }
  return getExtensionShellUiDefinition(family);
}

const EXTENSION_FAMILY_UI_ADAPTERS: readonly ExtensionFamilyUiAdapter[] = [
  CAMERA_EXTENSION_FAMILY_UI_ADAPTER,
];

export function resolveExtensionFamilyUiRegistration(
  providerId: string | null | undefined,
) {
  return resolveProviderFamilyUiAdapter(providerId);
}

export function supportsExtensionRemoteDeviceUi(
  providerId: string | null | undefined,
) {
  return resolveExtensionFamilyUiDefaults(providerId)?.supportsRemoteDeviceUi === true;
}

export function supportsExtensionAttachedDeviceList(
  providerId: string | null | undefined,
) {
  return resolveExtensionFamilyUiDefaults(providerId)?.supportsAttachedDeviceList === true;
}

export function resolveExtensionAttachedDeviceFamilyId(
  providerId: string | null | undefined,
) {
  return resolveExtensionFamilyUiDefaults(providerId)?.attachedDeviceFamilyId ?? null;
}

export function resolveExtensionFamilyCurrentNativeProviderId(input: {
  familyId: string;
  nativeRuntimeProviders: LocalProviderSummary[];
  currentNativeCameraStatus: CameraStatusSnapshot | null;
}) {
  const registration = resolveExtensionFamilyUiRegistration(input.familyId);
  return registration?.resolveCurrentNativeProviderId
    ? registration.resolveCurrentNativeProviderId(input)
    : null;
}

export function resolveExtensionProjectIntegrationProviderEntryKey(input: {
  integrationProviderId: string;
  availableProviderIds: Iterable<string>;
  currentNativeProviderId: string | null;
}) {
  const availableProviderIds = new Set(
    Array.from(input.availableProviderIds).map((providerId) => normalizeString(providerId)),
  );
  const normalizedIntegrationProviderId = normalizeString(input.integrationProviderId);
  if (availableProviderIds.has(normalizedIntegrationProviderId)) {
    return normalizedIntegrationProviderId;
  }
  const registration = resolveExtensionFamilyUiRegistration(normalizedIntegrationProviderId);
  return registration?.resolveProjectIntegrationProviderEntryKey
    ? registration.resolveProjectIntegrationProviderEntryKey({
        integrationProviderId: normalizedIntegrationProviderId,
        availableProviderIds,
        currentNativeProviderId: input.currentNativeProviderId,
      })
    : null;
}

export function buildExtensionNativeAttachMetadata(input: {
  providerId: string;
  currentNativeCameraStatus: CameraStatusSnapshot | null;
  currentPlatform: string;
}) {
  return (
    resolveExtensionFamilyUiRegistration(input.providerId)?.buildNativeAttachMetadata?.(input) ??
    null
  );
}

export function shouldUseExtensionCurrentNativeStatus(input: {
  providerId: string;
  source: "host" | "project_integration" | "native_runtime";
  currentNativeProviderId: string | null;
}) {
  return (
    resolveExtensionFamilyUiRegistration(input.providerId)?.shouldUseCurrentNativeStatus?.(input) ??
    false
  );
}

export function resolveExtensionFamilyInstanceTitle(input: {
  providerId: string;
  title: string;
  attachedFamilyCount: number;
  remoteDeviceLabel?: string | null;
  selectedDeviceLabel?: string | null;
}) {
  const shellUi = resolveExtensionFamilyUiDefaults(input.providerId);
  if (!shellUi?.appendDeviceLabelWhenMultipleAttached) {
    return input.title;
  }
  if (
    normalizeString(input.providerId) === normalizeString(shellUi.attachedDeviceFamilyId) &&
    input.attachedFamilyCount <= 1
  ) {
    return input.title;
  }
  const label = input.remoteDeviceLabel?.trim() || input.selectedDeviceLabel?.trim() || "";
  if (!label || label === "another device") {
    return input.title;
  }
  return `${input.title} · ${label}`;
}
