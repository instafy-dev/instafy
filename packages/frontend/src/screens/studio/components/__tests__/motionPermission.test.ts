import { describe, expect, it, vi, afterEach } from "vitest";

import { requestMotionAccessIfNeeded } from "../motionPermission";

const originalDeviceMotionEvent = globalThis.DeviceMotionEvent;

afterEach(() => {
  if (originalDeviceMotionEvent) {
    Object.defineProperty(globalThis, "DeviceMotionEvent", {
      configurable: true,
      writable: true,
      value: originalDeviceMotionEvent,
    });
  } else {
    // @ts-expect-error test cleanup
    delete globalThis.DeviceMotionEvent;
  }
});

describe("requestMotionAccessIfNeeded", () => {
  it("returns granted when the platform does not require a prompt", async () => {
    class PlainDeviceMotionEvent {}
    Object.defineProperty(globalThis, "DeviceMotionEvent", {
      configurable: true,
      writable: true,
      value: PlainDeviceMotionEvent,
    });

    await expect(requestMotionAccessIfNeeded()).resolves.toBe("granted");
  });

  it("requests permission when the platform exposes requestPermission", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    class PromptDeviceMotionEvent {}
    Object.assign(PromptDeviceMotionEvent, { requestPermission });
    Object.defineProperty(globalThis, "DeviceMotionEvent", {
      configurable: true,
      writable: true,
      value: PromptDeviceMotionEvent,
    });

    await expect(requestMotionAccessIfNeeded()).resolves.toBe("granted");
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("returns denied when the user rejects the motion prompt", async () => {
    const requestPermission = vi.fn().mockResolvedValue("denied");
    class PromptDeviceMotionEvent {}
    Object.assign(PromptDeviceMotionEvent, { requestPermission });
    Object.defineProperty(globalThis, "DeviceMotionEvent", {
      configurable: true,
      writable: true,
      value: PromptDeviceMotionEvent,
    });

    await expect(requestMotionAccessIfNeeded()).resolves.toBe("denied");
  });
});
