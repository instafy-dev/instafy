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
  claimControllerProviderRequest,
  listControllerProviderRequests,
} from "../providerRequests";

function jsonResponse(value: unknown) {
  return {
    ok: true,
    text: vi.fn().mockResolvedValue(JSON.stringify(value)),
    headers: new Headers(),
    status: 200,
  };
}

const canceledRecord = {
  id: "request-1",
  projectId: "project-1",
  providerId: "camera:device-1",
  requestKind: "tool_call",
  toolName: "camera.snapshot",
  arguments: {},
  status: "canceled",
  cancelReason: "steered",
  targetDeviceId: "device-1",
  jobId: "job-1",
  claimedByDeviceId: "device-1",
  error: "The provider request was canceled because its turn was steered.",
  createdAt: "2026-10-13T10:00:00+00:00",
  updatedAt: "2026-10-13T10:00:02+00:00",
  expiresAt: "2026-10-13T10:00:20+00:00",
  ageMs: 2150,
};

describe("listControllerProviderRequests", () => {
  beforeEach(() => {
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serializes comma-separated statuses for controller filtering", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue("[]"),
      headers: new Headers(),
      status: 200,
    });
    vi.stubGlobal("fetch", fetchMock);

    await listControllerProviderRequests({
      projectId: "project-1",
      providerId: "camera:device-1",
      statuses: ["pending", "claimed"],
      limit: 5,
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("statuses")).toBe("pending,claimed");
    expect(parsed.searchParams.get("providerId")).toBe("camera:device-1");
    expect(parsed.searchParams.get("limit")).toBe("5");
    expect(parsed.searchParams.has("deviceId")).toBe(false);
  });

  it("asks only for the requests one device may act on", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([canceledRecord]));
    vi.stubGlobal("fetch", fetchMock);

    const [record] = await listControllerProviderRequests({
      projectId: "project-1",
      providerId: "camera:device-1",
      deviceId: "device-1",
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).searchParams.get("deviceId")).toBe("device-1");
    expect(record).toMatchObject({
      status: "canceled",
      cancelReason: "steered",
      targetDeviceId: "device-1",
      jobId: "job-1",
      expiresAt: "2026-10-13T10:00:20+00:00",
      ageMs: 2150,
    });
  });
});

describe("provider request records", () => {
  beforeEach(() => {
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const claim = () =>
    claimControllerProviderRequest({
      projectId: "project-1",
      requestId: "request-1",
      providerId: "camera:device-1",
      deviceId: "device-1",
    });

  it("keep only a cancel reason the controller defines", async () => {
    for (const cancelReason of ["bored", "expired", "revoked"]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({ ...canceledRecord, cancelReason })),
      );

      const record = await claim();

      expect(record?.status).toBe("canceled");
      expect(record?.cancelReason).toBeNull();
    }
  });

  it("keep the server's ages and target from a claim, and nothing that is not one", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ ...canceledRecord, status: "claimed", ageMs: 840, triggerAgeMs: 21_500 }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            ...canceledRecord,
            status: "claimed",
            jobId: null,
            ageMs: "old",
            triggerAgeMs: "old",
          }),
        ),
    );

    expect(await claim()).toMatchObject({
      status: "claimed",
      targetDeviceId: "device-1",
      jobId: "job-1",
      ageMs: 840,
      triggerAgeMs: 21_500,
    });
    expect(await claim()).toMatchObject({ jobId: null, ageMs: null, triggerAgeMs: null });
  });
});
