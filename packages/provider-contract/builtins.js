import {
  createProviderManifest,
  createProviderSummary,
  createProviderUiSurfaceSpeechDesktopHostActions,
  createProviderUiSurfaceElements,
  createProviderUiSurfacePolicy,
  createProviderUiSurfaceSpeechSettingsControls,
  createProviderUiSurfaceSpeechStatusControls,
  createProviderUiSurfaceExtensionAttachmentAction,
  createProviderUiSurfaceExtensionStatusSections,
  createProviderUiSurfaceFacts,
  createProviderUiSurfaceHighlights,
  createProviderUiSurfaceMetadata,
  createProviderUiSurfaceSection,
} from "./index.js";

export const CAMERA_PROVIDER_ID = "camera";
export const CAMERA_PROVIDER_TITLE = "Camera";
export const CAMERA_PROVIDER_DESCRIPTION =
  "First-party camera observation provider. Native camera capture is available on Android, iPhone, and Instafy Desktop, with room for later browser and virtual-camera backends.";
export const CAMERA_PROVIDER_KIND = "sensor";
export const CAMERA_PROVIDER_TYPE = "phone_camera";
export const CAMERA_OBSERVATION_CAPABILITY_ID = "camera_observation";
export const CAMERA_CAPTURE_PHOTO_TOOL_ID = "instafy.camera.capture_photo";
export const CAMERA_CAPTURE_PHOTO_SERIES_TOOL_ID = "instafy.camera.capture_photo_series";
export const CAMERA_STATUS_RESOURCE_URI = "instafy://camera/status";
export const CAMERA_LENSES_RESOURCE_URI = "instafy://camera/lenses";
export const CAMERA_LATEST_CAPTURE_RESOURCE_URI = "instafy://camera/latest-capture";

export const SPEECH_PROVIDER_ID = "speech";
export const SPEECH_PROVIDER_TITLE = "Speech";
export const SPEECH_PROVIDER_DESCRIPTION =
  "Generic speech provider for self-hosted or tunneled transcription and text-to-speech backends.";
export const SPEECH_PROVIDER_KIND = "speech_service";
export const SPEECH_PROVIDER_TYPE = "speech";
export const SPEECH_TRANSCRIPTION_CAPABILITY_ID = "speech_transcription";
export const SPEECH_SYNTHESIS_CAPABILITY_ID = "speech_synthesis";
export const SPEECH_TRANSCRIBE_AUDIO_TOOL_ID = "instafy.speech.transcribe_audio";
export const SPEECH_SYNTHESIZE_SPEECH_TOOL_ID = "instafy.speech.synthesize_speech";
export const SPEECH_BOOTSTRAP_HOST_DEPENDENCIES_TOOL_ID =
  "instafy.speech.bootstrap_host_dependencies";
export const SPEECH_STATUS_RESOURCE_URI = "instafy://speech/status";
export const SPEECH_VOICES_RESOURCE_URI = "instafy://speech/voices";
export const SPEECH_HOST_DEPENDENCY_STATUS_RESOURCE_URI = "instafy://speech/dependencies";

export const CAMERA_PROVIDER_FAMILY = Object.freeze({
  id: CAMERA_PROVIDER_ID,
  title: CAMERA_PROVIDER_TITLE,
  description: CAMERA_PROVIDER_DESCRIPTION,
  kind: CAMERA_PROVIDER_KIND,
  providerType: CAMERA_PROVIDER_TYPE,
  rootUri: "instafy://camera",
  transportProbeSupported: false,
  capabilityIds: Object.freeze([CAMERA_OBSERVATION_CAPABILITY_ID]),
  toolAliases: Object.freeze({
    capturePhoto: CAMERA_CAPTURE_PHOTO_TOOL_ID,
    capturePhotoSeries: CAMERA_CAPTURE_PHOTO_SERIES_TOOL_ID,
  }),
  resourceAliases: Object.freeze({
    cameraStatus: CAMERA_STATUS_RESOURCE_URI,
    cameraLenses: CAMERA_LENSES_RESOURCE_URI,
    latestCaptureMetadata: CAMERA_LATEST_CAPTURE_RESOURCE_URI,
  }),
  manifest: createProviderManifest({
    familyId: CAMERA_PROVIDER_ID,
    hostSurfaces: [
      {
        surface: "extension_tile",
        title: CAMERA_PROVIDER_TITLE,
        description: "Take photos.",
        capabilityIds: [CAMERA_OBSERVATION_CAPABILITY_ID],
        metadata: createProviderUiSurfaceMetadata({
          kind: CAMERA_PROVIDER_KIND,
          policy: createProviderUiSurfacePolicy({
            trustLevel: "first_party",
            renderMode: "host_declarative",
          }),
          elements: createProviderUiSurfaceElements([
            createProviderUiSurfaceHighlights([
              "Native phone capture",
              "Per-space attachment",
            ]),
            createProviderUiSurfaceFacts([
              {
                label: "Capture modes",
                value: "Single photo or guided series",
              },
              {
                label: "Source",
                value: "Attached device camera",
              },
            ]),
            createProviderUiSurfaceExtensionAttachmentAction(),
            createProviderUiSurfaceExtensionStatusSections({
              setup: {
                items: [
                  "Choose a camera device.",
                  "Enable camera access there.",
                ],
              },
              currentAttachment: {},
              currentRuntime: {},
              savedSetup: {},
              availabilityIssue: {},
            }),
          ]),
        }),
      },
      {
        surface: "detail_view",
        title: "Camera setup",
        description: "Choose a camera device and check readiness.",
        capabilityIds: [CAMERA_OBSERVATION_CAPABILITY_ID],
        metadata: createProviderUiSurfaceMetadata({
          kind: CAMERA_PROVIDER_KIND,
          policy: createProviderUiSurfacePolicy({
            trustLevel: "first_party",
            renderMode: "host_declarative",
          }),
          elements: createProviderUiSurfaceElements([
            createProviderUiSurfaceExtensionAttachmentAction(),
            createProviderUiSurfaceExtensionStatusSections({
              setup: {
                items: [
                  "Choose a camera device and enable access there.",
                ],
              },
              currentAttachment: {},
              currentRuntime: {},
              savedSetup: {},
              availabilityIssue: {},
            }),
          ]),
        }),
      },
    ],
  }),
  extension: Object.freeze({
    listDescription: "Take photos.",
    kind: CAMERA_PROVIDER_KIND,
    shellUi: Object.freeze({
      supportsRemoteDeviceUi: true,
      supportsAttachedDeviceList: true,
      attachedDeviceFamilyId: CAMERA_PROVIDER_ID,
      appendDeviceLabelWhenMultipleAttached: true,
    }),
    nativeRuntimeUi: Object.freeze({
      stateLabels: Object.freeze({
        attached: "Used for {scopeLabel}.",
        detached: "Choose a camera device for {scopeLabel}.",
        nativeAttached: "This device is the camera for {scopeLabel}.",
        nativeDetached: "Use this device for camera captures.",
      }),
      attachAction: Object.freeze({
        label: "Attach camera",
        pendingLabel: "Attaching…",
        nativeRuntimeLabel: "Use this device",
        nativeRuntimePendingLabel: "Using this device…",
        nativeRuntimeVariant: "primary",
      }),
      detachAction: Object.freeze({
        label: "Detach camera",
        pendingLabel: "Detaching…",
        nativeRuntimeLabel: "Stop using this device",
        nativeRuntimePendingLabel: "Stopping…",
      }),
      detailsAction: Object.freeze({
        setupLabel: "Open setup",
        manageLabel: "Manage",
        hideLabel: "Close",
      }),
      savedDeviceLabel: "Preferred device",
    }),
    nativeRuntimeProvider: createProviderSummary({
      id: CAMERA_PROVIDER_ID,
      title: CAMERA_PROVIDER_TITLE,
      description:
        "Use this device for camera captures.",
      providerType: CAMERA_PROVIDER_TYPE,
      kind: CAMERA_PROVIDER_KIND,
      configured: true,
      discoverable: true,
      capabilityIds: [CAMERA_OBSERVATION_CAPABILITY_ID],
      toolIds: [CAMERA_CAPTURE_PHOTO_TOOL_ID, CAMERA_CAPTURE_PHOTO_SERIES_TOOL_ID],
      resourceUris: [
        CAMERA_STATUS_RESOURCE_URI,
        CAMERA_LENSES_RESOURCE_URI,
        CAMERA_LATEST_CAPTURE_RESOURCE_URI,
      ],
      toolAliases: {
        capturePhoto: CAMERA_CAPTURE_PHOTO_TOOL_ID,
        capturePhotoSeries: CAMERA_CAPTURE_PHOTO_SERIES_TOOL_ID,
      },
      resourceAliases: {
        cameraStatus: CAMERA_STATUS_RESOURCE_URI,
        cameraLenses: CAMERA_LENSES_RESOURCE_URI,
        latestCaptureMetadata: CAMERA_LATEST_CAPTURE_RESOURCE_URI,
      },
    }),
  }),
});

export const SPEECH_PROVIDER_FAMILY = Object.freeze({
  id: SPEECH_PROVIDER_ID,
  title: SPEECH_PROVIDER_TITLE,
  description: SPEECH_PROVIDER_DESCRIPTION,
  kind: SPEECH_PROVIDER_KIND,
  providerType: SPEECH_PROVIDER_TYPE,
  rootUri: "instafy://speech",
  transportProbeSupported: false,
  capabilityIds: Object.freeze([
    SPEECH_TRANSCRIPTION_CAPABILITY_ID,
    SPEECH_SYNTHESIS_CAPABILITY_ID,
  ]),
  toolAliases: Object.freeze({
    bootstrapHostDependencies: SPEECH_BOOTSTRAP_HOST_DEPENDENCIES_TOOL_ID,
    transcribeAudio: SPEECH_TRANSCRIBE_AUDIO_TOOL_ID,
    synthesizeSpeech: SPEECH_SYNTHESIZE_SPEECH_TOOL_ID,
  }),
  resourceAliases: Object.freeze({
    hostDependencyStatus: SPEECH_HOST_DEPENDENCY_STATUS_RESOURCE_URI,
    speechStatus: SPEECH_STATUS_RESOURCE_URI,
    speechVoices: SPEECH_VOICES_RESOURCE_URI,
  }),
  manifest: createProviderManifest({
    familyId: SPEECH_PROVIDER_ID,
    hostSurfaces: [
      {
        surface: "settings_card",
        title: "Speech provider",
        description: "Configure speech routing and voices for this space.",
        capabilityIds: [
          SPEECH_TRANSCRIPTION_CAPABILITY_ID,
          SPEECH_SYNTHESIS_CAPABILITY_ID,
        ],
        metadata: createProviderUiSurfaceMetadata({
          kind: SPEECH_PROVIDER_KIND,
          policy: createProviderUiSurfacePolicy({
            trustLevel: "first_party",
            renderMode: "host_declarative",
          }),
          elements: createProviderUiSurfaceElements([
            createProviderUiSurfaceSection({
              binding: {
                hostBindingId: "speech_settings_summary",
              },
            }),
            createProviderUiSurfaceSpeechSettingsControls({
              includeScopeControl: false,
            }),
            createProviderUiSurfaceSpeechDesktopHostActions(),
          ]),
        }),
      },
      {
        surface: "status_card",
        title: "Speech provider status",
        description: "Show the current hosted speech path and readiness.",
        capabilityIds: [
          SPEECH_TRANSCRIPTION_CAPABILITY_ID,
          SPEECH_SYNTHESIS_CAPABILITY_ID,
        ],
        metadata: createProviderUiSurfaceMetadata({
          kind: SPEECH_PROVIDER_KIND,
          policy: createProviderUiSurfacePolicy({
            trustLevel: "first_party",
            renderMode: "host_declarative",
          }),
          elements: createProviderUiSurfaceElements([
            createProviderUiSurfaceSection({
              title: "Connection",
              binding: {
                hostBindingId: "speech_connection_diagnostics",
              },
            }),
            createProviderUiSurfaceSection({
              title: "Readiness",
              binding: {
                hostBindingId: "speech_backend_readiness",
              },
            }),
            createProviderUiSurfaceSpeechStatusControls({
              includeFallbackControl: false,
            }),
          ]),
        }),
      },
    ],
  }),
});

export const BUILT_IN_PROVIDER_FAMILIES = Object.freeze([
  CAMERA_PROVIDER_FAMILY,
  SPEECH_PROVIDER_FAMILY,
]);

export const BUILT_IN_EXTENSION_PROVIDER_FAMILIES = Object.freeze(
  BUILT_IN_PROVIDER_FAMILIES.filter(
    (family) =>
      Boolean(family.extension) ||
      Boolean(
        family.manifest.hostSurfaces?.some(
          (surface) => surface.surface === "extension_tile",
        ),
      ),
  ),
);

export const BUILT_IN_PROVIDER_FAMILIES_BY_ID = Object.freeze(
  Object.fromEntries(
    BUILT_IN_PROVIDER_FAMILIES.map((family) => [family.id, family]),
  ),
);
