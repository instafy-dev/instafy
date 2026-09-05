import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ ready: vi.fn(), channel: vi.fn(), check: vi.fn(), addListener: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("@capacitor/app", () => ({ App: { addListener: mocks.addListener } }));
vi.mock("../shared", () => ({
  otaIsSupportedOnThisClient: () => true,
  resolveNativeOtaChannel: () => "internal",
}));
vi.mock("../nativeRuntimeConfig", () => ({ nativeBuildDisablesOta: async () => false }));
vi.mock("../client", () => ({
  buildNativeOtaIdentity: async () => ({
    device_id: "device-1", platform: "ios", channel: "internal", native_version: "1.0", native_build: "80",
  }),
  checkForNativeOtaUpdate: mocks.check,
  postNativeOtaEvent: async () => undefined,
}));
vi.mock("../liveUpdate", () => ({
  markNativeLiveUpdateReady: mocks.ready,
  setNativeLiveUpdateChannel: mocks.channel,
  getNativeLiveUpdateCurrentBundleId: async () => null,
}));
vi.mock("../state", () => ({
  readStoredNativeOtaState: () => ({}),
  reconcileNativeOtaState: () => ({
    state: { current: { bundle_version: null, git_sha: null }, pending: { bundle_version: null } },
  }),
  writeStoredNativeOtaState: vi.fn(),
  readLastNativeOtaError: () => null,
}));

describe("native OTA startup acknowledgment ordering", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      location: { search: "" }, localStorage: { getItem: () => null }, addEventListener: vi.fn(),
    });
    mocks.ready.mockResolvedValue({ currentBundleId: null, previousBundleId: null, rollback: false });
    mocks.channel.mockResolvedValue(undefined);
    mocks.check.mockResolvedValue({ update_available: false, reason: "already_active" });
    mocks.addListener.mockResolvedValue({ remove: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the native rollback timer armed and postpones checks until the shell commits", async () => {
    const { installNativeOtaBootstrap } = await import("../bootstrap");
    const { markNativeOtaAppMounted } = await import("../appReady");
    await installNativeOtaBootstrap();
    await Promise.resolve();
    expect(mocks.ready).not.toHaveBeenCalled();
    expect(mocks.channel).not.toHaveBeenCalled();
    expect(mocks.check).not.toHaveBeenCalled();

    markNativeOtaAppMounted();
    await vi.waitFor(() => expect(mocks.addListener).toHaveBeenCalledTimes(1));
    expect(mocks.ready).toHaveBeenCalledTimes(1);
    expect(mocks.channel).toHaveBeenCalledWith("internal");
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });

  it("does not lose a shell acknowledgment that arrives before async bootstrap installation", async () => {
    const { markNativeOtaAppMounted } = await import("../appReady");
    markNativeOtaAppMounted();
    const { installNativeOtaBootstrap } = await import("../bootstrap");
    await installNativeOtaBootstrap();
    await vi.waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(1));
    expect(mocks.ready).toHaveBeenCalledTimes(1);
  });
});
