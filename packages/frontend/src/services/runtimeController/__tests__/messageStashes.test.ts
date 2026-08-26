import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveControllerAccessTokenMock = vi.hoisted(() => vi.fn());
const readControllerErrorMock = vi.hoisted(() =>
  vi.fn(async (_response: unknown, fallback: string) => fallback),
);
const readControllerApiErrorMock = vi.hoisted(() =>
  vi.fn(async (_response: unknown, fallback: string) => ({
    status: 409,
    message: fallback,
    code: "message_stash_idempotency_conflict",
    details: null,
    url: null,
  })),
);

vi.mock("../core", () => ({
  ControllerApiError: class ControllerApiError extends Error {
    readonly code: string | null;

    constructor(payload: { message: string; code: string | null }) {
      super(payload.message);
      this.code = payload.code;
    }
  },
  readControllerApiError: readControllerApiErrorMock,
  readControllerError: readControllerErrorMock,
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
  createMessageStash,
  deleteMessageStash,
  listMessageStashes,
} from "../messageStashes";

const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";
const PROJECT_ID = "33333333-3333-3333-3333-333333333333";
const STASH_ID = "11111111-1111-1111-1111-111111111111";
const CLIENT_STASH_ID = "44444444-4444-4444-8444-444444444444";

function stashPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: STASH_ID,
    clientStashId: CLIENT_STASH_ID,
    projectId: PROJECT_ID,
    conversationId: CONVERSATION_ID,
    text: "Try a smaller type scale",
    editorState: { root: { children: [] } },
    composerEnvelope: { targetAgentHandles: ["octo"] },
    createdAt: "2026-08-16T10:00:00.000Z",
    updatedAt: "2026-08-16T10:00:00.000Z",
    ...overrides,
  };
}

describe("message stashes controller client", () => {
  beforeEach(() => {
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists normalized private stashes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([stashPayload(), stashPayload({ id: "" })]),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listMessageStashes({ conversationId: CONVERSATION_ID })).resolves.toEqual([
      stashPayload(),
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://controller.test/conversations/${CONVERSATION_ID}/message-stashes`,
    );
  });

  it("creates a stash with editor state and the opaque targeting envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(stashPayload()),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createMessageStash({
        conversationId: CONVERSATION_ID,
        clientStashId: CLIENT_STASH_ID,
        text: "Try a smaller type scale",
        editorState: { root: { children: [] } },
        composerEnvelope: { targetAgentHandles: ["octo"] },
      }),
    ).resolves.toMatchObject({ id: STASH_ID });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      clientStashId: CLIENT_STASH_ID,
      text: "Try a smaller type scale",
      editorState: { root: { children: [] } },
      composerEnvelope: { targetAgentHandles: ["octo"] },
    });
  });

  it("surfaces a definitive create rejection as a ControllerApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409 }));

    await expect(
      createMessageStash({
        conversationId: CONVERSATION_ID,
        clientStashId: CLIENT_STASH_ID,
        text: "Try a smaller type scale",
        editorState: null,
        composerEnvelope: {},
      }),
    ).rejects.toMatchObject({
      message: "message stash create failed",
      code: "message_stash_idempotency_conflict",
    });
  });

  it("deletes an explicit stash", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, stash: stashPayload() }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deleteMessageStash({ conversationId: CONVERSATION_ID, stashId: STASH_ID }),
    ).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `http://controller.test/conversations/${CONVERSATION_ID}/message-stashes/${STASH_ID}`,
    );
    expect(init.method).toBe("DELETE");
  });
});
