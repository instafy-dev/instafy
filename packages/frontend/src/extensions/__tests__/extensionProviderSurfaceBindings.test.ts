import { describe, expect, it } from "vitest";
import { buildExtensionProviderHostSectionBindings } from "../extensionProviderSurfaceBindings";
import type { ExtensionsPanelRowModel } from "../../screens/studio/components/extensionsPanelRowModel";

function createBaseModel(): ExtensionsPanelRowModel {
  return {
    entry: {
      provider: {
        id: "camera:pixel-test",
        title: "Camera",
        capabilityIds: ["camera_observation"],
        discoverable: true,
      },
      source: "host",
      integration: null,
      mutationProviderId: "camera:pixel-test",
      discoverable: true,
      attached: true,
      selectedDevice: {
        identifier: "pixel-device",
        name: "Pixel 9",
        address: "192.168.1.10",
        transport: "lan",
      },
      cameraState: {
        selectedLens: "rear",
        lastCapture: null,
        updatedAt: null,
      },
      assistantDefinitions: [],
      capabilityIds: ["camera_observation"],
      providerCapabilityIds: ["camera_observation"],
      attachedCapabilityIds: ["camera_observation"],
    },
    isPending: false,
    extension: {
      familyId: "camera",
      title: "Camera",
      listDescription: "Camera extension.",
      kind: "sensor",
      providerType: "camera",
      nativeRuntimeProvider: null,
    },
    providerLabel: "Camera",
    connectionType: "local_provider",
    eligibleAssistantLabel: "None yet",
    discoveredCapabilityLabel: "camera_observation",
    projectCapabilityLabel: "camera_observation",
    nativeExtension: null,
    attachedRemoteOnly: false,
    savedNativeStateLabel: null,
    kindLabel: "Sensor",
    hasNativeSetup: false,
    remoteCameraPresentation: null,
    remoteCameraDevice: null,
    attachedFamilyCount: 2,
    isFamilyDefault: true,
    rowPresentation: {
      hasSummaryLine: true,
      hasExpandableDetails: true,
      detailsExpanded: true,
      providerTitle: "Camera · Pixel 9",
      extensionState: "attached",
      statusLabel: "Attached",
      statusTone: "ready",
      detailsButtonLabel: "Close",
      fallbackSummary: "Attached for Kitchen.",
      attachLabel: "Attach",
      attachVariant: "outline",
      detachLabel: "Detach",
    },
    attachedRemoteOnlySummary: null,
    nativeCameraAttachMetadata: null,
    familyCameraDeviceItems: [],
    runtimeStatus: null,
    runtimeStatusCheckedAt: null,
    auxiliaryStatus: null,
    auxiliaryStatusCheckedAt: null,
    cameraLiveStatus: null,
    cameraLiveCheckedAt: null,
    refreshNativeCameraStatus: false,
  };
}

describe("extensionProviderSurfaceBindings", () => {
  it("keeps attachment details in facts without repeating them in the section description", () => {
    const bindings = buildExtensionProviderHostSectionBindings(createBaseModel());
    const attachment = bindings.extension_attachment_status;

    expect(attachment?.description).toBeUndefined();
    expect(attachment?.facts).toEqual([
      { label: "Status", value: "Attached" },
      { label: "Source", value: "Local provider" },
      { label: "Device", value: "Pixel 9" },
      { label: "Preference", value: "Default for new requests" },
    ]);
  });

  it("omits the duplicate runtime state fact while keeping runtime-specific details", () => {
    const bindings = buildExtensionProviderHostSectionBindings(createBaseModel());
    const runtime = bindings.extension_runtime_status;

    expect(runtime?.description).toBe("Available locally.");
    expect(runtime?.facts).toEqual([{ label: "Available", value: "Yes" }]);
  });

  it("labels remote native camera attachments by their provider device instead of this device", () => {
    const baseModel = createBaseModel();
    const bindings = buildExtensionProviderHostSectionBindings({
      ...baseModel,
      entry: {
        ...baseModel.entry,
        source: "project_integration",
        integration: {
          id: "integration-camera-desktop",
          projectId: "project-1",
          provider: "camera:desktop-webcam-1",
          status: "attached",
          connectionType: "native_runtime",
          credentialId: null,
          metadata: {},
          requiredScopes: [],
          capabilities: ["camera_observation"],
          createdBy: null,
          createdAt: "2026-04-17T08:00:00.000Z",
          updatedAt: "2026-04-17T08:00:00.000Z",
        },
        mutationProviderId: "camera:desktop-webcam-1",
        selectedDevice: {
          transport: "desktop_webcam",
          identifier: "desktop-camera",
          address: "desktop-camera",
          name: "Desktop webcam",
        },
      },
      connectionType: "native_runtime",
      remoteCameraPresentation: {
        requestSummary: null,
        remoteStatus: "ready",
        attachedRemoteOnlySummary: "Ready on Desktop webcam.",
        deviceDetails: {
          label: "Desktop webcam",
          presenceStatus: "online",
          platformLabel: "Desktop",
          stateText: "Ready · external lens.",
          freshnessText: "Seen just now.",
        },
      },
    } as ExtensionsPanelRowModel);

    expect(bindings.extension_attachment_status?.facts).toContainEqual({
      label: "Source",
      value: "Desktop",
    });
    expect(bindings.extension_attachment_status?.facts).not.toContainEqual({
      label: "Source",
      value: "This device",
    });
  });

  it("keeps setup guidance visible while native setup-backed providers are not attached yet", () => {
    const baseModel = createBaseModel();
    const bindings = buildExtensionProviderHostSectionBindings({
      ...baseModel,
      entry: {
        ...baseModel.entry,
        source: "native_runtime",
        attached: false,
      },
      hasNativeSetup: true,
      nativeExtension: ({
        summarize: () => ({
          tone: "warning",
          text: "Open setup.",
        }),
      } as unknown) as ExtensionsPanelRowModel["nativeExtension"],
    });

    expect(bindings.extension_setup_guidance?.hidden).toBe(false);
  });

  it("hides duplicate setup and attachment sections when the current native device is already attached", () => {
    const baseModel = createBaseModel();
    const bindings = buildExtensionProviderHostSectionBindings({
      ...baseModel,
      entry: {
        ...baseModel.entry,
        source: "native_runtime",
        attached: true,
      },
      hasNativeSetup: true,
      nativeExtension: ({
        summarize: () => ({
          tone: "ready",
          text: "Camera ready on this phone.",
        }),
      } as unknown) as ExtensionsPanelRowModel["nativeExtension"],
    });

    expect(bindings.extension_setup_guidance?.hidden).toBe(true);
    expect(bindings.extension_attachment_status?.hidden).toBe(true);
    expect(bindings.extension_saved_state?.hidden).toBe(true);
  });
});
