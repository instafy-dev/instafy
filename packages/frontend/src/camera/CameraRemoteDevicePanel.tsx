import type { ProjectProviderSelectedDevice } from "../capabilities/projectProviderAccess";
import {
  NativeExtensionDetailCard,
  NativeExtensionDeviceCard,
  NativeExtensionMetaLine,
} from "../extensions/nativeExtensionSetupUi";
import type { ControllerProviderDeviceRecord } from "../services/runtimeController/providerDevices";
import { resolveCameraRemoteDeviceDetails } from "./cameraRemoteRequestPresentation";

type CameraRemoteDevicePanelProps = {
  selectedDevice: ProjectProviderSelectedDevice | null;
  device?: ControllerProviderDeviceRecord | null;
  nowMs?: number;
  testId?: string;
};

export function CameraRemoteDevicePanel({
  selectedDevice,
  device,
  nowMs,
  testId = "project-provider-camera-remote-device",
}: CameraRemoteDevicePanelProps) {
  const details = resolveCameraRemoteDeviceDetails({
    selectedDevice,
    device,
    nowMs,
  });

  if (!details) {
    return null;
  }

  return (
    <NativeExtensionDetailCard
      className="rounded-2xl bg-transparent dark:bg-transparent"
      testId={testId}
    >
      <NativeExtensionDeviceCard
        eyebrow="Preferred device"
        title={details.label}
        className="border-transparent bg-transparent p-0 dark:border-transparent dark:bg-transparent"
        meta={[
          [
            details.presenceStatus === "online" ? "Online" : "Offline",
            details.platformLabel,
          ]
            .filter(Boolean)
            .join(" · "),
        ]}
        summary={details.stateText}
        summaryTone={details.presenceStatus === "online" ? "secondary" : "warning"}
      />
      {details.freshnessText ? (
        <NativeExtensionMetaLine className="text-xs">
          {details.freshnessText}
        </NativeExtensionMetaLine>
      ) : null}
    </NativeExtensionDetailCard>
  );
}
