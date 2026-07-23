import { CameraAttachedDeviceListPanel } from "../camera/CameraAttachedDeviceListPanel";
import { CameraRemoteDevicePanel } from "../camera/CameraRemoteDevicePanel";
import type { ProjectProviderSelectedDevice } from "../capabilities/projectProviderAccess";
import type {
  CameraExtensionAttachedDeviceItem,
  CameraExtensionRemotePresentation,
} from "./cameraExtensionFamilyPresentation";
import type { ControllerProviderDeviceRecord } from "../services/runtimeController/providerDevices";

type ExtensionFamilyDetailPanelsProps = {
  providerId: string;
  attachedFamilyCount: number;
  familyCameraDeviceItems: CameraExtensionAttachedDeviceItem[];
  isPending: boolean;
  onMakeDefaultCameraProvider?: (providerId: string) => void;
  remoteCameraPresentation: CameraExtensionRemotePresentation | null;
  selectedDevice: ProjectProviderSelectedDevice | null;
  remoteCameraDevice: ControllerProviderDeviceRecord | null;
};

export function ExtensionFamilyDetailPanels({
  providerId,
  attachedFamilyCount,
  familyCameraDeviceItems,
  isPending,
  onMakeDefaultCameraProvider,
  remoteCameraPresentation,
  selectedDevice,
  remoteCameraDevice,
}: ExtensionFamilyDetailPanelsProps) {
  return (
    <>
      {attachedFamilyCount > 1 && familyCameraDeviceItems.length > 0 ? (
        <CameraAttachedDeviceListPanel
          items={familyCameraDeviceItems.map((item) => ({
            ...item,
            onMakeDefault:
              item.isDefault || isPending || !onMakeDefaultCameraProvider
                ? null
                : () => {
                    onMakeDefaultCameraProvider(item.providerId);
                  },
          }))}
          testId={`project-provider-camera-attached-devices-${providerId}`}
        />
      ) : null}
      {remoteCameraPresentation ? (
        <CameraRemoteDevicePanel
          selectedDevice={selectedDevice}
          device={remoteCameraDevice}
          testId={`project-provider-camera-remote-device-${providerId}`}
        />
      ) : null}
    </>
  );
}
