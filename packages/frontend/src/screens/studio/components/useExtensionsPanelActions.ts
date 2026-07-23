import { useMemo } from "react";
import type { CapabilityId } from "@instafy/sdk/capabilities";
import type { StatusContextValue } from "../../../status/StatusProvider";
import { controllerClient } from "../../../sdk/instafy";
import type { LocalProviderSummary } from "../../../capabilities/localProviderHostClient";
import {
  attachProjectProvider,
  detachProjectProvider,
  formatProjectProviderSelectedDeviceLabel,
  getProjectProviderFamilyId,
  isProjectIntegrationAttached,
  withProjectProviderFamilyDefault,
  withProjectProviderFamilyPreferredProvider,
  withProjectProviderSelectedDevice,
  withoutProjectProviderSelectedDevice,
} from "../../../capabilities/projectProviderAccess";
import { withProjectProviderCameraState } from "../../../camera/cameraProjectState";
import type { CameraCaptureMetadata, CameraStatusSnapshot } from "../../../camera/types";
import { resolveExtensionDefinition } from "../../../extensions/extensionCatalog";
import { resolveNativeExtensionRegistration } from "../../../extensions/nativeExtensionRegistry";
import type { NativeExtensionStatusValue } from "../../../extensions/nativeExtensionTypes";
import type { ControllerProjectIntegration } from "../../../services/runtimeController/integrations";
import type { ExtensionsPanelRowModel, ProjectExtensionEntry } from "./extensionsPanelRowModel";

type ShowStatus = StatusContextValue["showStatus"];

type SaveConnectedDeviceInput = {
  transport?: string | null;
  identifier: string;
  address?: string | null;
  name?: string | null;
  nativePlatform?: "android" | "ios" | null;
  lastConnectedAt?: string | null;
};

type PersistCameraStateInput = {
  selectedLens?: CameraCaptureMetadata["lens"] | null;
  lastCapture?: CameraCaptureMetadata | null;
};

type ProviderMutationPendingChange = (providerId: string | null) => void;
type ExpandProviderDetails = (providerId: string) => void;
type UpdateNativeRuntimeStatus = (
  providerId: string,
  status: NativeExtensionStatusValue,
) => void;
type UpdateNativeAuxiliaryStatus = (
  providerId: string,
  status: NativeExtensionStatusValue,
) => void;
type UpdateNativeCameraStatus = (
  providerId: string,
  status: CameraStatusSnapshot | null,
) => void;

export type ExtensionsPanelActionsInput = {
  activeProjectId: string | null;
  activeProjectName: string | null;
  projectExtensions: ProjectExtensionEntry[];
  projectIntegrations: ControllerProjectIntegration[];
  refreshProjectIntegrations: () => Promise<void>;
  showStatus: ShowStatus;
  onProviderMutationPendingChange: ProviderMutationPendingChange;
  expandProviderDetails: ExpandProviderDetails;
  updateNativeRuntimeStatus: UpdateNativeRuntimeStatus;
  updateNativeAuxiliaryStatus: UpdateNativeAuxiliaryStatus;
  updateNativeCameraStatus: UpdateNativeCameraStatus;
};

function formatProviderLabel(provider: LocalProviderSummary) {
  return resolveExtensionDefinition({ provider }).title;
}

export function createExtensionsPanelActionController(input: ExtensionsPanelActionsInput) {
  const handleSetFamilyDefault = async (entry: ProjectExtensionEntry) => {
    const projectId = input.activeProjectId?.trim() ?? "";
    if (!projectId || !entry.integration) {
      input.showStatus("Select a space before changing the default extension device.", "warning", 3000);
      return;
    }

    const familyId = getProjectProviderFamilyId(entry.mutationProviderId) ?? entry.mutationProviderId;
    const siblingIntegrations = input.projectIntegrations.filter(
      (integration) =>
        isProjectIntegrationAttached(integration) &&
        getProjectProviderFamilyId(integration.provider) === familyId,
    );

    input.onProviderMutationPendingChange(entry.provider.id);
    try {
      await Promise.all(
        siblingIntegrations.map((integration) =>
          controllerClient.integrations.upsert(projectId, integration.provider, {
            status: integration.status,
            connectionType: integration.connectionType,
            credentialId: integration.credentialId,
            metadata: withProjectProviderFamilyPreferredProvider(
              withProjectProviderFamilyDefault(
                integration.metadata,
                integration.provider.trim().toLowerCase() === entry.mutationProviderId.trim().toLowerCase(),
              ),
              entry.mutationProviderId,
              {
                familyId,
                selectedDevice: entry.selectedDevice,
              },
            ),
            requiredScopes: integration.requiredScopes,
            capabilities: integration.capabilities,
          }),
        ),
      );
      await input.refreshProjectIntegrations();
      input.showStatus(
        `New ${resolveExtensionDefinition({ integrationProviderId: familyId }).title} requests will prefer ${
          entry.selectedDevice?.name?.trim() || formatProjectProviderSelectedDeviceLabel(entry.selectedDevice)
        }.`,
        "success",
        3000,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to update the default extension device.";
      input.showStatus(message, "error", 4500);
    } finally {
      input.onProviderMutationPendingChange(null);
    }
  };

  const handleAttachExtension = async (
    provider: LocalProviderSummary,
    capabilityIds: CapabilityId[],
    connectionType = "local_provider",
    options?: {
      providerId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<boolean> => {
    const projectId = input.activeProjectId?.trim() ?? "";
    if (!projectId) {
      input.showStatus("Select a space before attaching an extension.", "warning", 3000);
      return false;
    }
    if (capabilityIds.length === 0) {
      input.showStatus(
        `${formatProviderLabel(provider)} does not advertise any usable capability ids yet.`,
        "warning",
        4000,
      );
      return false;
    }

    input.onProviderMutationPendingChange(provider.id);
    try {
      const result = await attachProjectProvider({
        projectId,
        providerId: options?.providerId?.trim() || provider.id,
        connectionType,
        capabilityId: capabilityIds[0] ?? null,
        capabilityIds: capabilityIds.slice(1),
        metadata: {
          attachedFrom: "extensions_panel",
          ...options?.metadata,
        },
      });
      if (!result.success) {
        throw new Error(result.error ?? `Unable to attach ${formatProviderLabel(provider)}.`);
      }
      await input.refreshProjectIntegrations();
      input.showStatus(
        `Attached ${formatProviderLabel(provider)} to ${input.activeProjectName ?? "this space"}.`,
        "success",
        3000,
      );
      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Unable to attach ${formatProviderLabel(provider)}.`;
      input.showStatus(message, "error", 4500);
      return false;
    } finally {
      input.onProviderMutationPendingChange(null);
    }
  };

  const handleAttachEntry = async (entry: ProjectExtensionEntry, rowModel: ExtensionsPanelRowModel) => {
    const attached = await handleAttachExtension(
      entry.provider,
      entry.capabilityIds,
      rowModel.connectionType,
      {
        providerId: entry.mutationProviderId,
        metadata: rowModel.nativeCameraAttachMetadata
          ? {
              selectedDevice: rowModel.nativeCameraAttachMetadata,
            }
          : undefined,
      },
    );
    if (attached && entry.source === "native_runtime" && rowModel.hasNativeSetup) {
      input.expandProviderDetails(entry.provider.id);
    }
    return attached;
  };

  const handleRememberProviderDevice = async (
    provider: LocalProviderSummary,
    providerId: string,
    capabilityIds: CapabilityId[],
    integration: ControllerProjectIntegration | null,
    connectionType: string,
    device: SaveConnectedDeviceInput,
  ) => {
    const projectId = input.activeProjectId?.trim() ?? "";
    if (!projectId) {
      input.showStatus("Select a space before saving extension setup.", "warning", 3000);
      return;
    }

    input.onProviderMutationPendingChange(provider.id);
    try {
      const result = await attachProjectProvider({
        projectId,
        providerId,
        connectionType,
        capabilityId: capabilityIds[0] ?? null,
        capabilityIds: capabilityIds.slice(1),
        metadata: withProjectProviderSelectedDevice(integration?.metadata, {
          transport: device.transport?.trim() || "ble",
          identifier: device.identifier,
          address: device.address ?? device.identifier,
          name: device.name ?? null,
          nativePlatform: device.nativePlatform ?? null,
          connectedAt: device.lastConnectedAt ?? null,
        }),
      });
      if (!result.success) {
        throw new Error(result.error ?? `Unable to save ${formatProviderLabel(provider)} device.`);
      }
      await input.refreshProjectIntegrations();
      input.showStatus(
        `Saved ${device.name?.trim() || device.address || device.identifier} for ${formatProviderLabel(provider)} in ${input.activeProjectName ?? "this space"}.`,
        "success",
        3000,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Unable to save ${formatProviderLabel(provider)} device.`;
      input.showStatus(message, "error", 4500);
      throw error;
    } finally {
      input.onProviderMutationPendingChange(null);
    }
  };

  const handleForgetProviderDevice = async (
    provider: LocalProviderSummary,
    providerId: string,
    capabilityIds: CapabilityId[],
    integration: ControllerProjectIntegration | null,
    connectionType: string,
  ) => {
    const projectId = input.activeProjectId?.trim() ?? "";
    if (!projectId) {
      input.showStatus("Select a space before clearing extension setup.", "warning", 3000);
      return;
    }

    input.onProviderMutationPendingChange(provider.id);
    try {
      const result = await attachProjectProvider({
        projectId,
        providerId,
        connectionType,
        capabilityId: capabilityIds[0] ?? null,
        capabilityIds: capabilityIds.slice(1),
        metadata: withoutProjectProviderSelectedDevice(integration?.metadata),
      });
      if (!result.success) {
        throw new Error(result.error ?? `Unable to clear ${formatProviderLabel(provider)} device setup.`);
      }
      await input.refreshProjectIntegrations();
      input.showStatus(
        `Cleared saved device setup for ${formatProviderLabel(provider)} in ${input.activeProjectName ?? "this space"}.`,
        "info",
        3000,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Unable to clear ${formatProviderLabel(provider)} device setup.`;
      input.showStatus(message, "error", 4500);
      throw error;
    } finally {
      input.onProviderMutationPendingChange(null);
    }
  };

  const handlePersistCameraState = async (
    provider: LocalProviderSummary,
    providerId: string,
    capabilityIds: CapabilityId[],
    integration: ControllerProjectIntegration | null,
    connectionType: string,
    state: PersistCameraStateInput,
  ) => {
    const projectId = input.activeProjectId?.trim() ?? "";
    if (!projectId) {
      input.showStatus("Select a space before saving camera setup.", "warning", 3000);
      return;
    }

    input.onProviderMutationPendingChange(provider.id);
    try {
      const result = await attachProjectProvider({
        projectId,
        providerId,
        connectionType,
        capabilityId: capabilityIds[0] ?? null,
        capabilityIds: capabilityIds.slice(1),
        metadata: withProjectProviderCameraState(integration?.metadata, {
          selectedLens: state.selectedLens,
          lastCapture: state.lastCapture,
        }),
      });
      if (!result.success) {
        throw new Error(result.error ?? `Unable to save ${formatProviderLabel(provider)} setup.`);
      }
      await input.refreshProjectIntegrations();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Unable to save ${formatProviderLabel(provider)} setup.`;
      input.showStatus(message, "error", 4500);
      throw error;
    } finally {
      input.onProviderMutationPendingChange(null);
    }
  };

  const handleRuntimeProbe = async (provider: LocalProviderSummary) => {
    const projectId = input.activeProjectId?.trim() ?? "";
    if (!projectId) {
      throw new Error("Select a space before running a runtime probe.");
    }

    const registration = resolveNativeExtensionRegistration({ provider });
    if (!registration?.runRuntimeProbe) {
      throw new Error(
        `${formatProviderLabel(provider)} does not expose a runtime probe.`,
      );
    }

    const response = await registration.runRuntimeProbe({
      projectId,
      provider,
    });

    input.showStatus(
      `Runtime probe completed for ${formatProviderLabel(provider)}.`,
      "success",
      3000,
    );

    return response;
  };

  const handleDetachExtension = async (
    provider: LocalProviderSummary,
    connectionType = "local_provider",
    providerIdOverride?: string | null,
  ) => {
    const projectId = input.activeProjectId?.trim() ?? "";
    if (!projectId) {
      input.showStatus("Select a space before detaching an extension.", "warning", 3000);
      return;
    }

    input.onProviderMutationPendingChange(provider.id);
    try {
      const result = await detachProjectProvider({
        projectId,
        providerId: providerIdOverride?.trim() || provider.id,
        connectionType,
        metadata: {
          detachedFrom: "extensions_panel",
        },
      });
      if (!result.success) {
        throw new Error(result.error ?? `Unable to detach ${formatProviderLabel(provider)}.`);
      }
      await input.refreshProjectIntegrations();
      input.showStatus(
        `Detached ${formatProviderLabel(provider)} from ${input.activeProjectName ?? "this space"}.`,
        "info",
        3000,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Unable to detach ${formatProviderLabel(provider)}.`;
      input.showStatus(message, "error", 4500);
    } finally {
      input.onProviderMutationPendingChange(null);
    }
  };

  const handleDetachEntry = async (entry: ProjectExtensionEntry, rowModel: ExtensionsPanelRowModel) => {
    await handleDetachExtension(
      entry.provider,
      rowModel.connectionType,
      entry.mutationProviderId,
    );
  };

  const handleRuntimeStatusChange = (
    providerId: string,
    nextStatus: NativeExtensionStatusValue,
  ) => {
    input.updateNativeRuntimeStatus(providerId, nextStatus);
  };

  const handleAuxiliaryStatusChange = (
    providerId: string,
    nextStatus: NativeExtensionStatusValue,
  ) => {
    input.updateNativeAuxiliaryStatus(providerId, nextStatus);
  };

  const handleCameraStatusChange = (providerId: string, nextStatus: CameraStatusSnapshot | null) => {
    input.updateNativeCameraStatus(providerId, nextStatus);
  };

  const handleMakeCameraFamilyDefault = (providerId: string) => {
    const nextDefaultEntry = input.projectExtensions.find(
      (candidate) =>
        candidate.mutationProviderId.trim().toLowerCase() === providerId.trim().toLowerCase(),
    );
    if (nextDefaultEntry) {
      void handleSetFamilyDefault(nextDefaultEntry);
    }
  };

  return {
    handleSetFamilyDefault,
    handleAttachExtension,
    handleAttachEntry,
    handleRememberProviderDevice,
    handleForgetProviderDevice,
    handlePersistCameraState,
    handleRuntimeProbe,
    handleDetachExtension,
    handleDetachEntry,
    handleRuntimeStatusChange,
    handleAuxiliaryStatusChange,
    handleCameraStatusChange,
    handleMakeCameraFamilyDefault,
  };
}

export type ExtensionsPanelActionController = ReturnType<
  typeof createExtensionsPanelActionController
>;

export function useExtensionsPanelActions(input: ExtensionsPanelActionsInput) {
  const {
    activeProjectId,
    activeProjectName,
    expandProviderDetails,
    onProviderMutationPendingChange,
    projectExtensions,
    projectIntegrations,
    refreshProjectIntegrations,
    showStatus,
    updateNativeCameraStatus,
    updateNativeRuntimeStatus,
    updateNativeAuxiliaryStatus,
  } = input;

  return useMemo(
    () =>
      createExtensionsPanelActionController({
        activeProjectId,
        activeProjectName,
        expandProviderDetails,
        onProviderMutationPendingChange,
        projectExtensions,
        projectIntegrations,
        refreshProjectIntegrations,
        showStatus,
        updateNativeCameraStatus,
        updateNativeRuntimeStatus,
        updateNativeAuxiliaryStatus,
      }),
    [
      activeProjectId,
      activeProjectName,
      expandProviderDetails,
      onProviderMutationPendingChange,
      projectExtensions,
      projectIntegrations,
      refreshProjectIntegrations,
      showStatus,
      updateNativeCameraStatus,
      updateNativeRuntimeStatus,
      updateNativeAuxiliaryStatus,
    ],
  );
}
