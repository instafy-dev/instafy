import type { ReactNode } from "react";
import { ExtensionProviderSurfaceDetails } from "./extensionProviderSurfaceDetails";

type ExtensionRowDetailsProps = {
  familyDetails: ReactNode;
  savedNativeStateLabel: string | null;
  discoverable: boolean;
  discoveryError: string | null;
  hideSavedNativeStateLabel?: boolean;
  hideDiscoveryError?: boolean;
  customNativeSetupPanel: ReactNode;
  providerSurfaceDetails: ReactNode;
  developerDetails: ReactNode;
  diagnosticsPanel: ReactNode;
};

export function ExtensionRowDetails({
  familyDetails,
  savedNativeStateLabel,
  discoverable,
  discoveryError,
  hideSavedNativeStateLabel = false,
  hideDiscoveryError = false,
  customNativeSetupPanel,
  providerSurfaceDetails,
  developerDetails,
  diagnosticsPanel,
}: ExtensionRowDetailsProps) {
  return (
    <>
      {familyDetails}
      {customNativeSetupPanel}
      <ExtensionProviderSurfaceDetails
        savedNativeStateLabel={savedNativeStateLabel}
        discoverable={discoverable}
        discoveryError={discoveryError}
        hideSavedNativeStateLabel={hideSavedNativeStateLabel}
        hideDiscoveryError={hideDiscoveryError}
        providerSurfaceDetails={providerSurfaceDetails}
      />
      {developerDetails}
      {diagnosticsPanel}
    </>
  );
}
