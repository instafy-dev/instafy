import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { StatusIntent } from "../../../status/useStatus";
import type { ChatSubmitOverride } from "./chatSubmitPlanning";
import type { EditingQueuedChatItem, QueuedChatSendItem } from "./chatSendQueueStorage";
import {
  isServerQueuedChatSendItem,
  type EnqueueServerSendQueuePayload,
  type ServerQueuedChatSendItem,
} from "./useChatServerSendQueue";

type SubmitMessageFn = (
  override?: ChatSubmitOverride,
  options?: { allowWhileBusy?: boolean; metadata?: Record<string, unknown> | null },
) => Promise<boolean>;

type InterruptConversationRuns = (input: {
  conversationId: string;
  reason?: string | null;
  accessToken: null;
}) => Promise<string[] | null>;

type FocusInput = (options?: { force?: boolean }) => void;

type OnInputChange = (conversationId: string, value: string, editorState: string | null) => void;

type ResolvePromptAgentTargets = (
  input: string,
  options: { useSticky: boolean; updateSticky?: boolean },
) => { targetHandles: string[] };

type ShowStatus = (message: string, intent?: StatusIntent, durationMs?: number) => void;

type UseChatSendQueueActionsOptions = {
  activeConversationControllerId: string | null;
  activeConversationId: string | null;
  chatSendQueue: QueuedChatSendItem[];
  dispatchServerSendQueueEntryNow: (entryId: string) => Promise<boolean>;
  editingQueuedItem: EditingQueuedChatItem | null;
  enqueueServerSendQueueItem: (payload: EnqueueServerSendQueuePayload) => Promise<boolean>;
  focusInput: FocusInput;
  hostedRuntimeEnsuring: boolean;
  imageAttachmentCount: number;
  inputEditorState: string | null;
  inputValue: string;
  interruptConversationRuns: InterruptConversationRuns;
  invitePromptOpen: boolean;
  isAssistantTyping: boolean;
  latestInputValueRef: MutableRefObject<string>;
  onInputChange: OnInputChange;
  queuedTargetHandlesByItemId: Map<string, string[]>;
  refreshServerSendQueue: () => Promise<void>;
  removeServerSendQueueEntry: (entryId: string) => Promise<boolean>;
  resolvePromptAgentTargets: ResolvePromptAgentTargets;
  resolveQueuedItemTargets: (item: QueuedChatSendItem) => string[];
  runtimeReady: boolean;
  sendingAttachment: boolean;
  serverSendQueueItems: ServerQueuedChatSendItem[];
  serverQueueHydrated: boolean;
  setChatSendQueue: Dispatch<SetStateAction<QueuedChatSendItem[]>>;
  setChatSendQueueExpanded: Dispatch<SetStateAction<boolean>>;
  setEditingQueuedItem: Dispatch<SetStateAction<EditingQueuedChatItem | null>>;
  setPendingBrowserLaunchMode: (mode: "new_page" | null) => void;
  showStatus: ShowStatus;
  submitMessage: SubmitMessageFn;
  targetsOverlapActiveRuns: (targetAgentHandles: string[]) => boolean;
  waitingForPreferredRuntime: boolean;
};

export function useChatSendQueueActions({
  activeConversationControllerId,
  activeConversationId,
  chatSendQueue,
  dispatchServerSendQueueEntryNow,
  editingQueuedItem,
  enqueueServerSendQueueItem,
  focusInput,
  hostedRuntimeEnsuring,
  imageAttachmentCount,
  inputEditorState,
  inputValue,
  interruptConversationRuns,
  invitePromptOpen,
  isAssistantTyping,
  latestInputValueRef,
  onInputChange,
  queuedTargetHandlesByItemId,
  refreshServerSendQueue,
  removeServerSendQueueEntry,
  resolvePromptAgentTargets,
  resolveQueuedItemTargets,
  runtimeReady,
  sendingAttachment,
  serverSendQueueItems,
  serverQueueHydrated,
  setChatSendQueue,
  setChatSendQueueExpanded,
  setEditingQueuedItem,
  setPendingBrowserLaunchMode,
  showStatus,
  submitMessage,
  targetsOverlapActiveRuns,
  waitingForPreferredRuntime,
}: UseChatSendQueueActionsOptions) {
  const chatSendQueueDrainRef = useRef(false);

  const handleSendQueuedMessageNow = useCallback(
    async (queuedId: string) => {
      if (!activeConversationId || sendingAttachment) {
        return;
      }
      const serverItem = serverSendQueueItems.find((entry) => entry.id === queuedId) ?? null;
      const item = serverItem ?? chatSendQueue.find((entry) => entry.id === queuedId) ?? null;
      if (!item) {
        return;
      }
      const itemTargetHandles = queuedTargetHandlesByItemId.get(item.id) ?? resolveQueuedItemTargets(item);
      if (!activeConversationControllerId) {
        showStatus("Sync this conversation before interrupting a run.", "info", 4500);
        return;
      }

      chatSendQueueDrainRef.current = true;
      try {
        if (targetsOverlapActiveRuns(itemTargetHandles)) {
          const canceledRunIds =
            (await interruptConversationRuns({
              conversationId: activeConversationControllerId,
              reason: "Interrupted by a new message",
              accessToken: null,
            })) ?? [];
          if (canceledRunIds.length > 0) {
            showStatus("Interrupting current reply. Your queued message will send next.", "info", 3500);
          }
        }

        if (serverItem) {
          await dispatchServerSendQueueEntryNow(serverItem.id);
          return;
        }

        const ok = await submitMessage(
          {
            message: item.message,
            editorState: item.editorState,
            browserPageTarget: item.browserPageTarget,
            browserLaunchMode: item.browserLaunchMode,
            metadata: item.metadata ?? null,
            runtimeOverride: item.runtimeOverride ?? null,
          },
          { allowWhileBusy: true },
        );
        if (ok) {
          setChatSendQueue((previous) => previous.filter((entry) => entry.id !== queuedId));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(message, "error", 5000);
      } finally {
        chatSendQueueDrainRef.current = false;
      }
    },
    [
      activeConversationControllerId,
      activeConversationId,
      chatSendQueue,
      dispatchServerSendQueueEntryNow,
      interruptConversationRuns,
      queuedTargetHandlesByItemId,
      resolveQueuedItemTargets,
      sendingAttachment,
      serverSendQueueItems,
      setChatSendQueue,
      showStatus,
      submitMessage,
      targetsOverlapActiveRuns,
    ],
  );

  const handleEditQueuedMessage = useCallback(
    async (queuedId: string) => {
      if (!activeConversationId) {
        return;
      }
      const serverItem = serverSendQueueItems.find((entry) => entry.id === queuedId) ?? null;
      const item = serverItem ?? chatSendQueue.find((entry) => entry.id === queuedId) ?? null;
      if (!item) {
        return;
      }
      const targetAgentHandles = queuedTargetHandlesByItemId.get(item.id) ?? resolveQueuedItemTargets(item);
      if (serverItem) {
        // Remove the server entry before steering it into the composer;
        // otherwise a failed removal (or an entry the server drain already
        // dispatched) would let a later save re-enqueue a duplicate message.
        const removed = await removeServerSendQueueEntry(serverItem.id);
        if (!removed) {
          showStatus(
            "Couldn't remove the queued message — it may have already been sent.",
            "info",
            5000,
          );
          void refreshServerSendQueue();
          return;
        }
      } else {
        setChatSendQueue((previous) => previous.filter((entry) => entry.id !== queuedId));
      }
      setEditingQueuedItem({ item, targetAgentHandles });
      latestInputValueRef.current = item.message;
      onInputChange(activeConversationId, item.message, item.editorState);
      setPendingBrowserLaunchMode(item.browserLaunchMode);
      focusInput({ force: true });
      setChatSendQueueExpanded(false);
    },
    [
      activeConversationId,
      chatSendQueue,
      focusInput,
      latestInputValueRef,
      onInputChange,
      queuedTargetHandlesByItemId,
      refreshServerSendQueue,
      removeServerSendQueueEntry,
      resolveQueuedItemTargets,
      serverSendQueueItems,
      setChatSendQueue,
      setChatSendQueueExpanded,
      setEditingQueuedItem,
      setPendingBrowserLaunchMode,
      showStatus,
    ],
  );

  const handleCancelQueuedEdit = useCallback(() => {
    if (!editingQueuedItem) {
      return;
    }
    const restoredTargetHandles =
      editingQueuedItem.item.targetAgentHandles.length > 0
        ? editingQueuedItem.item.targetAgentHandles
        : editingQueuedItem.targetAgentHandles;
    const restoredItem: QueuedChatSendItem = {
      id: editingQueuedItem.item.id,
      message: editingQueuedItem.item.message,
      editorState: editingQueuedItem.item.editorState,
      createdAt: editingQueuedItem.item.createdAt,
      targetAgentHandles: restoredTargetHandles,
      browserPageTarget: editingQueuedItem.item.browserPageTarget,
      browserLaunchMode: editingQueuedItem.item.browserLaunchMode,
      metadata: editingQueuedItem.item.metadata ?? null,
      ...(editingQueuedItem.item.runtimeOverride
        ? { runtimeOverride: editingQueuedItem.item.runtimeOverride }
        : {}),
    };
    const restoreLocally = () => {
      setChatSendQueue((previous) => {
        if (previous.some((entry) => entry.id === restoredItem.id)) {
          return previous;
        }
        return [...previous, restoredItem];
      });
    };
    if (isServerQueuedChatSendItem(editingQueuedItem.item)) {
      void enqueueServerSendQueueItem({
        message: restoredItem.message,
        targetAgentHandles: restoredTargetHandles,
        metadata: restoredItem.metadata ?? null,
        ...(restoredItem.runtimeOverride
          ? { runtimeOverride: restoredItem.runtimeOverride }
          : {}),
      }).then((queued) => {
        if (!queued) {
          restoreLocally();
        }
      });
    } else {
      restoreLocally();
    }
    if (activeConversationId && latestInputValueRef.current.trim() === editingQueuedItem.item.message.trim()) {
      latestInputValueRef.current = "";
      onInputChange(activeConversationId, "", null);
    }
    setPendingBrowserLaunchMode(null);
    setEditingQueuedItem(null);
  }, [
    activeConversationId,
    editingQueuedItem,
    enqueueServerSendQueueItem,
    latestInputValueRef,
    onInputChange,
    setChatSendQueue,
    setEditingQueuedItem,
    setPendingBrowserLaunchMode,
  ]);

  const handleRequeueEditedMessage = useCallback(() => {
    if (!editingQueuedItem || !activeConversationId) {
      return;
    }
    const trimmed = inputValue.trim();
    if (!trimmed) {
      focusInput({ force: true });
      return;
    }
    const selection = resolvePromptAgentTargets(trimmed, {
      useSticky: true,
      updateSticky: false,
    });
    const targetAgentHandles =
      selection.targetHandles.length > 0
        ? selection.targetHandles
        : editingQueuedItem.targetAgentHandles;
    const updatedItem: QueuedChatSendItem = {
      id: editingQueuedItem.item.id,
      message: trimmed,
      editorState: inputEditorState ?? null,
      createdAt: Date.now(),
      targetAgentHandles,
      browserPageTarget: editingQueuedItem.item.browserPageTarget,
      browserLaunchMode: editingQueuedItem.item.browserLaunchMode,
      metadata: editingQueuedItem.item.metadata ?? null,
      ...(editingQueuedItem.item.runtimeOverride
        ? { runtimeOverride: editingQueuedItem.item.runtimeOverride }
        : {}),
    };
    const requeueLocally = () => {
      setChatSendQueue((previous) => {
        const withoutCurrent = previous.filter((entry) => entry.id !== updatedItem.id);
        return [...withoutCurrent, updatedItem];
      });
    };
    if (isServerQueuedChatSendItem(editingQueuedItem.item)) {
      void enqueueServerSendQueueItem({
        message: trimmed,
        targetAgentHandles,
        metadata: updatedItem.metadata ?? null,
        ...(updatedItem.runtimeOverride
          ? { runtimeOverride: updatedItem.runtimeOverride }
          : {}),
      }).then((queued) => {
        if (!queued) {
          requeueLocally();
        }
      });
    } else {
      requeueLocally();
    }
    latestInputValueRef.current = "";
    onInputChange(activeConversationId, "", null);
    setPendingBrowserLaunchMode(null);
    setEditingQueuedItem(null);
    setChatSendQueueExpanded(false);
  }, [
    activeConversationId,
    editingQueuedItem,
    enqueueServerSendQueueItem,
    focusInput,
    inputEditorState,
    inputValue,
    latestInputValueRef,
    onInputChange,
    resolvePromptAgentTargets,
    setChatSendQueue,
    setChatSendQueueExpanded,
    setEditingQueuedItem,
    setPendingBrowserLaunchMode,
  ]);

  const handleSendEditedMessageNow = useCallback(async () => {
    if (!editingQueuedItem) {
      return;
    }
    const trimmed = inputValue.trim();
    if (!trimmed) {
      focusInput({ force: true });
      return;
    }
    const ok = await submitMessage(
      {
        message: trimmed,
        editorState: inputEditorState ?? null,
        browserPageTarget: editingQueuedItem.item.browserPageTarget,
        browserLaunchMode: editingQueuedItem.item.browserLaunchMode,
        metadata: editingQueuedItem.item.metadata ?? null,
        runtimeOverride: editingQueuedItem.item.runtimeOverride ?? null,
      },
      { allowWhileBusy: true },
    );
    if (ok) {
      setPendingBrowserLaunchMode(null);
      setEditingQueuedItem(null);
    }
  }, [
    editingQueuedItem,
    focusInput,
    inputEditorState,
    inputValue,
    setEditingQueuedItem,
    setPendingBrowserLaunchMode,
    submitMessage,
  ]);

  // Client auto-drain only covers the localStorage fallback queue. Entries in
  // the controller send queue are dispatched server-side when the target agents
  // go idle, so draining them here would double-send.
  useEffect(() => {
    if (chatSendQueueDrainRef.current || editingQueuedItem || !activeConversationId) {
      return;
    }
    if (!serverQueueHydrated || serverSendQueueItems.length > 0) {
      return;
    }
    if (invitePromptOpen || sendingAttachment) {
      return;
    }
    if (waitingForPreferredRuntime || hostedRuntimeEnsuring || !runtimeReady || isAssistantTyping) {
      return;
    }
    const next = chatSendQueue[0];
    if (!next) {
      return;
    }
    const draftTrimmed = inputValue.trim();
    if (imageAttachmentCount > 0) {
      return;
    }
    if (draftTrimmed.length > 0 && draftTrimmed !== next.message.trim()) {
      return;
    }

    chatSendQueueDrainRef.current = true;
    void (async () => {
      try {
        const ok = await submitMessage(
          {
            message: next.message,
            editorState: next.editorState,
            browserPageTarget: next.browserPageTarget,
            browserLaunchMode: next.browserLaunchMode,
            metadata: next.metadata ?? null,
            runtimeOverride: next.runtimeOverride ?? null,
          },
          { allowWhileBusy: true },
        );
        if (ok) {
          setChatSendQueue((previous) => previous.filter((item) => item.id !== next.id));
        }
      } finally {
        chatSendQueueDrainRef.current = false;
      }
    })();
  }, [
    activeConversationId,
    chatSendQueue,
    editingQueuedItem,
    hostedRuntimeEnsuring,
    imageAttachmentCount,
    inputValue,
    invitePromptOpen,
    isAssistantTyping,
    runtimeReady,
    sendingAttachment,
    serverQueueHydrated,
    serverSendQueueItems.length,
    setChatSendQueue,
    submitMessage,
    waitingForPreferredRuntime,
  ]);

  return {
    handleCancelQueuedEdit,
    handleEditQueuedMessage,
    handleRequeueEditedMessage,
    handleSendEditedMessageNow,
    handleSendQueuedMessageNow,
  };
}
