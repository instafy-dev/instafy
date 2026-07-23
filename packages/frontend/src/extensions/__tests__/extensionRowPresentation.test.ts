import { describe, expect, it } from "vitest";
import { resolveExtensionRowPresentation } from "../extensionRowPresentation";

describe("extensionRowPresentation", () => {
  it("derives native extension row labels and status from the shared presenter", () => {
    const presentation = resolveExtensionRowPresentation({
      attached: false,
      discoverable: true,
      discoveryError: null,
      source: "native_runtime",
      isPending: false,
      activeRequestState: null,
      needsSetup: true,
      attachedRemoteOnly: false,
      remoteStatus: null,
      scopeLabel: "Home",
      providerId: "camera:pixel-test",
      providerTitle: "Camera",
      attachedFamilyCount: 2,
      remoteDeviceLabel: "Pixel Test",
      selectedDeviceLabel: "Pixel Test",
      nativeExtension: {
        formatAttachButtonLabel: () => "Use this phone",
        formatAttachButtonVariant: () => "primary",
        formatDetachButtonLabel: () => "Stop using this phone",
        formatDetailsButtonLabel: () => "Open setup",
      },
      hasNativeSetup: true,
      showDeveloperDetails: false,
      integrationPresent: false,
      kindLabel: "Sensor",
      savedNativeStateLabel: "Saved device: Pixel Test",
      expanded: false,
    });

    expect(presentation).toMatchObject({
      hasSummaryLine: true,
      hasExpandableDetails: true,
      detailsExpanded: false,
      providerTitle: "Camera · Pixel Test",
      statusLabel: "Needs setup",
      statusTone: "attention",
      detailsButtonLabel: "Open setup",
      attachLabel: "Use this phone",
      attachVariant: "primary",
      detachLabel: "Stop using this phone",
    });
    expect(presentation.fallbackSummary).toBe("Finish setup before use.");
  });

  it("derives host fallback rows without native extension bindings", () => {
    const presentation = resolveExtensionRowPresentation({
      attached: true,
      discoverable: true,
      discoveryError: null,
      source: "host",
      isPending: false,
      activeRequestState: null,
      needsSetup: false,
      attachedRemoteOnly: false,
      remoteStatus: null,
      scopeLabel: "Home",
      providerId: "camera",
      providerTitle: "Camera",
      attachedFamilyCount: 1,
      remoteDeviceLabel: null,
      selectedDeviceLabel: null,
      nativeExtension: null,
      hasNativeSetup: false,
      showDeveloperDetails: false,
      integrationPresent: false,
      kindLabel: "Sensor",
      savedNativeStateLabel: null,
      expanded: false,
    });

    expect(presentation).toMatchObject({
      hasSummaryLine: true,
      hasExpandableDetails: false,
      providerTitle: "Camera",
      statusLabel: "Attached",
      statusTone: "ready",
      detailsButtonLabel: "Details",
      attachLabel: "Attach",
      attachVariant: "outline",
      detachLabel: "Detach",
    });
    expect(presentation.fallbackSummary).toBe("Attached for Home.");
  });
});
