import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useChatSendQueueActions } from "../../../src/screens/studio/components/useChatSendQueueActions";
import type { EditingQueuedChatItem, QueuedChatSendItem } from "../../../src/screens/studio/components/chatSendQueueStorage";
import type { ChatSendQueueSurfaceProps } from "../../../src/screens/studio/components/ChatSendQueueSurface";
import type { ChatSubmitOverride } from "../../../src/screens/studio/components/chatSubmitPlanning";
import { buildCollapsedQueuedMessageSummary } from "../../../src/screens/studio/components/chatSendQueueSummary";

const messages = [
  "Compare the pricing and export options on the websites we opened.",
  "Then check keyboard accessibility and mobile navigation. Include any problems with focus, menus, and long page titles.",
  "Summarize the trade-offs and recommend the best fit for our small team.",
  "Check whether the selected plan supports inviting external collaborators.",
  "Write a short checklist with links to the relevant documentation.",
  "Finish with the unanswered questions we should send to support.",
];

/** Inert data boundary, real queue action hook: no runtime, authentication or network. */
export function useQueueReview({ count, draft, editorState, onDraftChange, focusInput, setSent, readOnly }: {
  count: number;
  draft: string;
  editorState: string | null;
  onDraftChange: (value: string, editorState: string | null) => void;
  focusInput: () => void;
  setSent: Dispatch<SetStateAction<string[]>>;
  readOnly: boolean;
}) {
  const [items, setItems] = useState<QueuedChatSendItem[]>(() => messages.slice(0, count).map((message, index) => ({
    id: `queue-${index + 1}`, message, editorState: null, createdAt: index + 1,
    targetAgentHandles: ["octo"], browserPageTarget: null, browserLaunchMode: null,
  })));
  const [editing, setEditing] = useState<EditingQueuedChatItem | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState("");
  const latestInputValueRef = useRef(draft);
  latestInputValueRef.current = draft;
  const targets = useMemo(() => new Map(items.map(item => [item.id, item.targetAgentHandles])), [items]);
  const submitMessage = useCallback(async (override?: ChatSubmitOverride) => {
    setSent(current => [...current, override?.message ?? draft]);
    onDraftChange("", null);
    return true;
  }, [draft, onDraftChange, setSent]);
  const actions = useChatSendQueueActions({
    activeConversationControllerId: "fixture-controller", activeConversationId: "fixture-conversation",
    chatSendQueue: items, editingQueuedItem: editing,
    dispatchServerSendQueueEntryNow: async () => false, restoreServerSendQueueItem: async () => false,
    focusInput, hostedRuntimeEnsuring: false, imageAttachmentCount: 0, inputEditorState: editorState,
    inputValue: draft, interruptConversationRuns: async () => [], invitePromptOpen: false,
    isAssistantTyping: false, latestInputValueRef, onInputChange: (_, value, state) => onDraftChange(value, state),
    queuedTargetHandlesByItemId: targets, refreshServerSendQueue: async () => {},
    removeServerSendQueueEntry: async () => false, resolvePromptAgentTargets: () => ({ targetHandles: ["octo"] }),
    resolveQueuedItemTargets: item => item.targetAgentHandles, runtimeReady: false, sendingAttachment: false,
    serverSendQueueItems: [], serverQueueHydrated: false, setChatSendQueue: setItems,
    setChatSendQueueExpanded: setExpanded, setEditingQueuedItem: setEditing,
    setPendingBrowserLaunchMode: () => {}, showStatus: setStatus, submitMessage,
    targetsOverlapActiveRuns: () => false, waitingForPreferredRuntime: false,
  });
  const display = items.map(item => ({ id: item.id, message: item.message, targetHandles: item.targetAgentHandles }));
  const props: ChatSendQueueSurfaceProps = {
    totalQueuedCount: items.length, editingQueuedItem: editing, chatSendQueueExpanded: expanded,
    collapsedQueuedMessageSummary: buildCollapsedQueuedMessageSummary(display[0] ?? null, items.length), queueCanSendNow: true,
    chatSendQueueDisplay: display,
    sendingAttachment: false, inputValue: draft, mutationDisabled: readOnly || actions.queueEditPending,
    onToggleExpanded: () => setExpanded(value => !value),
    onSendQueuedMessageNow: actions.handleSendQueuedMessageNow,
    onRemoveQueuedItem: id => setItems(current => current.filter(item => item.id !== id)),
    onReorderQueuedItem: (id, targetIndex) => setItems(current => {
      const next = [...current];
      const index = next.findIndex(item => item.id === id);
      if (index < 0) return current;
      const [item] = next.splice(index, 1);
      next.splice(targetIndex, 0, item);
      return next;
    }),
    onEditQueuedMessage: actions.handleEditQueuedMessage,
    onCancelQueuedEdit: actions.handleCancelQueuedEdit,
    onRequeueEditedMessage: actions.handleRequeueEditedMessage,
    onSendEditedMessageNow: actions.handleSendEditedMessageNow,
  };
  return { props, items, status, editing };
}
