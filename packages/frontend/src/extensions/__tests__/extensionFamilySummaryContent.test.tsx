import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ExtensionFamilySummaryContent,
  hasExtensionFamilySummaryContent,
} from "../extensionFamilySummaryContent";
import type { ExtensionsPanelRowModel } from "../../screens/studio/components/extensionsPanelRowModel";

function createBaseModel(): ExtensionsPanelRowModel {
  return {
    entry: {
      provider: {
        id: "camera:pixel-test",
        title: "Camera",
        capabilityIds: ["camera_observation"],
      },
      source: "project_integration",
      integration: null,
      mutationProviderId: "camera:pixel-test",
      discoverable: false,
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
    connectionType: "native_runtime",
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
    attachedFamilyCount: 1,
    isFamilyDefault: false,
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
      attachLabel: "Use This Device",
      attachVariant: "primary",
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

describe("ExtensionFamilySummaryContent", () => {
  it("renders remote device caption and attached-remote summary for camera family entries", () => {
    const model: ExtensionsPanelRowModel = {
      ...createBaseModel(),
      attachedRemoteOnly: true,
      attachedRemoteOnlySummary: "Runs on Pixel 9. Keep Instafy open there.",
      remoteCameraPresentation: {
        requestSummary: {
          requestState: "pending",
          text: "Runs on Pixel 9. Keep Instafy open there.",
          compactText: "Pending on Pixel 9.",
          deviceLabel: "Pixel 9",
          hasActiveRequest: true,
          tone: "warning",
          hasRecentFailure: false,
          requiresPermission: false,
          presenceStatus: "offline",
        },
        deviceDetails: {
          label: "Pixel 9",
          platformLabel: "Android",
          stateText: "Offline",
          freshnessText: null,
          presenceStatus: "offline",
        },
        remoteStatus: "offline",
        attachedRemoteOnlySummary: "Runs on Pixel 9. Keep Instafy open there.",
      },
    };

    const html = renderToStaticMarkup(<ExtensionFamilySummaryContent model={model} />);

    expect(html).toContain("Preferred device · Pixel 9 · Android");
    expect(html).toContain("Runs on Pixel 9. Keep Instafy open there.");
    expect(hasExtensionFamilySummaryContent({ model })).toBe(true);
  });

  it("reports no family summary content when the row has no family-specific summary data", () => {
    const model = createBaseModel();
    const html = renderToStaticMarkup(<ExtensionFamilySummaryContent model={model} />);

    expect(html).toBe("");
    expect(hasExtensionFamilySummaryContent({ model })).toBe(false);
  });
});
