import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  callLocalProviderToolMock,
  captureNativeCameraPhotoMock,
  captureNativeCameraPhotoSeriesMock,
  isVirtualCameraCaptureTestArmedMock,
  listControllerProviderDevicesMock,
  listControllerProviderRequestsMock,
  listProjectIntegrationsMock,
  dispatchControllerProviderResourceReadMock,
  dispatchControllerProviderToolCallMock,
  getLocalProviderForCapabilityMock,
  getLocalProviderSummaryMock,
  getNativeCameraStatusMock,
  readLocalProviderResourceMock,
} = vi.hoisted(() => ({
  callLocalProviderToolMock: vi.fn(),
  captureNativeCameraPhotoMock: vi.fn(),
  captureNativeCameraPhotoSeriesMock: vi.fn(),
  isVirtualCameraCaptureTestArmedMock: vi.fn(),
  listControllerProviderDevicesMock: vi.fn(),
  listControllerProviderRequestsMock: vi.fn(),
  listProjectIntegrationsMock: vi.fn(),
  dispatchControllerProviderResourceReadMock: vi.fn(),
  dispatchControllerProviderToolCallMock: vi.fn(),
  getLocalProviderForCapabilityMock: vi.fn(),
  getLocalProviderSummaryMock: vi.fn(),
  getNativeCameraStatusMock: vi.fn(),
  readLocalProviderResourceMock: vi.fn(),
}));

vi.mock("../../capabilities/localProviderHostClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../capabilities/localProviderHostClient")>()),
  callLocalProviderTool: callLocalProviderToolMock,
  getLocalProviderForCapability: getLocalProviderForCapabilityMock,
  getLocalProviderSummary: getLocalProviderSummaryMock,
  readLocalProviderResource: readLocalProviderResourceMock,
}));

vi.mock("../../services/runtimeController/providerRequests", () => ({
  dispatchControllerProviderResourceRead: dispatchControllerProviderResourceReadMock,
  dispatchControllerProviderToolCall: dispatchControllerProviderToolCallMock,
  listControllerProviderRequests: listControllerProviderRequestsMock,
}));

vi.mock("../../services/runtimeController/providerDevices", () => ({
  listControllerProviderDevices: listControllerProviderDevicesMock,
}));

vi.mock("../nativeCameraBridge", () => ({
  captureNativeCameraPhoto: captureNativeCameraPhotoMock,
  captureNativeCameraPhotoSeries: captureNativeCameraPhotoSeriesMock,
  getNativeCameraStatus: getNativeCameraStatusMock,
  isVirtualCameraCaptureTestArmed: isVirtualCameraCaptureTestArmedMock,
}));

vi.mock("../../sdk/instafy", () => ({
  controllerClient: {
    integrations: {
      listForProject: listProjectIntegrationsMock,
    },
  },
}));

import {
  createNativeCameraExecutionContext,
  captureProviderPhoto,
  captureProviderPhotoSeries,
  readCameraProviderStatus,
} from "../cameraBridgeClient";

describe("cameraBridgeClient", () => {
  beforeEach(() => {
    vi.useRealTimers();
    callLocalProviderToolMock.mockReset();
    captureNativeCameraPhotoMock.mockReset();
    captureNativeCameraPhotoSeriesMock.mockReset();
    isVirtualCameraCaptureTestArmedMock.mockReset();
    isVirtualCameraCaptureTestArmedMock.mockReturnValue(false);
    listControllerProviderDevicesMock.mockReset();
    listControllerProviderRequestsMock.mockReset();
    listProjectIntegrationsMock.mockReset();
    dispatchControllerProviderResourceReadMock.mockReset();
    dispatchControllerProviderToolCallMock.mockReset();
    getLocalProviderForCapabilityMock.mockReset();
    getLocalProviderSummaryMock.mockReset();
    getNativeCameraStatusMock.mockReset();
    readLocalProviderResourceMock.mockReset();

    getNativeCameraStatusMock.mockResolvedValue({
      supported: false,
      platform: "web",
      backend: "phone_camera",
      deviceId: null,
      deviceLabel: null,
      providerId: null,
      permission: "denied",
      permissionGranted: false,
      canCapture: false,
      availableLenses: [],
      selectedLens: null,
      lastCapture: null,
    });
    getLocalProviderSummaryMock.mockResolvedValue(null);
    getLocalProviderForCapabilityMock.mockResolvedValue(null);
    listControllerProviderDevicesMock.mockResolvedValue([]);
    listControllerProviderRequestsMock.mockResolvedValue([]);
    listProjectIntegrationsMock.mockResolvedValue({
      success: true,
      integrations: [],
    });
  });

  it("creates a native camera execution context from mobile camera status", () => {
    const context = createNativeCameraExecutionContext("camera", {
      supported: true,
      platform: "ios",
      backend: "phone_camera",
      deviceId: "iphone-main",
      deviceLabel: "Marcus iPhone",
      providerId: "camera",
      permission: "granted",
      permissionGranted: true,
      canCapture: true,
      availableLenses: [{ id: "rear", title: "Rear camera", available: true }],
      selectedLens: "rear",
      lastCapture: null,
    });

    expect(context).toEqual({
      providerId: "camera",
      providerType: "phone_camera",
      runtime: {
        backendId: "phone_camera",
        transportKind: "native_camera",
        transportTarget: "iphone-main",
        executionSurface: "ios",
      },
    });
  });

  it("dispatches a remote camera status read when no local provider is discoverable", async () => {
    dispatchControllerProviderResourceReadMock.mockResolvedValue({
      ok: true,
      providerId: "camera:android-test-device",
      uri: "instafy://camera/status",
      exists: true,
      value: {
        supported: true,
        platform: "android",
        backend: "phone_camera",
        deviceId: "android-test-device",
        deviceLabel: "Pixel Test",
        providerId: "camera:android-test-device",
        permission: "granted",
        permissionGranted: true,
        canCapture: true,
        availableLenses: [{ id: "front", title: "Front camera", available: true }],
        selectedLens: "front",
        lastCapture: null,
      },
    });

    const status = await readCameraProviderStatus({
      projectId: "project-1",
      providerId: "camera:android-test-device",
    });

    expect(dispatchControllerProviderResourceReadMock).toHaveBeenCalledWith({
      projectId: "project-1",
      providerId: "camera:android-test-device",
      uri: "instafy://camera/status",
    });
    expect(status).toMatchObject({
      supported: true,
      platform: "android",
      selectedLens: "front",
    });
  });

  it("dispatches a remote camera tool call when no local provider is discoverable", async () => {
    dispatchControllerProviderToolCallMock.mockResolvedValue({
      ok: true,
      providerId: "camera:android-test-device",
      name: "instafy.camera.capture_photo",
      value: {
        supported: true,
        platform: "android",
        backend: "phone_camera",
        deviceId: "android-test-device",
        deviceLabel: "Pixel Test",
        providerId: "camera:android-test-device",
        permission: "granted",
        permissionGranted: true,
        canCapture: true,
        availableLenses: [{ id: "front", title: "Front camera", available: true }],
        selectedLens: "front",
        lastCapture: null,
        cancelled: false,
        capture: {
          captureId: "capture-1",
          backend: "phone_camera",
          lens: "front",
          capturedAt: "2026-04-01T10:00:00.000Z",
        },
      },
      executionContext: {
        providerId: "camera:android-test-device",
        runtime: {
          backendId: "phone_camera",
        },
      },
    });

    const response = await captureProviderPhoto({
      projectId: "project-1",
      providerId: "camera:android-test-device",
      lens: "front",
    });

    expect(dispatchControllerProviderToolCallMock).toHaveBeenCalledWith({
      projectId: "project-1",
      providerId: "camera:android-test-device",
      name: "instafy.camera.capture_photo",
      argumentsValue: {
        lens: "front",
      },
      timeoutMs: 75000,
    });
    expect(response.result.capture?.captureId).toBe("capture-1");
    expect(response.executionContext).toMatchObject({
      providerId: "camera:android-test-device",
    });
  });

  it("prefers remote camera capture over the local stub when a native phone is attached", async () => {
    getLocalProviderSummaryMock.mockResolvedValue({
      id: "camera",
      providerType: "phone_camera",
    });
    listProjectIntegrationsMock.mockResolvedValue({
      success: true,
      integrations: [
        {
          id: "integration-camera-native",
          projectId: "project-1",
          provider: "camera",
          status: "attached",
          connectionType: "native_runtime",
          credentialId: null,
          metadata: {
            attached: true,
            enabled: true,
            selectedDevice: {
              transport: "native_camera",
              identifier: "iphone-main",
              address: "iphone-main",
              name: "Marcus iPhone",
              nativePlatform: "ios",
            },
          },
          requiredScopes: [],
          capabilities: ["camera_observation"],
          createdBy: null,
          createdAt: "2026-04-01T12:00:00.000Z",
          updatedAt: "2026-04-01T12:00:00.000Z",
        },
      ],
    });
    dispatchControllerProviderToolCallMock.mockResolvedValue({
      ok: true,
      providerId: "camera",
      name: "instafy.camera.capture_photo",
      value: {
        supported: true,
        platform: "ios",
        backend: "phone_camera",
        deviceId: "iphone-main",
        deviceLabel: "Marcus iPhone",
        providerId: "camera",
        permission: "granted",
        permissionGranted: true,
        canCapture: true,
        availableLenses: [{ id: "front", title: "Front camera", available: true }],
        selectedLens: "front",
        lastCapture: null,
        cancelled: false,
        capture: {
          captureId: "capture-remote-1",
          backend: "phone_camera",
          lens: "front",
          capturedAt: "2026-04-01T10:00:00.000Z",
        },
      },
      executionContext: {
        providerId: "camera",
        runtime: {
          backendId: "phone_camera",
        },
      },
    });

    const response = await captureProviderPhoto({
      projectId: "project-1",
      providerId: "camera",
      lens: "front",
    });

    expect(dispatchControllerProviderToolCallMock).toHaveBeenCalledWith({
      projectId: "project-1",
      providerId: "camera",
      name: "instafy.camera.capture_photo",
      argumentsValue: {
        lens: "front",
      },
      timeoutMs: 75000,
    });
    expect(callLocalProviderToolMock).not.toHaveBeenCalled();
    expect(response.result.capture?.captureId).toBe("capture-remote-1");
  });

  it("reports remote request status updates while waiting on another device", async () => {
    vi.useFakeTimers();

    let resolveToolCall: (value: unknown) => void = () => {
      throw new Error("Expected remote tool call to be pending.");
    };
    dispatchControllerProviderToolCallMock.mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          resolveToolCall = resolve;
        }),
    );
    listProjectIntegrationsMock.mockResolvedValue({
      success: true,
      integrations: [
        {
          id: "integration-camera-remote",
          projectId: "project-1",
          provider: "camera:android-test-device",
          status: "connected",
          connectionType: "native_runtime",
          credentialId: null,
          metadata: {
            attached: true,
            selectedDevice: {
              transport: "native_camera",
              identifier: "android-test-device",
              address: "android-test-device",
              name: "Marcus phone",
              nativePlatform: "android",
            },
          },
          requiredScopes: [],
          capabilities: ["camera_observation"],
          createdBy: null,
          createdAt: "2026-04-01T12:00:00.000Z",
          updatedAt: "2026-04-01T12:00:00.000Z",
        },
      ],
    });
    listControllerProviderDevicesMock.mockResolvedValue([
      {
        projectId: "project-1",
        providerId: "camera:android-test-device",
        providerFamilyId: "camera",
        deviceId: "android-test-device",
        deviceLabel: "Marcus phone",
        platform: "android",
        status: "ready",
        connectionType: "native_runtime",
        metadata: {
          permissionGranted: true,
        },
        presenceStatus: "online",
        createdAt: "2026-04-01T12:00:00.000Z",
        updatedAt: "2026-04-01T12:00:00.000Z",
        lastSeenAt: "2026-04-01T12:00:00.000Z",
      },
    ]);
    listControllerProviderRequestsMock
      .mockResolvedValueOnce([
        {
          id: "request-1",
          projectId: "project-1",
          providerId: "camera:android-test-device",
          requestKind: "tool_call",
          toolName: "instafy.camera.capture_photo",
          arguments: {
            lens: "front",
          },
          status: "pending",
          createdAt: "2026-04-01T12:00:00.000Z",
          updatedAt: "2026-04-01T12:00:01.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "request-1",
          projectId: "project-1",
          providerId: "camera:android-test-device",
          requestKind: "tool_call",
          toolName: "instafy.camera.capture_photo",
          arguments: {
            lens: "front",
          },
          status: "claimed",
          claimedByDeviceLabel: "Marcus phone",
          createdAt: "2026-04-01T12:00:00.000Z",
          claimedAt: "2026-04-01T12:00:02.000Z",
          updatedAt: "2026-04-01T12:00:02.000Z",
        },
      ]);

    const summaries: string[] = [];
    const responsePromise = captureProviderPhoto({
      projectId: "project-1",
      providerId: "camera:android-test-device",
      lens: "front",
      onRemoteRequestSummary: (summary) => {
        summaries.push(summary.text);
      },
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(listControllerProviderRequestsMock).toHaveBeenCalled();
    expect(summaries).toContain("Waiting for Marcus phone to accept the front selfie request.");

    await vi.advanceTimersByTimeAsync(1_300);
    expect(summaries).toContain("Marcus phone is capturing now.");

    const completeToolCall = resolveToolCall as ((value: unknown) => void) | null;
    if (!completeToolCall) {
      throw new Error("Expected remote camera tool call resolver to be set.");
    }

    completeToolCall({
      ok: true,
      providerId: "camera:android-test-device",
      name: "instafy.camera.capture_photo",
      value: {
        supported: true,
        platform: "android",
        backend: "phone_camera",
        deviceId: "android-test-device",
        deviceLabel: "Marcus phone",
        providerId: "camera:android-test-device",
        permission: "granted",
        permissionGranted: true,
        canCapture: true,
        availableLenses: [{ id: "front", title: "Front camera", available: true }],
        selectedLens: "front",
        lastCapture: null,
        cancelled: false,
        capture: {
          captureId: "capture-2",
          backend: "phone_camera",
          lens: "front",
          capturedAt: "2026-04-01T12:00:03.000Z",
        },
      },
      executionContext: {
        providerId: "camera:android-test-device",
        runtime: {
          backendId: "phone_camera",
        },
      },
    });

    const response = await responsePromise;
    expect(response.result.capture?.captureId).toBe("capture-2");
  });

  describe("armed virtual-camera seam short-circuit", () => {
    const VIRTUAL_CAPTURE_RESULT = {
      supported: true,
      platform: "virtual",
      backend: "virtual_camera",
      deviceId: "virtual-camera-test",
      deviceLabel: "Virtual test camera",
      providerId: "camera:virtual-camera-test",
      permission: "granted",
      permissionGranted: true,
      canCapture: true,
      availableLenses: [{ id: "front", title: "Virtual test lens", available: true }],
      selectedLens: "front",
      lastCapture: null,
      cancelled: false,
      capture: {
        captureId: "virtual-camera-capture-1",
        backend: "virtual_camera",
        lens: "front",
        capturedAt: "2026-07-21T10:00:00.000Z",
        webPath: "blob:virtual-camera-capture-1",
      },
    };

    it("captures via the seam even when the provider id mismatches the virtual identity", async () => {
      isVirtualCameraCaptureTestArmedMock.mockReturnValue(true);
      captureNativeCameraPhotoMock.mockResolvedValue(VIRTUAL_CAPTURE_RESULT);

      // Project-scoped run against an ATTACHED remote provider id: without the
      // short-circuit this would resolve integrations and dispatch a remote
      // capture (or deny) because camera:virtual-camera-test never matches.
      const response = await captureProviderPhoto({
        projectId: "project-1",
        providerId: "camera:android-test-device",
        lens: "front",
      });

      expect(captureNativeCameraPhotoMock).toHaveBeenCalledWith({ lens: "front" });
      expect(response.result.capture?.captureId).toBe("virtual-camera-capture-1");
      expect(response.executionContext).toMatchObject({
        providerId: "camera:virtual-camera-test",
      });
      // No provider resolution, remote dispatch, or local tool call happened.
      expect(listProjectIntegrationsMock).not.toHaveBeenCalled();
      expect(dispatchControllerProviderToolCallMock).not.toHaveBeenCalled();
      expect(callLocalProviderToolMock).not.toHaveBeenCalled();
      expect(getLocalProviderSummaryMock).not.toHaveBeenCalled();
    });

    it("short-circuits photo series captures the same way", async () => {
      isVirtualCameraCaptureTestArmedMock.mockReturnValue(true);
      captureNativeCameraPhotoSeriesMock.mockResolvedValue({
        ...VIRTUAL_CAPTURE_RESULT,
        requestedCount: 2,
        completedCount: 2,
        captures: [
          { ...VIRTUAL_CAPTURE_RESULT.capture, seriesIndex: 0 },
          { ...VIRTUAL_CAPTURE_RESULT.capture, captureId: "virtual-camera-capture-2", seriesIndex: 1 },
        ],
      });

      const response = await captureProviderPhotoSeries({
        projectId: "project-1",
        providerId: "camera:android-test-device",
        lens: "front",
        count: 2,
      });

      expect(captureNativeCameraPhotoSeriesMock).toHaveBeenCalledWith({
        lens: "front",
        count: 2,
      });
      expect(response.result.captures).toHaveLength(2);
      expect(dispatchControllerProviderToolCallMock).not.toHaveBeenCalled();
      expect(callLocalProviderToolMock).not.toHaveBeenCalled();
    });

    it("falls through to the normal provider routing when the seam is not armed", async () => {
      isVirtualCameraCaptureTestArmedMock.mockReturnValue(false);
      dispatchControllerProviderToolCallMock.mockResolvedValue({
        ok: true,
        providerId: "camera:android-test-device",
        name: "instafy.camera.capture_photo",
        value: {
          ...VIRTUAL_CAPTURE_RESULT,
          backend: "phone_camera",
          capture: { ...VIRTUAL_CAPTURE_RESULT.capture, captureId: "capture-remote-9" },
        },
      });

      const response = await captureProviderPhoto({
        projectId: "project-1",
        providerId: "camera:android-test-device",
        lens: "front",
      });

      expect(captureNativeCameraPhotoMock).not.toHaveBeenCalled();
      expect(response.result.capture?.captureId).toBe("capture-remote-9");
    });
  });
});
