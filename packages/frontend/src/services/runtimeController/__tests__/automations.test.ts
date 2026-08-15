import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveControllerRequestContextMock = vi.hoisted(() => vi.fn());
const readControllerErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../core", () => ({
  normalizeUuidParam: (value: string | null | undefined) => value?.trim() || null,
  readControllerError: readControllerErrorMock,
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

function requestBody(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

describe("automation controller client", () => {
  beforeEach(() => {
    resolveControllerRequestContextMock.mockReset();
    resolveControllerRequestContextMock.mockResolvedValue(defaultRequestContext);
    readControllerErrorMock.mockReset();
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

    const automations = await fetchProjectAutomationsFromController({
      projectId: PROJECT_ID,
    });

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
