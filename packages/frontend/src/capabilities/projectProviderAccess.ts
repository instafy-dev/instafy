import type { CapabilityId } from "@instafy/sdk/capabilities";
import { Capacitor } from "@capacitor/core";
import { controllerClient } from "../sdk/instafy/controllerClient";
import type { ControllerProjectIntegration } from "../services/runtimeController/integrations";
import {
  listLocalProviders,
  providerSupportsCapability,
  type LocalProviderSummary,
} from "./localProviderHostClient";
import { resolveExtensionFamilyId } from "../providers/extensionProviderId";
import {
  providerSupportsRemoteNativeExtension,
  resolveCurrentClientNativeRuntimeProvider,
  resolveCurrentClientNativeRuntimeProviderForCapability,
  resolveCurrentClientNativeRuntimeProviderId,
} from "../extensions/nativeRuntimeProviderRegistry";
export {
  getNativeRuntimeFallbackProvider,
  listCurrentClientNativeRuntimeProviders,
  resolveCurrentClientNativeRuntimeProvider,
} from "../extensions/nativeRuntimeProviderRegistry";

const ATTACHED_PROJECT_INTEGRATION_STATUSES = new Set([
  "attached",
  "available",
  "connected",
  "enabled",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeAssistantHandleAllowList(metadata: Record<string, unknown>): string[] {
  return normalizeStringArray(
    metadata.allowedAssistantHandles ?? metadata.assistantHandles ?? metadata.allowedAgents,
  ).map((entry) => entry.toLowerCase());
}

export interface ProjectProviderAccessResolution {
  providerId: string;
  allowed: boolean;
  source:
    | "unscoped_local_runtime"
    | "project_integration"
    | "project_integration_denied"
    | "project_policy_unavailable";
  integrationId?: string | null;
  status?: string | null;
  reason?: string | null;
  unavailableReason?: "attached_on_other_device" | "not_discoverable" | null;
}

export interface ProjectCapabilityProviderAccessResolution extends ProjectProviderAccessResolution {
  provider: LocalProviderSummary | null;
}

export interface ProjectProviderSelectedDevice {
  transport: string;
  identifier: string;
  address?: string | null;
  name?: string | null;
  nativePlatform?: "android" | "ios" | null;
  savedAt?: string | null;
  lastConnectedAt?: string | null;
}

export interface ProjectProviderSelectedDeviceInput {
  transport: string;
  identifier: string;
  address?: string | null;
  name?: string | null;
  nativePlatform?: "android" | "ios" | null;
  connectedAt?: string | null;
}

export interface ProjectProviderFamilySelection {
  familyId: string;
  preferredProviderId: string;
  preferredDevice: ProjectProviderSelectedDevice | null;
  updatedAt: string | null;
}

export interface ResolveProjectProviderAccessOptions {
  projectId?: string | null;
  providerId: string;
  assistantHandle: string;
  capabilityId?: CapabilityId | null;
}

export type ListProjectIntegrationsLoader = (
  projectId: string,
) => Promise<{ success: boolean; integrations: ControllerProjectIntegration[]; error?: string }>;

export type UpsertProjectIntegrationWriter = (
  projectId: string,
  providerId: string,
  params: {
    status?: string;
    connectionType?: string;
    credentialId?: string | null;
    metadata?: Record<string, unknown>;
    requiredScopes?: string[];
    capabilities?: CapabilityId[];
    accessToken?: string | null;
  },
) => Promise<{
  success: boolean;
  integration?: ControllerProjectIntegration;
  error?: string;
}>;

export type ListLocalProvidersLoader = () => Promise<{
  providers: LocalProviderSummary[];
}>;

export interface AttachProjectProviderOptions {
  projectId: string;
  providerId: string;
  assistantHandle?: string;
  assistantHandles?: string[];
  capabilityId?: CapabilityId | null;
  capabilityIds?: CapabilityId[];
  metadata?: Record<string, unknown>;
  status?: string;
  connectionType?: string;
}

export interface AttachProjectProviderResult {
  success: boolean;
  integration?: ControllerProjectIntegration;
  error?: string;
}

export function listProjectIntegrationAssistantHandles(
  integration: ControllerProjectIntegration | null | undefined,
): string[] {
  const metadata = isRecord(integration?.metadata) ? integration.metadata : {};
  return normalizeAssistantHandleAllowList(metadata);
}

export function isProjectIntegrationAttached(
  integration: ControllerProjectIntegration | null | undefined,
): boolean {
  if (!integration) {
    return false;
  }
  const status = integration.status.trim().toLowerCase();
  const metadata = isRecord(integration.metadata) ? integration.metadata : {};
  return (
    ATTACHED_PROJECT_INTEGRATION_STATUSES.has(status) &&
    metadata.attached !== false &&
    metadata.enabled !== false
  );
}

export function getProjectIntegrationByProvider(
  integrations: ControllerProjectIntegration[],
  providerId: string,
): ControllerProjectIntegration | null {
  return findProjectIntegration(integrations, providerId);
}

function normalizeProjectProviderSelectedDevice(
  value: unknown,
): ProjectProviderSelectedDevice | null {
  if (!isRecord(value)) {
    return null;
  }

  const transport = typeof value.transport === "string" ? value.transport.trim() : "";
  const identifier = typeof value.identifier === "string" ? value.identifier.trim() : "";
  if (!transport || !identifier) {
    return null;
  }

  const address =
    typeof value.address === "string" && value.address.trim().length > 0
      ? value.address.trim()
      : null;
  const name =
    typeof value.name === "string" && value.name.trim().length > 0 ? value.name.trim() : null;
  const nativePlatform =
    value.nativePlatform === "android" || value.nativePlatform === "ios"
      ? value.nativePlatform
      : null;
  const savedAt =
    typeof value.savedAt === "string" && value.savedAt.trim().length > 0
      ? value.savedAt.trim()
      : null;
  const lastConnectedAt =
    typeof value.lastConnectedAt === "string" && value.lastConnectedAt.trim().length > 0
      ? value.lastConnectedAt.trim()
      : null;

  return {
    transport,
    identifier,
    address,
    name,
    nativePlatform,
    savedAt,
    lastConnectedAt,
  };
}

function normalizeProjectProviderFamilySelection(
  value: unknown,
  expectedFamilyId?: string | null,
): ProjectProviderFamilySelection | null {
  if (!isRecord(value)) {
    return null;
  }

  const preferredProviderId =
    typeof value.preferredProviderId === "string"
      ? value.preferredProviderId.trim().toLowerCase()
      : "";
  if (!preferredProviderId) {
    return null;
  }

  const familyId =
    (typeof value.familyId === "string" ? value.familyId.trim().toLowerCase() : "") ||
    getProjectProviderFamilyId(preferredProviderId) ||
    preferredProviderId;
  const normalizedExpectedFamilyId =
    typeof expectedFamilyId === "string" ? expectedFamilyId.trim().toLowerCase() : "";
  if (normalizedExpectedFamilyId && familyId !== normalizedExpectedFamilyId) {
    return null;
  }

  if (getProjectProviderFamilyId(preferredProviderId) !== familyId) {
    return null;
  }

  const preferredDevice = normalizeProjectProviderSelectedDevice(
    value.preferredDevice ?? value.selectedDevice,
  );
  const updatedAt =
    typeof value.updatedAt === "string" && value.updatedAt.trim().length > 0
      ? value.updatedAt.trim()
      : null;

  return {
    familyId,
    preferredProviderId,
    preferredDevice,
    updatedAt,
  };
}

function getCurrentNativeMobilePlatform(): "android" | "ios" | null {
  const platform = Capacitor.getPlatform();
  return platform === "android" || platform === "ios" ? platform : null;
}

function isLikelyBluetoothMacAddress(value: string) {
  return /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/i.test(value.trim());
}

function isLikelyUuid(value: string) {
  return /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(value.trim());
}

function normalizeProjectProviderSelectedDeviceMap(
  value: unknown,
): Partial<Record<"android" | "ios", ProjectProviderSelectedDevice>> {
  if (!isRecord(value)) {
    return {};
  }

  const platforms: Array<"android" | "ios"> = ["android", "ios"];
  return Object.fromEntries(
    platforms
      .map((platform) => [platform, normalizeProjectProviderSelectedDevice(value[platform])] as const)
      .filter((entry): entry is ["android" | "ios", ProjectProviderSelectedDevice] => entry[1] !== null),
  );
}

function deviceMatchesCurrentNativePlatform(
  device: ProjectProviderSelectedDevice,
  platform: "android" | "ios",
) {
  if (device.nativePlatform) {
    return device.nativePlatform === platform;
  }

  const identifier = device.identifier.trim();
  const address = device.address?.trim() || "";
  if (platform === "android") {
    return isLikelyBluetoothMacAddress(address || identifier);
  }
  return isLikelyUuid(identifier);
}

export function getProjectProviderSelectedDevice(
  integration: ControllerProjectIntegration | null | undefined,
): ProjectProviderSelectedDevice | null {
  const metadata = isRecord(integration?.metadata) ? integration.metadata : {};
  const currentPlatform = getCurrentNativeMobilePlatform();
  const selectedDeviceMap = normalizeProjectProviderSelectedDeviceMap(metadata.selectedDevices);
  if (currentPlatform) {
    const platformDevice = selectedDeviceMap[currentPlatform];
    if (platformDevice) {
      return platformDevice;
    }
  }

  const selectedDevice = normalizeProjectProviderSelectedDevice(metadata.selectedDevice);
  if (!selectedDevice) {
    return null;
  }

  if (
    currentPlatform &&
    selectedDevice.transport.trim().toLowerCase() !== "desktop_webcam" &&
    !deviceMatchesCurrentNativePlatform(selectedDevice, currentPlatform)
  ) {
    return null;
  }

  return selectedDevice;
}

function compareStoredSelectedDevices(
  left: ProjectProviderSelectedDevice,
  right: ProjectProviderSelectedDevice,
) {
  const recencyDelta =
    parseTimestamp(right.lastConnectedAt) - parseTimestamp(left.lastConnectedAt) ||
    parseTimestamp(right.savedAt) - parseTimestamp(left.savedAt);
  if (recencyDelta !== 0) {
    return recencyDelta;
  }

  const leftName = left.name?.trim() ?? "";
  const rightName = right.name?.trim() ?? "";
  if (leftName && rightName) {
    return leftName.localeCompare(rightName);
  }
  return left.identifier.localeCompare(right.identifier);
}

export function getProjectProviderStoredSelectedDevice(
  integration: ControllerProjectIntegration | null | undefined,
): ProjectProviderSelectedDevice | null {
  const metadata = isRecord(integration?.metadata) ? integration.metadata : {};
  const selectedDevice = normalizeProjectProviderSelectedDevice(metadata.selectedDevice);
  if (selectedDevice) {
    return selectedDevice;
  }

  const selectedDeviceMap = normalizeProjectProviderSelectedDeviceMap(metadata.selectedDevices);
  const storedDevices = Object.values(selectedDeviceMap);
  if (storedDevices.length === 0) {
    return null;
  }
  return [...storedDevices].sort(compareStoredSelectedDevices)[0] ?? null;
}

export function getProjectProviderFamilySelection(
  integration: ControllerProjectIntegration | null | undefined,
): ProjectProviderFamilySelection | null {
  if (!integration) {
    return null;
  }

  const metadata = isRecord(integration.metadata) ? integration.metadata : {};
  const familyId =
    getProjectProviderFamilyId(integration.provider) ?? integration.provider.trim().toLowerCase();
  const explicitSelection = normalizeProjectProviderFamilySelection(
    metadata.providerFamilySelection,
    familyId,
  );
  if (explicitSelection) {
    if (explicitSelection.preferredDevice) {
      return explicitSelection;
    }
    if (
      explicitSelection.preferredProviderId === integration.provider.trim().toLowerCase()
    ) {
      return {
        ...explicitSelection,
        preferredDevice: getProjectProviderStoredSelectedDevice(integration),
      };
    }
    return explicitSelection;
  }

  const preferredProviderId =
    typeof metadata.preferredProviderId === "string"
      ? metadata.preferredProviderId.trim().toLowerCase()
      : "";
  if (!preferredProviderId || getProjectProviderFamilyId(preferredProviderId) !== familyId) {
    return null;
  }

  return {
    familyId,
    preferredProviderId,
    preferredDevice:
      preferredProviderId === integration.provider.trim().toLowerCase()
        ? getProjectProviderStoredSelectedDevice(integration)
        : null,
    updatedAt:
      typeof metadata.updatedAt === "string" && metadata.updatedAt.trim().length > 0
        ? metadata.updatedAt.trim()
        : null,
  };
}

export function withProjectProviderSelectedDevice(
  metadataValue: Record<string, unknown> | null | undefined,
  device: ProjectProviderSelectedDeviceInput,
  nowIso = new Date().toISOString(),
): Record<string, unknown> {
  const metadata = isRecord(metadataValue) ? metadataValue : {};
  const existingDevice = normalizeProjectProviderSelectedDevice(metadata.selectedDevice);
  const transport = device.transport.trim();
  const identifier = device.identifier.trim();
  const address =
    typeof device.address === "string" && device.address.trim().length > 0
      ? device.address.trim()
      : identifier;
  const name =
    typeof device.name === "string" && device.name.trim().length > 0 ? device.name.trim() : null;
  const nativePlatform =
    device.nativePlatform === "android" || device.nativePlatform === "ios"
      ? device.nativePlatform
      : getCurrentNativeMobilePlatform();
  const connectedAt =
    typeof device.connectedAt === "string" && device.connectedAt.trim().length > 0
      ? device.connectedAt.trim()
      : nowIso;
  const nextSelectedDevice: ProjectProviderSelectedDevice = {
    transport,
    identifier,
    address,
    name,
    nativePlatform,
    savedAt:
      existingDevice &&
      existingDevice.transport === transport &&
      existingDevice.identifier === identifier &&
      typeof existingDevice.savedAt === "string" &&
      existingDevice.savedAt.trim().length > 0
        ? existingDevice.savedAt
        : nowIso,
    lastConnectedAt: connectedAt,
  };
  const selectedDevices = normalizeProjectProviderSelectedDeviceMap(metadata.selectedDevices);
  if (nativePlatform) {
    selectedDevices[nativePlatform] = nextSelectedDevice;
  }

  return {
    ...metadata,
    selectedDevice: nextSelectedDevice,
    ...(Object.keys(selectedDevices).length > 0 ? { selectedDevices } : {}),
  };
}

export function withoutProjectProviderSelectedDevice(
  metadataValue: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const metadata = isRecord(metadataValue) ? { ...metadataValue } : {};
  const currentPlatform = getCurrentNativeMobilePlatform();
  const selectedDeviceMap = normalizeProjectProviderSelectedDeviceMap(metadata.selectedDevices);

  if (currentPlatform) {
    delete selectedDeviceMap[currentPlatform];
  }

  if (Object.keys(selectedDeviceMap).length > 0) {
    metadata.selectedDevices = selectedDeviceMap;
    const fallbackDevice =
      selectedDeviceMap[currentPlatform ?? "android"] ??
      selectedDeviceMap.android ??
      selectedDeviceMap.ios ??
      null;
    if (fallbackDevice) {
      metadata.selectedDevice = fallbackDevice;
    } else {
      delete metadata.selectedDevice;
    }
  } else {
    delete metadata.selectedDevices;
    delete metadata.selectedDevice;
  }

  return metadata;
}

function dedupeStringArray(values: Iterable<string>): string[] {
  return Array.from(
    new Set(
      Array.from(values)
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
}

function findProjectIntegration(
  integrations: ControllerProjectIntegration[],
  providerId: string,
): ControllerProjectIntegration | null {
  return (
    integrations.find(
      (entry) => entry.provider.trim().toLowerCase() === providerId.toLowerCase(),
    ) ?? null
  );
}

export function getProjectProviderFamilyId(providerId: string | null | undefined) {
  return resolveExtensionFamilyId(providerId);
}

export function isProjectProviderFamilyDefault(
  integration: ControllerProjectIntegration | null | undefined,
) {
  const metadata = isRecord(integration?.metadata) ? integration.metadata : {};
  return metadata.defaultForFamily === true;
}

export function getProjectProviderFamilyPreferredProviderId(
  integration: ControllerProjectIntegration | null | undefined,
) {
  return getProjectProviderFamilySelection(integration)?.preferredProviderId ?? null;
}

export function isProjectProviderFamilyPreferred(
  integration: ControllerProjectIntegration | null | undefined,
) {
  if (!integration) {
    return false;
  }
  return (
    getProjectProviderFamilyPreferredProviderId(integration) ===
    integration.provider.trim().toLowerCase()
  );
}

export function withProjectProviderFamilyDefault(
  metadataValue: Record<string, unknown> | null | undefined,
  isDefault: boolean,
): Record<string, unknown> {
  const metadata = isRecord(metadataValue) ? { ...metadataValue } : {};
  if (isDefault) {
    metadata.defaultForFamily = true;
  } else {
    delete metadata.defaultForFamily;
  }
  return metadata;
}

export function withProjectProviderFamilyPreferredProvider(
  metadataValue: Record<string, unknown> | null | undefined,
  providerId: string | null | undefined,
  options?: {
    familyId?: string | null;
    selectedDevice?: ProjectProviderSelectedDevice | ProjectProviderSelectedDeviceInput | null;
    nowIso?: string;
  },
): Record<string, unknown> {
  const metadata = isRecord(metadataValue) ? { ...metadataValue } : {};
  const normalizedProviderId = typeof providerId === "string" ? providerId.trim().toLowerCase() : "";
  const familyId =
    (typeof options?.familyId === "string" ? options.familyId.trim().toLowerCase() : "") ||
    getProjectProviderFamilyId(normalizedProviderId);
  const explicitSelectedDevice = normalizeProjectProviderSelectedDevice(options?.selectedDevice);
  const existingSelection = normalizeProjectProviderFamilySelection(
    metadata.providerFamilySelection,
    familyId,
  );
  const nowIso =
    typeof options?.nowIso === "string" && options.nowIso.trim().length > 0
      ? options.nowIso.trim()
      : new Date().toISOString();
  if (normalizedProviderId) {
    metadata.preferredProviderId = normalizedProviderId;
    if (familyId) {
      metadata.providerFamilySelection = {
        familyId,
        preferredProviderId: normalizedProviderId,
        preferredDevice:
          explicitSelectedDevice ??
          (existingSelection?.preferredProviderId === normalizedProviderId
            ? existingSelection.preferredDevice
            : null),
        updatedAt: nowIso,
      };
    }
  } else {
    delete metadata.preferredProviderId;
    delete metadata.providerFamilySelection;
  }
  return metadata;
}

export function formatProjectProviderSelectedDeviceLabel(
  selectedDevice: ProjectProviderSelectedDevice | null,
) {
  if (!selectedDevice) {
    return "another device";
  }
  const name = selectedDevice.name?.trim();
  const address = selectedDevice.address?.trim() || selectedDevice.identifier.trim();
  if (name && address) {
    return `${name} (${address})`;
  }
  return name || address || "another device";
}

function parseTimestamp(value: string | null | undefined) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function getProjectProviderRecencyScore(
  integration: ControllerProjectIntegration,
) {
  const selectedDevice = getProjectProviderSelectedDevice(integration);
  return Math.max(
    parseTimestamp(selectedDevice?.lastConnectedAt),
    parseTimestamp(selectedDevice?.savedAt),
    parseTimestamp(integration.updatedAt),
    parseTimestamp(integration.createdAt),
  );
}

function compareProjectProviderFamilySelections(
  left: ProjectProviderFamilySelection,
  right: ProjectProviderFamilySelection,
) {
  return (
    parseTimestamp(right.updatedAt) - parseTimestamp(left.updatedAt) ||
    right.preferredProviderId.localeCompare(left.preferredProviderId)
  );
}

function resolveProjectProviderFamilySelection(
  integrations: ControllerProjectIntegration[],
  familyId: string,
): ProjectProviderFamilySelection | null {
  const familyIntegrations = integrations.filter(
    (integration) => getProjectProviderFamilyId(integration.provider) === familyId,
  );
  if (familyIntegrations.length === 0) {
    return null;
  }

  const attachedFamilyIntegrations = familyIntegrations.filter((integration) =>
    isProjectIntegrationAttached(integration),
  );
  const selectionCandidates = familyIntegrations
    .map((integration) => getProjectProviderFamilySelection(integration))
    .filter((selection): selection is ProjectProviderFamilySelection => Boolean(selection))
    .map((selection) => {
      const matchingIntegration =
        familyIntegrations.find(
          (integration) =>
            integration.provider.trim().toLowerCase() === selection.preferredProviderId,
        ) ?? null;
      if (!matchingIntegration) {
        return null;
      }
      return {
        ...selection,
        preferredDevice:
          selection.preferredDevice ?? getProjectProviderStoredSelectedDevice(matchingIntegration),
      };
    })
    .filter((selection): selection is ProjectProviderFamilySelection => Boolean(selection))
    .sort(compareProjectProviderFamilySelections);

  if (selectionCandidates.length > 0) {
    return selectionCandidates[0] ?? null;
  }

  for (const integration of familyIntegrations) {
    const metadata = isRecord(integration.metadata) ? integration.metadata : {};
    const preferredProviderId =
      typeof metadata.preferredProviderId === "string"
        ? metadata.preferredProviderId.trim().toLowerCase()
        : "";
    if (!preferredProviderId) {
      continue;
    }
    const matchingIntegration =
      familyIntegrations.find(
        (candidate) =>
          candidate.provider.trim().toLowerCase() === preferredProviderId,
      ) ?? null;
    if (!matchingIntegration) {
      continue;
    }
    return {
      familyId,
      preferredProviderId,
      preferredDevice: getProjectProviderStoredSelectedDevice(matchingIntegration),
      updatedAt:
        typeof integration.updatedAt === "string" && integration.updatedAt.trim().length > 0
          ? integration.updatedAt.trim()
          : null,
    };
  }

  const fallbackIntegration =
    [...attachedFamilyIntegrations].sort((left, right) => {
      const leftDefault = isProjectProviderFamilyDefault(left) ? 1 : 0;
      const rightDefault = isProjectProviderFamilyDefault(right) ? 1 : 0;
      if (leftDefault !== rightDefault) {
        return rightDefault - leftDefault;
      }
      const recencyDelta =
        getProjectProviderRecencyScore(right) - getProjectProviderRecencyScore(left);
      if (recencyDelta !== 0) {
        return recencyDelta;
      }
      return left.provider.localeCompare(right.provider);
    })[0] ?? null;

  if (!fallbackIntegration) {
    return null;
  }

  return {
    familyId,
    preferredProviderId: fallbackIntegration.provider.trim().toLowerCase(),
    preferredDevice: getProjectProviderStoredSelectedDevice(fallbackIntegration),
    updatedAt:
      typeof fallbackIntegration.updatedAt === "string" &&
      fallbackIntegration.updatedAt.trim().length > 0
        ? fallbackIntegration.updatedAt.trim()
        : null,
  };
}

function resolveFamilyPreferredProviderId(
  integrations: ControllerProjectIntegration[],
  familyId: string,
) {
  return resolveProjectProviderFamilySelection(integrations, familyId)?.preferredProviderId ?? null;
}

function providerIsDiscoverable(provider: LocalProviderSummary): boolean {
  return provider.discoverable !== false;
}

export async function resolveProjectProviderAccess(
  options: ResolveProjectProviderAccessOptions,
  listProjectIntegrations: ListProjectIntegrationsLoader = controllerClient.integrations.listForProject,
): Promise<ProjectProviderAccessResolution> {
  const providerId = options.providerId.trim();
  const assistantHandle = options.assistantHandle.trim().toLowerCase();
  const projectId = options.projectId?.trim();
  const capabilityId = options.capabilityId?.trim() ?? "";

  if (!providerId || !assistantHandle || !projectId) {
    return {
      providerId,
      allowed: true,
      source: "unscoped_local_runtime",
      reason: projectId ? "Missing provider or assistant context." : "No active project scope.",
    };
  }

  const result = await listProjectIntegrations(projectId).catch((error: unknown) => ({
    success: false,
    integrations: [],
    error: error instanceof Error ? error.message : String(error),
  }));
  if (!result.success) {
    return {
      providerId,
      allowed: false,
      source: "project_policy_unavailable",
      reason:
        result.error?.trim().length
          ? `Unable to verify project provider policy for ${providerId}: ${result.error}`
          : `Unable to verify project provider policy for ${providerId}.`,
    };
  }

  const integration = findProjectIntegration(result.integrations, providerId);
  if (!integration) {
    return {
      providerId,
      allowed: false,
      source: "project_integration_denied",
      reason: `Provider ${providerId} is not attached to this project.`,
    };
  }

  const status = integration.status.trim().toLowerCase();
  const metadata = isRecord(integration.metadata) ? integration.metadata : {};
  const allowList = normalizeAssistantHandleAllowList(metadata);
  const hasCapabilityConstraint =
    capabilityId.length > 0 && integration.capabilities.length > 0;
  const attached =
    ATTACHED_PROJECT_INTEGRATION_STATUSES.has(status) &&
    metadata.attached !== false &&
    metadata.enabled !== false;
  const handleAllowed = allowList.length === 0 || allowList.includes(assistantHandle);
  const capabilityAllowed =
    !hasCapabilityConstraint || integration.capabilities.includes(capabilityId);

  if (attached && handleAllowed && capabilityAllowed) {
    return {
      providerId,
      allowed: true,
      source: "project_integration",
      integrationId: integration.id,
      status,
    };
  }

  const reason = !attached
    ? `Provider ${providerId} is not attached to this project.`
    : !handleAllowed
      ? `Assistant ${assistantHandle} is not allowed to use provider ${providerId} in this project.`
      : `Provider ${providerId} is not attached with capability ${capabilityId}.`;

  return {
    providerId,
    allowed: false,
    source: "project_integration_denied",
    integrationId: integration.id,
    status,
    reason,
  };
}

export async function resolveProjectCapabilityProviderAccess(
  options: Omit<ResolveProjectProviderAccessOptions, "providerId"> & {
    providerId?: string | null;
  },
  listProjectIntegrations: ListProjectIntegrationsLoader = controllerClient.integrations.listForProject,
  listProviders: ListLocalProvidersLoader = listLocalProviders,
): Promise<ProjectCapabilityProviderAccessResolution> {
  const requestedProviderId = options.providerId?.trim() ?? "";
  const capabilityId = options.capabilityId?.trim() ?? "";
  const requestedNativeFallbackProvider = requestedProviderId
    ? await resolveCurrentClientNativeRuntimeProvider(requestedProviderId)
    : null;
  const capabilityNativeFallbackProvider = !requestedProviderId
    ? await resolveCurrentClientNativeRuntimeProviderForCapability(capabilityId)
    : null;

  const discoveredProvidersResult = await listProviders()
    .then((result) => ({
      providers: result.providers ?? [],
      error: null,
    }))
    .catch((error: unknown) => ({
      providers: [] as LocalProviderSummary[],
      error: error instanceof Error ? error.message : String(error),
    }));

  const discoveredProviders = discoveredProvidersResult.providers.filter((provider) =>
    providerIsDiscoverable(provider) &&
    (requestedProviderId
      ? provider.id.trim().toLowerCase() === requestedProviderId.toLowerCase()
      : providerSupportsCapability(provider, capabilityId)),
  );

  if (!options.projectId?.trim()) {
    const provider = discoveredProviders[0] ?? requestedNativeFallbackProvider ?? capabilityNativeFallbackProvider;
    if (provider) {
      return {
        providerId: provider.id,
        provider,
        allowed: true,
        source: "unscoped_local_runtime",
        reason: "No active project scope.",
      };
    }
    return {
      providerId: requestedProviderId || capabilityId,
      provider: null,
      allowed: false,
      source: "project_policy_unavailable",
      reason:
        discoveredProvidersResult.error?.trim().length
          ? `Unable to discover a local provider for capability ${capabilityId}: ${discoveredProvidersResult.error}`
          : `No discoverable local provider currently advertises capability ${capabilityId}.`,
    };
  }

  const projectId = options.projectId.trim();
  const integrationsResult = await listProjectIntegrations(projectId).catch((error: unknown) => ({
    success: false,
    integrations: [] as ControllerProjectIntegration[],
    error: error instanceof Error ? error.message : String(error),
  }));

  if (!integrationsResult.success) {
    return {
      providerId: requestedProviderId || discoveredProviders[0]?.id || capabilityId,
      provider: null,
      allowed: false,
      source: "project_policy_unavailable",
      reason:
        integrationsResult.error?.trim().length
          ? `Unable to verify project provider policy for capability ${capabilityId}: ${integrationsResult.error}`
          : `Unable to verify project provider policy for capability ${capabilityId}.`,
    };
  }

  const attachedCandidates = integrationsResult.integrations.filter((integration) => {
    if (requestedProviderId && integration.provider.trim().toLowerCase() !== requestedProviderId.toLowerCase()) {
      return false;
    }
    if (capabilityId && integration.capabilities.length > 0 && !integration.capabilities.includes(capabilityId)) {
      return false;
    }
    return isProjectIntegrationAttached(integration);
  });

  const discoveredProviderIds = new Set(
    discoveredProviders.map((provider) => provider.id.trim().toLowerCase()),
  );
  const relevantNativeRuntimeFamilyIds = Array.from(
    new Set(
      [
        ...attachedCandidates.map((integration) => getProjectProviderFamilyId(integration.provider)),
        getProjectProviderFamilyId(requestedProviderId),
        getProjectProviderFamilyId(capabilityNativeFallbackProvider?.id),
      ].filter((familyId): familyId is string => typeof familyId === "string" && familyId.length > 0),
    ),
  );
  const currentNativeProviderIds = new Set(
    (
      await Promise.all(
        relevantNativeRuntimeFamilyIds.map((familyId) =>
          resolveCurrentClientNativeRuntimeProviderId(familyId),
        ),
      )
    ).filter((providerId): providerId is string => typeof providerId === "string" && providerId.length > 0),
  );
  const sortedAttachedCandidates = [...attachedCandidates].sort((left, right) => {
    const familyId = getProjectProviderFamilyId(left.provider) ?? left.provider;
    const familyPreferredProviderId = resolveFamilyPreferredProviderId(attachedCandidates, familyId);
    const leftMatchesPreferred =
      familyPreferredProviderId &&
      left.provider.trim().toLowerCase() === familyPreferredProviderId
        ? 1
        : 0;
    const rightMatchesPreferred =
      familyPreferredProviderId &&
      right.provider.trim().toLowerCase() === familyPreferredProviderId
        ? 1
        : 0;
    if (leftMatchesPreferred !== rightMatchesPreferred) {
      return rightMatchesPreferred - leftMatchesPreferred;
    }

    const leftDefault = isProjectProviderFamilyDefault(left) ? 1 : 0;
    const rightDefault = isProjectProviderFamilyDefault(right) ? 1 : 0;
    if (leftDefault !== rightDefault) {
      return rightDefault - leftDefault;
    }

    const leftMatchesCurrent = currentNativeProviderIds.has(left.provider.trim().toLowerCase()) ? 1 : 0;
    const rightMatchesCurrent = currentNativeProviderIds.has(right.provider.trim().toLowerCase()) ? 1 : 0;
    if (leftMatchesCurrent !== rightMatchesCurrent) {
      return rightMatchesCurrent - leftMatchesCurrent;
    }

    const leftDiscoverable = discoveredProviderIds.has(left.provider.trim().toLowerCase()) ? 1 : 0;
    const rightDiscoverable = discoveredProviderIds.has(right.provider.trim().toLowerCase()) ? 1 : 0;
    if (leftDiscoverable !== rightDiscoverable) {
      return rightDiscoverable - leftDiscoverable;
    }

    const recencyDelta =
      getProjectProviderRecencyScore(right) - getProjectProviderRecencyScore(left);
    if (recencyDelta !== 0) {
      return recencyDelta;
    }

    return left.provider.localeCompare(right.provider);
  });
  const preferredAttachedIntegration = sortedAttachedCandidates[0] ?? null;
  const discoveredAttachedProvider = preferredAttachedIntegration
    ? discoveredProviders.find(
        (provider) =>
          provider.id.trim().toLowerCase() ===
          preferredAttachedIntegration.provider.trim().toLowerCase(),
      ) ?? null
    : null;

  if (discoveredAttachedProvider) {
    const access = await resolveProjectProviderAccess(
      {
        ...options,
        providerId: discoveredAttachedProvider.id,
      },
      listProjectIntegrations,
    );
    return {
      ...access,
      provider: discoveredAttachedProvider,
    };
  }

  const undiscoveredAttachedProvider = preferredAttachedIntegration;
  if (undiscoveredAttachedProvider) {
    const nativeFallbackProvider = await resolveCurrentClientNativeRuntimeProvider(
      undiscoveredAttachedProvider.provider,
    );
    if (
      nativeFallbackProvider &&
      (!capabilityId || providerSupportsCapability(nativeFallbackProvider, capabilityId))
    ) {
      const access = await resolveProjectProviderAccess(
        {
          ...options,
          providerId: undiscoveredAttachedProvider.provider,
        },
        listProjectIntegrations,
      );
      return {
        ...access,
        provider: nativeFallbackProvider,
      };
    }

    const selectedDevice = getProjectProviderStoredSelectedDevice(undiscoveredAttachedProvider);
    const attachedOnOtherDevice =
      undiscoveredAttachedProvider.connectionType.trim().toLowerCase() === "native_runtime" &&
      selectedDevice !== null;

    if (
      attachedOnOtherDevice &&
      providerSupportsRemoteNativeExtension(undiscoveredAttachedProvider.provider)
    ) {
      return {
        providerId: undiscoveredAttachedProvider.provider,
        provider: null,
        allowed: true,
        source: "project_integration",
        integrationId: undiscoveredAttachedProvider.id,
        status: undiscoveredAttachedProvider.status,
        reason: `Provider ${undiscoveredAttachedProvider.provider} is attached on ${formatProjectProviderSelectedDeviceLabel(
          selectedDevice,
        )} and can be reached remotely while that device keeps this space open in Instafy.`,
      };
    }

    return {
      unavailableReason: attachedOnOtherDevice ? "attached_on_other_device" : "not_discoverable",
      providerId: undiscoveredAttachedProvider.provider,
      provider: null,
      allowed: false,
      source: "project_policy_unavailable",
      integrationId: undiscoveredAttachedProvider.id,
      status: undiscoveredAttachedProvider.status,
      reason: attachedOnOtherDevice
        ? `Provider ${undiscoveredAttachedProvider.provider} is attached on ${formatProjectProviderSelectedDeviceLabel(
            selectedDevice,
          )} and can currently be used only from that device.`
        : `Provider ${undiscoveredAttachedProvider.provider} is attached to this project but is not currently discoverable from the local provider host.`,
    };
  }

  const fallbackProviderId = requestedProviderId || discoveredProviders[0]?.id || capabilityId;
  return {
    providerId: fallbackProviderId,
    provider: discoveredProviders[0] ?? null,
    allowed: false,
    source: "project_integration_denied",
    reason: requestedProviderId
      ? `Provider ${requestedProviderId} is not attached to this project.`
      : `No discoverable provider for capability ${capabilityId} is attached to this project.`,
  };
}

export async function attachProjectProvider(
  options: AttachProjectProviderOptions,
  listProjectIntegrations: ListProjectIntegrationsLoader = controllerClient.integrations.listForProject,
  upsertProjectIntegration: UpsertProjectIntegrationWriter = controllerClient.integrations.upsert,
): Promise<AttachProjectProviderResult> {
  const projectId = options.projectId.trim();
  if (!projectId) {
    return { success: false, error: "Missing project id." };
  }

  const providerId = options.providerId.trim().toLowerCase();
  if (!providerId) {
    return { success: false, error: "Missing provider id." };
  }

  const requestedAssistantHandles = dedupeStringArray([
    options.assistantHandle?.trim().toLowerCase() ?? "",
    ...(options.assistantHandles ?? []).map((entry) => entry.toLowerCase()),
  ]);

  const existingIntegrations = await listProjectIntegrations(projectId).catch((error: unknown) => ({
    success: false,
    integrations: [] as ControllerProjectIntegration[],
    error: error instanceof Error ? error.message : String(error),
  }));

  const existingIntegration = existingIntegrations.success
    ? findProjectIntegration(existingIntegrations.integrations, providerId)
    : null;
  const existingMetadata = isRecord(existingIntegration?.metadata)
    ? existingIntegration.metadata
    : {};
  const providerFamilyId = getProjectProviderFamilyId(providerId) ?? providerId;
  const nowIso = new Date().toISOString();
  const incomingSelectedDevice = normalizeProjectProviderSelectedDevice(options.metadata?.selectedDevice);
  const familySelection = existingIntegrations.success
    ? resolveProjectProviderFamilySelection(existingIntegrations.integrations, providerFamilyId)
    : null;
  const existingAssistantHandles = normalizeAssistantHandleAllowList(existingMetadata);
  const assistantHandles = dedupeStringArray([
    ...existingAssistantHandles,
    ...requestedAssistantHandles,
  ]);
  const capabilities = dedupeStringArray([
    ...(existingIntegration?.capabilities ?? []),
    options.capabilityId?.trim() ?? "",
    ...(options.capabilityIds ?? []).map((entry) => entry.trim()),
  ]) as CapabilityId[];
  const status =
    options.status?.trim() ||
    (existingIntegration &&
    ATTACHED_PROJECT_INTEGRATION_STATUSES.has(existingIntegration.status.trim().toLowerCase())
      ? existingIntegration.status
      : "attached");
  const connectionType =
    options.connectionType?.trim() ||
    existingIntegration?.connectionType.trim() ||
    "local_provider";

  const metadata: Record<string, unknown> = {
    ...existingMetadata,
    ...options.metadata,
    attached: true,
    enabled: true,
    attachedVia: connectionType === "native_runtime" ? "native_runtime" : "local_provider_host",
    updatedAt: nowIso,
  };
  if (assistantHandles.length > 0) {
    metadata.allowedAssistantHandles = assistantHandles;
    metadata.assistantHandles = assistantHandles;
    metadata.allowedAgents = assistantHandles;
  } else {
    delete metadata.allowedAssistantHandles;
    delete metadata.assistantHandles;
    delete metadata.allowedAgents;
  }
  if (typeof metadata.attachedAt !== "string" || metadata.attachedAt.trim().length === 0) {
    metadata.attachedAt = nowIso;
  }
  if (metadata.defaultForFamily === undefined) {
    const otherFamilyDefaultExists =
      existingIntegrations.success &&
      existingIntegrations.integrations.some(
        (integration) =>
          integration.provider.trim().toLowerCase() !== providerId &&
          isProjectIntegrationAttached(integration) &&
          getProjectProviderFamilyId(integration.provider) === providerFamilyId &&
          isProjectProviderFamilyDefault(integration),
      );
    metadata.defaultForFamily =
      isProjectProviderFamilyDefault(existingIntegration) || !otherFamilyDefaultExists;
  }
  if (
    typeof metadata.preferredProviderId !== "string" ||
    metadata.preferredProviderId.trim().length === 0
  ) {
    metadata.preferredProviderId =
      familySelection?.preferredProviderId ||
      (metadata.defaultForFamily === true ? providerId : providerId);
  }

  const preferredProviderId =
    typeof metadata.preferredProviderId === "string"
      ? metadata.preferredProviderId.trim().toLowerCase()
      : providerId;
  metadata.providerFamilySelection = withProjectProviderFamilyPreferredProvider(
    {
      providerFamilySelection: metadata.providerFamilySelection,
      preferredProviderId: metadata.preferredProviderId,
    },
    preferredProviderId,
    {
      familyId: providerFamilyId,
      selectedDevice:
        preferredProviderId === providerId
          ? incomingSelectedDevice ??
            getProjectProviderStoredSelectedDevice(existingIntegration) ??
            familySelection?.preferredDevice ??
            null
          : familySelection?.preferredDevice ?? null,
      nowIso,
    },
  ).providerFamilySelection;

  const result = await upsertProjectIntegration(projectId, providerId, {
    status,
    connectionType,
    credentialId: existingIntegration?.credentialId ?? null,
    metadata,
    requiredScopes: existingIntegration?.requiredScopes ?? [],
    capabilities,
  }).catch((error: unknown) => ({
    success: false,
    integration: undefined,
    error: error instanceof Error ? error.message : String(error),
  }));

  if (!result.success || !result.integration) {
    return {
      success: false,
      error: result.error ?? `Unable to attach provider ${providerId} to project.`,
    };
  }

  return {
    success: true,
    integration: result.integration,
  };
}

export async function detachProjectProvider(
  options: Pick<AttachProjectProviderOptions, "projectId" | "providerId" | "connectionType" | "metadata">,
  listProjectIntegrations: ListProjectIntegrationsLoader = controllerClient.integrations.listForProject,
  upsertProjectIntegration: UpsertProjectIntegrationWriter = controllerClient.integrations.upsert,
): Promise<AttachProjectProviderResult> {
  const projectId = options.projectId.trim();
  if (!projectId) {
    return { success: false, error: "Missing project id." };
  }

  const providerId = options.providerId.trim().toLowerCase();
  if (!providerId) {
    return { success: false, error: "Missing provider id." };
  }

  const existingIntegrations = await listProjectIntegrations(projectId).catch((error: unknown) => ({
    success: false,
    integrations: [] as ControllerProjectIntegration[],
    error: error instanceof Error ? error.message : String(error),
  }));
  const existingIntegration = existingIntegrations.success
    ? findProjectIntegration(existingIntegrations.integrations, providerId)
    : null;
  const existingMetadata = isRecord(existingIntegration?.metadata)
    ? existingIntegration.metadata
    : {};
  const nowIso = new Date().toISOString();
  const providerFamilyId = getProjectProviderFamilyId(providerId) ?? providerId;
  const remainingAttachedFamilyIntegrations = existingIntegrations.success
    ? existingIntegrations.integrations.filter(
        (integration) =>
          integration.provider.trim().toLowerCase() !== providerId &&
          isProjectIntegrationAttached(integration) &&
          getProjectProviderFamilyId(integration.provider) === providerFamilyId,
      )
    : [];
  const nextFamilySelection =
    remainingAttachedFamilyIntegrations.length > 0
      ? resolveProjectProviderFamilySelection(remainingAttachedFamilyIntegrations, providerFamilyId)
      : null;
  const nextPreferredProviderId = nextFamilySelection?.preferredProviderId ?? null;

  if (existingIntegrations.success && remainingAttachedFamilyIntegrations.length > 0) {
    await Promise.all(
      remainingAttachedFamilyIntegrations.map((integration) =>
        upsertProjectIntegration(projectId, integration.provider, {
          status: integration.status,
          connectionType: integration.connectionType,
          credentialId: integration.credentialId,
          metadata: withProjectProviderFamilyPreferredProvider(
            withProjectProviderFamilyDefault(
              integration.metadata,
              integration.provider.trim().toLowerCase() === nextPreferredProviderId,
            ),
            nextPreferredProviderId,
            {
              familyId: providerFamilyId,
              selectedDevice:
                integration.provider.trim().toLowerCase() === nextPreferredProviderId
                  ? nextFamilySelection?.preferredDevice ?? getProjectProviderStoredSelectedDevice(integration)
                  : nextFamilySelection?.preferredDevice ?? null,
              nowIso,
            },
          ),
          requiredScopes: integration.requiredScopes,
          capabilities: integration.capabilities,
        }),
      ),
    );
  }

  const result = await upsertProjectIntegration(projectId, providerId, {
    status: "available",
    connectionType:
      options.connectionType?.trim() ||
      existingIntegration?.connectionType.trim() ||
      "local_provider",
    credentialId: existingIntegration?.credentialId ?? null,
    metadata: {
      ...existingMetadata,
      ...options.metadata,
      attached: false,
      enabled: false,
      defaultForFamily: false,
      detachedAt: nowIso,
      updatedAt: nowIso,
      ...withProjectProviderFamilyPreferredProvider(
        {},
        nextPreferredProviderId,
        {
          familyId: providerFamilyId,
          selectedDevice: nextFamilySelection?.preferredDevice ?? null,
          nowIso,
        },
      ),
    },
    requiredScopes: existingIntegration?.requiredScopes ?? [],
    capabilities: existingIntegration?.capabilities ?? [],
  }).catch((error: unknown) => ({
    success: false,
    integration: undefined,
    error: error instanceof Error ? error.message : String(error),
  }));

  if (!result.success || !result.integration) {
    return {
      success: false,
      error: result.error ?? `Unable to detach provider ${providerId} from project.`,
    };
  }

  return {
    success: true,
    integration: result.integration,
  };
}
