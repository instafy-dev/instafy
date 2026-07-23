import type { CapabilityId } from "@instafy/sdk/capabilities";
import type { LocalProviderSummary } from "../../../capabilities/localProviderHostClient";
import type { ProjectProviderCameraState } from "../../../camera/cameraProjectState";
import type { ControllerProjectIntegration } from "../../../services/runtimeController/integrations";
import type {
  NativeExtensionSetupPanelProps,
  NativeExtensionStatusValue,
} from "../../../extensions/nativeExtensionTypes";
import type { CameraStatusSnapshot } from "../../../camera/types";
import type { ProjectProviderSelectedDevice } from "../../../capabilities/projectProviderAccess";

type RememberProviderDevice = (
  provider: LocalProviderSummary,
  providerId: string,
  capabilityIds: CapabilityId[],
  integration: ControllerProjectIntegration | null,
  connectionType: string,
  device: {
    transport?: string | null;
    identifier: string;
    address?: string | null;
    name?: string | null;
    nativePlatform?: "android" | "ios" | null;
    lastConnectedAt?: string | null;
  },
) => Promise<void>;

type ForgetProviderDevice = (
  provider: LocalProviderSummary,
  providerId: string,
  capabilityIds: CapabilityId[],
  integration: ControllerProjectIntegration | null,
  connectionType: string,
) => Promise<void>;

type PersistCameraState = (
  provider: LocalProviderSummary,
  providerId: string,
  capabilityIds: CapabilityId[],
  integration: ControllerProjectIntegration | null,
  connectionType: string,
  state: {
    selectedLens?: ProjectProviderCameraState["selectedLens"];
    lastCapture?: ProjectProviderCameraState["lastCapture"];
  },
) => Promise<void>;

type BuildExtensionsPanelNativeSetupPanelPropsInput = {
  provider: LocalProviderSummary;
  mutationProviderId: string;
  capabilityIds: CapabilityId[];
  integration: ControllerProjectIntegration | null;
  connectionType: string;
  attached: boolean;
  developerDetailsDefault: boolean;
  surfaceCoverage: NativeExtensionSetupPanelProps["surfaceCoverage"];
  selectedDevice: ProjectProviderSelectedDevice | null;
  cameraState: ProjectProviderCameraState;
  savePending: boolean;
  onRememberProviderDevice: RememberProviderDevice;
  onForgetProviderDevice: ForgetProviderDevice;
  onRunRuntimeProbe: (provider: LocalProviderSummary) => Promise<unknown>;
  onRuntimeStatusChange: (providerId: string, status: NativeExtensionStatusValue) => void;
  onAuxiliaryStatusChange: (providerId: string, status: NativeExtensionStatusValue) => void;
  onPersistCameraState: PersistCameraState;
  onCameraStatusChange: (providerId: string, status: CameraStatusSnapshot | null) => void;
};

export function buildExtensionsPanelNativeSetupPanelProps(
  input: BuildExtensionsPanelNativeSetupPanelPropsInput,
): NativeExtensionSetupPanelProps {
  return {
    providerId: input.provider.id,
    attached: input.attached,
    developerDetailsDefault: input.developerDetailsDefault,
    allowDeveloperToggle: false,
    surfaceCoverage: input.surfaceCoverage,
    selectedDevice: input.selectedDevice,
    cameraState: input.cameraState,
    savePending: input.savePending,
    onSaveConnectedDevice: input.attached
      ? async (device) => {
          await input.onRememberProviderDevice(
            input.provider,
            input.mutationProviderId,
            input.capabilityIds,
            input.integration,
            input.connectionType,
            {
              transport: device.transport,
              identifier: device.identifier,
              address: device.address,
              name: device.name,
              nativePlatform: device.nativePlatform,
              lastConnectedAt: device.connectedAt,
            },
          );
        }
      : undefined,
    onForgetSavedDevice:
      input.selectedDevice && input.attached
        ? async () => {
            await input.onForgetProviderDevice(
              input.provider,
              input.mutationProviderId,
              input.capabilityIds,
              input.integration,
              input.connectionType,
            );
          }
        : undefined,
    onRunRuntimeProbe:
      input.selectedDevice && input.attached
        ? async () => input.onRunRuntimeProbe(input.provider)
        : undefined,
    onRuntimeStatusChange: input.onRuntimeStatusChange,
    onAuxiliaryStatusChange: input.onAuxiliaryStatusChange,
    onPersistCameraState: input.attached
      ? async (state) => {
          await input.onPersistCameraState(
            input.provider,
            input.mutationProviderId,
            input.capabilityIds,
            input.integration,
            input.connectionType,
            state,
          );
        }
      : undefined,
    onCameraStatusChange: input.onCameraStatusChange,
  };
}
