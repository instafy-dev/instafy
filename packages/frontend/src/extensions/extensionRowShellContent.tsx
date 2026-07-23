import type { ComponentProps } from "react";
import { ExtensionDeveloperDetails } from "../screens/studio/components/ExtensionDeveloperDetails";
import { ProviderDiagnosticsPanel } from "../screens/studio/components/ProviderDiagnosticsPanel";
import { ProviderShellSurface } from "../screens/studio/components/ProviderShellSurface";
import type { ExtensionProviderShellRow } from "../screens/studio/components/extensionProviderShellRow";
import type {
  ExtensionsPanelRowModel,
  ProjectExtensionEntry,
} from "../screens/studio/components/extensionsPanelRowModel";
import { ExtensionFamilyDetailPanels } from "./extensionFamilyDetailPanels";
import { ExtensionRowDetails } from "./extensionRowDetails";
import { ExtensionRowSummary } from "./extensionRowSummary";

type BuildExtensionRowShellContentInput = {
  entry: ProjectExtensionEntry;
  rowModel: ExtensionsPanelRowModel;
  providerShellRow: ExtensionProviderShellRow;
  showDeveloperDetails: boolean;
  isPending: boolean;
  refreshLocalProviders: () => Promise<void>;
  onMakeDefaultCameraProvider: (providerId: string) => void;
};

export type ExtensionRowShellViewModel = {
  summaryProps: ComponentProps<typeof ExtensionRowSummary>;
  detailsProps: ComponentProps<typeof ExtensionRowDetails>;
};

export function buildExtensionRowShellViewModel(
  input: BuildExtensionRowShellContentInput,
): ExtensionRowShellViewModel {
  const { entry, rowModel, providerShellRow, showDeveloperDetails, isPending } = input;

  return {
    summaryProps: {
      model: rowModel,
      hideRuntimeSummary:
        rowModel.rowPresentation.detailsExpanded && providerShellRow.coversRuntimeStatus,
      hideSavedStateSummary:
        rowModel.rowPresentation.detailsExpanded && providerShellRow.coversSavedState,
      hideDefaultPreferenceCaption:
        rowModel.rowPresentation.detailsExpanded && providerShellRow.coversAttachmentStatus,
      hideRemoteDeviceCaption:
        rowModel.rowPresentation.detailsExpanded &&
        providerShellRow.coversAttachmentStatus &&
        providerShellRow.coversRuntimeStatus,
    },
    detailsProps: {
      familyDetails: (
        <ExtensionFamilyDetailPanels
          providerId={entry.provider.id}
          attachedFamilyCount={rowModel.attachedFamilyCount}
          familyCameraDeviceItems={rowModel.familyCameraDeviceItems}
          isPending={isPending}
          onMakeDefaultCameraProvider={input.onMakeDefaultCameraProvider}
          remoteCameraPresentation={rowModel.remoteCameraPresentation}
          selectedDevice={entry.selectedDevice}
          remoteCameraDevice={rowModel.remoteCameraDevice}
        />
      ),
      savedNativeStateLabel:
        rowModel.remoteCameraPresentation ? null : rowModel.savedNativeStateLabel,
      discoverable: entry.discoverable,
      discoveryError: entry.provider.error ?? null,
      hideSavedNativeStateLabel: providerShellRow.coversSavedState,
      hideDiscoveryError: providerShellRow.coversDiscoveryError,
      customNativeSetupPanel: providerShellRow.nativeSetupPanel,
      providerSurfaceDetails: (
        <ProviderShellSurface
          entry={providerShellRow.shellSurfaceEntry}
          hostActionBindings={providerShellRow.hostActionBindings}
          hostSectionBindings={providerShellRow.hostSectionBindings}
          presentation={rowModel.hasNativeSetup ? "embedded" : "default"}
        />
      ),
      developerDetails: showDeveloperDetails ? (
        <ExtensionDeveloperDetails
          eligibleAssistantLabel={rowModel.eligibleAssistantLabel}
          kindLabel={rowModel.kindLabel}
          discoveredCapabilityLabel={rowModel.discoveredCapabilityLabel}
          projectCapabilityLabel={rowModel.projectCapabilityLabel}
          integrationId={entry.integration?.id ?? null}
          source={entry.source}
        />
      ) : null,
      diagnosticsPanel:
        showDeveloperDetails && entry.source === "host" ? (
          <ProviderDiagnosticsPanel
            provider={entry.provider}
            onRefreshProviders={input.refreshLocalProviders}
            allowCollapse={false}
            autoDiscoverOnExpand={false}
          />
        ) : null,
    },
  };
}
