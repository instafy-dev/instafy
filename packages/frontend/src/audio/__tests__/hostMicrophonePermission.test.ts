import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeHostMicrophonePermissionNotice,
  requestHostMicrophonePermission,
  shouldShowHostMicrophonePermissionNotice,
} from "../hostMicrophonePermission";
import { ensureNativeHostMicrophonePermission } from "../nativeAudioSessionBridge";

vi.mock("../nativeAudioSessionBridge", () => ({
  ensureNativeHostMicrophonePermission: vi.fn(),
}));

describe("hostMicrophonePermission helpers", () => {
  beforeEach(() => {
    vi.mocked(ensureNativeHostMicrophonePermission).mockReset();
    vi.unstubAllGlobals();
  });

  it("shows a notice when microphone access is pending", () => {
    expect(shouldShowHostMicrophonePermissionNotice("prompt")).toBe(true);
    expect(describeHostMicrophonePermissionNotice("prompt").actionLabel).toBe("Allow microphone");
  });

  it("shows a retry notice when microphone access is denied", () => {
    expect(shouldShowHostMicrophonePermissionNotice("denied")).toBe(true);
    expect(describeHostMicrophonePermissionNotice("denied").actionLabel).toBe("Request again");
    expect(describeHostMicrophonePermissionNotice("denied").description).toContain(
      "both macOS and browser-site microphone access",
    );
  });

  it("stays hidden when microphone access is already granted", () => {
    expect(shouldShowHostMicrophonePermissionNotice("granted")).toBe(false);
  });

  it("prefers native bridge permission results when available", async () => {
    vi.mocked(ensureNativeHostMicrophonePermission).mockResolvedValue("granted");

    await expect(requestHostMicrophonePermission()).resolves.toBe("granted");
  });

  it("falls back to browser permission when native iOS status stays pending", async () => {
    vi.mocked(ensureNativeHostMicrophonePermission).mockResolvedValue("prompt");
    const stop = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop }],
        }),
      },
    });

    await expect(requestHostMicrophonePermission()).resolves.toBe("granted");
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
