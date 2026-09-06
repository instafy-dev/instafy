// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listSendQueueMock = vi.hoisted(() => vi.fn());
const enqueueSendQueueEntryMock = vi.hoisted(() => vi.fn());
const cancelSendQueueEntryMock = vi.hoisted(() => vi.fn());
const dispatchSendQueueEntryNowMock = vi.hoisted(() => vi.fn());
const reorderSendQueueEntryMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../services/runtimeController/sendQueue", () => ({
  CONVERSATION_SEND_QUEUE_EVENT: "instafy:conversation-send-queue",
  listSendQueue: listSendQueueMock,
  enqueueSendQueueEntry: enqueueSendQueueEntryMock,
  cancelSendQueueEntry: cancelSendQueueEntryMock,
  dispatchSendQueueEntryNow: dispatchSendQueueEntryNowMock,
  reorderSendQueueEntry: reorderSendQueueEntryMock,
}));

import type { ControllerSendQueueEntry } from "../../../../services/runtimeController/sendQueue";
import {
  buildServerSendQueuePromptBody,
  mapServerSendQueueEntryToQueuedItem,
  reconcileServerQueueEntryPositions,
  reorderServerQueueEntries,
  useChatServerSendQueue,
} from "../useChatServerSendQueue";
import { queuedMentionComposer, QUEUED_MENTION_USER_ID } from "./fixtures/queuedMentionComposer";
import { MAX_QUEUED_COMPOSER_BYTES, queuedComposerDispatchMessage } from "../chatSendQueueComposer";

type HookResult = ReturnType<typeof useChatServerSendQueue>;

function createEntry(overrides: Partial<ControllerSendQueueEntry> = {}): ControllerSendQueueEntry {
  return {
    id: "entry-1",
    conversationId: "controller-conversation-1",
    status: "queued",
    queuePosition: 10,
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
    reorderSendQueueEntryMock.mockReset();
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
    expect(resultRef.current?.serverQueueHydrated).toBe(true);
  });

  it("stays unhydrated until the initial queue request settles successfully", async () => {
    let resolveList: (entries: ControllerSendQueueEntry[]) => void = () => undefined;
    listSendQueueMock.mockImplementation(
      () =>
        new Promise<ControllerSendQueueEntry[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    const resultRef = await renderHook("controller-conversation-1");
    expect(resultRef.current?.serverQueueHydrated).toBe(false);

    await act(async () => {
      resolveList([]);
      await Promise.resolve();
    });
    expect(resultRef.current?.serverQueueHydrated).toBe(true);
  });

  it("does not hydrate from a stale GET while a newer queue refresh is pending", async () => {
    const resolvers: Array<(entries: ControllerSendQueueEntry[]) => void> = [];
    listSendQueueMock.mockImplementation(
      () =>
        new Promise<ControllerSendQueueEntry[]>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const resultRef = await renderHook("controller-conversation-1");
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
    expect(resolvers).toHaveLength(2);

    await act(async () => {
      resolvers[0]?.([]);
      await Promise.resolve();
    });
    expect(resultRef.current?.serverQueueHydrated).toBe(false);

    await act(async () => {
      resolvers[1]?.([createEntry()]);
      await Promise.resolve();
    });
    expect(resultRef.current?.serverQueueHydrated).toBe(true);
    expect(resultRef.current?.serverSendQueueItems).toHaveLength(1);
  });

  it("moves an entry before an anchor without mutating the input", () => {
    const entries = [
      createEntry({ id: "entry-1", queuePosition: 10 }),
      createEntry({ id: "entry-2", queuePosition: 20 }),
      createEntry({ id: "entry-3", queuePosition: 30 }),
    ];

    const reordered = reorderServerQueueEntries(entries, "entry-3", "entry-1");

    expect(reordered.map((entry) => entry.id)).toEqual(["entry-3", "entry-1", "entry-2"]);
    expect(entries.map((entry) => entry.id)).toEqual(["entry-1", "entry-2", "entry-3"]);
    expect(reorderServerQueueEntries(reordered, "entry-3", "entry-1")).toBe(reordered);
  });

  it("adopts persisted positions without dropping concurrent queue changes", () => {
    const first = createEntry({ id: "entry-1", queuePosition: 10 });
    const second = createEntry({ id: "entry-2", queuePosition: 20 });
    const concurrent = createEntry({ id: "entry-3", queuePosition: 30 });

    const reconciled = reconcileServerQueueEntryPositions(
      [second, first, concurrent],
      [
        { ...second, queuePosition: 10 },
        { ...first, queuePosition: 20 },
      ],
    );

    expect(reconciled.map((entry) => entry.id)).toEqual(["entry-2", "entry-1", "entry-3"]);
  });

  it("optimistically reorders once and adopts the authoritative persisted order", async () => {
    const first = createEntry({ id: "entry-1", queuePosition: 10 });
    const second = createEntry({ id: "entry-2", queuePosition: 20 });
    listSendQueueMock.mockResolvedValue([first, second]);
    let resolveReorder: (value: {
      ok: boolean;
      changed: boolean;
      entries: ControllerSendQueueEntry[];
    }) => void = () => undefined;
    reorderSendQueueEntryMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReorder = resolve;
        }),
    );
    const resultRef = await renderHook("controller-conversation-1");

    let reorderPromise: Promise<boolean> | undefined;
    await act(async () => {
      reorderPromise = resultRef.current?.reorderServerSendQueueEntry("entry-2", "entry-1");
    });
    expect(resultRef.current?.serverSendQueueItems.map((entry) => entry.id)).toEqual([
      "entry-2",
      "entry-1",
    ]);
    expect(resultRef.current?.serverQueueReordering).toBe(true);
    await expect(
      resultRef.current?.reorderServerSendQueueEntry("entry-1", null),
    ).resolves.toBe(false);

    await act(async () => {
      resolveReorder({
        ok: true,
        changed: true,
        entries: [
          { ...second, queuePosition: 10 },
          { ...first, queuePosition: 20 },
        ],
      });
      await expect(reorderPromise).resolves.toBe(true);
    });

    expect(reorderSendQueueEntryMock).toHaveBeenCalledTimes(1);
    expect(reorderSendQueueEntryMock).toHaveBeenCalledWith({
      conversationId: "controller-conversation-1",
      entryId: "entry-2",
      beforeEntryId: "entry-1",
    });
    expect(resultRef.current?.serverSendQueueItems.map((entry) => entry.id)).toEqual([
      "entry-2",
      "entry-1",
    ]);
    expect(resultRef.current?.serverQueueReordering).toBe(false);
  });

  it("restores persisted order when reorder and reconciliation both fail", async () => {
    const first = createEntry({ id: "entry-1", queuePosition: 10 });
    const second = createEntry({ id: "entry-2", queuePosition: 20 });
    listSendQueueMock.mockResolvedValueOnce([first, second]).mockResolvedValueOnce(null);
    reorderSendQueueEntryMock.mockRejectedValue(new Error("request failed"));
    const resultRef = await renderHook("controller-conversation-1");

    let result: boolean | undefined;
    await act(async () => {
      result = await resultRef.current?.reorderServerSendQueueEntry("entry-2", "entry-1");
    });

    expect(result).toBe(false);
    expect(resultRef.current?.serverSendQueueItems.map((entry) => entry.id)).toEqual([
      "entry-1",
      "entry-2",
    ]);
    expect(resultRef.current?.serverQueueReordering).toBe(false);
  });

  it("does not let a stale reorder refresh or unlock the next conversation", async () => {
    const firstA = createEntry({ id: "entry-a-1", conversationId: "controller-conversation-1" });
    const secondA = createEntry({
      id: "entry-a-2",
      conversationId: "controller-conversation-1",
      queuePosition: 20,
    });
    const firstB = createEntry({ id: "entry-b-1", conversationId: "controller-conversation-2" });
    const secondB = createEntry({
      id: "entry-b-2",
      conversationId: "controller-conversation-2",
      queuePosition: 20,
    });
    listSendQueueMock.mockImplementation(({ conversationId }: { conversationId: string }) =>
      Promise.resolve(
        conversationId === "controller-conversation-1"
          ? [firstA, secondA]
          : [firstB, secondB],
      ),
    );
    let rejectA: (error: Error) => void = () => undefined;
    let resolveB: (value: {
      ok: boolean;
      changed: boolean;
      entries: ControllerSendQueueEntry[];
    }) => void = () => undefined;
    reorderSendQueueEntryMock.mockImplementation(
      ({ conversationId }: { conversationId: string }) =>
        new Promise((resolve, reject) => {
          if (conversationId === "controller-conversation-1") {
            rejectA = reject;
          } else {
            resolveB = resolve;
          }
        }),
    );
    const resultRef = await renderHook("controller-conversation-1");
    let reorderA: Promise<boolean> | undefined;
    act(() => {
      reorderA = resultRef.current?.reorderServerSendQueueEntry("entry-a-2", "entry-a-1");
    });

    await act(async () => {
      root.render(
        <Harness conversationControllerId="controller-conversation-2" resultRef={resultRef} />,
      );
    });
    let reorderB: Promise<boolean> | undefined;
    act(() => {
      reorderB = resultRef.current?.reorderServerSendQueueEntry("entry-b-2", "entry-b-1");
    });
    expect(resultRef.current?.serverQueueReordering).toBe(true);

    await act(async () => {
      rejectA(new Error("stale failure"));
      await expect(reorderA).resolves.toBe(false);
    });
    expect(resultRef.current?.serverSendQueueItems.map((entry) => entry.id)).toEqual([
      "entry-b-2",
      "entry-b-1",
    ]);
    expect(resultRef.current?.serverQueueReordering).toBe(true);
    await expect(
      resultRef.current?.reorderServerSendQueueEntry("entry-b-1", null),
    ).resolves.toBe(false);

    await act(async () => {
      resolveB({
        ok: true,
        changed: true,
        entries: [
          { ...secondB, queuePosition: 10 },
          { ...firstB, queuePosition: 20 },
        ],
      });
      await expect(reorderB).resolves.toBe(true);
    });
    expect(resultRef.current?.serverQueueReordering).toBe(false);
    expect(
      listSendQueueMock.mock.calls.filter(
        ([params]) => params.conversationId === "controller-conversation-1",
      ),
    ).toHaveLength(1);
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
  it.each(["plain", "page", "new_page"])("roundtrips real picker nodes bound to the exact %s queued dispatch", (mode) => {
    const composer = queuedMentionComposer();
    const browserPageTarget = mode === "page" ? { id: "page-1", url: "https://example.test/", host: "example.test", label: "Example" } : null;
    const browserLaunchMode = mode === "new_page" ? "new_page" as const : null;
    const message = queuedComposerDispatchMessage({ message: composer.message, browserPageTarget, browserLaunchMode });
    const body = buildServerSendQueuePromptBody({
      message, composerMessage: composer.message, editorState: composer.editorState,
      browserPageTarget, browserLaunchMode, targetAgentHandles: ["octo"],
      metadata: { mentionedUserIds: [QUEUED_MENTION_USER_ID] },
    });
    const hydrated = mapServerSendQueueEntryToQueuedItem(createEntry({ message: body }));
    expect(hydrated).toMatchObject({ ...composer, browserPageTarget, browserLaunchMode, metadata: { mentionedUserIds: [QUEUED_MENTION_USER_ID] } });
    expect(hydrated?.metadata?.queuedComposer).toBeUndefined();
  });

  it("does not restore sidecar editor text over a different authoritative queued message", () => {
    const composer = queuedMentionComposer();
    const body = buildServerSendQueuePromptBody({ ...composer, targetAgentHandles: ["octo"] });
    body.promptText = "Different server text";
    expect(mapServerSendQueueEntryToQueuedItem(createEntry({ message: body }))).toMatchObject({ message: "Different server text", editorState: null });
  });

  it("bounds persisted composer data and rejects mismatched editor text", () => {
    const composer = queuedMentionComposer("x".repeat(MAX_QUEUED_COMPOSER_BYTES));
    expect(() => buildServerSendQueuePromptBody({ ...composer, targetAgentHandles: [] })).toThrow("Unable to preserve this draft");
    expect(() => buildServerSendQueuePromptBody({ ...queuedMentionComposer(), message: "Unrelated text", targetAgentHandles: [] })).toThrow("Unable to preserve this draft");
  });

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
