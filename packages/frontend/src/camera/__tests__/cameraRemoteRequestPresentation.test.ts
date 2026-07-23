import { describe, expect, it } from "vitest";
import {
  formatCameraRequestTimelineLabel,
  formatCameraCapabilityFailureMessage,
  resolveCameraRequestTimelinePresentation,
  resolveCameraRemoteDeviceDetails,
  resolveCameraRemoteRequestSummary,
} from "../cameraRemoteRequestPresentation";

describe("cameraRemoteRequestPresentation", () => {
  it("formats a queued timeline label with the selected phone", () => {
    expect(
      formatCameraRequestTimelineLabel({
        deviceLabel: "Taylor phone",
        requestState: "pending",
        presenceStatus: "online",
      }),
    ).toBe("Waiting on Taylor phone");
  });

  it("formats an offline queued timeline label clearly", () => {
    expect(
      formatCameraRequestTimelineLabel({
        deviceLabel: "Taylor phone",
        requestState: "pending",
        presenceStatus: "offline",
      }),
    ).toBe("Taylor phone is offline");
  });

  it("formats a recent failure timeline label with the device name", () => {
    expect(
      formatCameraRequestTimelineLabel({
        deviceLabel: "Taylor phone",
        hasRecentFailure: true,
      }),
    ).toBe("Last capture on Taylor phone failed");
  });

  it("resolves a loading timeline presentation for active capture", () => {
    expect(
      resolveCameraRequestTimelinePresentation({
        deviceLabel: "Taylor phone",
        requestState: "in_progress",
      }),
    ).toEqual({
      label: "Taylor phone is capturing",
      tone: "secondary",
      showSpinner: true,
    });
  });

  it("resolves a warning timeline presentation for offline waiting", () => {
    expect(
      resolveCameraRequestTimelinePresentation({
        deviceLabel: "Taylor phone",
        requestState: "pending",
        presenceStatus: "offline",
      }),
    ).toEqual({
      label: "Taylor phone is offline",
      tone: "warning",
      showSpinner: true,
    });
  });

  it("summarizes an active remote request with the device label", () => {
    const summary = resolveCameraRemoteRequestSummary({
      selectedDevice: {
        transport: "native_camera",
        identifier: "camera-device-1",
        address: "camera-device-1",
        name: "Taylor phone",
      },
      requests: [
        {
          id: "req-1",
          projectId: "project-1",
          providerId: "camera:camera-device-1",
          requestKind: "tool_call",
          toolName: "instafy.camera.capture_photo",
          arguments: {
            lens: "front",
          },
          status: "claimed",
          createdAt: "2026-04-01T12:00:00.000Z",
          claimedAt: "2026-04-01T12:00:01.000Z",
          updatedAt: "2026-04-01T12:00:02.000Z",
        },
      ],
    });

    expect(summary).toEqual({
      tone: "secondary",
      compactText: "Capturing now.",
      deviceLabel: "Taylor phone",
      hasActiveRequest: true,
      requestState: "in_progress",
      presenceStatus: null,
      requiresPermission: false,
      hasRecentFailure: false,
      text: "Taylor phone is capturing now.",
    });
  });

  it("surfaces a ready online device with the latest capture summary", () => {
    const summary = resolveCameraRemoteRequestSummary({
      selectedDevice: {
        transport: "native_camera",
        identifier: "camera-device-1",
        address: "camera-device-1",
        name: "Taylor phone",
      },
      device: {
        projectId: "project-1",
        providerId: "camera:camera-device-1",
        providerFamilyId: "camera",
        deviceId: "camera-device-1",
        deviceLabel: "Taylor phone",
        platform: "android",
        status: "ready",
        connectionType: "native_runtime",
        metadata: {
          permissionGranted: true,
          selectedLens: "front",
          lastCapture: {
            captureId: "capture-1",
            capturedAt: "2026-04-01T12:04:00.000Z",
            lens: "front",
            width: 3024,
            height: 4032,
          },
        },
        presenceStatus: "online",
        createdAt: "2026-04-01T12:00:00.000Z",
        updatedAt: "2026-04-01T12:04:00.000Z",
        lastSeenAt: "2026-04-01T12:04:00.000Z",
      },
      requests: [],
    });

    expect(summary).toEqual({
      tone: "secondary",
      compactText: "Latest capture · front lens · 3024×4032.",
      deviceLabel: "Taylor phone",
      hasActiveRequest: false,
      requestState: null,
      presenceStatus: "online",
      requiresPermission: false,
      hasRecentFailure: false,
      text: "Ready on Taylor phone · latest capture front lens · 3024×4032.",
    });
  });

  it("flags when the attached phone is online but still needs camera permission", () => {
    const summary = resolveCameraRemoteRequestSummary({
      selectedDevice: {
        transport: "native_camera",
        identifier: "camera-device-1",
        address: "camera-device-1",
        name: "Taylor phone",
      },
      device: {
        projectId: "project-1",
        providerId: "camera:camera-device-1",
        providerFamilyId: "camera",
        deviceId: "camera-device-1",
        deviceLabel: "Taylor phone",
        platform: "ios",
        status: "permission_required",
        connectionType: "native_runtime",
        metadata: {
          permissionGranted: false,
          selectedLens: "front",
        },
        presenceStatus: "online",
        createdAt: "2026-04-01T12:00:00.000Z",
        updatedAt: "2026-04-01T12:04:00.000Z",
        lastSeenAt: "2026-04-01T12:04:00.000Z",
      },
      requests: [],
    });

    expect(summary).toEqual({
      tone: "warning",
      compactText: "Needs camera access.",
      deviceLabel: "Taylor phone",
      hasActiveRequest: false,
      requestState: null,
      presenceStatus: "online",
      requiresPermission: true,
      hasRecentFailure: false,
      text: "Taylor phone needs camera access before it can take new photos.",
    });
  });

  it("flags when the saved camera device is offline", () => {
    const summary = resolveCameraRemoteRequestSummary({
      selectedDevice: {
        transport: "native_camera",
        identifier: "camera-device-1",
        address: "camera-device-1",
        name: "Taylor phone",
      },
      requests: [],
    });

    expect(summary).toEqual({
      tone: "warning",
      compactText: "Offline. Open Instafy on this device.",
      deviceLabel: "Taylor phone",
      hasActiveRequest: false,
      requestState: null,
      presenceStatus: "offline",
      requiresPermission: false,
      hasRecentFailure: false,
      text: "Taylor phone is offline. Open Instafy there to use Camera.",
    });
  });

  it("describes the attached remote phone with freshness and platform details", () => {
    expect(
      resolveCameraRemoteDeviceDetails({
        nowMs: Date.parse("2026-04-01T12:05:00.000Z"),
        selectedDevice: {
          transport: "native_camera",
          identifier: "camera-device-1",
          address: "camera-device-1",
          name: "Taylor phone",
          nativePlatform: "android",
        },
        device: {
          projectId: "project-1",
          providerId: "camera:camera-device-1",
          providerFamilyId: "camera",
          deviceId: "camera-device-1",
          deviceLabel: "Taylor phone",
          platform: "android",
          status: "ready",
          connectionType: "native_runtime",
          metadata: {
            permissionGranted: true,
            lastCapture: {
              captureId: "capture-1",
              capturedAt: "2026-04-01T12:04:00.000Z",
              lens: "rear",
              width: 4032,
              height: 3024,
            },
          },
          presenceStatus: "online",
          createdAt: "2026-04-01T12:00:00.000Z",
          updatedAt: "2026-04-01T12:04:00.000Z",
          lastSeenAt: "2026-04-01T12:04:00.000Z",
        },
      }),
    ).toEqual({
      label: "Taylor phone",
      presenceStatus: "online",
      platformLabel: "Android",
      stateText: "Latest capture · rear lens · 4032×3024.",
      freshnessText: "Seen 1 minute ago.",
    });
  });

  it("keeps a saved remote camera device understandable even when it is offline", () => {
    expect(
      resolveCameraRemoteDeviceDetails({
        nowMs: Date.parse("2026-04-01T12:05:00.000Z"),
        selectedDevice: {
          transport: "native_camera",
          identifier: "camera-device-1",
          address: "camera-device-1",
          name: "Taylor phone",
          nativePlatform: "ios",
          lastConnectedAt: "2026-04-01T12:02:00.000Z",
        },
      }),
    ).toEqual({
      label: "Taylor phone",
      presenceStatus: "offline",
      platformLabel: "iPhone",
      stateText: "Offline. Open Instafy on this device.",
      freshnessText: "Seen 3 minutes ago.",
    });
  });

  it("turns a recent timeout into a concise offline hint", () => {
    const summary = resolveCameraRemoteRequestSummary({
      nowMs: Date.parse("2026-04-01T12:05:00.000Z"),
      selectedDevice: {
        transport: "native_camera",
        identifier: "camera-device-1",
        address: "camera-device-1",
        name: "Taylor phone",
      },
      requests: [
        {
          id: "req-1",
          projectId: "project-1",
          providerId: "camera:camera-device-1",
          requestKind: "tool_call",
          toolName: "instafy.camera.capture_photo",
          arguments: {
            lens: "rear",
          },
          status: "expired",
          error: "Timed out waiting for the provider device to respond.",
          createdAt: "2026-04-01T12:04:00.000Z",
          completedAt: "2026-04-01T12:04:30.000Z",
          updatedAt: "2026-04-01T12:04:30.000Z",
        },
      ],
    });

    expect(summary).toEqual({
      tone: "warning",
      compactText: "Last request timed out. Open Instafy there and try again.",
      deviceLabel: "Taylor phone",
      hasActiveRequest: false,
      requestState: null,
      presenceStatus: null,
      requiresPermission: false,
      hasRecentFailure: true,
      text: "Taylor phone did not answer the rear photo request. Open Instafy there and try again.",
    });
  });

  it("distinguishes a queued request from an active capture", () => {
    const summary = resolveCameraRemoteRequestSummary({
      selectedDevice: {
        transport: "native_camera",
        identifier: "camera-device-1",
        address: "camera-device-1",
        name: "Taylor phone",
      },
      device: {
        projectId: "project-1",
        providerId: "camera:camera-device-1",
        providerFamilyId: "camera",
        deviceId: "camera-device-1",
        deviceLabel: "Taylor phone",
        platform: "android",
        status: "ready",
        connectionType: "native_runtime",
        metadata: {
          permissionGranted: true,
        },
        presenceStatus: "online",
        createdAt: "2026-04-01T12:00:00.000Z",
        updatedAt: "2026-04-01T12:04:00.000Z",
        lastSeenAt: "2026-04-01T12:04:00.000Z",
      },
      requests: [
        {
          id: "req-1",
          projectId: "project-1",
          providerId: "camera:camera-device-1",
          requestKind: "tool_call",
          toolName: "instafy.camera.capture_photo",
          arguments: {
            lens: "rear",
          },
          status: "pending",
          createdAt: "2026-04-01T12:04:00.000Z",
          updatedAt: "2026-04-01T12:04:01.000Z",
        },
      ],
    });

    expect(summary).toEqual({
      tone: "secondary",
      compactText: "Waiting for the rear photo request.",
      deviceLabel: "Taylor phone",
      hasActiveRequest: true,
      requestState: "pending",
      presenceStatus: "online",
      requiresPermission: false,
      hasRecentFailure: false,
      text: "Waiting for Taylor phone to accept the rear photo request.",
    });
  });

  it("formats camera timeout failures for chat", () => {
    expect(
      formatCameraCapabilityFailureMessage({
        assistantDisplayName: "Octo",
        error: "Timed out waiting for the provider device to respond.",
        selectedDevice: {
          transport: "native_camera",
          identifier: "camera-device-1",
          address: "camera-device-1",
          name: "Taylor phone",
        },
      }),
    ).toBe(
      "Octo did not hear back from Camera on Taylor phone. Open Instafy there and try again.",
    );
  });
});
