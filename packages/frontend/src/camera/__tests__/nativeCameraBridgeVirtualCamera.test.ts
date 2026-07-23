// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// 1x1 PNG fixture; the pixel content is irrelevant for the seam tests.
const TEST_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type VirtualCameraTestController = {
  configure: (options: {
    imageDataUrl: string;
    fileName?: string;
    width?: number;
    height?: number;
    lens?: string;
    captureDelayMs?: number;
    ttlMs?: number;
  }) => Promise<boolean>;
  clear: () => Promise<boolean>;
};

type VirtualCameraTestWindow = Window & {
  __INSTAFY_CAMERA_CAPTURE_TEST__?: VirtualCameraTestController;
};

const createObjectURLMock = vi.fn(() => `blob:virtual-${createObjectURLMock.mock.calls.length}`);
const revokeObjectURLMock = vi.fn();

async function importBridgeOnWebPlatform() {
  vi.doMock("@capacitor/core", () => ({
    Capacitor: {
      getPlatform: () => "web",
    },
    registerPlugin: vi.fn(),
  }));
  // jsdom does not implement object URLs.
  URL.createObjectURL = createObjectURLMock as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURLMock as unknown as typeof URL.revokeObjectURL;
  const module = await import("../nativeCameraBridge");
  const controller = (window as VirtualCameraTestWindow).__INSTAFY_CAMERA_CAPTURE_TEST__;
  if (!controller) {
    throw new Error("The virtual camera test seam was not installed at module scope.");
  }
  return { module, controller };
}

afterEach(() => {
  vi.doUnmock("@capacitor/core");
  vi.resetModules();
  createObjectURLMock.mockClear();
  revokeObjectURLMock.mockClear();
  delete (window as VirtualCameraTestWindow).__INSTAFY_CAMERA_CAPTURE_TEST__;
});

describe("nativeCameraBridge virtual camera test seam", () => {
  it("installs the controller at module scope and stays unsupported until configured", async () => {
    const { module } = await importBridgeOnWebPlatform();

    expect(module.supportsCurrentClientNativeCameraBridge()).toBe(false);
    const status = await module.getNativeCameraStatus();
    expect(status.supported).toBe(false);
    expect(status.backend).not.toBe("virtual_camera");
  });

  it("reports a granted virtual_camera status with one synthetic lens once configured", async () => {
    const { module, controller } = await importBridgeOnWebPlatform();

    await expect(
      controller.configure({
        imageDataUrl: TEST_IMAGE_DATA_URL,
        lens: "front",
      }),
    ).resolves.toBe(true);

    expect(module.supportsCurrentClientNativeCameraBridge()).toBe(true);
    const status = await module.getNativeCameraStatus();
    expect(status.supported).toBe(true);
    expect(status.backend).toBe("virtual_camera");
    expect(status.permission).toBe("granted");
    expect(status.permissionGranted).toBe(true);
    expect(status.canCapture).toBe(true);
    expect(status.availableLenses).toHaveLength(1);
    expect(status.availableLenses[0]).toMatchObject({
      id: "front",
      available: true,
      selected: true,
    });
    expect(status.selectedLens).toBe("front");
  });

  it("rejects a configure call without an imageDataUrl", async () => {
    const { module, controller } = await importBridgeOnWebPlatform();

    await expect(
      controller.configure({ imageDataUrl: "" }),
    ).resolves.toBe(false);
    expect(module.supportsCurrentClientNativeCameraBridge()).toBe(false);
  });

  it("captures a decoded virtual photo with plausible metadata", async () => {
    const { module, controller } = await importBridgeOnWebPlatform();
    await controller.configure({
      imageDataUrl: TEST_IMAGE_DATA_URL,
      fileName: "banana-fixture.png",
      width: 64,
      height: 48,
      lens: "front",
    });

    const result = await module.captureNativeCameraPhoto({ lens: "front" });

    expect(result.cancelled).toBe(false);
    expect(result.backend).toBe("virtual_camera");
    expect(result.capture).not.toBeNull();
    const capture = result.capture!;
    expect(capture.captureId).toMatch(/^virtual-camera-/);
    expect(capture.backend).toBe("virtual_camera");
    expect(capture.lens).toBe("front");
    expect(capture.fileName).toBe("banana-fixture.png");
    expect(capture.width).toBe(64);
    expect(capture.height).toBe(48);
    expect(capture.mimeType).toBe("image/png");
    expect(capture.webPath).toMatch(/^blob:virtual-/);
    expect(typeof capture.sizeBytes).toBe("number");
    expect(capture.sizeBytes).toBeGreaterThan(0);
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);

    const status = await module.getNativeCameraStatus();
    expect(status.lastCapture?.captureId).toBe(capture.captureId);
  });

  it("honors captureDelayMs before returning the capture", async () => {
    const { module, controller } = await importBridgeOnWebPlatform();
    await controller.configure({
      imageDataUrl: TEST_IMAGE_DATA_URL,
      captureDelayMs: 40,
    });

    const startedAt = Date.now();
    const result = await module.captureNativeCameraPhoto();
    const elapsedMs = Date.now() - startedAt;

    expect(result.capture).not.toBeNull();
    expect(elapsedMs).toBeGreaterThanOrEqual(30);
  });

  it("exposes the armed state through isVirtualCameraCaptureTestArmed", async () => {
    const { module, controller } = await importBridgeOnWebPlatform();

    expect(module.isVirtualCameraCaptureTestArmed()).toBe(false);
    await controller.configure({ imageDataUrl: TEST_IMAGE_DATA_URL });
    expect(module.isVirtualCameraCaptureTestArmed()).toBe(true);
    await controller.clear();
    expect(module.isVirtualCameraCaptureTestArmed()).toBe(false);
  });

  it("auto-clears past the ttlMs deadline so a dead smoke cannot leave the seam sticky", async () => {
    const { module, controller } = await importBridgeOnWebPlatform();
    await controller.configure({
      imageDataUrl: TEST_IMAGE_DATA_URL,
      ttlMs: 20,
    });
    expect(module.isVirtualCameraCaptureTestArmed()).toBe(true);
    expect(module.supportsCurrentClientNativeCameraBridge()).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 40));

    // Past the deadline the seam disarms itself and every entry point falls
    // through to the real capture paths (unsupported on this web test client).
    expect(module.isVirtualCameraCaptureTestArmed()).toBe(false);
    expect(module.supportsCurrentClientNativeCameraBridge()).toBe(false);
    const result = await module.captureNativeCameraPhoto();
    expect(result.capture).toBeNull();
    expect(result.backend).not.toBe("virtual_camera");
    const status = await module.getNativeCameraStatus();
    expect(status.supported).toBe(false);
    expect(status.lastCapture).toBeNull();
  });

  it("stays armed under the default 15-minute ttl for the duration of a smoke", async () => {
    const { module, controller } = await importBridgeOnWebPlatform();
    await controller.configure({ imageDataUrl: TEST_IMAGE_DATA_URL });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(module.isVirtualCameraCaptureTestArmed()).toBe(true);
    const result = await module.captureNativeCameraPhoto();
    expect(result.capture).not.toBeNull();
    expect(result.backend).toBe("virtual_camera");
  });

  it("clears back to the unsupported state and revokes the object URL", async () => {
    const { module, controller } = await importBridgeOnWebPlatform();
    await controller.configure({ imageDataUrl: TEST_IMAGE_DATA_URL });
    const captured = await module.captureNativeCameraPhoto();
    expect(captured.capture).not.toBeNull();

    await expect(controller.clear()).resolves.toBe(true);

    expect(module.supportsCurrentClientNativeCameraBridge()).toBe(false);
    const status = await module.getNativeCameraStatus();
    expect(status.supported).toBe(false);
    expect(status.lastCapture).toBeNull();
    expect(revokeObjectURLMock).toHaveBeenCalledWith(captured.capture!.webPath);
  });
});
