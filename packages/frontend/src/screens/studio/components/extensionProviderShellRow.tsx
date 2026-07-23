import type { ReactNode } from "react";
import {
  providerHostSurfaceHasActionBinding,
  providerHostSurfaceHasSectionBinding,
  resolveExtensionProviderShellSurfaceEntry,
} from "../../../providers/providerHostSurfaces";
import { buildExtensionProviderHostSectionBindings } from "../../../extensions/extensionProviderSurfaceBindings";
import type { SurfaceHostActionBinding } from "./ProviderHostSurfaceActions";
import { buildExtensionsPanelNativeSetupPanelProps } from "./extensionsPanelNativeSetupPanelProps";
import type { ProjectExtensionEntry, ExtensionsPanelRowModel } from "./extensionsPanelRowModel";
import type { ExtensionsPanelActionController } from "./useExtensionsPanelActions";
import type { LocalProviderSummary } from "../../../capabilities/localProviderHostClient";

type BuildExtensionProviderShellRowInput = {
  entry: ProjectExtensionEntry;
  rowModel: ExtensionsPanelRowModel;
  showDeveloperDetails: boolean;
  isPending: boolean;
  extensionActions: ExtensionsPanelActionController;
};

export type ExtensionProviderShellRow = {
  shellSurfaceEntry: ReturnType<typeof resolveExtensionProviderShellSurfaceEntry>;
  nativeSetupPanel: ReactNode;
  hostSectionBindings: ReturnType<typeof buildExtensionProviderHostSectionBindings>;
  hostActionBindings: Record<string, SurfaceHostActionBinding>;
  coversSavedState: boolean;
  coversAttachmentStatus: boolean;
  coversRuntimeStatus: boolean;
  coversDiscoveryError: boolean;
  coversAttachmentAction: boolean;
};

export function resolveExtensionProviderShellRowEntry(provider: LocalProviderSummary) {
  return resolveExtensionProviderShellSurfaceEntry(provider);
}

export function buildExtensionProviderShellRow(
  input: BuildExtensionProviderShellRowInput,
): ExtensionProviderShellRow {
  const shellSurfaceEntry = resolveExtensionProviderShellRowEntry(input.entry.provider);
  const collapseNativeRuntimeChrome =
    input.rowModel.hasNativeSetup &&
    input.rowModel.entry.source === "native_runtime" &&
    input.rowModel.entry.attached;
  const coversSetupGuidance = providerHostSurfaceHasSectionBinding(
    shellSurfaceEntry,
    "extension_setup_guidance",
  );
  const coversSavedState = providerHostSurfaceHasSectionBinding(
    shellSurfaceEntry,
    "extension_saved_state",
  );
  const coversAttachmentStatus = providerHostSurfaceHasSectionBinding(
    shellSurfaceEntry,
    "extension_attachment_status",
  );
  const coversRuntimeStatus = providerHostSurfaceHasSectionBinding(
    shellSurfaceEntry,
    "extension_runtime_status",
  );
  const coversDiscoveryError = providerHostSurfaceHasSectionBinding(
    shellSurfaceEntry,
    "extension_issue_status",
  );
  const coversAttachmentAction = providerHostSurfaceHasActionBinding(
    shellSurfaceEntry,
    "extension_attachment_action",
  );

  const nativeSetupPanel =
    input.rowModel.hasNativeSetup && input.rowModel.nativeExtension
      ? input.rowModel.nativeExtension.renderSetupPanel(
          buildExtensionsPanelNativeSetupPanelProps({
            provider: input.rowModel.entry.provider,
            mutationProviderId: input.rowModel.entry.mutationProviderId,
            capabilityIds: input.entry.attachedCapabilityIds,
            integration: input.rowModel.entry.integration,
            connectionType: input.rowModel.connectionType,
            attached: input.rowModel.entry.attached,
            developerDetailsDefault: input.showDeveloperDetails,
            surfaceCoverage: {
              setupGuidance: coversSetupGuidance,
              attachmentStatus: coversAttachmentStatus,
              runtimeStatus: coversRuntimeStatus,
              savedState: coversSavedState,
              availabilityIssue: coversDiscoveryError,
            },
            selectedDevice: input.rowModel.entry.selectedDevice,
            cameraState: input.rowModel.entry.cameraState,
            savePending: input.isPending,
            onRememberProviderDevice: input.extensionActions.handleRememberProviderDevice,
            onForgetProviderDevice: input.extensionActions.handleForgetProviderDevice,
            onRunRuntimeProbe: input.extensionActions.handleRuntimeProbe,
            onRuntimeStatusChange: input.extensionActions.handleRuntimeStatusChange,
            onAuxiliaryStatusChange: input.extensionActions.handleAuxiliaryStatusChange,
            onPersistCameraState: input.extensionActions.handlePersistCameraState,
            onCameraStatusChange: input.extensionActions.handleCameraStatusChange,
          }),
        )
      : null;

  const hostSectionBindings = buildExtensionProviderHostSectionBindings(input.rowModel);
  const hostActionBindings: Record<string, SurfaceHostActionBinding> = collapseNativeRuntimeChrome
    ? {
        extension_attachment_action: {
          hidden: true,
        },
      }
      : {
        extension_attachment_action: input.entry.attached
          ? {
              label: "Detach",
              busyLabel: input.rowModel.nativeExtension
                ? input.rowModel.nativeExtension.formatDetachButtonLabel(true, input.entry.source)
                : "Detaching…",
              description: "Stop using this provider here.",
              variant: "outline",
              disabled: input.isPending,
              onPress: async () => {
                await input.extensionActions.handleDetachEntry(input.entry, input.rowModel);
              },
            }
          : {
              label: "Attach",
              busyLabel: input.rowModel.nativeExtension
                ? input.rowModel.nativeExtension.formatAttachButtonLabel(true, input.entry.source)
                : "Attaching…",
              description: "Use this provider here.",
              variant: input.rowModel.rowPresentation.attachVariant,
              disabled: input.isPending || input.entry.capabilityIds.length === 0,
              onPress: async () => {
                await input.extensionActions.handleAttachEntry(input.entry, input.rowModel);
              },
            },
      };

  return {
    shellSurfaceEntry,
    nativeSetupPanel,
    hostSectionBindings,
    hostActionBindings,
    coversSavedState,
    coversAttachmentStatus,
    coversRuntimeStatus,
    coversDiscoveryError,
    coversAttachmentAction,
  };
}
