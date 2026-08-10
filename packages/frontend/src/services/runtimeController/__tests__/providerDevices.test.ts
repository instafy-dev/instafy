import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveControllerAccessTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../core", () => ({
  controllerBaseUrl: "http://controller.test",
  readControllerError: vi.fn(),
  resolveControllerRequestContext: async (desired: string | null) => ({
    baseUrl: "http://controller.test",
    accessToken: await resolveControllerAccessTokenMock(desired),
    credentialSource: "ambient",
    generation: 1,
  }),
  runtimeControllerEnabled: true,
}));

import {
  heartbeatControllerProviderDevice,
  listControllerProviderDevices,
} from "../providerDevices";

describe("providerDevices", () => {
  beforeEach(() => {
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serializes family-aware provider device listing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue("[]"),
      headers: new Headers(),
      status: 200,
    });
    vi.stubGlobal("fetch", fetchMock);

    await listControllerProviderDevices({
      projectId: "project-1",
      providerFamilyId: "camera",
      providerId: "camera:ios-device",
      limit: 25,
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("providerFamilyId")).toBe("camera");
    expect(parsed.searchParams.get("providerId")).toBe("camera:ios-device");
    expect(parsed.searchParams.get("limit")).toBe("25");
  });

  it("normalizes heartbeat responses for device presence", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          projectId: "project-1",
          providerId: "camera:ios-device",
          providerFamilyId: "camera",
          deviceId: "ios-device",
          deviceLabel: "Marcus iPhone",
          platform: "ios",
          status: "ready",
          connectionType: "native_runtime",
          metadata: {
            permissionGranted: true,
            selectedLens: "front",
          },
          presenceStatus: "online",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:05.000Z",
          lastSeenAt: "2026-04-02T10:00:05.000Z",
        }),
      ),
      headers: new Headers(),
      status: 200,
    });
    vi.stubGlobal("fetch", fetchMock);

    const record = await heartbeatControllerProviderDevice({
      projectId: "project-1",
      providerId: "camera:ios-device",
      providerFamilyId: "camera",
      deviceId: "ios-device",
      deviceLabel: "Marcus iPhone",
      platform: "ios",
      status: "ready",
      connectionType: "native_runtime",
      metadata: {
        permissionGranted: true,
        selectedLens: "front",
      },
    });

    expect(record).toEqual({
      projectId: "project-1",
      providerId: "camera:ios-device",
      providerFamilyId: "camera",
      deviceId: "ios-device",
      deviceLabel: "Marcus iPhone",
      platform: "ios",
      status: "ready",
      connectionType: "native_runtime",
      metadata: {
        permissionGranted: true,
        selectedLens: "front",
      },
      presenceStatus: "online",
      createdAt: "2026-04-02T10:00:00.000Z",
      updatedAt: "2026-04-02T10:00:05.000Z",
      lastSeenAt: "2026-04-02T10:00:05.000Z",
    });
  });
});
