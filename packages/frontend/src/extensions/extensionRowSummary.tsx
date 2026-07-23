import { Text } from "../components/Text";
import {
  ExtensionFamilySummaryContent,
  hasExtensionFamilySummaryContent,
} from "./extensionFamilySummaryContent";
import { HostExtensionHealthSummary } from "./extensionHostHealthSummary";
import type { ExtensionsPanelRowModel } from "../screens/studio/components/extensionsPanelRowModel";

export function ExtensionRowSummary({
  model,
  hideRuntimeSummary = false,
  hideSavedStateSummary = false,
  hideDefaultPreferenceCaption = false,
  hideRemoteDeviceCaption = false,
}: {
  model: ExtensionsPanelRowModel;
  hideRuntimeSummary?: boolean;
  hideSavedStateSummary?: boolean;
  hideDefaultPreferenceCaption?: boolean;
  hideRemoteDeviceCaption?: boolean;
}) {
  if (!model.rowPresentation.hasSummaryLine) {
    return (
      <Text variant="body" tone="muted" className="leading-5">
        {model.rowPresentation.fallbackSummary}
      </Text>
    );
  }

  const familySummary = (
    <ExtensionFamilySummaryContent
      model={model}
      hideRuntimeSummary={hideRuntimeSummary}
      hideRemoteDeviceCaption={hideRemoteDeviceCaption}
    />
  );
  const showsFamilySummary = hasExtensionFamilySummaryContent({
    model,
    hideRuntimeSummary,
    hideRemoteDeviceCaption,
  });
  const primarySummary = model.attachedRemoteOnlySummary ? null : model.entry.source === "host" ? (
    !hideRuntimeSummary ? <HostExtensionHealthSummary provider={model.entry.provider} /> : null
  ) : model.nativeExtension && model.hasNativeSetup ? (
    !hideRuntimeSummary
      ? model.nativeExtension.renderSummary({
          providerId: model.entry.provider.id,
          attached: model.entry.attached,
          selectedDevice: model.entry.selectedDevice,
          cameraState: model.entry.cameraState,
          runtimeStatus: model.runtimeStatus,
          runtimeStatusCheckedAt: model.runtimeStatusCheckedAt,
          auxiliaryStatus: model.auxiliaryStatus,
          auxiliaryStatusCheckedAt: model.auxiliaryStatusCheckedAt,
          cameraLiveStatus: model.cameraLiveStatus,
          cameraLiveCheckedAt: model.cameraLiveCheckedAt,
          refreshNativeCameraStatus: model.refreshNativeCameraStatus,
        })
      : null
  ) : model.savedNativeStateLabel ? (
    !hideSavedStateSummary ? (
      <Text variant="body" tone="muted" className="leading-5">
        {model.savedNativeStateLabel}
      </Text>
    ) : null
  ) : null;

  const showsFamilyDefaultCaption =
    !hideDefaultPreferenceCaption && model.isFamilyDefault && model.attachedFamilyCount > 1;
  const familyDefaultCaption =
    model.nativeExtension?.formatDefaultCaption?.() ?? "Default for new requests.";

  if (!showsFamilyDefaultCaption && !showsFamilySummary && !primarySummary) {
    return null;
  }

  return (
    <div className="space-y-1">
      {showsFamilyDefaultCaption ? (
        <Text variant="caption" tone="secondary">
          {familyDefaultCaption}
        </Text>
      ) : null}
      {familySummary}
      {primarySummary}
    </div>
  );
}
