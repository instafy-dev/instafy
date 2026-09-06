// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedChatSendItem } from "../chatSendQueueStorage";
import { useChatSendQueueActions } from "../useChatSendQueueActions";
import type { ServerQueuedChatSendItem } from "../useChatServerSendQueue";
import { buildServerSendQueuePromptBody, mapServerSendQueueEntryToQueuedItem } from "../useChatServerSendQueue";
import { queuedMentionComposer, QUEUED_MENTION_USER_ID } from "./fixtures/queuedMentionComposer";
import { queuedComposerDispatchMessage } from "../chatSendQueueComposer";

function hydratedPickerItem() {
  const composer = queuedMentionComposer();
  const browserPageTarget = { id: "page-1", url: "https://example.test/", host: "example.test", label: "Example" };
  const body = buildServerSendQueuePromptBody({
    message: queuedComposerDispatchMessage({ message: composer.message, browserPageTarget, browserLaunchMode: null }),
    composerMessage: composer.message, editorState: composer.editorState, browserPageTarget,
    targetAgentHandles: ["octo"], metadata: { mentionedUserIds: [QUEUED_MENTION_USER_ID] },
  });
  return mapServerSendQueueEntryToQueuedItem({
    id: "entry-1", conversationId: "controller-conversation-1", status: "queued", queuePosition: 10, targetAgentHandles: ["octo"],
    message: JSON.parse(JSON.stringify(body)), createdAt: new Date().toISOString(), dispatchedAt: null, errorMessage: null,
  })!;
}

type HookOptions = Parameters<typeof useChatSendQueueActions>[0];
type HookResult = ReturnType<typeof useChatSendQueueActions>;

function createServerItem(
  overrides: Partial<ServerQueuedChatSendItem> = {},
): ServerQueuedChatSendItem {
  return {
    id: "entry-1",
    message: "Queued for Octo",
    editorState: null,
    createdAt: Date.now(),
    targetAgentHandles: ["octo"],
    browserPageTarget: null,
    browserLaunchMode: null,
    metadata: null,
    source: "server",
    status: "queued",
    errorMessage: null,
    ...overrides,
  };
}

function createLocalItem(overrides: Partial<QueuedChatSendItem> = {}): QueuedChatSendItem {
  return {
    id: "local-1",
    message: "Queued locally",
    editorState: null,
    createdAt: Date.now(),
    targetAgentHandles: ["octo"],
    browserPageTarget: null,
    browserLaunchMode: null,
    metadata: null,
    ...overrides,
  };
}

function createOptions(overrides: Partial<HookOptions> = {}): HookOptions {
  return {
    activeConversationControllerId: "controller-conversation-1",
    activeConversationId: "conversation-local",
    chatSendQueue: [],
    dispatchServerSendQueueEntryNow: vi.fn(async () => true),
    editingQueuedItem: null,
    enqueueServerSendQueueItem: vi.fn(async () => true),
    focusInput: vi.fn(),
    hostedRuntimeEnsuring: false,
    imageAttachmentCount: 0,
    inputEditorState: null,
    inputValue: "",
    interruptConversationRuns: vi.fn(async () => []),
    invitePromptOpen: false,
    isAssistantTyping: false,
    latestInputValueRef: { current: "" },
    onInputChange: vi.fn(),
    queuedTargetHandlesByItemId: new Map<string, string[]>(),
    refreshServerSendQueue: vi.fn(async () => undefined),
    removeServerSendQueueEntry: vi.fn(async () => true),
    resolvePromptAgentTargets: vi.fn(() => ({ targetHandles: [] })),
    resolveQueuedItemTargets: (item: QueuedChatSendItem) => item.targetAgentHandles,
    runtimeReady: true,
    sendingAttachment: false,
    serverSendQueueItems: [],
    serverQueueHydrated: true,
    setChatSendQueue: vi.fn(),
    setChatSendQueueExpanded: vi.fn(),
    setEditingQueuedItem: vi.fn(),
    setPendingBrowserLaunchMode: vi.fn(),
    showStatus: vi.fn(),
    submitMessage: vi.fn(async () => true),
    targetsOverlapActiveRuns: vi.fn(() => false),
    waitingForPreferredRuntime: false,
    ...overrides,
  };
}

function Harness({
  options,
  resultRef,
}: {
  options: HookOptions;
  resultRef: MutableRefObject<HookResult | null>;
}) {
  resultRef.current = useChatSendQueueActions(options);
  return null;
}

describe("useChatSendQueueActions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderHook(options: HookOptions): Promise<MutableRefObject<HookResult | null>> {
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });
    return resultRef;
  }

  it("sends server entries now by interrupting runs and dispatching on the controller", async () => {
    const options = createOptions({
      interruptConversationRuns: vi.fn(async () => ["run-1"]),
      serverSendQueueItems: [createServerItem()],
      targetsOverlapActiveRuns: vi.fn(() => true),
    });
    const resultRef = await renderHook(options);

    await act(async () => {
      await resultRef.current?.handleSendQueuedMessageNow("entry-1");
    });

    expect(options.interruptConversationRuns).toHaveBeenCalledWith({
      conversationId: "controller-conversation-1",
      reason: "Interrupted by a new message",
      accessToken: null,
    });
    expect(options.dispatchServerSendQueueEntryNow).toHaveBeenCalledWith("entry-1");
    expect(options.submitMessage).not.toHaveBeenCalled();
  });

  it.each([true, false])("recomputes edited server-queue human mentions (selected mention: %s)", async (hasMention) => {
    const oldId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const newId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const item = createServerItem({ metadata: { mentionedUserIds: [oldId], preserved: true } });
    const options = createOptions({
      editingQueuedItem: { item, targetAgentHandles: ["octo"] },
      inputValue: "Edited @teammate message",
      inputEditorState: JSON.stringify({ root: { children: hasMention ? [{ type: "user-mention", userId: newId, handle: "teammate" }] : [{ type: "text", text: "@teammate" }] } }),
    });
    const resultRef = await renderHook(options);
    await act(async () => resultRef.current?.handleRequeueEditedMessage());
    expect(options.enqueueServerSendQueueItem).toHaveBeenCalledWith(expect.objectContaining({
      metadata: hasMention ? { mentionedUserIds: [newId], preserved: true } : { preserved: true },
    }));
  });

  it.each(["unchanged", "unrelated word", "removed token"])("preserves selected identities across server hydration, Edit, and requeue: %s", async (edit) => {
    const item = hydratedPickerItem();
    const initialOptions = createOptions({ serverSendQueueItems: [item] });
    const initial = await renderHook(initialOptions);
    await act(async () => { await initial.current?.handleEditQueuedMessage(item.id); });
    expect(initialOptions.onInputChange).toHaveBeenCalledWith("conversation-local", item.message, item.editorState);
    const edited = edit === "unchanged" ? { message: item.message, editorState: item.editorState }
      : queuedMentionComposer(" please check this updated page", edit !== "removed token");
    const options = createOptions({
      editingQueuedItem: { item, targetAgentHandles: ["octo"] },
      inputValue: edited.message, inputEditorState: edited.editorState,
    });
    const result = await renderHook(options);
    await act(async () => result.current?.handleRequeueEditedMessage());
    const payload = vi.mocked(options.enqueueServerSendQueueItem).mock.calls[0][0];
    const body = buildServerSendQueuePromptBody(payload);
    expect(body.promptText).toBe(queuedComposerDispatchMessage({ ...item, message: edited.message }));
    const rehydrated = mapServerSendQueueEntryToQueuedItem({
      id: "entry-2", conversationId: "controller-conversation-1", status: "queued", queuePosition: 10, targetAgentHandles: ["octo"],
      message: body, createdAt: new Date().toISOString(), dispatchedAt: null, errorMessage: null,
    });
    expect(rehydrated?.editorState).toBe(edited.editorState);
    expect(rehydrated?.metadata?.mentionedUserIds).toEqual(edit === "removed token" ? undefined : [QUEUED_MENTION_USER_ID]);
    expect(rehydrated?.browserPageTarget).toEqual(item.browserPageTarget);
  });

  it.each([true, false])("forwards the hydrated edited nodes through Send edited now (mention remains: %s)", async (selected) => {
    const item = hydratedPickerItem();
    const edited = queuedMentionComposer(" please check the updated page", selected);
    const options = createOptions({
      editingQueuedItem: { item, targetAgentHandles: ["octo"] }, inputValue: edited.message, inputEditorState: edited.editorState,
    });
    const result = await renderHook(options);
    await act(async () => { await result.current?.handleSendEditedMessageNow(); });
    const payload = vi.mocked(options.submitMessage).mock.calls[0][0];
    expect(payload?.editorState).toBe(edited.editorState);
    expect(payload?.metadata?.mentionedUserIds).toEqual(selected ? [QUEUED_MENTION_USER_ID] : undefined);
    expect(payload?.browserPageTarget).toEqual(item.browserPageTarget);
  });

  it("preserves hydrated nodes when cancel-edit falls back locally and later auto-drains", async () => {
    const item = hydratedPickerItem();
    const options = createOptions({
      editingQueuedItem: { item, targetAgentHandles: ["octo"] }, enqueueServerSendQueueItem: vi.fn(async () => false),
    });
    const result = await renderHook(options);
    await act(async () => result.current?.handleCancelQueuedEdit());
    const update = vi.mocked(options.setChatSendQueue).mock.calls[0][0];
    const restored = typeof update === "function" ? update([]) : update;
    expect(restored[0].editorState).toBe(item.editorState);
    const draining = createOptions({ chatSendQueue: restored });
    await renderHook(draining);
    expect(draining.submitMessage).toHaveBeenCalledWith(expect.objectContaining({
      editorState: item.editorState, metadata: expect.objectContaining({ mentionedUserIds: [QUEUED_MENTION_USER_ID] }),
    }), { allowWhileBusy: true });
  });

  it("keeps the local resend path for localStorage fallback entries", async () => {
    const runtimeOverride = {
      runtimeId: "shared-runtime-1",
      runtimeDisplayName: null,
      preferRuntime: true,
    };
    const options = createOptions({
      chatSendQueue: [createLocalItem({ runtimeOverride })],
      isAssistantTyping: true,
    });
    const resultRef = await renderHook(options);

    await act(async () => {
      await resultRef.current?.handleSendQueuedMessageNow("local-1");
    });

    expect(options.dispatchServerSendQueueEntryNow).not.toHaveBeenCalled();
    expect(options.submitMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Queued locally",
        runtimeOverride,
      }),
      { allowWhileBusy: true },
    );
    expect(options.setChatSendQueue).toHaveBeenCalled();
  });

  it("does not auto-drain server queue entries (the controller dispatches them)", async () => {
    const options = createOptions({
      serverSendQueueItems: [createServerItem()],
    });
    await renderHook(options);

    await act(async () => {
      await Promise.resolve();
    });

    expect(options.submitMessage).not.toHaveBeenCalled();
    expect(options.dispatchServerSendQueueEntryNow).not.toHaveBeenCalled();
  });

  it("still auto-drains localStorage fallback entries once the runtime is free", async () => {
    const options = createOptions({
      chatSendQueue: [createLocalItem()],
    });
    await renderHook(options);

    await act(async () => {
      await Promise.resolve();
    });

    expect(options.submitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Queued locally" }),
      { allowWhileBusy: true },
    );
  });

  it("keeps local fallback entries behind the visible server queue", async () => {
    const options = createOptions({
      chatSendQueue: [createLocalItem()],
      serverSendQueueItems: [createServerItem()],
    });
    await renderHook(options);

    await act(async () => {
      await Promise.resolve();
    });

    expect(options.submitMessage).not.toHaveBeenCalled();
  });

  it("waits for server queue hydration before draining a local fallback", async () => {
    const options = createOptions({
      chatSendQueue: [createLocalItem()],
      serverQueueHydrated: false,
    });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });
    expect(options.submitMessage).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        <Harness options={{ ...options, serverQueueHydrated: true }} resultRef={resultRef} />,
      );
      await Promise.resolve();
    });
    expect(options.submitMessage).toHaveBeenCalledTimes(1);
  });

  it("cancels the server entry when steering it into the composer", async () => {
    const serverItem = createServerItem();
    const options = createOptions({
      serverSendQueueItems: [serverItem],
    });
    const resultRef = await renderHook(options);

    await act(async () => {
      await resultRef.current?.handleEditQueuedMessage("entry-1");
    });

    expect(options.removeServerSendQueueEntry).toHaveBeenCalledWith("entry-1");
    expect(options.setEditingQueuedItem).toHaveBeenCalledWith({
      item: serverItem,
      targetAgentHandles: ["octo"],
    });
    expect(options.onInputChange).toHaveBeenCalledWith(
      "conversation-local",
      "Queued for Octo",
      null,
    );
    expect(options.setChatSendQueue).not.toHaveBeenCalled();
  });

  it("does not steer a server entry into the composer when the removal fails", async () => {
    const options = createOptions({
      removeServerSendQueueEntry: vi.fn(async () => false),
      serverSendQueueItems: [createServerItem()],
    });
    const resultRef = await renderHook(options);

    await act(async () => {
      await resultRef.current?.handleEditQueuedMessage("entry-1");
    });

    expect(options.removeServerSendQueueEntry).toHaveBeenCalledWith("entry-1");
    expect(options.showStatus).toHaveBeenCalledWith(
      "Couldn't remove the queued message — it may have already been sent.",
      "info",
      5000,
    );
    expect(options.refreshServerSendQueue).toHaveBeenCalledTimes(1);
    expect(options.setEditingQueuedItem).not.toHaveBeenCalled();
    expect(options.onInputChange).not.toHaveBeenCalled();
  });

  it("re-enqueues a canceled server edit back onto the controller queue", async () => {
    const serverItem = createServerItem();
    const options = createOptions({
      editingQueuedItem: { item: serverItem, targetAgentHandles: ["octo"] },
    });
    const resultRef = await renderHook(options);

    await act(async () => {
      resultRef.current?.handleCancelQueuedEdit();
    });

    expect(options.enqueueServerSendQueueItem).toHaveBeenCalledWith({
      message: "Queued for Octo",
      composerMessage: "Queued for Octo",
      editorState: null,
      browserPageTarget: null,
      browserLaunchMode: null,
      targetAgentHandles: ["octo"],
      metadata: null,
    });
    expect(options.setChatSendQueue).not.toHaveBeenCalled();
    expect(options.setEditingQueuedItem).toHaveBeenCalledWith(null);
  });
});
