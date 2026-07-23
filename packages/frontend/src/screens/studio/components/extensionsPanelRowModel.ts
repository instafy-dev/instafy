import type { CapabilityId } from "@instafy/sdk/capabilities";
import type { ProjectProviderCameraState } from "../../../camera/cameraProjectState";
import type { CameraStatusSnapshot } from "../../../camera/types";
import type { ProjectProviderSelectedDevice } from "../../../capabilities/projectProviderAccess";
import {
  formatProjectProviderSelectedDeviceLabel,
  isProjectProviderFamilyPreferred,
} from "../../../capabilities/projectProviderAccess";
import type { LocalProviderSummary } from "../../../capabilities/localProviderHostClient";
import { listBuiltInAssistantDefinitions } from "../../../assistants/localBuiltInAssistantCatalog";
import {
  formatExtensionKindLabel,
  resolveExtensionDefinition,
  type ExtensionDefinition,
} from "../../../extensions/extensionCatalog";
import {
  type CameraExtensionAttachedDeviceItem,
  type CameraExtensionRemotePresentation,
} from "../../../extensions/cameraExtensionFamilyPresentation";
import {
  buildExtensionFamilyRowSupport,
  type ExtensionFamilyRowSupport,
} from "../../../extensions/extensionFamilyRowSupport";
import { resolveNativeExtensionRegistration } from "../../../extensions/nativeExtensionRegistry";
import {
  resolveExtensionRowPresentation,
  type ExtensionRowPresentation,
} from "../../../extensions/extensionRowPresentation";
import type { ControllerProjectIntegration } from "../../../services/runtimeController/integrations";
import type { ControllerProviderRequestRecord } from "../../../services/runtimeController";
import type { ControllerProviderDeviceRecord } from "../../../services/runtimeController/providerDevices";
import type { NativeExtensionStatusValue } from "../../../extensions/nativeExtensionTypes";

type CheckedStatus<T> = {
  status: T | null;
  checkedAt: string | null;
};

export type ProjectExtensionEntry = {
  provider: LocalProviderSummary;
  source: "host" | "project_integration" | "native_runtime";
  integration: ControllerProjectIntegration | null;
  mutationProviderId: string;
  discoverable: boolean;
  attached: boolean;
  selectedDevice: ProjectProviderSelectedDevice | null;
  cameraState: ProjectProviderCameraState;
  assistantDefinitions: ReturnType<typeof listBuiltInAssistantDefinitions>;
  capabilityIds: CapabilityId[];
  providerCapabilityIds: CapabilityId[];
  attachedCapabilityIds: CapabilityId[];
};

export type ExtensionsPanelRowModel = {
  entry: ProjectExtensionEntry;
  isPending: boolean;
  extension: ExtensionDefinition;
  providerLabel: string;
  connectionType: string;
  eligibleAssistantLabel: string;
  discoveredCapabilityLabel: string;
  projectCapabilityLabel: string;
  nativeExtension: ReturnType<typeof resolveNativeExtensionRegistration> | null;
  attachedRemoteOnly: boolean;
  savedNativeStateLabel: string | null;
  kindLabel: string | null;
  hasNativeSetup: boolean;
  remoteCameraPresentation: CameraExtensionRemotePresentation | null;
  remoteCameraDevice: ControllerProviderDeviceRecord | null;
  attachedFamilyCount: number;
  isFamilyDefault: boolean;
  rowPresentation: ExtensionRowPresentation;
  attachedRemoteOnlySummary: string | null;
  nativeCameraAttachMetadata: ExtensionFamilyRowSupport["nativeCameraAttachMetadata"];
  familyCameraDeviceItems: CameraExtensionAttachedDeviceItem[];
  runtimeStatus: NativeExtensionStatusValue;
  runtimeStatusCheckedAt: string | null;
  auxiliaryStatus: NativeExtensionStatusValue;
  auxiliaryStatusCheckedAt: string | null;
  cameraLiveStatus: CameraStatusSnapshot | null;
  cameraLiveCheckedAt: string | null;
  refreshNativeCameraStatus: boolean;
};

type BuildExtensionsPanelRowModelInput = {
  entry: ProjectExtensionEntry;
  activeProjectName?: string | null;
  isPending: boolean;
  showDeveloperDetails: boolean;
  expanded: boolean;
  currentNativeCameraStatus: CameraStatusSnapshot | null;
  nativeRuntimeStatusByProvider: Record<
    string,
    CheckedStatus<NativeExtensionStatusValue>
  >;
  nativeAuxiliaryStatusByProvider: Record<string, CheckedStatus<NativeExtensionStatusValue>>;
  nativeCameraHealthStateByProvider: Record<string, CheckedStatus<CameraStatusSnapshot>>;
  remoteCameraRequestsByProvider: Record<string, ControllerProviderRequestRecord[]>;
  remoteCameraDevicesByProvider: Record<string, ControllerProviderDeviceRecord>;
  attachedExtensionFamilyCounts: Map<string, number>;
  cameraAttachedDeviceItems: CameraExtensionAttachedDeviceItem[];
  hasProviderHostSurface: boolean;
};

function hasNativeExtensionSetup(entry: ProjectExtensionEntry) {
  if (entry.source !== "native_runtime") {
    return false;
  }
  return (
    resolveNativeExtensionRegistration({
      provider: entry.provider,
      capabilityIds: entry.capabilityIds,
      integrationProviderId: entry.integration?.provider ?? entry.provider.id,
    }) !== null
  );
}

function resolveExtensionConnectionType(
  source: "host" | "project_integration" | "native_runtime",
  integration: ControllerProjectIntegration | null,
) {
  if (source === "native_runtime") {
    return "native_runtime";
  }
  return integration?.connectionType?.trim() || "local_provider";
}

export function buildExtensionsPanelRowModel(
  input: BuildExtensionsPanelRowModelInput,
): ExtensionsPanelRowModel {
  const entry = input.entry;
  const extension = resolveExtensionDefinition({
    provider: entry.provider,
    capabilityIds: entry.capabilityIds,
    integrationProviderId: entry.integration?.provider ?? entry.provider.id,
  });
  const providerLabel = extension.title;
  const connectionType = resolveExtensionConnectionType(entry.source, entry.integration);
  const eligibleAssistantLabel =
    entry.assistantDefinitions.length > 0
      ? entry.assistantDefinitions.map((assistant) => assistant.mentionToken).join(", ")
      : "None yet";
  const discoveredCapabilityLabel =
    entry.providerCapabilityIds.length > 0
      ? entry.providerCapabilityIds.join(", ")
      : "Capability ids unavailable";
  const projectCapabilityLabel =
    entry.attachedCapabilityIds.length > 0
      ? entry.attachedCapabilityIds.join(", ")
      : "No project capability scope recorded yet";
  const nativeExtension = resolveNativeExtensionRegistration({
    provider: entry.provider,
    capabilityIds: entry.capabilityIds,
    integrationProviderId: entry.integration?.provider ?? entry.provider.id,
  });
  const savedNativeStateLabel =
    nativeExtension?.formatSavedStateLabel({
      selectedDevice: entry.selectedDevice,
      cameraState: entry.cameraState,
    }) ?? null;
  const kindLabel = formatExtensionKindLabel(extension.kind);
  const hasNativeSetup = hasNativeExtensionSetup(entry);
  const runtimeStatus =
    input.nativeRuntimeStatusByProvider[entry.provider.id]?.status ?? null;
  const runtimeStatusCheckedAt =
    input.nativeRuntimeStatusByProvider[entry.provider.id]?.checkedAt ?? null;
  const auxiliaryStatus =
    input.nativeAuxiliaryStatusByProvider[entry.provider.id]?.status ?? null;
  const auxiliaryStatusCheckedAt =
    input.nativeAuxiliaryStatusByProvider[entry.provider.id]?.checkedAt ?? null;
  const cameraLiveStatus =
    input.nativeCameraHealthStateByProvider[entry.provider.id]?.status ?? null;
  const cameraLiveCheckedAt =
    input.nativeCameraHealthStateByProvider[entry.provider.id]?.checkedAt ?? null;
  const familyRowSupport = buildExtensionFamilyRowSupport({
    providerId: entry.provider.id,
    mutationProviderId: entry.mutationProviderId,
    source: entry.source,
    integration: entry.integration,
    attached: entry.attached,
    discoverable: entry.discoverable,
    selectedDevice: entry.selectedDevice,
    currentNativeCameraStatus: input.currentNativeCameraStatus,
    remoteCameraRequestsByProvider: input.remoteCameraRequestsByProvider,
    remoteCameraDevicesByProvider: input.remoteCameraDevicesByProvider,
    attachedExtensionFamilyCounts: input.attachedExtensionFamilyCounts,
    cameraAttachedDeviceItems: input.cameraAttachedDeviceItems,
  });
  const {
    attachedRemoteOnly,
    remoteCameraPresentation,
    attachedFamilyCount,
    attachedRemoteOnlySummary,
    remoteCameraDevice,
    nativeCameraAttachMetadata,
    familyCameraDeviceItems,
  } = familyRowSupport;
  const isFamilyDefault =
    entry.attached && isProjectProviderFamilyPreferred(entry.integration);
  const selectedDeviceLabel =
    entry.selectedDevice?.name?.trim() ||
    formatProjectProviderSelectedDeviceLabel(entry.selectedDevice);
  const nativeSetupSummary =
    entry.source !== "host"
      ? nativeExtension?.summarize({
          attached: entry.attached,
          selectedDevice: entry.selectedDevice,
          cameraState: entry.cameraState,
          runtimeStatus,
          auxiliaryStatus,
          cameraLiveStatus,
        })
      : null;
  const needsSetup = nativeSetupSummary?.tone === "warning";
  const rowPresentation = resolveExtensionRowPresentation({
    attached: entry.attached,
    discoverable: entry.discoverable,
    discoveryError: entry.provider.error ?? null,
    source: entry.source,
    isPending: input.isPending,
    activeRequestState: remoteCameraPresentation?.requestSummary?.requestState ?? null,
    needsSetup,
    attachedRemoteOnly,
    remoteStatus: remoteCameraPresentation?.remoteStatus ?? null,
    scopeLabel: input.activeProjectName,
    providerId: entry.mutationProviderId,
    providerTitle: extension.title,
    attachedFamilyCount,
    remoteDeviceLabel: remoteCameraPresentation?.deviceDetails?.label ?? null,
    selectedDeviceLabel,
    nativeExtension,
    hasNativeSetup,
    hasProviderHostSurface: input.hasProviderHostSurface,
    showDeveloperDetails: input.showDeveloperDetails,
    integrationPresent: Boolean(entry.integration),
    kindLabel,
    savedNativeStateLabel,
    expanded: input.expanded,
  });

  return {
    entry,
    isPending: input.isPending,
    extension,
    providerLabel,
    connectionType,
    eligibleAssistantLabel,
    discoveredCapabilityLabel,
    projectCapabilityLabel,
    nativeExtension,
    attachedRemoteOnly,
    savedNativeStateLabel,
    kindLabel,
    hasNativeSetup,
    remoteCameraPresentation,
    remoteCameraDevice,
    attachedFamilyCount,
    isFamilyDefault,
    rowPresentation,
    attachedRemoteOnlySummary,
    nativeCameraAttachMetadata,
    familyCameraDeviceItems,
    runtimeStatus,
    runtimeStatusCheckedAt,
    auxiliaryStatus,
    auxiliaryStatusCheckedAt,
    cameraLiveStatus,
    cameraLiveCheckedAt,
    refreshNativeCameraStatus:
      entry.source === "native_runtime" || entry.source === "project_integration",
  };
}
