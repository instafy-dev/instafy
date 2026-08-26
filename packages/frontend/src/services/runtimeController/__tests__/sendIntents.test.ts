import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveControllerAccessTokenMock = vi.hoisted(() => vi.fn());
const readControllerErrorMock = vi.hoisted(() =>
  vi.fn(async (_response: unknown, fallback: string) => ({
    status: 400,
    message: fallback,
    code: null,
    details: null,
    url: null,
  })),
);

vi.mock("../core", () => ({
  ControllerApiError: class ControllerApiError extends Error {
    constructor(payload: { message: string }) {
      super(payload.message);
    }
  },
  readControllerApiError: readControllerErrorMock,
  resolveControllerRequestContext: async (desired: string | null) => ({
    baseUrl: "http://controller.test",
    accessToken: await resolveControllerAccessTokenMock(desired),
    credentialSource: "ambient",
    generation: 1,
  }),
  runtimeControllerEnabled: true,
  safeJson: (value: unknown) => value,
}));

import {
  createConversationSendIntentAttemptKey,
  sendConversationIntent,
} from "../sendIntents";

const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";

describe("send intents controller client", () => {
  beforeEach(() => {
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps an attempt key stable for ambiguous retries and changes it with the payload", () => {
    const base = {
      conversationId: CONVERSATION_ID,
      mode: "queue" as const,
      request: { promptText: "keep going" },
      targetAgentHandles: ["octo"],
    };
    expect(createConversationSendIntentAttemptKey(base)).toBe(
      createConversationSendIntentAttemptKey({ ...base }),
    );
    expect(
      createConversationSendIntentAttemptKey({
        ...base,
        request: { promptText: "different" },
      }),
    ).not.toBe(createConversationSendIntentAttemptKey(base));
  });

  it("posts a queue intent with an idempotency id and prompt request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        clientSendId: "client-1",
        requestedMode: "queue",
        appliedMode: "queue",
        state: "queued",
        deduplicated: false,
        queueEntry: { id: "queue-1" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendConversationIntent({
        conversationId: CONVERSATION_ID,
        clientSendId: "client-1",
        mode: "queue",
        request: { promptText: "follow up" },
        targetAgentHandles: ["octo"],
      }),
    ).resolves.toMatchObject({ state: "queued", queueEntry: { id: "queue-1" } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://controller.test/conversations/${CONVERSATION_ID}/send-intents`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      clientSendId: "client-1",
      mode: "queue",
      request: { promptText: "follow up" },
      targetAgentHandles: ["octo"],
    });
  });

  it("normalizes the steer delivery status and optional identifiers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        clientSendId: "client-2",
        requestedMode: "steer",
        appliedMode: "steer",
        status: "applied",
        commandId: "command-1",
        jobId: "job-1",
        runId: "run-1",
        messageId: "message-1",
        sequence: 2,
      }),
    }));

    await expect(
      sendConversationIntent({
        conversationId: CONVERSATION_ID,
        clientSendId: "client-2",
        mode: "steer",
        request: { promptText: "use the smaller type" },
        expectedActiveJobId: "job-1",
      }),
    ).resolves.toMatchObject({
      state: "applied",
      commandId: "command-1",
      jobId: "job-1",
      runId: "run-1",
    });
  });

  it("returns null without issuing a request when authentication is unavailable", async () => {
    resolveControllerAccessTokenMock.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendConversationIntent({
        conversationId: CONVERSATION_ID,
        clientSendId: "client-3",
        mode: "queue",
        request: {},
      }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed successful responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true }),
    }));

    await expect(
      sendConversationIntent({
        conversationId: CONVERSATION_ID,
        clientSendId: "client-4",
        mode: "steer",
        request: {},
      }),
    ).rejects.toThrow("invalid send intent response");
  });
});
