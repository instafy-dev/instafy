import { CAMERA_PROVIDER_FAMILY } from "@instafy/provider-contract/builtins";
import type { BuiltInAssistantDefinition } from "../../../assistants/localBuiltInAssistantCatalog";
import type { CapabilityId } from "@instafy/sdk/capabilities";
import type { LocalProviderSummary } from "../../../capabilities/localProviderHostClient";
import {
  getNativeRuntimeFallbackProvider,
  getProjectProviderFamilyId,
  getProjectProviderSelectedDevice,
  getProjectProviderStoredSelectedDevice,
  isProjectProviderFamilyPreferred,
  isProjectIntegrationAttached,
} from "../../../capabilities/projectProviderAccess";
import { getProjectProviderCameraState } from "../../../camera/cameraProjectState";
import { resolveExtensionDefinition } from "../../../extensions/extensionCatalog";
import { resolveExtensionProjectIntegrationProviderEntryKey } from "../../../extensions/extensionFamilyUiRegistry";
import type { ControllerProjectIntegration } from "../../../services/runtimeController/integrations";
import type { ProjectExtensionEntry } from "./extensionsPanelRowModel";

function getProjectExtensionEntrySortPriority(entry: ProjectExtensionEntry) {
  if (entry.attached && isProjectProviderFamilyPreferred(entry.integration)) {
    return 0;
  }
  if (entry.attached) {
    return 1;
  }
  if (entry.discoverable) {
    return 2;
  }
  return 3;
}

function sortProjectExtensionEntries(entries: ProjectExtensionEntry[]) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const priorityDelta =
        getProjectExtensionEntrySortPriority(left.entry) -
        getProjectExtensionEntrySortPriority(right.entry);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return left.index - right.index;
    })
    .map(({ entry }) => entry);
}

export function dedupeCapabilityIds(values: Iterable<string>): CapabilityId[] {
  return Array.from(
    new Set(
      Array.from(values)
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ) as CapabilityId[];
}

function inferSyntheticProviderCapabilityIds(integration: ControllerProjectIntegration): CapabilityId[] {
  if (integration.capabilities.length > 0) {
    return dedupeCapabilityIds(integration.capabilities);
  }
  const nativeFallbackProvider = getNativeRuntimeFallbackProvider(integration.provider);
  if (nativeFallbackProvider?.capabilityIds?.length) {
    return dedupeCapabilityIds(nativeFallbackProvider.capabilityIds);
  }
  return [];
}

export function createSyntheticProjectProviderSummary(
  integration: ControllerProjectIntegration,
): LocalProviderSummary {
  const capabilityIds = inferSyntheticProviderCapabilityIds(integration);
  const extension = resolveExtensionDefinition({
    capabilityIds,
    integrationProviderId: integration.provider,
  });
  const nativeFallbackProvider = getNativeRuntimeFallbackProvider(integration.provider);
  if (nativeFallbackProvider) {
    return {
      ...nativeFallbackProvider,
      id: integration.provider,
      title: extension.title,
      description: extension.listDescription,
      configured: true,
      discoverable: false,
      capabilityIds,
    };
  }

  return {
    id: integration.provider,
    title: extension.title,
    description: extension.listDescription,
    kind: extension.kind ?? undefined,
    providerType: extension.providerType ?? undefined,
    configured: true,
    discoverable: false,
    capabilityIds,
  };
}

export function buildProjectExtensionEntries(input: {
  builtInAssistants: BuiltInAssistantDefinition[];
  localProviders: LocalProviderSummary[];
  nativeRuntimeProviders: LocalProviderSummary[];
  projectIntegrations: ControllerProjectIntegration[];
  currentNativeCameraProviderId: string | null;
}): ProjectExtensionEntry[] {
  const providerEntries = new Map<
    string,
    {
      provider: LocalProviderSummary;
      source: "host" | "project_integration" | "native_runtime";
      integration: ControllerProjectIntegration | null;
    }
  >();

  for (const provider of input.localProviders) {
    providerEntries.set(provider.id, {
      provider,
      source: "host",
      integration: null,
    });
  }

  for (const provider of input.nativeRuntimeProviders) {
    const providerFamilyId = getProjectProviderFamilyId(provider.id) ?? provider.id;
    const hostFamilyEntry = Array.from(providerEntries.entries()).find(
      ([entryProviderId, entry]) =>
        entry.source === "host" &&
        (getProjectProviderFamilyId(entryProviderId) ?? entryProviderId) === providerFamilyId,
    );
    if (hostFamilyEntry && providerFamilyId === CAMERA_PROVIDER_FAMILY.id) {
      providerEntries.delete(hostFamilyEntry[0]);
    }
    if (providerEntries.has(provider.id)) {
      continue;
    }
    providerEntries.set(provider.id, {
      provider,
      source: "native_runtime",
      integration: null,
    });
  }

  for (const integration of input.projectIntegrations) {
    const existingKey = resolveExtensionProjectIntegrationProviderEntryKey({
      integrationProviderId: integration.provider,
      availableProviderIds: providerEntries.keys(),
      currentNativeProviderId: input.currentNativeCameraProviderId,
    });
    if (existingKey) {
      const existingEntry = providerEntries.get(existingKey);
      if (existingEntry) {
        providerEntries.set(existingKey, {
          ...existingEntry,
          integration,
        });
      }
      continue;
    }
    providerEntries.set(integration.provider, {
      provider: createSyntheticProjectProviderSummary(integration),
      source: "project_integration",
      integration,
    });
  }

  const entries = Array.from(providerEntries.values()).map(({ provider, source, integration }) => {
    const providerCapabilityIds = dedupeCapabilityIds(provider.capabilityIds ?? []);
    const assistantDefinitions = input.builtInAssistants.filter((assistant) =>
      assistant.capabilityBindings.some(
        (binding) =>
          binding.enabled !== false && providerCapabilityIds.includes(binding.capabilityId),
      ),
    );
    const capabilityIds =
      providerCapabilityIds.length > 0
        ? providerCapabilityIds
        : dedupeCapabilityIds(
            assistantDefinitions.flatMap((assistant) =>
              assistant.capabilityBindings
                .filter((binding) => binding.enabled !== false)
                .map((binding) => binding.capabilityId),
            ),
          );

    return {
      provider,
      source,
      integration,
      mutationProviderId: integration?.provider?.trim() || provider.id,
      discoverable: provider.discoverable !== false,
      attached: isProjectIntegrationAttached(integration),
      selectedDevice:
        getProjectProviderSelectedDevice(integration) ??
        getProjectProviderStoredSelectedDevice(integration),
      cameraState: getProjectProviderCameraState(integration),
      assistantDefinitions,
      capabilityIds,
      providerCapabilityIds,
      attachedCapabilityIds:
        integration?.capabilities.length && integration.capabilities.some((entry) => entry.trim().length > 0)
          ? dedupeCapabilityIds(integration.capabilities)
          : capabilityIds,
    };
  });

  return sortProjectExtensionEntries(entries);
}

export function listAttachedCameraProviderIds(projectExtensions: ProjectExtensionEntry[]) {
  return Array.from(
    new Set(
      projectExtensions
        .filter(
          (entry) =>
            entry.attached &&
            getProjectProviderFamilyId(entry.mutationProviderId) === CAMERA_PROVIDER_FAMILY.id,
        )
        .map((entry) => entry.mutationProviderId),
    ),
  );
}

export function countAttachedExtensionFamilies(projectExtensions: ProjectExtensionEntry[]) {
  const counts = new Map<string, number>();
  for (const entry of projectExtensions) {
    if (!entry.attached) {
      continue;
    }
    const familyId = getProjectProviderFamilyId(entry.mutationProviderId) ?? entry.mutationProviderId;
    counts.set(familyId, (counts.get(familyId) ?? 0) + 1);
  }
  return counts;
}
