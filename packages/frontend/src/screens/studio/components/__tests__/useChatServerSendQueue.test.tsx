// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listSendQueueMock = vi.hoisted(() => vi.fn());
const enqueueSendQueueEntryMock = vi.hoisted(() => vi.fn());
const cancelSendQueueEntryMock = vi.hoisted(() => vi.fn());
const dispatchSendQueueEntryNowMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../services/runtimeController/sendQueue", () => ({
  CONVERSATION_SEND_QUEUE_EVENT: "instafy:conversation-send-queue",
  listSendQueue: listSendQueueMock,
  enqueueSendQueueEntry: enqueueSendQueueEntryMock,
  cancelSendQueueEntry: cancelSendQueueEntryMock,
  dispatchSendQueueEntryNow: dispatchSendQueueEntryNowMock,
}));

import type { ControllerSendQueueEntry } from "../../../../services/runtimeController/sendQueue";
import {
  buildServerSendQueuePromptBody,
  mapServerSendQueueEntryToQueuedItem,
  useChatServerSendQueue,
} from "../useChatServerSendQueue";

type HookResult = ReturnType<typeof useChatServerSendQueue>;

function createEntry(overrides: Partial<ControllerSendQueueEntry> = {}): ControllerSendQueueEntry {
  return {
    id: "entry-1",
    conversationId: "controller-conversation-1",
    status: "queued",
    targetAgentHandles: ["octo"],
    message: { promptText: "Follow up on the codec lane" },
    errorMessage: null,
    createdAt: "2026-07-05T10:00:00.000Z",
    dispatchedAt: null,
    ...overrides,
  };
}

function Harness({
  conversationControllerId,
  resultRef,
}: {
  conversationControllerId: string | null;
  resultRef: MutableRefObject<HookResult | null>;
}) {
  resultRef.current = useChatServerSendQueue({
    conversationControllerId,
    runtimeControllerEnabled: true,
  });
  return null;
}

describe("useChatServerSendQueue", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    listSendQueueMock.mockReset();
    listSendQueueMock.mockResolvedValue([]);
    enqueueSendQueueEntryMock.mockReset();
    cancelSendQueueEntryMock.mockReset();
    dispatchSendQueueEntryNowMock.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderHook(
    conversationControllerId: string | null,
  ): Promise<MutableRefObject<HookResult | null>> {
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(
        <Harness conversationControllerId={conversationControllerId} resultRef={resultRef} />,
      );
    });
    return resultRef;
  }

  it("hydrates the server queue with the initial GET", async () => {
    listSendQueueMock.mockResolvedValue([createEntry()]);

    const resultRef = await renderHook("controller-conversation-1");

    expect(listSendQueueMock).toHaveBeenCalledWith({
      conversationId: "controller-conversation-1",
    });
    expect(resultRef.current?.serverSendQueueItems).toEqual([
      expect.objectContaining({
        id: "entry-1",
        message: "Follow up on the codec lane",
        source: "server",
        status: "queued",
      }),
    ]);
  });

  it("refetches when a conversation.sendQueue event targets this conversation", async () => {
    const resultRef = await renderHook("controller-conversation-1");
    expect(resultRef.current?.serverSendQueueItems).toEqual([]);

    listSendQueueMock.mockResolvedValue([createEntry()]);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("instafy:conversation-send-queue", {
          detail: {
            projectId: "project-1",
            conversationId: "controller-conversation-1",
            data: { action: "enqueued" },
          },
        }),
      );
    });

    expect(resultRef.current?.serverSendQueueItems).toHaveLength(1);
  });

  it("ignores conversation.sendQueue events for other conversations", async () => {
    await renderHook("controller-conversation-1");
    listSendQueueMock.mockClear();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("instafy:conversation-send-queue", {
          detail: {
            projectId: "project-1",
            conversationId: "controller-conversation-2",
            data: { action: "enqueued" },
          },
        }),
      );
    });

    expect(listSendQueueMock).not.toHaveBeenCalled();
  });

  it("reports enqueue failure so callers can fall back to localStorage", async () => {
    const withoutConversation = await renderHook(null);
    await act(async () => {
      await expect(
        withoutConversation.current?.enqueueServerSendQueueItem({
          message: "hello",
          targetAgentHandles: [],
        }),
      ).resolves.toBe(false);
    });
    expect(enqueueSendQueueEntryMock).not.toHaveBeenCalled();

    enqueueSendQueueEntryMock.mockResolvedValue(null);
    const resultRef = await renderHook("controller-conversation-1");
    await act(async () => {
      await expect(
        resultRef.current?.enqueueServerSendQueueItem({
          message: "hello",
          targetAgentHandles: ["octo"],
        }),
      ).resolves.toBe(false);
    });
  });

  it("appends the created entry optimistically after a successful enqueue", async () => {
    enqueueSendQueueEntryMock.mockResolvedValue(createEntry());
    const resultRef = await renderHook("controller-conversation-1");

    await act(async () => {
      await expect(
        resultRef.current?.enqueueServerSendQueueItem({
          message: "Follow up on the codec lane",
          targetAgentHandles: ["octo"],
        }),
      ).resolves.toBe(true);
    });

    expect(enqueueSendQueueEntryMock).toHaveBeenCalledWith({
      conversationId: "controller-conversation-1",
      message: expect.objectContaining({
        promptText: "Follow up on the codec lane",
        intent: "feature",
      }),
      targetAgentHandles: ["octo"],
    });
    expect(resultRef.current?.serverSendQueueItems).toHaveLength(1);
  });

  it("removes canceled and dispatched entries from the visible queue", async () => {
    listSendQueueMock.mockResolvedValue([createEntry(), createEntry({ id: "entry-2" })]);
    cancelSendQueueEntryMock.mockResolvedValue({ ok: true, entry: createEntry() });
    dispatchSendQueueEntryNowMock.mockResolvedValue({
      outcome: "dispatched",
      response: {
        runId: "run-1",
        promptId: "prompt-1",
        status: "queued",
      },
    });
    const resultRef = await renderHook("controller-conversation-1");

    await act(async () => {
      await expect(resultRef.current?.removeServerSendQueueEntry("entry-1")).resolves.toBe(true);
    });
    expect(resultRef.current?.serverSendQueueItems.map((item) => item.id)).toEqual(["entry-2"]);

    await act(async () => {
      await expect(
        resultRef.current?.dispatchServerSendQueueEntryNow("entry-2"),
      ).resolves.toBe(true);
    });
    expect(resultRef.current?.serverSendQueueItems).toEqual([]);
  });

  it("treats an already-dispatched send-now as success and resyncs the queue", async () => {
    listSendQueueMock.mockResolvedValue([createEntry()]);
    dispatchSendQueueEntryNowMock.mockResolvedValue({
      outcome: "alreadyDispatched",
      response: null,
    });
    const resultRef = await renderHook("controller-conversation-1");
    expect(resultRef.current?.serverSendQueueItems).toHaveLength(1);

    listSendQueueMock.mockResolvedValue([]);
    await act(async () => {
      await expect(
        resultRef.current?.dispatchServerSendQueueEntryNow("entry-1"),
      ).resolves.toBe(true);
    });

    expect(resultRef.current?.serverSendQueueItems).toEqual([]);
    expect(listSendQueueMock).toHaveBeenCalledTimes(2);
  });

  it("treats a dispatch of an entry that is already gone as success", async () => {
    listSendQueueMock.mockResolvedValue([createEntry()]);
    dispatchSendQueueEntryNowMock.mockResolvedValue({ outcome: "notFound", response: null });
    const resultRef = await renderHook("controller-conversation-1");
    expect(resultRef.current?.serverSendQueueItems).toHaveLength(1);

    listSendQueueMock.mockResolvedValue([]);
    await act(async () => {
      await expect(
        resultRef.current?.dispatchServerSendQueueEntryNow("entry-1"),
      ).resolves.toBe(true);
    });

    expect(resultRef.current?.serverSendQueueItems).toEqual([]);
    expect(listSendQueueMock).toHaveBeenCalledTimes(2);
  });

  it("treats a failed enqueue as successful when the server committed the entry anyway", async () => {
    enqueueSendQueueEntryMock.mockRejectedValue(new Error("request timed out"));
    const resultRef = await renderHook("controller-conversation-1");

    listSendQueueMock.mockResolvedValue([createEntry()]);
    await act(async () => {
      await expect(
        resultRef.current?.enqueueServerSendQueueItem({
          message: "Follow up on the codec lane",
          targetAgentHandles: ["octo"],
        }),
      ).resolves.toBe(true);
    });

    expect(resultRef.current?.serverSendQueueItems).toEqual([
      expect.objectContaining({ id: "entry-1", message: "Follow up on the codec lane" }),
    ]);
  });

  it("keeps reporting genuine enqueue failures so callers fall back to localStorage", async () => {
    enqueueSendQueueEntryMock.mockRejectedValue(new Error("request timed out"));
    const resultRef = await renderHook("controller-conversation-1");

    await act(async () => {
      await expect(
        resultRef.current?.enqueueServerSendQueueItem({
          message: "Follow up on the codec lane",
          targetAgentHandles: ["octo"],
        }),
      ).resolves.toBe(false);
    });

    expect(resultRef.current?.serverSendQueueItems).toEqual([]);
  });

  it("keeps the optimistic entry when the enqueue's own send-queue event refresh races the commit", async () => {
    const resultRef = await renderHook("controller-conversation-1");
    expect(resultRef.current?.serverSendQueueItems).toEqual([]);

    let resolveEnqueue: (entry: ControllerSendQueueEntry) => void = () => undefined;
    enqueueSendQueueEntryMock.mockImplementation(
      () =>
        new Promise<ControllerSendQueueEntry>((resolve) => {
          resolveEnqueue = resolve;
        }),
    );
    const listResolvers: Array<(entries: ControllerSendQueueEntry[]) => void> = [];
    listSendQueueMock.mockImplementation(
      () =>
        new Promise<ControllerSendQueueEntry[]>((resolve) => {
          listResolvers.push(resolve);
        }),
    );

    let enqueuePromise: Promise<boolean> | undefined;
    act(() => {
      enqueuePromise = resultRef.current?.enqueueServerSendQueueItem({
        message: "Follow up on the codec lane",
        targetAgentHandles: ["octo"],
      });
    });

    // The server inserts the row and echoes a conversation.sendQueue event
    // before the POST response reaches the client.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("instafy:conversation-send-queue", {
          detail: {
            projectId: "project-1",
            conversationId: "controller-conversation-1",
            data: { action: "enqueued" },
          },
        }),
      );
    });

    // The event-driven GET resolves with a snapshot read before the insert
    // became visible.
    expect(listResolvers).toHaveLength(1);
    await act(async () => {
      listResolvers[0]([]);
    });

    await act(async () => {
      resolveEnqueue(createEntry());
      await expect(enqueuePromise).resolves.toBe(true);
    });

    expect(resultRef.current?.serverSendQueueItems).toEqual([
      expect.objectContaining({ id: "entry-1", status: "queued" }),
    ]);
  });

  it("keeps an optimistic entry enqueued immediately after a conversation switch-in", async () => {
    const resultRef = await renderHook("controller-conversation-1");

    // Switch in while the new conversation's hydration GET is still in flight.
    const listResolvers: Array<(entries: ControllerSendQueueEntry[]) => void> = [];
    listSendQueueMock.mockImplementation(
      () =>
        new Promise<ControllerSendQueueEntry[]>((resolve) => {
          listResolvers.push(resolve);
        }),
    );
    await act(async () => {
      root.render(
        <Harness conversationControllerId="controller-conversation-2" resultRef={resultRef} />,
      );
    });
    expect(listResolvers).toHaveLength(1);

    let resolveEnqueue: (entry: ControllerSendQueueEntry) => void = () => undefined;
    enqueueSendQueueEntryMock.mockImplementation(
      () =>
        new Promise<ControllerSendQueueEntry>((resolve) => {
          resolveEnqueue = resolve;
        }),
    );
    let enqueuePromise: Promise<boolean> | undefined;
    act(() => {
      enqueuePromise = resultRef.current?.enqueueServerSendQueueItem({
        message: "Follow up on the codec lane",
        targetAgentHandles: ["octo"],
      });
    });

    // The enqueue's send-queue event echo lands while the POST is in flight.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("instafy:conversation-send-queue", {
          detail: {
            projectId: "project-1",
            conversationId: "controller-conversation-2",
            data: { action: "enqueued" },
          },
        }),
      );
    });

    // Both pending GETs resolve with snapshots read before the insert landed.
    await act(async () => {
      for (const resolve of listResolvers.splice(0)) {
        resolve([]);
      }
    });

    await act(async () => {
      resolveEnqueue(
        createEntry({ id: "entry-switch", conversationId: "controller-conversation-2" }),
      );
      await expect(enqueuePromise).resolves.toBe(true);
    });

    expect(resultRef.current?.serverSendQueueItems).toEqual([
      expect.objectContaining({ id: "entry-switch", status: "queued" }),
    ]);
  });

  it("ignores a stale refresh snapshot that resolves after the optimistic commit", async () => {
    const resultRef = await renderHook("controller-conversation-1");

    const listResolvers: Array<(entries: ControllerSendQueueEntry[]) => void> = [];
    listSendQueueMock.mockImplementation(
      () =>
        new Promise<ControllerSendQueueEntry[]>((resolve) => {
          listResolvers.push(resolve);
        }),
    );
    // A refresh starts before the enqueue...
    act(() => {
      window.dispatchEvent(
        new CustomEvent("instafy:conversation-send-queue", {
          detail: {
            projectId: "project-1",
            conversationId: "controller-conversation-1",
            data: { action: "dispatched" },
          },
        }),
      );
    });
    expect(listResolvers).toHaveLength(1);

    enqueueSendQueueEntryMock.mockResolvedValue(createEntry());
    await act(async () => {
      await expect(
        resultRef.current?.enqueueServerSendQueueItem({
          message: "Follow up on the codec lane",
          targetAgentHandles: ["octo"],
        }),
      ).resolves.toBe(true);
    });
    expect(resultRef.current?.serverSendQueueItems).toHaveLength(1);

    // ...and its pre-insert snapshot resolves after the optimistic commit. It
    // must not clobber the fresh entry.
    await act(async () => {
      listResolvers[0]([]);
    });
    expect(resultRef.current?.serverSendQueueItems).toEqual([
      expect.objectContaining({ id: "entry-1" }),
    ]);
  });

  it("discards optimistic enqueue results that resolve after switching away and back", async () => {
    let resolveEnqueue: (entry: ControllerSendQueueEntry) => void = () => undefined;
    enqueueSendQueueEntryMock.mockImplementation(
      () =>
        new Promise<ControllerSendQueueEntry>((resolve) => {
          resolveEnqueue = resolve;
        }),
    );
    const resultRef = await renderHook("controller-conversation-1");

    let enqueuePromise: Promise<boolean> | undefined;
    act(() => {
      enqueuePromise = resultRef.current?.enqueueServerSendQueueItem({
        message: "Follow up on the codec lane",
        targetAgentHandles: ["octo"],
      });
    });

    await act(async () => {
      root.render(
        <Harness conversationControllerId="controller-conversation-2" resultRef={resultRef} />,
      );
    });
    await act(async () => {
      root.render(
        <Harness conversationControllerId="controller-conversation-1" resultRef={resultRef} />,
      );
    });

    // The queue was reset and rehydrated in between; the stale commit must not
    // re-append an entry the server may already have dispatched.
    await act(async () => {
      resolveEnqueue(createEntry());
      await expect(enqueuePromise).resolves.toBe(true);
    });

    expect(resultRef.current?.serverSendQueueItems).toEqual([]);
  });

  it("discards optimistic enqueue results that resolve after a conversation switch", async () => {
    let resolveEnqueue: (entry: ControllerSendQueueEntry) => void = () => undefined;
    enqueueSendQueueEntryMock.mockImplementation(
      () =>
        new Promise<ControllerSendQueueEntry>((resolve) => {
          resolveEnqueue = resolve;
        }),
    );
    const resultRef = await renderHook("controller-conversation-1");

    let enqueuePromise: Promise<boolean> | undefined;
    act(() => {
      enqueuePromise = resultRef.current?.enqueueServerSendQueueItem({
        message: "Follow up on the codec lane",
        targetAgentHandles: ["octo"],
      });
    });

    await act(async () => {
      root.render(
        <Harness conversationControllerId="controller-conversation-2" resultRef={resultRef} />,
      );
    });

    await act(async () => {
      resolveEnqueue(createEntry());
      await expect(enqueuePromise).resolves.toBe(true);
    });

    expect(resultRef.current?.serverSendQueueItems).toEqual([]);
  });
});

describe("buildServerSendQueuePromptBody", () => {
  it("defaults interactive prompts to writable without requiring file changes", () => {
    const body = buildServerSendQueuePromptBody({
      message: "Fix the header",
      targetAgentHandles: ["octo"],
      metadata: { foo: "bar" },
    });

    expect(body.promptText).toBe("Fix the header");
    expect(body.intent).toBe("feature");
    expect(body.metadata).toMatchObject({ foo: "bar", writeIntent: true });
    expect((body.metadata as Record<string, unknown>).runtimeExpectations).toBeUndefined();
  });

  it("keeps terminal command metadata untouched", () => {
    const body = buildServerSendQueuePromptBody({
      message: "/term ls",
      targetAgentHandles: [],
      metadata: { messageType: "terminal_command" },
      intent: "terminal_command",
    });

    expect(body.intent).toBe("terminal_command");
    expect(body.metadata).toEqual({ messageType: "terminal_command" });
  });

  it("preserves an exact Shared Browser runtime in the durable queue body", () => {
    const body = buildServerSendQueuePromptBody({
      message: "Click the visible link",
      targetAgentHandles: ["octo"],
      metadata: {
        browserTransport: "shared",
        runtimeExpectations: { workspaceFileChanges: false },
      },
      runtimeOverride: {
        runtimeId: "shared-runtime-1",
        runtimeDisplayName: null,
        preferRuntime: true,
      },
    });

    expect(body).toMatchObject({
      runtimeId: "shared-runtime-1",
      runtimeDisplayName: null,
      preferRuntime: true,
      metadata: {
        browserTransport: "shared",
        runtimeExpectations: { workspaceFileChanges: false },
      },
    });
  });
});

describe("mapServerSendQueueEntryToQueuedItem", () => {
  it("maps failed entries with their error message", () => {
    const item = mapServerSendQueueEntryToQueuedItem(
      createEntry({ status: "failed", errorMessage: "runtime offline" }),
    );

    expect(item).toMatchObject({
      id: "entry-1",
      message: "Follow up on the codec lane",
      targetAgentHandles: ["octo"],
      source: "server",
      status: "failed",
      errorMessage: "runtime offline",
    });
  });

  it("drops entries without a prompt text", () => {
    expect(mapServerSendQueueEntryToQueuedItem(createEntry({ message: {} }))).toBeNull();
  });

  it("hydrates the queued runtime override for edit and fallback paths", () => {
    const item = mapServerSendQueueEntryToQueuedItem(
      createEntry({
        message: {
          promptText: "Click the visible link",
          runtimeId: "shared-runtime-1",
          runtimeDisplayName: null,
          preferRuntime: true,
        },
      }),
    );

    expect(item?.runtimeOverride).toEqual({
      runtimeId: "shared-runtime-1",
      runtimeDisplayName: null,
      preferRuntime: true,
    });
  });
});
