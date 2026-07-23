import { CAMERA_PROVIDER_FAMILY } from "@instafy/provider-contract/builtins";
import { Capacitor } from "@capacitor/core";
import type { ProjectProviderSelectedDevice } from "../capabilities/projectProviderAccess";
import { getProjectProviderFamilyId } from "../capabilities/projectProviderAccess";
import type { CameraStatusSnapshot } from "../camera/types";
import {
  resolveCameraExtensionRemotePresentation,
  type CameraExtensionAttachedDeviceItem,
  type CameraExtensionRemotePresentation,
} from "./cameraExtensionFamilyPresentation";
import {
  buildExtensionNativeAttachMetadata,
  supportsExtensionRemoteDeviceUi,
} from "./extensionFamilyUiRegistry";
import type { ControllerProjectIntegration } from "../services/runtimeController/integrations";
import type { ControllerProviderRequestRecord } from "../services/runtimeController";
import type { ControllerProviderDeviceRecord } from "../services/runtimeController/providerDevices";

type ExtensionRowSource = "host" | "project_integration" | "native_runtime";

export type ExtensionFamilyRowSupport = {
  attachedRemoteOnly: boolean;
  remoteCameraPresentation: CameraExtensionRemotePresentation | null;
  remoteCameraDevice: ControllerProviderDeviceRecord | null;
  attachedFamilyCount: number;
  attachedRemoteOnlySummary: string | null;
  nativeCameraAttachMetadata: ReturnType<typeof buildExtensionNativeAttachMetadata> | null;
  familyCameraDeviceItems: CameraExtensionAttachedDeviceItem[];
};

type BuildExtensionFamilyRowSupportInput = {
  providerId: string;
  mutationProviderId: string;
  source: ExtensionRowSource;
  integration: ControllerProjectIntegration | null;
  attached: boolean;
  discoverable: boolean;
  selectedDevice: ProjectProviderSelectedDevice | null;
  currentNativeCameraStatus: CameraStatusSnapshot | null;
  remoteCameraRequestsByProvider: Record<string, ControllerProviderRequestRecord[]>;
  remoteCameraDevicesByProvider: Record<string, ControllerProviderDeviceRecord>;
  attachedExtensionFamilyCounts: Map<string, number>;
  cameraAttachedDeviceItems: CameraExtensionAttachedDeviceItem[];
};

function isAttachedOnAnotherDevice(input: BuildExtensionFamilyRowSupportInput) {
  return (
    input.attached &&
    !input.discoverable &&
    input.source === "project_integration" &&
    input.integration?.connectionType.trim().toLowerCase() === "native_runtime" &&
    input.selectedDevice !== null
  );
}

export function buildExtensionFamilyRowSupport(
  input: BuildExtensionFamilyRowSupportInput,
): ExtensionFamilyRowSupport {
  const familyId =
    getProjectProviderFamilyId(input.mutationProviderId) ?? input.mutationProviderId;
  const attachedRemoteOnly = isAttachedOnAnotherDevice(input);
  const remoteCameraPresentation = supportsExtensionRemoteDeviceUi(input.mutationProviderId)
    ? resolveCameraExtensionRemotePresentation({
        attachedRemoteOnly,
        providerId: input.mutationProviderId,
        selectedDevice: input.selectedDevice,
        remoteCameraDevicesByProvider: input.remoteCameraDevicesByProvider,
        remoteCameraRequestsByProvider: input.remoteCameraRequestsByProvider,
      })
    : null;

  return {
    attachedRemoteOnly,
    remoteCameraPresentation,
    remoteCameraDevice: input.remoteCameraDevicesByProvider[input.mutationProviderId] ?? null,
    attachedFamilyCount: input.attachedExtensionFamilyCounts.get(familyId) ?? 0,
    attachedRemoteOnlySummary: attachedRemoteOnly
      ? remoteCameraPresentation?.attachedRemoteOnlySummary ?? null
      : null,
    nativeCameraAttachMetadata:
      input.source === "native_runtime"
        ? buildExtensionNativeAttachMetadata({
            providerId: input.providerId,
            currentNativeCameraStatus: input.currentNativeCameraStatus,
            currentPlatform: Capacitor.getPlatform(),
          })
        : null,
    familyCameraDeviceItems:
      familyId === CAMERA_PROVIDER_FAMILY.id ? input.cameraAttachedDeviceItems : [],
  };
}
