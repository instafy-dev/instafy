import type {
  ProviderManifest,
  ProviderResourceAliases,
  ProviderSummary,
  ProviderToolAliases,
} from "./index.js";

export type BuiltInProviderExtensionDefinition = {
  listDescription: string;
  kind: string;
  nativeRuntimeProvider: ProviderSummary;
  nativeRuntimeUi?: BuiltInProviderNativeRuntimeUiDefinition;
  shellUi?: BuiltInProviderExtensionShellUiDefinition;
};

export type BuiltInProviderExtensionShellUiDefinition = {
  supportsRemoteDeviceUi?: boolean;
  supportsAttachedDeviceList?: boolean;
  attachedDeviceFamilyId?: string;
  appendDeviceLabelWhenMultipleAttached?: boolean;
};

export type BuiltInProviderNativeRuntimeActionDefinition = {
  label: string;
  pendingLabel: string;
  nativeRuntimeLabel?: string;
  nativeRuntimePendingLabel?: string;
  nativeRuntimeVariant?: "primary" | "outline";
};

export type BuiltInProviderNativeRuntimeDetailsActionDefinition = {
  setupLabel: string;
  manageLabel: string;
  hideLabel: string;
};

export type BuiltInProviderNativeRuntimeUiDefinition = {
  stateLabels: {
    attached: string;
    detached: string;
    nativeAttached: string;
    nativeDetached: string;
  };
  attachAction: BuiltInProviderNativeRuntimeActionDefinition;
  detachAction: BuiltInProviderNativeRuntimeActionDefinition;
  detailsAction?: BuiltInProviderNativeRuntimeDetailsActionDefinition;
  savedDeviceLabel?: string;
};

export type BuiltInProviderFamilyDefinition = {
  id: string;
  title: string;
  description: string;
  kind: string;
  providerType: string;
  rootUri: string;
  transportProbeSupported: boolean;
  capabilityIds: readonly string[];
  toolAliases: ProviderToolAliases;
  resourceAliases: ProviderResourceAliases;
  manifest: ProviderManifest;
  extension?: BuiltInProviderExtensionDefinition;
};

export const CAMERA_PROVIDER_ID: "camera";
export const CAMERA_PROVIDER_TITLE: "Camera";
export const CAMERA_PROVIDER_DESCRIPTION: string;
export const CAMERA_PROVIDER_KIND: "sensor";
export const CAMERA_PROVIDER_TYPE: "phone_camera";
export const CAMERA_OBSERVATION_CAPABILITY_ID: "camera_observation";
export const CAMERA_CAPTURE_PHOTO_TOOL_ID: "instafy.camera.capture_photo";
export const CAMERA_CAPTURE_PHOTO_SERIES_TOOL_ID: "instafy.camera.capture_photo_series";
export const CAMERA_STATUS_RESOURCE_URI: "instafy://camera/status";
export const CAMERA_LENSES_RESOURCE_URI: "instafy://camera/lenses";
export const CAMERA_LATEST_CAPTURE_RESOURCE_URI: "instafy://camera/latest-capture";

export const SPEECH_PROVIDER_ID: "speech";
export const SPEECH_PROVIDER_TITLE: "Speech";
export const SPEECH_PROVIDER_DESCRIPTION: string;
export const SPEECH_PROVIDER_KIND: "speech_service";
export const SPEECH_PROVIDER_TYPE: "speech";
export const SPEECH_TRANSCRIPTION_CAPABILITY_ID: "speech_transcription";
export const SPEECH_SYNTHESIS_CAPABILITY_ID: "speech_synthesis";
export const SPEECH_TRANSCRIBE_AUDIO_TOOL_ID: "instafy.speech.transcribe_audio";
export const SPEECH_SYNTHESIZE_SPEECH_TOOL_ID: "instafy.speech.synthesize_speech";
export const SPEECH_BOOTSTRAP_HOST_DEPENDENCIES_TOOL_ID: "instafy.speech.bootstrap_host_dependencies";
export const SPEECH_STATUS_RESOURCE_URI: "instafy://speech/status";
export const SPEECH_VOICES_RESOURCE_URI: "instafy://speech/voices";
export const SPEECH_HOST_DEPENDENCY_STATUS_RESOURCE_URI: "instafy://speech/dependencies";

export const CAMERA_PROVIDER_FAMILY: BuiltInProviderFamilyDefinition;
export const SPEECH_PROVIDER_FAMILY: BuiltInProviderFamilyDefinition;
export const BUILT_IN_PROVIDER_FAMILIES: readonly BuiltInProviderFamilyDefinition[];
export const BUILT_IN_EXTENSION_PROVIDER_FAMILIES: readonly BuiltInProviderFamilyDefinition[];
export const BUILT_IN_PROVIDER_FAMILIES_BY_ID: Readonly<
  Record<string, BuiltInProviderFamilyDefinition>
>;
