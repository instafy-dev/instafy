import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveControllerAccessTokenMock = vi.hoisted(() => vi.fn());
const readControllerErrorMock = vi.hoisted(() =>
  vi.fn(async (_response: unknown, fallback: string) => fallback),
);

vi.mock("../core", () => ({
  controllerBaseUrl: "http://controller.test",
  readControllerError: readControllerErrorMock,
  resolveControllerAccessToken: resolveControllerAccessTokenMock,
  runtimeControllerEnabled: true,
  safeJson: (value: unknown) => value,
}));

import {
  cancelSendQueueEntry,
  dispatchSendQueueEntryNow,
  enqueueSendQueueEntry,
  listSendQueue,
} from "../sendQueue";

const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";
const ENTRY_ID = "11111111-1111-1111-1111-111111111111";

function buildEntryPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    conversationId: CONVERSATION_ID,
    status: "queued",
    targetAgentHandles: ["octo"],
    message: { promptText: "Follow up on the codec lane" },
    errorMessage: null,
    createdAt: "2026-07-05T10:00:00.000Z",
    dispatchedAt: null,
    ...overrides,
  };
}

describe("sendQueue controller client", () => {
  beforeEach(() => {
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
    readControllerErrorMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists queued entries oldest first with normalized fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi
        .fn()
        .mockResolvedValue([buildEntryPayload(), buildEntryPayload({ id: "", status: "failed" })]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const entries = await listSendQueue({ conversationId: CONVERSATION_ID });

    expect(entries).toEqual([
      {
        id: ENTRY_ID,
        conversationId: CONVERSATION_ID,
        status: "queued",
        targetAgentHandles: ["octo"],
        message: { promptText: "Follow up on the codec lane" },
        errorMessage: null,
        createdAt: "2026-07-05T10:00:00.000Z",
        dispatchedAt: null,
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://controller.test/conversations/${CONVERSATION_ID}/send-queue`);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-123");
  });

  it("returns null without fetching when no access token is available", async () => {
    resolveControllerAccessTokenMock.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(listSendQueue({ conversationId: CONVERSATION_ID })).resolves.toBeNull();
    await expect(
      enqueueSendQueueEntry({
        conversationId: CONVERSATION_ID,
        message: { promptText: "hello" },
        targetAgentHandles: [],
      }),
    ).resolves.toBeNull();
    await expect(
      cancelSendQueueEntry({ conversationId: CONVERSATION_ID, entryId: ENTRY_ID }),
    ).resolves.toBeNull();
    await expect(
      dispatchSendQueueEntryNow({ conversationId: CONVERSATION_ID, entryId: ENTRY_ID }),
    ).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the prompt body and target handles when enqueueing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(buildEntryPayload()),
    });
    vi.stubGlobal("fetch", fetchMock);

    const entry = await enqueueSendQueueEntry({
      conversationId: CONVERSATION_ID,
      message: { promptText: "Follow up on the codec lane", intent: "feature" },
      targetAgentHandles: ["octo"],
    });

    expect(entry).toMatchObject({ id: ENTRY_ID, status: "queued" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://controller.test/conversations/${CONVERSATION_ID}/send-queue`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      message: { promptText: "Follow up on the codec lane", intent: "feature" },
      targetAgentHandles: ["octo"],
    });
  });

  it("throws the controller error message when the enqueue fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue("bad request"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      enqueueSendQueueEntry({
        conversationId: CONVERSATION_ID,
        message: { promptText: "hello" },
        targetAgentHandles: [],
      }),
    ).rejects.toThrow("send queue enqueue failed");
  });

  it("cancels entries through the DELETE endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, entry: buildEntryPayload() }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await cancelSendQueueEntry({
      conversationId: CONVERSATION_ID,
      entryId: ENTRY_ID,
    });

    expect(result).toMatchObject({ ok: true, entry: { id: ENTRY_ID } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `http://controller.test/conversations/${CONVERSATION_ID}/send-queue/${ENTRY_ID}`,
    );
    expect(init.method).toBe("DELETE");
  });

  it("dispatches entries immediately through the dispatch endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        runId: "run-1",
        promptId: "prompt-1",
        status: "queued",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchSendQueueEntryNow({
      conversationId: CONVERSATION_ID,
      entryId: ENTRY_ID,
    });

    expect(result).toEqual({
      outcome: "dispatched",
      response: {
        runId: "run-1",
        promptId: "prompt-1",
        status: "queued",
        conversationId: CONVERSATION_ID,
      },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `http://controller.test/conversations/${CONVERSATION_ID}/send-queue/${ENTRY_ID}/dispatch`,
    );
    expect(init.method).toBe("POST");
  });

  it("reports entries the server drain already dispatched", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, alreadyDispatched: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dispatchSendQueueEntryNow({ conversationId: CONVERSATION_ID, entryId: ENTRY_ID }),
    ).resolves.toEqual({ outcome: "alreadyDispatched", response: null });
  });

  it("reports unknown or canceled entries instead of throwing on 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue("send queue entry not found"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dispatchSendQueueEntryNow({ conversationId: CONVERSATION_ID, entryId: ENTRY_ID }),
    ).resolves.toEqual({ outcome: "notFound", response: null });
    expect(readControllerErrorMock).not.toHaveBeenCalled();
  });

  it("still throws the controller error for non-404 dispatch failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue("boom"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dispatchSendQueueEntryNow({ conversationId: CONVERSATION_ID, entryId: ENTRY_ID }),
    ).rejects.toThrow("send queue dispatch failed");
  });
});
