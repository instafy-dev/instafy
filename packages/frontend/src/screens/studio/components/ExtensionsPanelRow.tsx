import { ExtensionListRow } from "./ExtensionListRow";
import {
  buildExtensionProviderShellRow,
  resolveExtensionProviderShellRowEntry,
} from "./extensionProviderShellRow";
import {
  buildExtensionRowShellViewModel,
} from "../../../extensions/extensionRowShellContent";
import { ExtensionRowDetails } from "../../../extensions/extensionRowDetails";
import { ExtensionRowSummary } from "../../../extensions/extensionRowSummary";
import {
  buildExtensionsPanelRowModel,
  type ProjectExtensionEntry,
} from "./extensionsPanelRowModel";
import { buildExtensionsPanelRowActions } from "./extensionsPanelRowActions";
import type { ExtensionsPanelActionController } from "./useExtensionsPanelActions";
import type { CameraStatusSnapshot } from "../../../camera/types";
import type { CameraExtensionAttachedDeviceItem } from "../../../extensions/cameraExtensionFamilyPresentation";
import type { NativeExtensionStatusValue } from "../../../extensions/nativeExtensionTypes";
import type { ControllerProviderRequestRecord } from "../../../services/runtimeController";
import type { ControllerProviderDeviceRecord } from "../../../services/runtimeController/providerDevices";

type CheckedStatus<T> = { status: T | null; checkedAt: string | null };

export type ExtensionRowController = {
  refreshLocalProviders: () => Promise<void>;
  extensionActions: ExtensionsPanelActionController;
  onToggleDetails: (providerId: string) => void;
  onMakeDefaultCameraProvider: (providerId: string) => void;
};

type ExtensionsPanelRowProps = {
  entry: ProjectExtensionEntry;
  activeProjectName?: string | null;
  pendingProviderId: string | null;
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
  rowController: ExtensionRowController;
};

function buildExtensionActionAriaLabel(label: string, providerLabel: string) {
  if (label === "Use This Device" || label === "Use this phone") {
    return `${label} for ${providerLabel}`;
  }
  if (label === "Make Default") {
    return `Make ${providerLabel} Default`;
  }
  return `${label} ${providerLabel}`;
}

export function ExtensionsPanelRow({
  entry,
  activeProjectName,
  pendingProviderId,
  showDeveloperDetails,
  expanded,
  currentNativeCameraStatus,
  nativeRuntimeStatusByProvider,
  nativeAuxiliaryStatusByProvider,
  nativeCameraHealthStateByProvider,
  remoteCameraRequestsByProvider,
  remoteCameraDevicesByProvider,
  attachedExtensionFamilyCounts,
  cameraAttachedDeviceItems,
  rowController,
}: ExtensionsPanelRowProps) {
  const isPending = pendingProviderId === entry.provider.id;
  const shellSurfaceEntry = resolveExtensionProviderShellRowEntry(entry.provider);
  const rowModel = buildExtensionsPanelRowModel({
    entry,
    activeProjectName,
    isPending,
    showDeveloperDetails,
    expanded,
    currentNativeCameraStatus,
    nativeRuntimeStatusByProvider,
    nativeAuxiliaryStatusByProvider,
    nativeCameraHealthStateByProvider,
    remoteCameraRequestsByProvider,
    remoteCameraDevicesByProvider,
    attachedExtensionFamilyCounts,
    cameraAttachedDeviceItems,
    hasProviderHostSurface: shellSurfaceEntry !== null,
  });
  const providerShellRow = buildExtensionProviderShellRow({
    entry,
    rowModel,
    showDeveloperDetails,
    isPending,
    extensionActions: rowController.extensionActions,
  });
  const rowShellViewModel = buildExtensionRowShellViewModel({
    entry,
    rowModel,
    providerShellRow,
    showDeveloperDetails,
    isPending,
    refreshLocalProviders: rowController.refreshLocalProviders,
    onMakeDefaultCameraProvider: rowController.onMakeDefaultCameraProvider,
  });
  const summary = <ExtensionRowSummary {...rowShellViewModel.summaryProps} />;
  const details = <ExtensionRowDetails {...rowShellViewModel.detailsProps} />;

  const { rowActions, footerActions } = buildExtensionsPanelRowActions({
    attached: entry.attached,
    capabilityCount: entry.capabilityIds.length,
    isPending,
    providerId: entry.provider.id,
    providerLabel: rowModel.providerLabel,
    rowPresentation: rowModel.rowPresentation,
    buildActionAriaLabel: buildExtensionActionAriaLabel,
    onAttach: () => {
      void rowController.extensionActions.handleAttachEntry(entry, rowModel);
    },
    onToggleDetails: () => {
      rowController.onToggleDetails(entry.provider.id);
    },
    onDetach: () => {
      void rowController.extensionActions.handleDetachEntry(entry, rowModel);
    },
  });

  return (
    <ExtensionListRow
      providerId={entry.provider.id}
      title={rowModel.rowPresentation.providerTitle}
      description={rowModel.extension.listDescription}
      statusLabel={rowModel.rowPresentation.statusLabel}
      statusTone={rowModel.rowPresentation.statusTone}
      summary={summary}
      actions={rowActions}
      details={details}
      footerActions={providerShellRow.coversAttachmentAction ? [] : footerActions}
      detailsExpanded={rowModel.rowPresentation.detailsExpanded}
    />
  );
}
