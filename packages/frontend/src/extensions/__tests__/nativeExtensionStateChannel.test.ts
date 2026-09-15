import { describe, expect, it } from "vitest";
import {
  dispatchNativeExtensionStateUpdated,
  NATIVE_EXTENSION_STATE_UPDATED_EVENT,
  readNativeExtensionStateUpdateDetail,
} from "../nativeExtensionStateChannel";

describe("nativeExtensionStateChannel", () => {
  it("dispatches and parses native camera state updates", async () => {
    const originalWindow = globalThis.window;
    const eventTarget = new EventTarget();
    Object.defineProperty(globalThis, "window", {
      value: eventTarget,
      configurable: true,
      writable: true,
    });
    try {
      const eventPromise = new Promise<Event>((resolve) => {
        const handle = (event: Event) => {
          window.removeEventListener(NATIVE_EXTENSION_STATE_UPDATED_EVENT, handle);
          resolve(event);
        };
        window.addEventListener(NATIVE_EXTENSION_STATE_UPDATED_EVENT, handle);
      });

      dispatchNativeExtensionStateUpdated({
        projectId: "project-1",
        providerId: "camera:device-1",
        integrationUpdated: true,
        cameraStatus: {
          supported: true,
          platform: "ios",
          backend: "phone_camera",
          deviceId: "device-1",
          deviceLabel: "Taylor iPhone",
          providerId: "camera:device-1",
          permission: "granted",
          permissionGranted: true,
          canCapture: true,
          availableLenses: [],
          selectedLens: "front",
          lastCapture: null,
        },
      });

      const event = await eventPromise;
      expect(readNativeExtensionStateUpdateDetail(event)).toEqual({
        projectId: "project-1",
        providerId: "camera:device-1",
        integrationUpdated: true,
        cameraStatus: {
          supported: true,
          platform: "ios",
          backend: "phone_camera",
          deviceId: "device-1",
          deviceLabel: "Taylor iPhone",
          providerId: "camera:device-1",
          permission: "granted",
          permissionGranted: true,
          canCapture: true,
          availableLenses: [],
          selectedLens: "front",
          lastCapture: null,
        },
      });
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: Window }).window;
      } else {
        Object.defineProperty(globalThis, "window", {
          value: originalWindow,
          configurable: true,
          writable: true,
        });
      }
    }
  });

  it("ignores malformed events", () => {
    const event = new CustomEvent(NATIVE_EXTENSION_STATE_UPDATED_EVENT, {
      detail: {
        projectId: " ",
        providerId: null,
      },
    });

    expect(readNativeExtensionStateUpdateDetail(event)).toBeNull();
  });
});
