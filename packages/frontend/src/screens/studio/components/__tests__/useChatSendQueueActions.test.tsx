// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MutableRefObject } from "react";
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditingQueuedChatItem, QueuedChatSendItem } from "../chatSendQueueStorage";
import { useChatSendQueueActions } from "../useChatSendQueueActions";
import type { ServerQueuedChatSendItem } from "../useChatServerSendQueue";
import { buildServerSendQueuePromptBody, mapServerSendQueueEntryToQueuedItem } from "../useChatServerSendQueue";
import { queuedMentionComposer, QUEUED_MENTION_USER_ID } from "./fixtures/queuedMentionComposer";
import { queuedComposerDispatchMessage } from "../chatSendQueueComposer";

function hydratedPickerItem() {
  const composer = queuedMentionComposer();
  const browserPageTarget = { id: "page-1", url: "https://example.test/", host: "example.test", label: "Example" };
  const body = buildServerSendQueuePromptBody({
    message: queuedComposerDispatchMessage({ message: composer.message, browserLaunchMode: null }),
    composerMessage: composer.message, editorState: composer.editorState, browserPageTarget,
    targetAgentHandles: ["octo"], metadata: { mentionedUserIds: [QUEUED_MENTION_USER_ID] },
  });
  return mapServerSendQueueEntryToQueuedItem({
    id: "entry-1", conversationId: "controller-conversation-1", status: "queued", queuePosition: 10, targetAgentHandles: ["octo"],
    updatedAt: "2026-10-23T12:00:00.123456Z", message: JSON.parse(JSON.stringify(body)), createdAt: new Date().toISOString(), dispatchedAt: null, errorMessage: null,
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
    updatedAt: "2026-10-23T12:00:00.123456Z",
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

function plainEditorState(message: string, format = 0): string {
  const editor = createEditor({ onError: (error) => { throw error; } });
  editor.update(() => {
    for (const line of message.split("\n")) {
      $getRoot().append($createParagraphNode().append($createTextNode(line).setFormat(format)));
    }
  }, { discrete: true });
  return JSON.stringify(editor.getEditorState().toJSON());
}

function createOptions(overrides: Partial<HookOptions> = {}): HookOptions {
  return {
    activeConversationControllerId: "controller-conversation-1",
    activeConversationId: "conversation-local",
    chatSendQueue: [],
    dispatchServerSendQueueEntryNow: vi.fn(async () => true),
    editingQueuedItem: null,
    restoreServerSendQueueItem: vi.fn(async () => true),
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

  it.each([
    { draft: "Unsent work", attachments: 0, uploading: false },
    { draft: "", attachments: 1, uploading: false },
    { draft: "", attachments: 0, uploading: true },
  ])("protects the existing composer before editing a queued message: %j", async ({ draft, attachments, uploading }) => {
    const options = createOptions({
      serverSendQueueItems: [createServerItem()],
      latestInputValueRef: { current: draft },
      imageAttachmentCount: attachments,
      sendingAttachment: uploading,
    });
    const result = await renderHook(options);
    await act(async () => result.current?.handleEditQueuedMessage("entry-1"));
    expect(options.removeServerSendQueueEntry).not.toHaveBeenCalled();
    expect(options.onInputChange).not.toHaveBeenCalled();
    expect(options.setEditingQueuedItem).not.toHaveBeenCalled();
    expect(options.showStatus).toHaveBeenCalled();
  });

  it.each([true, false])("protects text typed while cancellation is pending (restore succeeds: %s)", async (restored) => {
    let resolveRemoval!: (removed: boolean) => void;
    const options = createOptions({
      serverSendQueueItems: [createServerItem()],
      removeServerSendQueueEntry: vi.fn(() => new Promise<boolean>((resolve) => { resolveRemoval = resolve; })),
      restoreServerSendQueueItem: vi.fn(async () => restored),
    });
    const result = await renderHook(options);
    let editing!: Promise<void>;
    await act(async () => { editing = result.current!.handleEditQueuedMessage("entry-1"); });
    expect(result.current?.queueEditPending).toBe(true);
    await act(async () => result.current?.handleEditQueuedMessage("entry-1"));
    expect(options.removeServerSendQueueEntry).toHaveBeenCalledTimes(1);
    options.latestInputValueRef.current = "Typed during the request";
    await act(async () => { resolveRemoval(true); await editing; });
    expect(options.onInputChange).not.toHaveBeenCalled();
    expect(options.restoreServerSendQueueItem).toHaveBeenCalledWith("entry-1", expect.objectContaining({ composerMessage: "Queued for Octo" }), "queued");
    expect(options.latestInputValueRef.current).toBe("Typed during the request");
    if (restored) {
      const update = vi.mocked(options.setEditingQueuedItem).mock.calls[0][0];
      expect(typeof update).toBe("function");
      if (typeof update === "function") expect(update(null)).toBeNull();
    } else {
      expect(options.setEditingQueuedItem).toHaveBeenCalledWith(expect.objectContaining({ restoreOnly: true }));
    }
  });

  it("does not cancel an entry on an older controller that cannot restore its slot", async () => {
    const options = createOptions({ serverSendQueueItems: [createServerItem({ updatedAt: undefined })] });
    const result = await renderHook(options);
    await act(async () => result.current?.handleEditQueuedMessage("entry-1"));
    expect(options.removeServerSendQueueEntry).not.toHaveBeenCalled();
    expect(options.onInputChange).not.toHaveBeenCalled();
    expect(options.showStatus).toHaveBeenCalledWith(expect.stringContaining("Update the controller"), "info", 5000);
  });

  it("offers recovery on returning after switching chats during a failed restore", async () => {
    let finishRemoval!: (removed: boolean) => void;
    const options = createOptions({
      serverSendQueueItems: [createServerItem()],
      removeServerSendQueueEntry: vi.fn(() => new Promise<boolean>((resolve) => { finishRemoval = resolve; })),
      restoreServerSendQueueItem: vi.fn(async () => false),
    });
    const result = await renderHook(options);
    let edit!: Promise<void>;
    await act(async () => { edit = result.current!.handleEditQueuedMessage("entry-1"); });
    await renderHook({ ...options, activeConversationId: "other-conversation" });
    await act(async () => { finishRemoval(true); await edit; });
    expect(options.onInputChange).not.toHaveBeenCalled();
    expect(options.setEditingQueuedItem).not.toHaveBeenCalled();
    await renderHook(options);
    expect(options.setEditingQueuedItem).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({ id: "entry-1" }), restoreOnly: true,
    }));
  });

  it("clears recovery if the user returns to the chat before automatic restore succeeds", async () => {
    let finishRemoval!: (removed: boolean) => void;
    let finishRestore!: (restored: boolean) => void;
    let recovery: EditingQueuedChatItem | null = null;
    const options = createOptions({
      serverSendQueueItems: [createServerItem()],
      removeServerSendQueueEntry: vi.fn(() => new Promise<boolean>((resolve) => { finishRemoval = resolve; })),
      restoreServerSendQueueItem: vi.fn(() => new Promise<boolean>((resolve) => { finishRestore = resolve; })),
      setEditingQueuedItem: vi.fn((update) => { recovery = typeof update === "function" ? update(recovery) : update; }),
    });
    const result = await renderHook(options);
    let edit!: Promise<void>;
    await act(async () => { edit = result.current!.handleEditQueuedMessage("entry-1"); });
    await renderHook({ ...options, activeConversationId: "other-conversation" });
    await act(async () => { finishRemoval(true); });
    expect(options.restoreServerSendQueueItem).toHaveBeenCalledTimes(1);

    options.latestInputValueRef.current = "A draft that must stay";
    await renderHook(options);
    expect(recovery).toEqual(expect.objectContaining({ restoreOnly: true, item: expect.objectContaining({ id: "entry-1" }) }));
    await act(async () => { finishRestore(true); await edit; });

    expect(recovery).toBeNull();
    expect(options.latestInputValueRef.current).toBe("A draft that must stay");
    expect(options.onInputChange).not.toHaveBeenCalled();
    expect(options.setPendingBrowserLaunchMode).not.toHaveBeenCalled();
    const clearRecovery = vi.mocked(options.setEditingQueuedItem).mock.calls.at(-1)![0];
    expect(typeof clearRecovery).toBe("function");
    if (typeof clearRecovery === "function") {
      const unrelated = { item: createLocalItem(), targetAgentHandles: [], restoreOnly: true };
      const normalEdit = { item: createServerItem(), targetAgentHandles: [] };
      expect(clearRecovery(unrelated)).toBe(unrelated);
      expect(clearRecovery(normalEdit)).toBe(normalEdit);
    }
    vi.mocked(options.setEditingQueuedItem).mockClear();
    await renderHook({ ...options, activeConversationId: "other-conversation" });
    await renderHook(options);
    expect(options.setEditingQueuedItem).not.toHaveBeenCalled();
  });

  it("keeps failed automatic restore in its original chat after navigation during the request", async () => {
    let finishRemoval!: (removed: boolean) => void;
    let finishRestore!: (restored: boolean) => void;
    const options = createOptions({
      serverSendQueueItems: [createServerItem()],
      removeServerSendQueueEntry: vi.fn(() => new Promise<boolean>((resolve) => { finishRemoval = resolve; })),
      restoreServerSendQueueItem: vi.fn(() => new Promise<boolean>((resolve) => { finishRestore = resolve; })),
    });
    const result = await renderHook(options);
    let edit!: Promise<void>;
    await act(async () => { edit = result.current!.handleEditQueuedMessage("entry-1"); });
    options.latestInputValueRef.current = "Typed during cancellation";
    await act(async () => { finishRemoval(true); });
    expect(options.restoreServerSendQueueItem).toHaveBeenCalledTimes(1);

    await renderHook({ ...options, activeConversationId: "other-conversation" });
    await act(async () => { finishRestore(false); await edit; });
    expect(options.setEditingQueuedItem).not.toHaveBeenCalled();
    expect(options.onInputChange).not.toHaveBeenCalled();

    await renderHook(options);
    expect(options.setEditingQueuedItem).toHaveBeenCalledWith(expect.objectContaining({
      restoreOnly: true, item: expect.objectContaining({ id: "entry-1" }),
    }));
    expect(options.latestInputValueRef.current).toBe("Typed during cancellation");
  });

  it("does not offer to restore an edit already sent while another chat was open", async () => {
    let finishSend!: (sent: boolean) => void;
    const item = createLocalItem();
    const options = createOptions({
      chatSendQueue: [item], runtimeReady: false,
      submitMessage: vi.fn(() => new Promise<boolean>((resolve) => { finishSend = resolve; })),
    });
    const initial = await renderHook(options);
    await act(async () => initial.current?.handleEditQueuedMessage(item.id));
    const editing = vi.mocked(options.setEditingQueuedItem).mock.calls[0][0];
    if (typeof editing === "function" || !editing) throw new Error("expected queued edit");
    const result = await renderHook({ ...options, chatSendQueue: [], editingQueuedItem: editing, inputValue: item.message });
    let sending!: Promise<void>;
    await act(async () => { sending = result.current!.handleSendEditedMessageNow(); });
    await renderHook({ ...options, chatSendQueue: [], activeConversationId: "other-chat" });
    await act(async () => { finishSend(true); await sending; });
    vi.mocked(options.setEditingQueuedItem).mockClear();
    await renderHook({ ...options, chatSendQueue: [] });
    expect(options.setEditingQueuedItem).not.toHaveBeenCalled();
  });

  it.each(["cancel", "save"])("restores the middle local item to its original position on %s", async (action) => {
    const a = createLocalItem({ id: "a", message: "First" });
    const b = createLocalItem({ id: "b", message: "Middle" });
    const c = createLocalItem({ id: "c", message: "Third" });
    const added = createLocalItem({ id: "added", message: "Added during edit" });
    const options = createOptions({
      chatSendQueue: [a, c, added],
      editingQueuedItem: { item: b, targetAgentHandles: ["octo"], originalQueueOrder: ["a", "b", "c"] },
      inputValue: action === "save" ? "Updated middle" : b.message,
      latestInputValueRef: { current: action === "save" ? "Updated middle" : b.message },
    });
    const result = await renderHook(options);
    await act(async () => action === "save" ? result.current?.handleRequeueEditedMessage() : result.current?.handleCancelQueuedEdit());
    const update = vi.mocked(options.setChatSendQueue).mock.calls[0][0];
    const queue = typeof update === "function" ? update([a, c, added]) : update;
    expect(queue.map((item) => item.id)).toEqual(["a", "b", "c", "added"]);
    expect(queue[1].message).toBe(action === "save" ? "Updated middle" : "Middle");
    expect(queue[1].createdAt).toBe(b.createdAt);
  });

  it("routes the ordinary composer action to Save queue during an edit", async () => {
    const first = createLocalItem({ id: "first", message: "First" });
    const edited = createLocalItem({ id: "edited", message: "Old second" });
    const options = createOptions({
      chatSendQueue: [first],
      editingQueuedItem: { item: edited, targetAgentHandles: ["octo"], originalQueueOrder: ["first", "edited"] },
      inputValue: "Updated second", latestInputValueRef: { current: "Updated second" },
    });
    const result = await renderHook(options);
    await act(async () => { expect(await result.current?.handleQueuedEditComposerSubmit()).toBe(true); });
    expect(options.submitMessage).not.toHaveBeenCalled();
    expect(options.setEditingQueuedItem).toHaveBeenCalledWith(null);
    const update = vi.mocked(options.setChatSendQueue).mock.calls[0][0];
    const queue = typeof update === "function" ? update([first]) : update;
    expect(queue.map((item) => item.message)).toEqual(["First", "Updated second"]);
  });

  it.each([false, true])("does not intercept independent sends or protected drafts (restore only: %s)", async (restoreOnly) => {
    const options = createOptions({
      editingQueuedItem: { item: createLocalItem(), targetAgentHandles: ["octo"], restoreOnly },
    });
    const result = await renderHook(options);
    expect(result.current?.handleQueuedEditComposerSubmit({ message: "Independent task", editorState: null })).toBeNull();
    if (restoreOnly) expect(result.current?.handleQueuedEditComposerSubmit()).toBeNull();
    expect(options.setChatSendQueue).not.toHaveBeenCalled();
  });

  it("does not drop newly added images when saving a queued text edit", async () => {
    const item = createLocalItem();
    const options = createOptions({
      editingQueuedItem: { item, targetAgentHandles: ["octo"] },
      inputValue: item.message, latestInputValueRef: { current: item.message }, imageAttachmentCount: 1,
    });
    const result = await renderHook(options);
    await act(async () => { expect(await result.current?.handleQueuedEditComposerSubmit()).toBe(false); });
    expect(options.setChatSendQueue).not.toHaveBeenCalled();
    expect(options.setEditingQueuedItem).not.toHaveBeenCalledWith(null);
    expect(options.onInputChange).not.toHaveBeenCalled();
    expect(options.submitMessage).not.toHaveBeenCalled();
    await act(async () => result.current?.handleSendEditedMessageNow());
    expect(options.submitMessage).not.toHaveBeenCalled();
    await act(async () => result.current?.handleCancelQueuedEdit());
    expect(options.setChatSendQueue).toHaveBeenCalledTimes(1);
    expect(options.setEditingQueuedItem).toHaveBeenCalledWith(null);
    expect(options.onInputChange).not.toHaveBeenCalled();
  });

  it.each(["Queued locally", "First line\nSecond line"])("clears an unchanged plain draft after Lexical hydration on Cancel: %s", async (message) => {
    const item = createLocalItem({ message, editorState: null });
    const options = createOptions({
      editingQueuedItem: { item, targetAgentHandles: ["octo"] },
      inputValue: item.message, latestInputValueRef: { current: item.message }, inputEditorState: plainEditorState(message),
    });
    const result = await renderHook(options);
    await act(async () => result.current?.handleCancelQueuedEdit());
    expect(options.setChatSendQueue).toHaveBeenCalledTimes(1);
    expect(options.onInputChange).toHaveBeenCalledWith("conversation-local", "", null);
    expect(options.latestInputValueRef.current).toBe("");
  });

  it("keeps changed formatting when canceling an edit with unchanged display text", async () => {
    const item = createLocalItem();
    const options = createOptions({
      editingQueuedItem: { item, targetAgentHandles: ["octo"] },
      inputValue: item.message, latestInputValueRef: { current: item.message }, inputEditorState: plainEditorState(item.message, 1),
    });
    const result = await renderHook(options);
    await act(async () => result.current?.handleCancelQueuedEdit());
    expect(options.setChatSendQueue).toHaveBeenCalledTimes(1);
    expect(options.onInputChange).not.toHaveBeenCalled();
    expect(options.setPendingBrowserLaunchMode).not.toHaveBeenCalled();
  });

  it("keeps a changed mention identity when canceling an edit with unchanged display text", async () => {
    const composer = queuedMentionComposer();
    const item = createLocalItem(composer);
    const options = createOptions({
      editingQueuedItem: { item, targetAgentHandles: ["octo"] },
      inputValue: item.message, latestInputValueRef: { current: item.message },
      inputEditorState: composer.editorState.replace(QUEUED_MENTION_USER_ID, "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff"),
    });
    const result = await renderHook(options);
    await act(async () => result.current?.handleCancelQueuedEdit());
    expect(options.setChatSendQueue).toHaveBeenCalledTimes(1);
    expect(options.onInputChange).not.toHaveBeenCalled();
    expect(options.setPendingBrowserLaunchMode).not.toHaveBeenCalled();
  });

  it("keeps a previously failed server item failed when canceling its edit", async () => {
    const item = createServerItem({ status: "failed" });
    const options = createOptions({ editingQueuedItem: { item, targetAgentHandles: ["octo"] } });
    const result = await renderHook(options);
    await act(async () => result.current?.handleCancelQueuedEdit());
    expect(options.restoreServerSendQueueItem).toHaveBeenCalledWith(item.id, expect.objectContaining({ composerMessage: item.message }), "failed");
  });

  it("preserves the original delivery intent when restoring a server edit", async () => {
    const item = createServerItem({ intent: "terminal_command" });
    const options = createOptions({ editingQueuedItem: { item, targetAgentHandles: ["octo"] } });
    const result = await renderHook(options);
    await act(async () => result.current?.handleCancelQueuedEdit());
    expect(options.restoreServerSendQueueItem).toHaveBeenCalledWith(item.id, expect.objectContaining({ intent: "terminal_command" }), "queued");
  });

  it("keeps edits available when the server cannot save and does not enqueue a fallback", async () => {
    const item = createServerItem();
    const options = createOptions({
      editingQueuedItem: { item, targetAgentHandles: ["octo"] }, inputValue: "Edited text", latestInputValueRef: { current: "Edited text" },
      restoreServerSendQueueItem: vi.fn(async () => false),
    });
    const result = await renderHook(options);
    await act(async () => result.current?.handleRequeueEditedMessage());
    expect(options.onInputChange).not.toHaveBeenCalled();
    expect(options.setEditingQueuedItem).not.toHaveBeenCalledWith(null);
    expect(options.setChatSendQueue).not.toHaveBeenCalled();
  });

  it("serializes Save and Cancel and preserves text typed while saving", async () => {
    let finishRestore!: (restored: boolean) => void;
    const item = createServerItem();
    const options = createOptions({
      editingQueuedItem: { item, targetAgentHandles: ["octo"] }, inputValue: "Saved edit", latestInputValueRef: { current: "Saved edit" },
      restoreServerSendQueueItem: vi.fn(() => new Promise<boolean>((resolve) => { finishRestore = resolve; })),
    });
    const result = await renderHook(options);
    let saving!: Promise<boolean>;
    await act(async () => { saving = result.current!.handleRequeueEditedMessage(); });
    expect(result.current?.queueEditPending).toBe(true);
    await act(async () => {
      await result.current?.handleRequeueEditedMessage();
      await result.current?.handleCancelQueuedEdit();
      await result.current?.handleSendEditedMessageNow();
    });
    expect(options.restoreServerSendQueueItem).toHaveBeenCalledTimes(1);
    expect(options.submitMessage).not.toHaveBeenCalled();
    options.latestInputValueRef.current = "New draft typed during Save";
    await act(async () => { finishRestore(true); await saving; });
    expect(options.onInputChange).not.toHaveBeenCalled();
    expect(options.setEditingQueuedItem).toHaveBeenCalledWith(null);
    expect(result.current?.queueEditPending).toBe(false);
  });

  it("does not save or send a protected draft while an interrupted edit needs restoring", async () => {
    const item = createServerItem();
    const options = createOptions({
      editingQueuedItem: { item, targetAgentHandles: ["octo"], restoreOnly: true },
      inputValue: "My protected draft", latestInputValueRef: { current: "My protected draft" },
    });
    const result = await renderHook(options);
    await act(async () => {
      await result.current?.handleRequeueEditedMessage();
      await result.current?.handleSendEditedMessageNow();
    });
    expect(options.restoreServerSendQueueItem).not.toHaveBeenCalled();
    expect(options.submitMessage).not.toHaveBeenCalled();
    await act(async () => result.current?.handleCancelQueuedEdit());
    expect(options.restoreServerSendQueueItem).toHaveBeenCalledTimes(1);
    expect(options.onInputChange).not.toHaveBeenCalled();
  });

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
    expect(options.restoreServerSendQueueItem).toHaveBeenCalledWith(item.id, expect.objectContaining({
      metadata: hasMention ? { mentionedUserIds: [newId], preserved: true } : { preserved: true },
    }), "queued");
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
    const payload = vi.mocked(options.restoreServerSendQueueItem).mock.calls[0][1];
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

  it("keeps a failed restore editable instead of creating a duplicate fallback entry", async () => {
    const item = hydratedPickerItem();
    const options = createOptions({
      editingQueuedItem: { item, targetAgentHandles: ["octo"] }, restoreServerSendQueueItem: vi.fn(async () => false),
      inputValue: item.message, latestInputValueRef: { current: item.message },
    });
    const result = await renderHook(options);
    await act(async () => result.current?.handleCancelQueuedEdit());
    expect(options.setChatSendQueue).not.toHaveBeenCalled();
    expect(options.setEditingQueuedItem).not.toHaveBeenCalledWith(null);
    expect(options.onInputChange).not.toHaveBeenCalled();
    expect(options.showStatus).toHaveBeenCalledWith(expect.stringContaining("try Cancel again"), "error", 5000);
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

  it("sends a message a stop left unsent only when its sender asks, through the controller", async () => {
    // The controller fails what was queued behind a turn a person stopped
    // once it gives that turn up; send now takes a failed entry.
    const unsent = createServerItem({
      status: "failed",
      errorMessage: "Not sent because the runtime was stopped. Send it now if you still need it, or remove it.",
    });
    const options = createOptions({ runtimeReady: true, serverSendQueueItems: [unsent] });
    // A machine that is ready, or comes back, does not send it.
    await renderHook(options);
    await act(async () => {
      await Promise.resolve();
    });
    expect(options.dispatchServerSendQueueEntryNow).not.toHaveBeenCalled();

    // Nor does a stopped machine keep its sender from sending it now.
    const resultRef = await renderHook({ ...options, runtimeReady: false });
    await act(async () => {
      await resultRef.current?.handleSendQueuedMessageNow("entry-1");
    });
    expect(options.dispatchServerSendQueueEntryNow).toHaveBeenCalledWith("entry-1");
    expect(options.submitMessage).not.toHaveBeenCalled();
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

  it("drains a local fallback entry as no new typed message", async () => {
    const options = createOptions({
      chatSendQueue: [
        createLocalItem({ metadata: { input: { kind: "person" }, mentionedUserIds: ["user-1"] } }),
      ],
    });
    await renderHook(options);

    await act(async () => {
      await Promise.resolve();
    });

    const payload = vi.mocked(options.submitMessage).mock.calls[0][0];
    expect(payload?.metadata).toEqual({ input: null, mentionedUserIds: ["user-1"] });
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
      originalQueueOrder: [serverItem.id],
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
      await resultRef.current?.handleCancelQueuedEdit();
    });

    expect(options.restoreServerSendQueueItem).toHaveBeenCalledWith(serverItem.id, {
      message: "Queued for Octo",
      composerMessage: "Queued for Octo",
      editorState: null,
      browserPageTarget: null,
      browserLaunchMode: null,
      targetAgentHandles: ["octo"],
      metadata: null,
    }, "queued");
    expect(options.setChatSendQueue).not.toHaveBeenCalled();
    expect(options.setEditingQueuedItem).toHaveBeenCalledWith(null);
  });
});
