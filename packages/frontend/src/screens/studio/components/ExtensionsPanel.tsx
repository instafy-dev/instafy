import { useMemo } from "react";
import { Puzzle } from "iconoir-react";
import { Toggle } from "../../../components/Toggle";
import {
  buildExtensionPanelSectionViewModel,
  ExtensionPanelSectionContent,
} from "../../../extensions/extensionPanelSectionContent";
import { useExtensionPanelViewState } from "../../../extensions/useExtensionPanelViewState";
import { useProjects } from "../../../projects/useProjects";
import { isAutomationBrowser } from "../../../services/runtimeController/logging";
import { useStatus } from "../../../status/useStatus";
import { SettingsShell } from "./SettingsShell";
import { StudioListSection } from "./StudioListSection";
import { useExtensionsPanelData } from "./useExtensionsPanelData";

export function ExtensionsPanel() {
  const { projectList, activeProjectId } = useProjects();
  const { showStatus } = useStatus();
  const showExtensionDeveloperTools =
    (import.meta.env.VITE_SHOW_EXTENSION_DEVTOOLS ?? "").trim() === "1" ||
    isAutomationBrowser();

  const activeProject = useMemo(
    () => projectList.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projectList],
  );
  const extensionsPanelData = useExtensionsPanelData({ activeProjectId });
  const {
    localProviderHostUnavailableOnThisClient,
    localProvidersLoading,
    localProvidersError,
    projectIntegrations,
    projectIntegrationsLoading,
    projectIntegrationsError,
    refreshLocalProviders,
    refreshProjectIntegrations,
    nativeRuntimeStatusByProvider,
    updateNativeRuntimeStatus,
    nativeAuxiliaryStatusByProvider,
    updateNativeAuxiliaryStatus,
    nativeCameraHealthStateByProvider,
    updateNativeCameraStatus,
    currentNativeCameraStatus,
    remoteCameraRequestsByProvider,
    remoteCameraDevicesByProvider,
    projectExtensions,
    attachedExtensionFamilyCounts,
    cameraAttachedDeviceItems,
  } = extensionsPanelData;
  const extensionPanelViewState = useExtensionPanelViewState({
    activeProjectId,
    activeProjectName: activeProject?.name ?? null,
    projectExtensions,
    projectIntegrations,
    refreshLocalProviders,
    refreshProjectIntegrations,
    showStatus,
    updateNativeRuntimeStatus,
    updateNativeAuxiliaryStatus,
    updateNativeCameraStatus,
  });
  const sectionViewModel = buildExtensionPanelSectionViewModel({
    activeProjectId,
    activeProjectName: activeProject?.name ?? null,
    pendingProviderId: extensionPanelViewState.uiState.pendingProviderId,
    showDeveloperDetails:
      showExtensionDeveloperTools && extensionPanelViewState.uiState.showDeveloperDetails,
    expandedProviderDetails: extensionPanelViewState.uiState.expandedProviderDetails,
    localProviderHostUnavailableOnThisClient,
    localProvidersLoading,
    localProvidersError,
    projectIntegrationsLoading,
    projectIntegrationsError,
    currentNativeCameraStatus,
    nativeRuntimeStatusByProvider,
    nativeAuxiliaryStatusByProvider,
    nativeCameraHealthStateByProvider,
    remoteCameraRequestsByProvider,
    remoteCameraDevicesByProvider,
    projectExtensions,
    attachedExtensionFamilyCounts,
    cameraAttachedDeviceItems,
    providerEventLogEntries: extensionPanelViewState.uiState.providerEventLogEntries,
    providerTriggerCandidates: extensionPanelViewState.uiState.providerTriggerCandidates,
  });

  return (
    <SettingsShell
      testId="extensions-panel"
      title="Extensions"
      hideTitle
    >
      <StudioListSection
        title="Available extensions"
        description={
          localProviderHostUnavailableOnThisClient
            ? "Showing on-device extensions only."
            : activeProject
              ? `Connect devices and tools to ${activeProject.name}.`
              : "Select a space to attach extensions intentionally."
        }
        icon={<Puzzle className="h-5 w-5" aria-hidden={true} />}
        tone="activity"
        actions={
          activeProjectId && showExtensionDeveloperTools ? (
            <Toggle
              isSelected={extensionPanelViewState.developerDetailsToggleProps.isSelected}
              onChange={extensionPanelViewState.developerDetailsToggleProps.onChange}
              size="sm"
              label="Developer details"
              data-testid="extensions-developer-toggle"
              className="w-full justify-between sm:w-auto sm:justify-end"
            />
          ) : null
        }
        data-testid="extensions-provider-access-section"
      >
        <ExtensionPanelSectionContent
          viewModel={sectionViewModel}
          actions={extensionPanelViewState.sectionActions}
        />
      </StudioListSection>
    </SettingsShell>
  );
}
