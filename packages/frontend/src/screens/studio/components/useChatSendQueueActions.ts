import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { StatusIntent } from "../../../status/useStatus";
import { withUserMentionMetadata } from "../../../conversations/userMentions";
import { queuedComposerDispatchMessage, queuedComposerEditorStateMatches } from "./chatSendQueueComposer";
import type { ChatSubmitOverride } from "./chatSubmitPlanning";
import { restoreEditedQueueItem, type EditingQueuedChatItem, type QueuedChatSendItem } from "./chatSendQueueStorage";
import { resolveComposerDraftReplaceBlock } from "./messageStashLifecycle";
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
  restoreServerSendQueueItem: (entryId: string, payload: EnqueueServerSendQueuePayload, status?: "queued" | "failed") => Promise<boolean>;
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
  restoreServerSendQueueItem,
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
  const queuedEditMutationRef = useRef(false);
  const [queueEditPending, setQueueEditPending] = useState(false);
  const interruptedEditsRef = useRef(new Map<string, EditingQueuedChatItem>());
  const currentComposerRef = useRef({ activeConversationId, imageAttachmentCount, sendingAttachment, inputEditorState });
  currentComposerRef.current = { activeConversationId, imageAttachmentCount, sendingAttachment, inputEditorState };

  useEffect(() => {
    if (!activeConversationId) return;
    const interrupted = interruptedEditsRef.current.get(activeConversationId);
    if (interrupted) {
      setEditingQueuedItem({ ...interrupted, restoreOnly: true });
    }
  }, [activeConversationId, setEditingQueuedItem]);

  const restoreQueuedItem = useCallback(async (editing: EditingQueuedChatItem, item: QueuedChatSendItem, status: "queued" | "failed" = "queued") => {
    if (isServerQueuedChatSendItem(editing.item)) {
      return restoreServerSendQueueItem(editing.item.id, {
        message: queuedComposerDispatchMessage(item),
        composerMessage: item.message,
        editorState: item.editorState,
        browserPageTarget: item.browserPageTarget,
        browserLaunchMode: item.browserLaunchMode,
        targetAgentHandles: item.targetAgentHandles,
        metadata: item.metadata ?? null,
        ...(editing.item.intent ? { intent: editing.item.intent } : {}),
        ...(item.runtimeOverride ? { runtimeOverride: item.runtimeOverride } : {}),
      }, status);
    }
    setChatSendQueue((previous) => restoreEditedQueueItem(previous, item, editing.originalQueueOrder));
    return true;
  }, [restoreServerSendQueueItem, setChatSendQueue]);

  const explainDraftBlock = useCallback(() => {
    const block = resolveComposerDraftReplaceBlock({
      composerText: latestInputValueRef.current,
      attachmentCount: currentComposerRef.current.imageAttachmentCount,
    });
    if (currentComposerRef.current.sendingAttachment || block === "attachments") {
      showStatus("Send or remove the images in your draft before editing a queued message.", "info", 4500);
      return true;
    }
    if (block === "composer_text") {
      showStatus("Stash, send, or clear your current draft before editing a queued message.", "info", 4500);
      focusInput({ force: true });
      return true;
    }
    return false;
  }, [focusInput, latestInputValueRef, showStatus]);

  const handleSendQueuedMessageNow = useCallback(
    async (queuedId: string) => {
      if (!activeConversationId || sendingAttachment || queuedEditMutationRef.current || chatSendQueueDrainRef.current) {
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
      if (!activeConversationId || editingQueuedItem || queuedEditMutationRef.current || chatSendQueueDrainRef.current || explainDraftBlock()) {
        return;
      }
      const serverItem = serverSendQueueItems.find((entry) => entry.id === queuedId) ?? null;
      const item = serverItem ?? chatSendQueue.find((entry) => entry.id === queuedId) ?? null;
      if (!item) {
        return;
      }
      if (serverItem && !serverItem.updatedAt) {
        showStatus("Update the controller before editing queued messages. Your draft and queue are unchanged.", "info", 5000);
        return;
      }
      const targetAgentHandles = queuedTargetHandlesByItemId.get(item.id) ?? resolveQueuedItemTargets(item);
      const editing = {
        item,
        targetAgentHandles,
        originalQueueOrder: (serverItem ? serverSendQueueItems : chatSendQueue).map((entry) => entry.id),
      };
      queuedEditMutationRef.current = true;
      setQueueEditPending(true);
      try {
        if (serverItem) {
          // Claim the entry before editing so the controller cannot dispatch
          // the old text while the user is changing it.
          const removed = await removeServerSendQueueEntry(serverItem.id);
          if (!removed) {
            showStatus("Couldn't remove the queued message — it may have already been sent.", "info", 5000);
            void refreshServerSendQueue();
            return;
          }
          interruptedEditsRef.current.set(activeConversationId, editing);
          // A cancellation can take time. Never replace text typed while it
          // was pending, nor install the old conversation's edit in a new one.
          const conversationChanged = currentComposerRef.current.activeConversationId !== activeConversationId;
          if (conversationChanged || explainDraftBlock()) {
            const restored = await restoreQueuedItem(editing, item, serverItem.status);
            if (restored) {
              interruptedEditsRef.current.delete(activeConversationId);
              if (currentComposerRef.current.activeConversationId === activeConversationId) {
                // Returning during the request may have shown its recovery action.
                setEditingQueuedItem((current) => current?.restoreOnly && current.item.id === item.id ? null : current);
              }
            } else {
              showStatus("Couldn't return the message to the queue. Your draft is safe; retry restoring the queued message.", "error", 6000);
              if (currentComposerRef.current.activeConversationId === activeConversationId) {
                // Keep a recoverable edit without replacing the current draft.
                setEditingQueuedItem({ ...editing, restoreOnly: true });
              }
            }
            return;
          }
        } else {
          setChatSendQueue((previous) => previous.filter((entry) => entry.id !== queuedId));
          interruptedEditsRef.current.set(activeConversationId, editing);
        }
        setEditingQueuedItem(editing);
        latestInputValueRef.current = item.message;
        onInputChange(activeConversationId, item.message, item.editorState);
        setPendingBrowserLaunchMode(item.browserLaunchMode);
        focusInput({ force: true });
        setChatSendQueueExpanded(false);
      } finally {
        queuedEditMutationRef.current = false;
        setQueueEditPending(false);
      }
    },
    [activeConversationId, chatSendQueue, editingQueuedItem, explainDraftBlock, focusInput, latestInputValueRef,
      onInputChange, queuedTargetHandlesByItemId, refreshServerSendQueue, removeServerSendQueueEntry,
      resolveQueuedItemTargets, restoreQueuedItem, serverSendQueueItems, setChatSendQueue,
      setChatSendQueueExpanded, setEditingQueuedItem, setPendingBrowserLaunchMode, showStatus],
  );

  const handleCancelQueuedEdit = useCallback(async () => {
    if (!editingQueuedItem || queuedEditMutationRef.current) {
      return;
    }
    const restoredItem = {
      ...editingQueuedItem.item,
      targetAgentHandles: editingQueuedItem.item.targetAgentHandles.length > 0
        ? editingQueuedItem.item.targetAgentHandles : editingQueuedItem.targetAgentHandles,
    };
    queuedEditMutationRef.current = true;
    setQueueEditPending(true);
    try {
      const restored = await restoreQueuedItem(editingQueuedItem, restoredItem,
        isServerQueuedChatSendItem(editingQueuedItem.item) ? editingQueuedItem.item.status : "queued");
      if (!restored) {
        showStatus("Couldn't restore the queued message. Your edit is still here; try Cancel again.", "error", 5000);
        return;
      }
      if (activeConversationId) interruptedEditsRef.current.delete(activeConversationId);
      if (currentComposerRef.current.activeConversationId !== activeConversationId) {
        return;
      }
      if (!editingQueuedItem.restoreOnly && activeConversationId &&
          currentComposerRef.current.imageAttachmentCount === 0 && !currentComposerRef.current.sendingAttachment &&
          queuedComposerEditorStateMatches(editingQueuedItem.item, currentComposerRef.current.inputEditorState) &&
          latestInputValueRef.current.trim() === editingQueuedItem.item.message.trim()) {
        latestInputValueRef.current = "";
        onInputChange(activeConversationId, "", null);
        setPendingBrowserLaunchMode(null);
      }
      setEditingQueuedItem(null);
    } finally {
      queuedEditMutationRef.current = false;
      setQueueEditPending(false);
    }
  }, [activeConversationId, editingQueuedItem, latestInputValueRef, onInputChange,
    restoreQueuedItem, setEditingQueuedItem, setPendingBrowserLaunchMode, showStatus]);

  const handleRequeueEditedMessage = useCallback(async (): Promise<boolean> => {
    if (!editingQueuedItem || editingQueuedItem.restoreOnly || !activeConversationId || queuedEditMutationRef.current) {
      return false;
    }
    if (currentComposerRef.current.imageAttachmentCount > 0 || currentComposerRef.current.sendingAttachment) {
      showStatus("Remove the images before saving this queued text message.", "info", 4500);
      return false;
    }
    const trimmed = inputValue.trim();
    if (!trimmed) {
      focusInput({ force: true });
      return false;
    }
    let metadata: Record<string, unknown>;
    try {
      metadata = withUserMentionMetadata(editingQueuedItem.item.metadata, inputEditorState);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : String(error), "error", 4500);
      return false;
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
      createdAt: editingQueuedItem.item.createdAt,
      targetAgentHandles,
      browserPageTarget: editingQueuedItem.item.browserPageTarget,
      browserLaunchMode: editingQueuedItem.item.browserLaunchMode,
      metadata,
      ...(editingQueuedItem.item.runtimeOverride
        ? { runtimeOverride: editingQueuedItem.item.runtimeOverride }
        : {}),
    };
    queuedEditMutationRef.current = true;
    setQueueEditPending(true);
    try {
      if (!await restoreQueuedItem(editingQueuedItem, updatedItem)) {
        showStatus("Couldn't save the queued message. Your edit is still here; try Save queue again.", "error", 5000);
        return false;
      }
      interruptedEditsRef.current.delete(activeConversationId);
      if (currentComposerRef.current.activeConversationId !== activeConversationId) {
        return true;
      }
      // Preserve new text typed while the save was in flight.
      if (latestInputValueRef.current.trim() === trimmed && currentComposerRef.current.inputEditorState === inputEditorState) {
        latestInputValueRef.current = "";
        onInputChange(activeConversationId, "", null);
        setPendingBrowserLaunchMode(null);
      }
      setEditingQueuedItem(null);
      setChatSendQueueExpanded(false);
      return true;
    } finally {
      queuedEditMutationRef.current = false;
      setQueueEditPending(false);
    }
  }, [activeConversationId, editingQueuedItem, focusInput, inputEditorState, inputValue,
    latestInputValueRef, onInputChange, resolvePromptAgentTargets, restoreQueuedItem,
    setChatSendQueueExpanded, setEditingQueuedItem, setPendingBrowserLaunchMode, showStatus]);

  const handleQueuedEditComposerSubmit = useCallback((override?: ChatSubmitOverride): Promise<boolean> | null => {
    if (!editingQueuedItem || editingQueuedItem.restoreOnly || override) return null;
    return handleRequeueEditedMessage();
  }, [editingQueuedItem, handleRequeueEditedMessage]);

  const handleSendEditedMessageNow = useCallback(async () => {
    if (!editingQueuedItem || editingQueuedItem.restoreOnly || queuedEditMutationRef.current) {
      return;
    }
    if (currentComposerRef.current.imageAttachmentCount > 0 || currentComposerRef.current.sendingAttachment) {
      showStatus("Remove the images before sending this queued text message.", "info", 4500);
      return;
    }
    const trimmed = inputValue.trim();
    if (!trimmed) {
      focusInput({ force: true });
      return;
    }
    let metadata: Record<string, unknown>;
    try {
      metadata = withUserMentionMetadata(editingQueuedItem.item.metadata, inputEditorState);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : String(error), "error", 4500);
      return;
    }
    queuedEditMutationRef.current = true;
    setQueueEditPending(true);
    try {
      const ok = await submitMessage(
        {
          message: trimmed,
          editorState: inputEditorState ?? null,
          browserPageTarget: editingQueuedItem.item.browserPageTarget,
          browserLaunchMode: editingQueuedItem.item.browserLaunchMode,
          metadata,
          runtimeOverride: editingQueuedItem.item.runtimeOverride ?? null,
        },
        { allowWhileBusy: true },
      );
      if (ok) {
        if (activeConversationId) interruptedEditsRef.current.delete(activeConversationId);
        if (currentComposerRef.current.activeConversationId === activeConversationId) {
          setPendingBrowserLaunchMode(null);
          setEditingQueuedItem(null);
        }
      }
    } finally {
      queuedEditMutationRef.current = false;
      setQueueEditPending(false);
    }
  }, [
    activeConversationId,
    editingQueuedItem,
    focusInput,
    inputEditorState,
    inputValue,
    setEditingQueuedItem,
    setPendingBrowserLaunchMode,
    showStatus,
    submitMessage,
  ]);

  // Client auto-drain only covers the localStorage fallback queue. Entries in
  // the controller send queue are dispatched server-side when the target agents
  // go idle, so draining them here would double-send. A drained entry says
  // nothing of how it was made (`input: null`): the controller cannot tell when
  // it was queued, so it must not count as a message the person types now
  // (useChatSubmitFlow.ts withPersonInput).
  useEffect(() => {
    if (chatSendQueueDrainRef.current || queuedEditMutationRef.current || queueEditPending || editingQueuedItem || !activeConversationId) {
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
            metadata: { ...(next.metadata ?? {}), input: null },
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
    queueEditPending,
    runtimeReady,
    sendingAttachment,
    serverQueueHydrated,
    serverSendQueueItems.length,
    setChatSendQueue,
    submitMessage,
    waitingForPreferredRuntime,
  ]);

  return {
    queueEditPending,
    handleCancelQueuedEdit,
    handleEditQueuedMessage,
    handleRequeueEditedMessage,
    handleQueuedEditComposerSubmit,
    handleSendEditedMessageNow,
    handleSendQueuedMessageNow,
  };
}
