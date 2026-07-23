import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@capacitor/core");
  vi.resetModules();
});

describe("nativeCameraBridge", () => {
  it("returns an unsupported status outside native mobile", async () => {
    vi.doMock("@capacitor/core", () => ({
      Capacitor: {
        getPlatform: () => "web",
      },
      registerPlugin: vi.fn(),
    }));

    const module = await import("../nativeCameraBridge");
    const status = await module.getNativeCameraStatus();

    expect(status.supported).toBe(false);
    expect(status.error).toContain("native mobile");
    expect(status.canCapture).toBe(false);
  });

  it("uses the Android plugin when available", async () => {
    const getStatus = vi.fn().mockResolvedValue({
      supported: true,
      platform: "android",
      backend: "phone_camera",
      permission: "granted",
      permissionGranted: true,
      canCapture: true,
      availableLenses: [{ id: "rear", title: "Rear camera", available: true }],
      selectedLens: "rear",
      lastCapture: null,
    });

    vi.doMock("@capacitor/core", () => ({
      Capacitor: {
        getPlatform: () => "android",
      },
      registerPlugin: vi.fn(() => ({
        getStatus,
        requestCameraPermissions: vi.fn(),
        capturePhoto: vi.fn(),
      })),
    }));

    const module = await import("../nativeCameraBridge");
    const status = await module.getNativeCameraStatus();

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(status.supported).toBe(true);
    expect(status.permissionGranted).toBe(true);
    expect(status.selectedLens).toBe("rear");
  });

  it("uses the iPhone plugin when available", async () => {
    const getStatus = vi.fn().mockResolvedValue({
      supported: true,
      platform: "ios",
      backend: "phone_camera",
      permission: "granted",
      permissionGranted: true,
      canCapture: true,
      availableLenses: [{ id: "front", title: "Front camera", available: true }],
      selectedLens: "front",
      lastCapture: null,
    });

    vi.doMock("@capacitor/core", () => ({
      Capacitor: {
        getPlatform: () => "ios",
      },
      registerPlugin: vi.fn(() => ({
        getStatus,
        requestCameraPermissions: vi.fn(),
        capturePhoto: vi.fn(),
      })),
    }));

    const module = await import("../nativeCameraBridge");
    const status = await module.getNativeCameraStatus();

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(status.supported).toBe(true);
    expect(status.platform).toBe("ios");
    expect(status.selectedLens).toBe("front");
  });

  it("preserves the current native status when capture fails", async () => {
    const getStatus = vi.fn().mockResolvedValue({
      supported: true,
      platform: "android",
      backend: "phone_camera",
      permission: "granted",
      permissionGranted: true,
      canCapture: true,
      availableLenses: [{ id: "rear", title: "Rear camera", available: true }],
      selectedLens: "rear",
      lastCapture: {
        captureId: "capture-1",
        backend: "phone_camera",
        lens: "rear",
        capturedAt: new Date(0).toISOString(),
      },
    });
    const capturePhoto = vi.fn().mockRejectedValue(new Error("camera unavailable"));

    vi.doMock("@capacitor/core", () => ({
      Capacitor: {
        getPlatform: () => "android",
      },
      registerPlugin: vi.fn(() => ({
        getStatus,
        requestCameraPermissions: vi.fn(),
        capturePhoto,
      })),
    }));

    const module = await import("../nativeCameraBridge");
    const result = await module.captureNativeCameraPhoto({ lens: "rear" });

    expect(capturePhoto).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(result.error).toContain("camera unavailable");
    expect(result.canCapture).toBe(true);
    expect(result.capture?.captureId).toBe("capture-1");
  });
});
