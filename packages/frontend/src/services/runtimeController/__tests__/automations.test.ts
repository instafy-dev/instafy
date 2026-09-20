import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const resolveControllerRequestContextMock = vi.hoisted(() => vi.fn());
const readControllerErrorMock = vi.hoisted(() => vi.fn());
const readControllerApiErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../core", async (importOriginal) => ({
  ControllerApiError: (await importOriginal<typeof import("../core")>()).ControllerApiError,
  normalizeUuidParam: (value: string | null | undefined) => value?.trim() || null,
  readControllerError: readControllerErrorMock,
  readControllerApiError: readControllerApiErrorMock,
  resolveControllerRequestContext: resolveControllerRequestContextMock,
  runtimeControllerEnabled: true,
}));

import {
  createProjectAutomationInController,
  fetchProjectAutomationsFromController,
  updateAutomationInController,
} from "../automations";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const AUTOMATION_ID = "22222222-2222-4222-8222-222222222222";

const defaultRequestContext = Object.freeze({
  baseUrl: "http://controller.test",
  accessToken: "token-123",
  credentialSource: "ambient" as const,
  generation: 1,
});

function automationPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: AUTOMATION_ID,
    projectId: PROJECT_ID,
    userId: "33333333-3333-4333-8333-333333333333",
    name: "Bug scan",
    promptText: "Look for bugs.",
    metadata: {},
    scheduleKind: "weekly",
    runAt: null,
    intervalHours: null,
    byDay: ["mo"],
    byHour: 9,
    byMinute: 0,
    timezone: "UTC",
    runtimeMode: "auto",
    runtimeProvider: null,
    conversationId: null,
    status: "active",
    lockedUntil: null,
    lastRunAt: null,
    nextRunAt: "2026-08-17T09:00:00Z",
    lastError: null,
    createdAt: "2026-08-15T09:00:00Z",
    updatedAt: "2026-08-15T09:00:00Z",
    ...overrides,
  };
}

function okAutomationResponse(): Response {
  return new Response(JSON.stringify(automationPayload()), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function requestBody(fetchMock: Mock, index: number) {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

describe("automation controller client", () => {
  beforeEach(() => {
    resolveControllerRequestContextMock.mockReset();
    resolveControllerRequestContextMock.mockResolvedValue(defaultRequestContext);
    readControllerErrorMock.mockReset();
    readControllerApiErrorMock.mockReset();
  });

  it.each([401, 403, 404, 503])("preserves HTTP %s so protected lists can distinguish denial from temporary failure", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status })));
    readControllerApiErrorMock.mockResolvedValue({ status, message: "List unavailable", code: null, details: null });

    await expect(fetchProjectAutomationsFromController({ projectId: PROJECT_ID })).rejects.toMatchObject({
      name: "ControllerApiError", status, message: "List unavailable",
    });
  });

  it("treats a missing session as an authorization failure", async () => {
    resolveControllerRequestContextMock.mockResolvedValue({ ...defaultRequestContext, accessToken: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchProjectAutomationsFromController({ projectId: PROJECT_ID })).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not mistake a malformed response for an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    await expect(fetchProjectAutomationsFromController({ projectId: PROJECT_ID })).rejects.toThrow("missing automations list");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults missing silence flags to false and preserves explicit true values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          automationPayload(),
          automationPayload({
            id: "44444444-4444-4444-8444-444444444444",
            silentWhenNothingToReport: true,
          }),
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = new AbortController();
    const automations = await fetchProjectAutomationsFromController({
      projectId: PROJECT_ID,
      signal: request.signal,
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: request.signal });

    expect(automations?.map((automation) => automation.silentWhenNothingToReport)).toEqual([
      false,
      true,
    ]);
  });

  it("serializes explicit true and false silence flags when creating", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => okAutomationResponse());
    vi.stubGlobal("fetch", fetchMock);

    for (const silentWhenNothingToReport of [true, false]) {
      await createProjectAutomationInController({
        projectId: PROJECT_ID,
        name: "Bug scan",
        promptText: "Look for bugs.",
        scheduleKind: "weekly",
        silentWhenNothingToReport,
      });
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(fetchMock, 0).silentWhenNothingToReport).toBe(true);
    expect(requestBody(fetchMock, 1).silentWhenNothingToReport).toBe(false);
  });

  it("serializes explicit true and false silence flags when updating", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => okAutomationResponse());
    vi.stubGlobal("fetch", fetchMock);

    for (const silentWhenNothingToReport of [true, false]) {
      await updateAutomationInController({
        automationId: AUTOMATION_ID,
        silentWhenNothingToReport,
      });
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(fetchMock, 0)).toEqual({ silentWhenNothingToReport: true });
    expect(requestBody(fetchMock, 1)).toEqual({ silentWhenNothingToReport: false });
  });
});
