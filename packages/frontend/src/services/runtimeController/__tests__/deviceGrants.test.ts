import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveControllerAccessTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../core", () => ({
  controllerBaseUrl: "http://controller.test",
  readControllerError: vi.fn(async (_response: unknown, fallback: string) => fallback),
  resolveControllerRequestContext: async (desired: string | null) => ({
    baseUrl: "http://controller.test",
    accessToken: await resolveControllerAccessTokenMock(desired),
    credentialSource: "ambient",
    generation: 1,
  }),
  runtimeControllerEnabled: true,
}));

import {
  createControllerDeviceGrant,
  listControllerDeviceGrants,
  revokeControllerDeviceGrant,
} from "../deviceGrants";

const grant = {
  id: "grant-1",
  userId: "user-1",
  agentId: "agent-1",
  providerId: "kit",
  deviceId: "kit-1",
  toolIds: ["kit.part.move"],
  conversationId: "conversation-1",
  voice: true,
};

function answer(status: number, value: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(value)),
    headers: new Headers(),
  };
}

function sent(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return {
    path: new URL(url).pathname,
    method: init.method,
    body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
}

describe("device grants", () => {
  beforeEach(() => {
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends each change with only what the caller gave", async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer(200, grant));
    vi.stubGlobal("fetch", fetchMock);
    const minimal = {
      agentId: "agent-1",
      providerId: "kit",
      deviceId: "kit-1",
      toolIds: ["kit.part.move"],
      conversationId: "conversation-1",
    };
    const budgets = { callsPerTool: { "kit.part.move": 2 } };
    const grants = "/projects/project-1/device-grants";
    // The controller refuses unknown and null fields, so absent ones are left out.
    const cases: [() => Promise<{ success: boolean }>, string, string, unknown][] = [
      [
        () =>
          createControllerDeviceGrant({
            projectId: "project-1",
            ...minimal,
            budgets,
            runtimeId: null,
            voice: true,
          }),
        grants,
        "POST",
        { ...minimal, budgets, voice: true },
      ],
      [
        () => createControllerDeviceGrant({ projectId: "project-1", ...minimal }),
        grants,
        "POST",
        minimal,
      ],
      [
        () => revokeControllerDeviceGrant({ projectId: "project-1", grantId: "grant-1" }),
        `${grants}/grant-1`,
        "DELETE",
        undefined,
      ],
    ];
    for (const [index, [call, path, method, body]] of cases.entries()) {
      await expect(call()).resolves.toMatchObject({ success: true });
      expect(sent(fetchMock, index)).toEqual({ path, method, body });
    }
  });

  it("lists the person's grants, none where grants are off, and fails on any other answer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer(200, [{ ...grant, changed: true }]))
      .mockResolvedValueOnce(answer(404, { message: "not found" }))
      .mockResolvedValueOnce(answer(503, { message: "database unavailable" }))
      .mockResolvedValueOnce(answer(200, { grants: [] }))
      .mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const list = () => listControllerDeviceGrants({ projectId: "project-1" });

    await expect(list()).resolves.toEqual([{ ...grant, changed: true }]);
    expect(sent(fetchMock)).toMatchObject({
      path: "/projects/project-1/device-grants",
      method: "GET",
    });
    await expect(list()).resolves.toEqual([]);
    // A read that failed is never a person without grants.
    await expect(list()).rejects.toThrow("Unable to list device grants");
    await expect(list()).rejects.toThrow("not a list");
    await expect(list()).rejects.toThrow("network down");
  });
});
