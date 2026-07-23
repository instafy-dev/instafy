import { InlineNotice, type InlineNoticeTone } from "../components/InlineNotice";
import {
  ExtensionsPanelRow,
  type ExtensionRowController,
} from "../screens/studio/components/ExtensionsPanelRow";
import {
  StudioListRow,
  StudioListSurface,
} from "../screens/studio/components/StudioListSection";
import type {
  ProjectExtensionEntry,
} from "../screens/studio/components/extensionsPanelRowModel";
import { ExtensionProviderEventDebugPanel } from "./extensionProviderEventDebugPanel";
import { ExtensionProviderTriggerQueuePanel } from "./extensionProviderTriggerQueuePanel";
import type { ProviderEventLogEntry } from "./providerEventLog";
import type { ProviderEventSyntheticScenario } from "./providerEventSynthetic";
import type { ProviderTriggerCandidate } from "./providerEventTriggers";
import type { CameraStatusSnapshot } from "../camera/types";
import type { CameraExtensionAttachedDeviceItem } from "./cameraExtensionFamilyPresentation";
import type { ControllerProviderRequestRecord } from "../services/runtimeController";
import type { ControllerProviderDeviceRecord } from "../services/runtimeController/providerDevices";
import type { NativeExtensionStatusValue } from "./nativeExtensionTypes";

type CheckedStatus<T> = { status: T | null; checkedAt: string | null };

type ExtensionSectionNotice = {
  tone: InlineNoticeTone;
  title?: string;
  message: string;
};

export function resolveExtensionPanelSectionNotice({
  activeProjectId,
  localProvidersError,
  localProviderHostUnavailableOnThisClient,
  projectIntegrationsError,
  localProvidersLoading,
  projectIntegrationsLoading,
  projectExtensionsCount,
}: {
  activeProjectId: string | null;
  localProvidersError: string | null;
  localProviderHostUnavailableOnThisClient: boolean;
  projectIntegrationsError: string | null;
  localProvidersLoading: boolean;
  projectIntegrationsLoading: boolean;
  projectExtensionsCount: number;
}): ExtensionSectionNotice | null {
  if (!activeProjectId) {
    return {
      tone: "info",
      message: "Select a space first.",
    };
  }

  if (projectIntegrationsError) {
    return {
      tone: "warning",
      title: "Access unavailable",
      message: `Could not load extension access: ${projectIntegrationsError}`,
    };
  }

  if (
    localProvidersError &&
    !localProviderHostUnavailableOnThisClient &&
    projectExtensionsCount === 0
  ) {
    return {
      tone: "warning",
      title: "Local providers unavailable",
      message: localProvidersError,
    };
  }

  if ((localProvidersLoading || projectIntegrationsLoading) && projectExtensionsCount === 0) {
    return {
      tone: "info",
      title: "Checking extensions",
      message: "Looking for devices and saved access.",
    };
  }

  if (!localProvidersLoading && !projectIntegrationsLoading && projectExtensionsCount === 0) {
    return {
      tone: "info",
      title: "No extensions yet",
      message: "Open Instafy on a phone or desktop to add a camera or board.",
    };
  }

  return null;
}

type ExtensionPanelSectionContentProps = {
  viewModel: ExtensionPanelSectionViewModel;
  actions: ExtensionPanelSectionActions;
};

export type ExtensionPanelSectionViewModel = {
  activeProjectId: string | null;
  activeProjectName: string | null;
  pendingProviderId: string | null;
  showDeveloperDetails: boolean;
  expandedProviderDetails: Record<string, boolean>;
  sectionNotice: ExtensionSectionNotice | null;
  currentNativeCameraStatus: CameraStatusSnapshot | null;
  nativeRuntimeStatusByProvider: Record<string, CheckedStatus<NativeExtensionStatusValue>>;
  nativeAuxiliaryStatusByProvider: Record<string, CheckedStatus<NativeExtensionStatusValue>>;
  nativeCameraHealthStateByProvider: Record<string, CheckedStatus<CameraStatusSnapshot>>;
  remoteCameraRequestsByProvider: Record<string, ControllerProviderRequestRecord[]>;
  remoteCameraDevicesByProvider: Record<string, ControllerProviderDeviceRecord>;
  projectExtensions: ProjectExtensionEntry[];
  attachedExtensionFamilyCounts: Map<string, number>;
  cameraAttachedDeviceItems: CameraExtensionAttachedDeviceItem[];
  providerEventLogEntries: ProviderEventLogEntry[];
  providerTriggerCandidates: ProviderTriggerCandidate[];
};

export type ExtensionPanelSectionActions = {
  rowController: ExtensionRowController;
  onDismissTriggerEntry: (entry: ProviderTriggerCandidate) => void;
  onClearTriggers: () => void;
  onEmitSyntheticProviderEvents: (scenario: ProviderEventSyntheticScenario) => void;
  onClearProviderEventLog: () => void;
};

type BuildExtensionPanelSectionViewModelInput = {
  activeProjectId: string | null;
  activeProjectName: string | null;
  pendingProviderId: string | null;
  showDeveloperDetails: boolean;
  expandedProviderDetails: Record<string, boolean>;
  localProviderHostUnavailableOnThisClient: boolean;
  localProvidersLoading: boolean;
  localProvidersError: string | null;
  projectIntegrationsLoading: boolean;
  projectIntegrationsError: string | null;
  currentNativeCameraStatus: CameraStatusSnapshot | null;
  nativeRuntimeStatusByProvider: Record<string, CheckedStatus<NativeExtensionStatusValue>>;
  nativeAuxiliaryStatusByProvider: Record<string, CheckedStatus<NativeExtensionStatusValue>>;
  nativeCameraHealthStateByProvider: Record<string, CheckedStatus<CameraStatusSnapshot>>;
  remoteCameraRequestsByProvider: Record<string, ControllerProviderRequestRecord[]>;
  remoteCameraDevicesByProvider: Record<string, ControllerProviderDeviceRecord>;
  projectExtensions: ProjectExtensionEntry[];
  attachedExtensionFamilyCounts: Map<string, number>;
  cameraAttachedDeviceItems: CameraExtensionAttachedDeviceItem[];
  providerEventLogEntries: ProviderEventLogEntry[];
  providerTriggerCandidates: ProviderTriggerCandidate[];
};

export function buildExtensionPanelSectionViewModel(
  input: BuildExtensionPanelSectionViewModelInput,
): ExtensionPanelSectionViewModel {
  return {
    activeProjectId: input.activeProjectId,
    activeProjectName: input.activeProjectName,
    pendingProviderId: input.pendingProviderId,
    showDeveloperDetails: input.showDeveloperDetails,
    expandedProviderDetails: input.expandedProviderDetails,
    sectionNotice: resolveExtensionPanelSectionNotice({
      activeProjectId: input.activeProjectId,
      localProvidersError: input.localProvidersError,
      localProviderHostUnavailableOnThisClient: input.localProviderHostUnavailableOnThisClient,
      projectIntegrationsError: input.projectIntegrationsError,
      localProvidersLoading: input.localProvidersLoading,
      projectIntegrationsLoading: input.projectIntegrationsLoading,
      projectExtensionsCount: input.projectExtensions.length,
    }),
    currentNativeCameraStatus: input.currentNativeCameraStatus,
    nativeRuntimeStatusByProvider: input.nativeRuntimeStatusByProvider,
    nativeAuxiliaryStatusByProvider: input.nativeAuxiliaryStatusByProvider,
    nativeCameraHealthStateByProvider: input.nativeCameraHealthStateByProvider,
    remoteCameraRequestsByProvider: input.remoteCameraRequestsByProvider,
    remoteCameraDevicesByProvider: input.remoteCameraDevicesByProvider,
    projectExtensions: input.projectExtensions,
    attachedExtensionFamilyCounts: input.attachedExtensionFamilyCounts,
    cameraAttachedDeviceItems: input.cameraAttachedDeviceItems,
    providerEventLogEntries: input.providerEventLogEntries,
    providerTriggerCandidates: input.providerTriggerCandidates,
  };
}

export function ExtensionPanelSectionContent({
  viewModel,
  actions,
}: ExtensionPanelSectionContentProps) {
  return (
    <>
      {viewModel.sectionNotice ? (
        <InlineNotice tone={viewModel.sectionNotice.tone} title={viewModel.sectionNotice.title}>
          {viewModel.sectionNotice.message}
        </InlineNotice>
      ) : null}

      {viewModel.activeProjectId && viewModel.providerTriggerCandidates.length > 0 ? (
        <ExtensionProviderTriggerQueuePanel
          entries={viewModel.providerTriggerCandidates}
          onDismissEntry={actions.onDismissTriggerEntry}
          onClear={actions.onClearTriggers}
        />
      ) : null}

      {viewModel.activeProjectId && viewModel.showDeveloperDetails ? (
        <ExtensionProviderEventDebugPanel
          entries={viewModel.providerEventLogEntries}
          onEmitScenario={actions.onEmitSyntheticProviderEvents}
          onClear={actions.onClearProviderEventLog}
        />
      ) : null}

      {viewModel.activeProjectId && viewModel.projectExtensions.length > 0 ? (
        <StudioListSurface>
          {viewModel.projectExtensions.map((entry, index) => (
            <StudioListRow key={entry.provider.id} separated={index > 0}>
              <ExtensionsPanelRow
                entry={entry}
                activeProjectName={viewModel.activeProjectName}
                pendingProviderId={viewModel.pendingProviderId}
                showDeveloperDetails={viewModel.showDeveloperDetails}
                expanded={Boolean(viewModel.expandedProviderDetails[entry.provider.id])}
                currentNativeCameraStatus={viewModel.currentNativeCameraStatus}
                nativeRuntimeStatusByProvider={viewModel.nativeRuntimeStatusByProvider}
                nativeAuxiliaryStatusByProvider={viewModel.nativeAuxiliaryStatusByProvider}
                nativeCameraHealthStateByProvider={viewModel.nativeCameraHealthStateByProvider}
                remoteCameraRequestsByProvider={viewModel.remoteCameraRequestsByProvider}
                remoteCameraDevicesByProvider={viewModel.remoteCameraDevicesByProvider}
                attachedExtensionFamilyCounts={viewModel.attachedExtensionFamilyCounts}
                cameraAttachedDeviceItems={viewModel.cameraAttachedDeviceItems}
                rowController={actions.rowController}
              />
            </StudioListRow>
          ))}
        </StudioListSurface>
      ) : null}
    </>
  );
}
