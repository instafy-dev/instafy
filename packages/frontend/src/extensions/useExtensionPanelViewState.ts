import { useCallback, useEffect, useState } from "react";
import {
  clearProviderEventLogStore,
  useProviderEventLogStore,
} from "./providerEventStore";
import {
  clearProviderTriggerQueue,
  dismissProviderTriggerCandidate,
  useProviderTriggerQueue,
} from "./providerTriggerQueue";
import {
  createSyntheticProviderEvents,
  type ProviderEventSyntheticScenario,
} from "./providerEventSynthetic";
import { dispatchDebugInjectedProviderEvents } from "./providerEventChannel";
import type { ExtensionPanelSectionActions } from "./extensionPanelSectionContent";
import type { ExtensionRowController } from "../screens/studio/components/ExtensionsPanelRow";
import {
  useExtensionsPanelActions,
  type ExtensionsPanelActionsInput,
} from "../screens/studio/components/useExtensionsPanelActions";
import type { ProviderTriggerCandidate } from "./providerEventTriggers";

type UseExtensionPanelViewStateInput = Pick<
  ExtensionsPanelActionsInput,
  | "activeProjectId"
  | "activeProjectName"
  | "projectExtensions"
  | "projectIntegrations"
  | "refreshProjectIntegrations"
  | "showStatus"
  | "updateNativeRuntimeStatus"
  | "updateNativeAuxiliaryStatus"
  | "updateNativeCameraStatus"
> & {
  refreshLocalProviders: () => Promise<void>;
};

export type ExtensionPanelViewState = {
  uiState: {
    pendingProviderId: string | null;
    showDeveloperDetails: boolean;
    expandedProviderDetails: Record<string, boolean>;
    providerEventLogEntries: ReturnType<typeof useProviderEventLogStore>;
    providerTriggerCandidates: ReturnType<typeof useProviderTriggerQueue>;
  };
  developerDetailsToggleProps: {
    isSelected: boolean;
    onChange: (nextValue: boolean) => void;
  };
  sectionActions: ExtensionPanelSectionActions;
};

export function useExtensionPanelViewState(
  input: UseExtensionPanelViewStateInput,
): ExtensionPanelViewState {
  const [providerMutationPendingId, setProviderMutationPendingId] = useState<string | null>(null);
  const [showDeveloperDetails, setShowDeveloperDetails] = useState(false);
  const [expandedProviderDetails, setExpandedProviderDetails] = useState<Record<string, boolean>>(
    {},
  );
  const providerEventLogEntries = useProviderEventLogStore();
  const providerTriggerCandidates = useProviderTriggerQueue();

  useEffect(() => {
    setExpandedProviderDetails({});
  }, [input.activeProjectId]);

  const expandProviderDetails = useCallback((providerId: string) => {
    setExpandedProviderDetails((current) => ({
      ...current,
      [providerId]: true,
    }));
  }, []);

  const extensionActions = useExtensionsPanelActions({
    ...input,
    onProviderMutationPendingChange: setProviderMutationPendingId,
    expandProviderDetails,
  });

  const toggleProviderDetails = useCallback((providerId: string) => {
    setExpandedProviderDetails((current) => ({
      ...current,
      [providerId]: !current[providerId],
    }));
  }, []);

  const handleMakeCameraFamilyDefault = useCallback(
    (providerId: string) => {
      extensionActions.handleMakeCameraFamilyDefault(providerId);
    },
    [extensionActions],
  );

  const emitSyntheticProviderEvents = useCallback(
    (scenario: ProviderEventSyntheticScenario) => {
      dispatchDebugInjectedProviderEvents(createSyntheticProviderEvents(scenario));
    },
    [],
  );

  const clearProviderEventLog = useCallback(() => {
    clearProviderEventLogStore();
  }, []);

  const clearPendingProviderTriggers = useCallback(() => {
    clearProviderTriggerQueue();
  }, []);

  const dismissTriggerEntry = useCallback((entry: ProviderTriggerCandidate) => {
    dismissProviderTriggerCandidate(entry);
  }, []);

  const rowController: ExtensionRowController = {
    refreshLocalProviders: input.refreshLocalProviders,
    extensionActions,
    onToggleDetails: toggleProviderDetails,
    onMakeDefaultCameraProvider: handleMakeCameraFamilyDefault,
  };

  return {
    uiState: {
      pendingProviderId: providerMutationPendingId,
      showDeveloperDetails,
      expandedProviderDetails,
      providerEventLogEntries,
      providerTriggerCandidates,
    },
    developerDetailsToggleProps: {
      isSelected: showDeveloperDetails,
      onChange: setShowDeveloperDetails,
    },
    sectionActions: {
      rowController,
      onDismissTriggerEntry: dismissTriggerEntry,
      onClearTriggers: clearPendingProviderTriggers,
      onEmitSyntheticProviderEvents: emitSyntheticProviderEvents,
      onClearProviderEventLog: clearProviderEventLog,
    },
  };
}
