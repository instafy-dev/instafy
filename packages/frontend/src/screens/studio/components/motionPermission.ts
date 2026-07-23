export type MotionPermissionState = "granted" | "denied" | "unsupported";

type DeviceMotionEventWithPermission = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

export async function requestMotionAccessIfNeeded(): Promise<MotionPermissionState> {
  if (typeof globalThis === "undefined" || typeof DeviceMotionEvent === "undefined") {
    return "unsupported";
  }

  const motionEvent = DeviceMotionEvent as DeviceMotionEventWithPermission;
  if (typeof motionEvent.requestPermission !== "function") {
    return "granted";
  }

  const permission = await motionEvent.requestPermission();
  return permission === "granted" ? "granted" : "denied";
}
