import type { ReactNode } from "react";
import type { ProjectProviderCameraState } from "../camera/cameraProjectState";
import type { CameraStatusSnapshot } from "../camera/types";
import type { ProjectProviderSelectedDevice } from "../capabilities/projectProviderAccess";
import type { LocalProviderSummary } from "../capabilities/localProviderHostClient";
import type { ExtensionDefinition } from "./extensionCatalog";

export type NativeExtensionEntrySource = "host" | "project_integration" | "native_runtime";
// Runtime details are owned and rendered by the trusted extension registration.
// Public composition stores them opaquely and never branches on private schemas.
export type NativeExtensionStatusValue = unknown;

export type NativeExtensionSummaryTone =
  | "muted"
  | "secondary"
  | "warning"
  | "success"
  | "danger";

export type NativeExtensionSummary = {
  tone: NativeExtensionSummaryTone;
  text: string;
};

export type NativeExtensionSurfaceCoverage = {
  setupGuidance: boolean;
  attachmentStatus: boolean;
  runtimeStatus: boolean;
  savedState: boolean;
  availabilityIssue: boolean;
};

export type NativeExtensionSummaryProps = {
  providerId: string;
  attached: boolean;
  selectedDevice: ProjectProviderSelectedDevice | null;
  cameraState: ProjectProviderCameraState;
  runtimeStatus?: NativeExtensionStatusValue;
  runtimeStatusCheckedAt?: string | null;
  auxiliaryStatus?: NativeExtensionStatusValue;
  auxiliaryStatusCheckedAt?: string | null;
  cameraLiveStatus?: CameraStatusSnapshot | null;
  cameraLiveCheckedAt?: string | null;
  refreshNativeCameraStatus?: boolean;
};

export type NativeExtensionSetupPanelProps = {
  providerId: string;
  attached: boolean;
  developerDetailsDefault: boolean;
  allowDeveloperToggle?: boolean;
  surfaceCoverage?: NativeExtensionSurfaceCoverage;
  selectedDevice: ProjectProviderSelectedDevice | null;
  cameraState: ProjectProviderCameraState;
  savePending: boolean;
  onSaveConnectedDevice?: (device: {
    transport: string;
    identifier: string;
    address: string;
    name?: string | null;
    nativePlatform?: "android" | "ios" | null;
    connectedAt: string;
  }) => Promise<void> | void;
  onForgetSavedDevice?: () => Promise<void> | void;
  onRunRuntimeProbe?: () => Promise<unknown> | unknown;
  onRuntimeStatusChange?: (
    providerId: string,
    status: NativeExtensionStatusValue,
  ) => void;
  onAuxiliaryStatusChange?: (
    providerId: string,
    status: NativeExtensionStatusValue,
  ) => void;
  onPersistCameraState?: (state: {
    selectedLens?: ProjectProviderCameraState["selectedLens"];
    lastCapture?: ProjectProviderCameraState["lastCapture"];
  }) => Promise<void> | void;
  onCameraStatusChange?: (providerId: string, status: CameraStatusSnapshot | null) => void;
};

export type NativeExtensionRegistration = {
  definition: ExtensionDefinition;
  runRuntimeProbe?: (input: {
    projectId: string;
    provider: LocalProviderSummary;
  }) => Promise<unknown>;
  formatStateLabel: (input: {
    source: NativeExtensionEntrySource;
    attached: boolean;
    projectName?: string | null;
  }) => string;
  formatSavedStateLabel: (input: {
    selectedDevice: ProjectProviderSelectedDevice | null;
    cameraState: ProjectProviderCameraState;
  }) => string | null;
  formatAttachButtonLabel: (isPending: boolean, source: NativeExtensionEntrySource) => string;
  formatAttachButtonVariant: (source: NativeExtensionEntrySource) => "primary" | "outline";
  formatDetachButtonLabel: (isPending: boolean, source: NativeExtensionEntrySource) => string;
  formatDetailsButtonLabel: (input: {
    attached: boolean;
    expanded: boolean;
    hasManageSurface: boolean;
    needsSetup?: boolean;
  }) => string;
  formatDefaultCaption?: () => string | null;
  summarize: (input: {
    attached: boolean;
    selectedDevice: ProjectProviderSelectedDevice | null;
    cameraState: ProjectProviderCameraState;
    runtimeStatus?: NativeExtensionStatusValue;
    auxiliaryStatus?: NativeExtensionStatusValue;
    cameraLiveStatus?: CameraStatusSnapshot | null;
  }) => NativeExtensionSummary;
  renderSummary: (props: NativeExtensionSummaryProps) => ReactNode;
  renderSetupPanel: (props: NativeExtensionSetupPanelProps) => ReactNode;
};
