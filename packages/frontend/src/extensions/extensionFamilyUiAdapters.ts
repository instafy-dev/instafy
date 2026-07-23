import type { LocalProviderSummary } from "../capabilities/localProviderHostClient";
import type { ProjectProviderSelectedDeviceInput } from "../capabilities/projectProviderAccess";
import type { CameraStatusSnapshot } from "../camera/types";

export type ExtensionFamilyUiAdapter = {
  familyId: string;
  matchesProviderId: (providerId: string | null | undefined) => boolean;
  resolveCurrentNativeProviderId?: (input: {
    nativeRuntimeProviders: LocalProviderSummary[];
    currentNativeCameraStatus: CameraStatusSnapshot | null;
  }) => string | null;
  resolveProjectIntegrationProviderEntryKey?: (input: {
    integrationProviderId: string;
    availableProviderIds: ReadonlySet<string>;
    currentNativeProviderId: string | null;
  }) => string | null;
  buildNativeAttachMetadata?: (input: {
    providerId: string;
    currentNativeCameraStatus: CameraStatusSnapshot | null;
    currentPlatform: string;
  }) => ProjectProviderSelectedDeviceInput | null;
  shouldUseCurrentNativeStatus?: (input: {
    providerId: string;
    source: "host" | "project_integration" | "native_runtime";
    currentNativeProviderId: string | null;
  }) => boolean;
};
