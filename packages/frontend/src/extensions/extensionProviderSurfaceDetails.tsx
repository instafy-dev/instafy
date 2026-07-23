import type { ReactNode } from "react";
import { Text } from "../components/Text";

type ExtensionProviderSurfaceDetailsProps = {
  savedNativeStateLabel: string | null;
  discoverable: boolean;
  discoveryError: string | null;
  hideSavedNativeStateLabel?: boolean;
  hideDiscoveryError?: boolean;
  providerSurfaceDetails: ReactNode;
};

export function ExtensionProviderSurfaceDetails({
  savedNativeStateLabel,
  discoverable,
  discoveryError,
  hideSavedNativeStateLabel = false,
  hideDiscoveryError = false,
  providerSurfaceDetails,
}: ExtensionProviderSurfaceDetailsProps) {
  return (
    <>
      {savedNativeStateLabel && !hideSavedNativeStateLabel ? (
        <Text variant="caption" tone="muted">
          {savedNativeStateLabel}
        </Text>
      ) : null}
      {!discoverable && discoveryError && !hideDiscoveryError ? (
        <Text variant="caption" tone="warning">
          Discovery error: {discoveryError}
        </Text>
      ) : null}
      {providerSurfaceDetails}
    </>
  );
}
