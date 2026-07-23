import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExtensionFamilyDetailPanels } from "../extensionFamilyDetailPanels";

describe("ExtensionFamilyDetailPanels", () => {
  it("renders the camera family attached-device list with preferred-device actions", () => {
    const html = renderToStaticMarkup(
      <ExtensionFamilyDetailPanels
        providerId="camera:pixel-test"
        attachedFamilyCount={2}
        familyCameraDeviceItems={[
          {
            providerId: "camera:pixel-test",
            label: "Pixel 9",
            platformLabel: "Android",
            summaryText: "Ready for this space.",
            freshnessText: null,
            tone: "secondary",
            presenceStatus: "online",
            isDefault: false,
            isCurrentDevice: true,
          },
        ]}
        isPending={false}
        onMakeDefaultCameraProvider={vi.fn()}
        remoteCameraPresentation={null}
        selectedDevice={null}
        remoteCameraDevice={null}
      />,
    );

    expect(html).toContain("Camera devices");
    expect(html).toContain("Use for new photos");
    expect(html).toContain("Pixel 9");
  });

  it("renders the camera remote-device panel when remote presentation is available", () => {
    const html = renderToStaticMarkup(
      <ExtensionFamilyDetailPanels
        providerId="camera:pixel-test"
        attachedFamilyCount={1}
        familyCameraDeviceItems={[]}
        isPending={false}
        remoteCameraPresentation={{
          requestSummary: null,
          deviceDetails: {
            label: "iPhone 16",
            platformLabel: "iPhone",
            stateText: "Ready on the phone.",
            freshnessText: "Seen just now.",
            presenceStatus: "online",
          },
          remoteStatus: "ready",
          attachedRemoteOnlySummary: "Runs on iPhone 16.",
        }}
        selectedDevice={{
          transport: "lan",
          identifier: "iphone-16",
          address: "192.168.1.25",
          name: "iPhone 16",
        }}
        remoteCameraDevice={{
          providerId: "camera:pixel-test",
          projectId: "project-1",
          connectedAt: "2026-04-19T10:00:00.000Z",
          lastSeenAt: "2026-04-19T10:05:00.000Z",
          status: "ready",
          metadata: {
            deviceName: "iPhone 16",
            nativePlatform: "ios",
          },
        } as never}
      />,
    );

    expect(html).toContain("Preferred device");
    expect(html).toContain("iPhone 16");
  });
});
