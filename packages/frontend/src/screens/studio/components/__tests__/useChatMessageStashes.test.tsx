/** @vitest-environment jsdom */

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createMessageStashMock = vi.hoisted(() => vi.fn());
const createMessageStashClientIdMock = vi.hoisted(() => vi.fn());
const deleteMessageStashMock = vi.hoisted(() => vi.fn());
const listMessageStashesMock = vi.hoisted(() => vi.fn());

const TestControllerApiError = vi.hoisted(
  () =>
    class TestControllerApiError extends Error {
      readonly code: string | null;

      constructor(message: string, code: string | null = null) {
        super(message);
        this.code = code;
      }
    },
);

vi.mock("../../../../services/runtimeController/messageStashes", () => ({
  createMessageStash: createMessageStashMock,
  createMessageStashClientId: createMessageStashClientIdMock,
  deleteMessageStash: deleteMessageStashMock,
  listMessageStashes: listMessageStashesMock,
}));

vi.mock("../../../../services/runtimeController/core", () => ({
  ControllerApiError: TestControllerApiError,
}));

import {
  createChatMessageStashPayloadFingerprint,
  useChatMessageStashes,
  type CreateChatMessageStashInput,
} from "../useChatMessageStashes";

type HookResult = ReturnType<typeof useChatMessageStashes>;

function Harness({ resultRef }: { resultRef: MutableRefObject<HookResult | null> }) {
  resultRef.current = useChatMessageStashes({
    conversationControllerId: "conversation-1",
    enabled: true,
  });
  return null;
}

const payload: CreateChatMessageStashInput = {
  text: "Keep this draft",
  editorState: "editor-state-1",
  composerEnvelope: {
    metadata: { z: 1, a: 2 },
    targetAgentHandles: ["octo"],
  },
};

function stash(clientStashId: string, text = payload.text) {
  return {
    id: `stash-${clientStashId}`,
    clientStashId,
    projectId: "project-1",
    conversationId: "conversation-1",
    text,
    editorState: payload.editorState,
    composerEnvelope: payload.composerEnvelope,
    createdAt: "2026-08-16T10:00:00.000Z",
    updatedAt: "2026-08-16T10:00:00.000Z",
  };
}

describe("useChatMessageStashes create idempotency", () => {
  let container: HTMLDivElement;
  let root: Root;
  let resultRef: MutableRefObject<HookResult | null>;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    createMessageStashMock.mockReset();
    createMessageStashClientIdMock.mockReset();
    deleteMessageStashMock.mockReset();
    listMessageStashesMock.mockReset();
    listMessageStashesMock.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resultRef = { current: null };
    await act(async () => {
      root.render(<Harness resultRef={resultRef} />);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("reuses one client id after an ambiguous network failure, then rotates after success", async () => {
    createMessageStashClientIdMock
      .mockReturnValueOnce("client-1")
      .mockReturnValueOnce("client-2");
    createMessageStashMock
      .mockRejectedValueOnce(new TypeError("network disconnected"))
      .mockResolvedValueOnce(stash("client-1"))
      .mockResolvedValueOnce(stash("client-2"));

    await act(async () => {
      await expect(resultRef.current?.createStash(payload)).rejects.toThrow(
        "network disconnected",
      );
    });
    await act(async () => {
      await expect(resultRef.current?.createStash(payload)).resolves.toMatchObject({
        clientStashId: "client-1",
      });
    });
    await act(async () => {
      await expect(resultRef.current?.createStash(payload)).resolves.toMatchObject({
        clientStashId: "client-2",
      });
    });

    expect(createMessageStashClientIdMock).toHaveBeenCalledTimes(2);
    expect(createMessageStashMock.mock.calls.map(([input]) => input.clientStashId)).toEqual([
      "client-1",
      "client-1",
      "client-2",
    ]);
  });

  it("uses a new id when the payload changes after an ambiguous failure", async () => {
    createMessageStashClientIdMock
      .mockReturnValueOnce("client-1")
      .mockReturnValueOnce("client-2");
    createMessageStashMock
      .mockRejectedValueOnce(new TypeError("request timed out"))
      .mockResolvedValueOnce(stash("client-2", "Edited draft"));

    await act(async () => {
      await expect(resultRef.current?.createStash(payload)).rejects.toThrow("timed out");
    });
    await act(async () => {
      await resultRef.current?.createStash({ ...payload, text: "Edited draft" });
    });

    expect(createMessageStashMock.mock.calls.map(([input]) => input.clientStashId)).toEqual([
      "client-1",
      "client-2",
    ]);
  });

  it("reuses the id after a potentially ambiguous ControllerApiError", async () => {
    createMessageStashClientIdMock
      .mockReturnValueOnce("client-1")
      .mockReturnValueOnce("client-2");
    createMessageStashMock
      .mockRejectedValueOnce(new TestControllerApiError("gateway timeout"))
      .mockResolvedValueOnce(stash("client-1"))
      .mockResolvedValueOnce(stash("client-2"));

    await act(async () => {
      await expect(resultRef.current?.createStash(payload)).rejects.toThrow("gateway timeout");
    });
    await act(async () => {
      await resultRef.current?.createStash(payload);
    });
    await act(async () => {
      await resultRef.current?.createStash(payload);
    });

    expect(createMessageStashMock.mock.calls.map(([input]) => input.clientStashId)).toEqual([
      "client-1",
      "client-1",
      "client-2",
    ]);
  });

  it("rotates the id after an explicit idempotency conflict", async () => {
    createMessageStashClientIdMock
      .mockReturnValueOnce("client-1")
      .mockReturnValueOnce("client-2");
    createMessageStashMock
      .mockRejectedValueOnce(
        new TestControllerApiError(
          "conflict",
          "message_stash_idempotency_conflict",
        ),
      )
      .mockResolvedValueOnce(stash("client-2"));

    await act(async () => {
      await expect(resultRef.current?.createStash(payload)).rejects.toThrow("conflict");
    });
    await act(async () => {
      await resultRef.current?.createStash(payload);
    });

    expect(createMessageStashMock.mock.calls.map(([input]) => input.clientStashId)).toEqual([
      "client-1",
      "client-2",
    ]);
  });

  it("fingerprints semantically identical JSON objects independently of key order", () => {
    expect(createChatMessageStashPayloadFingerprint(payload)).toBe(
      createChatMessageStashPayloadFingerprint({
        composerEnvelope: {
          targetAgentHandles: ["octo"],
          metadata: { a: 2, z: 1 },
        },
        editorState: "editor-state-1",
        text: "Keep this draft",
      }),
    );
  });
});
