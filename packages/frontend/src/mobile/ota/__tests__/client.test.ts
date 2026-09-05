import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isOtaNativeBuild } from "@instafy/ota-contracts";
import {
  buildNativeOtaIdentity,
  checkForNativeOtaUpdate,
  postNativeOtaEvent,
  type NativeOtaIdentity,
} from "../client";

const mocks = vi.hoisted(() => ({ getInfo: vi.fn(), fetch: vi.fn() }));
vi.mock("@capacitor/app", () => ({ App: { getInfo: mocks.getInfo } }));
vi.mock("../../../sdk/instafy", () => ({
  controllerBaseUrl: "https://controller.example.test",
  readControllerError: vi.fn(),
}));
vi.mock("../shared", () => ({
  otaIsSupportedOnThisClient: () => true,
  resolveNativeOtaPlatform: () => "ios",
  resolveNativeOtaChannel: () => "internal",
}));
vi.mock("../liveUpdate", () => ({ getNativeLiveUpdateDeviceId: async () => "device-1" }));
vi.mock("../state", () => ({
  readStoredNativeOtaState: () => ({ current: { bundle_version: null, git_sha: null } }),
  getOrCreateFallbackNativeOtaDeviceId: () => "fallback-device",
  storeLastNativeOtaCheckSnapshot: vi.fn(),
  storeLastNativeOtaResult: vi.fn(),
}));

const identity: NativeOtaIdentity = {
  device_id: "device-1", platform: "ios", channel: "internal",
  native_version: "1.0", native_build: "80",
  current_bundle_version: null, current_git_sha: null,
};
const offer = {
  update_available: true, reason: "update_available", required_native_build: "80",
  bundle_version: "next-bundle", artifact_url: "https://artifacts.example.test/next.zip",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.getInfo.mockResolvedValue({ version: "1.0", build: "80" });
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => offer });
});
afterEach(() => vi.unstubAllGlobals());

describe("native build compatibility", () => {
  it.each(["80", "260860838", "001.02.3", "0", "9".repeat(64)])("accepts bounded raw build %s", (build) => {
    expect(isOtaNativeBuild(build)).toBe(true);
  });
  it.each([undefined, null, 80, "", " 80", "80 ", "80\n", "1..2", ".1", "1.", "1e2", "１２", "9".repeat(65)])(
    "rejects malformed build %s", (build) => expect(isOtaNativeBuild(build)).toBe(false),
  );

  it("reads the installed native build, independently of marketing version and OTA identity", async () => {
    expect(await buildNativeOtaIdentity()).toEqual(identity);
    mocks.getInfo.mockResolvedValue({ version: "1.0", build: "79" });
    expect(await buildNativeOtaIdentity()).toMatchObject({ native_version: "1.0", native_build: "79" });
  });

  it.each([undefined, "", "80 ", "80\n", "9".repeat(65)])("reports an invalid/unavailable native build as unknown: %s", async (build) => {
    mocks.getInfo.mockResolvedValue({ version: "1.0", build });
    expect(await buildNativeOtaIdentity()).toMatchObject({ native_build: null });
  });

  it("sends native build and preserves the existing selected channel in checks and telemetry", async () => {
    expect(await checkForNativeOtaUpdate(identity)).toEqual(offer);
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({ native_build: "80", channel: "internal" });
    await postNativeOtaEvent({ identity, event_type: "update_check_requested" });
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toMatchObject({ native_build: "80", channel: "internal" });
  });

  it.each([undefined, null, "79", "81", "080", "80.0", "80 ", "80\n"])(
    "removes a guarded offer before download/staging for client build %s", async (native_build) => {
      expect(await checkForNativeOtaUpdate({ ...identity, native_build })).toEqual({
        update_available: false, reason: "native_build_incompatible",
      });
    },
  );

  it.each(["", "80 ", "80\n", "1..2", "9".repeat(65), 80])("rejects a malformed guarded response %s", async (required_native_build) => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ ...offer, required_native_build }) });
    expect(await checkForNativeOtaUpdate(identity)).toEqual({ update_available: false, reason: "native_build_incompatible" });
  });

  it.each([undefined, null])("keeps unguarded legacy responses backward-compatible: %s", async (required_native_build) => {
    const response = { ...offer, required_native_build };
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => response });
    expect(await checkForNativeOtaUpdate({ ...identity, native_build: null })).toEqual(response);
  });
});
