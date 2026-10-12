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

import { readControllerError } from "../core";
import {
  dispatchControllerProviderToolCall,
  listControllerProviderRequests,
} from "../providerRequests";

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
  });
});

describe("dispatchControllerProviderToolCall", () => {
  const params = {
    projectId: "project-1",
    providerId: "example-robot",
    name: "example.robot.skill.look_at",
    argumentsValue: { azimuth_deg: 0 },
    timeoutMs: 30_000,
  };

  function stubControllerAnswer(status: number, body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        text: vi.fn().mockResolvedValue(JSON.stringify(body)),
        headers: new Headers(),
      }),
    );
  }

  beforeEach(() => {
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
    vi.mocked(readControllerError).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes the device's own reply through as it is, success or failure", async () => {
    stubControllerAnswer(200, {
      ok: true,
      providerId: "example-robot",
      name: "example.robot.skill.look_at",
      value: { status: "succeeded" },
    });
    const succeeded = await dispatchControllerProviderToolCall(params);
    expect(succeeded).toMatchObject({ ok: true, value: { status: "succeeded" } });
    expect(succeeded.noDeviceReply).toBeUndefined();

    stubControllerAnswer(200, {
      ok: false,
      providerId: "example-robot",
      name: "example.robot.skill.look_at",
      error: "look_at blocked: the robot is stowed",
    });
    const failed = await dispatchControllerProviderToolCall(params);
    expect(failed).toMatchObject({ ok: false, error: "look_at blocked: the robot is stowed" });
    expect(failed.noDeviceReply).toBeUndefined();
    expect(failed.request).toBeUndefined();
  });

  it("reads a request no device picked up before the controller expired it as never claimed", async () => {
    stubControllerAnswer(200, {
      ok: false,
      providerId: "example-robot",
      name: "example.robot.skill.look_at",
      error: "Timed out waiting for the provider device to respond.",
      providerRequest: { id: "request-1", status: "expired" },
    });

    await expect(dispatchControllerProviderToolCall(params)).resolves.toMatchObject({
      ok: false,
      noDeviceReply: "never_claimed",
      request: { id: "request-1", status: "expired", claimedAt: null, claimedByDeviceLabel: null },
    });
  });

  it("reads a request a device claimed and did not finish in time as unknown", async () => {
    stubControllerAnswer(200, {
      ok: false,
      providerId: "example-robot",
      name: "example.robot.skill.look_at",
      error: "Timed out waiting for the provider device to respond.",
      providerRequest: {
        id: "request-1",
        status: "expired",
        claimedAt: "2026-10-12T12:00:28Z",
        claimedByDeviceLabel: "Robot V1",
      },
    });

    await expect(dispatchControllerProviderToolCall(params)).resolves.toMatchObject({
      noDeviceReply: "unknown",
      request: { status: "expired", claimedAt: "2026-10-12T12:00:28Z", claimedByDeviceLabel: "Robot V1" },
    });
  });

  it("reads an older controller's timeout, which says nothing about a claim, as unknown", async () => {
    stubControllerAnswer(200, {
      ok: false,
      providerId: "example-robot",
      name: "example.robot.skill.look_at",
      error: "Timed out waiting for the provider device to respond.",
    });

    const envelope = await dispatchControllerProviderToolCall(params);
    expect(envelope).toMatchObject({ ok: false, noDeviceReply: "unknown" });
    expect(envelope.request).toBeUndefined();
  });

  it("reads a lost answer or a 5xx as unknown, and a 4xx as never queued", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(dispatchControllerProviderToolCall(params)).resolves.toMatchObject({
      ok: false,
      error: "Unable to dispatch provider tool call: Failed to fetch",
      noDeviceReply: "unknown",
    });

    vi.mocked(readControllerError).mockResolvedValue("Gateway Timeout");
    stubControllerAnswer(504, {});
    await expect(dispatchControllerProviderToolCall(params)).resolves.toMatchObject({
      ok: false,
      error: "Gateway Timeout",
      statusCode: 504,
      noDeviceReply: "unknown",
    });

    vi.mocked(readControllerError).mockResolvedValue("provider is not attached to this project");
    stubControllerAnswer(400, {});
    await expect(dispatchControllerProviderToolCall(params)).resolves.toMatchObject({
      ok: false,
      error: "provider is not attached to this project",
      statusCode: 400,
      noDeviceReply: "not_queued",
    });
  });

  it("reads a call that was never sent as never queued", async () => {
    resolveControllerAccessTokenMock.mockResolvedValue(null);

    await expect(dispatchControllerProviderToolCall(params)).resolves.toMatchObject({
      ok: false,
      error: "Missing controller session token.",
      noDeviceReply: "not_queued",
    });
  });
});
