import { Text } from "../components/Text";
import type { ExtensionsPanelRowModel } from "../screens/studio/components/extensionsPanelRowModel";

type ExtensionFamilySummaryContentProps = {
  model: ExtensionsPanelRowModel;
  hideRuntimeSummary?: boolean;
  hideRemoteDeviceCaption?: boolean;
};

export function hasExtensionFamilySummaryContent({
  model,
  hideRuntimeSummary = false,
  hideRemoteDeviceCaption = false,
}: ExtensionFamilySummaryContentProps) {
  if (!hideRuntimeSummary && model.attachedRemoteOnlySummary) {
    return true;
  }
  return Boolean(
    !hideRemoteDeviceCaption &&
      model.remoteCameraPresentation?.deviceDetails &&
      model.attachedFamilyCount <= 1,
  );
}

export function ExtensionFamilySummaryContent({
  model,
  hideRuntimeSummary = false,
  hideRemoteDeviceCaption = false,
}: ExtensionFamilySummaryContentProps) {
  const remoteCameraDeviceDetails = model.remoteCameraPresentation?.deviceDetails ?? null;
  const remoteCameraRequestSummary = model.remoteCameraPresentation?.requestSummary ?? null;
  const remoteSummary = model.attachedRemoteOnlySummary
    ? !hideRuntimeSummary
      ? (
          <Text
            variant="body"
            tone={
              remoteCameraRequestSummary?.tone === "warning"
                ? "warning"
                : remoteCameraRequestSummary?.tone === "secondary"
                  ? "secondary"
                  : "muted"
            }
            className="leading-5"
          >
            {model.attachedRemoteOnlySummary}
          </Text>
        )
      : null
    : null;
  const remoteCaption =
    !hideRemoteDeviceCaption &&
    remoteCameraDeviceDetails !== null &&
    model.attachedFamilyCount <= 1 ? (
      <Text variant="caption" tone="muted">
        Preferred device · {remoteCameraDeviceDetails.label}
        {remoteCameraDeviceDetails.platformLabel
          ? ` · ${remoteCameraDeviceDetails.platformLabel}`
          : ""}
      </Text>
    ) : null;

  if (!remoteCaption && !remoteSummary) {
    return null;
  }

  return (
    <>
      {remoteCaption}
      {remoteSummary}
    </>
  );
}
