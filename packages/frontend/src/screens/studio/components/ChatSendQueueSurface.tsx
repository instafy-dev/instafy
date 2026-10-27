import type { Ref } from "react";
import { NumberedListLeft } from "iconoir-react";
import { Button } from "../../../components/Button";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import { ToolbarCountButton } from "../../../components/ToolbarCountButton";
import {
  buildQueuedMessageAccessiblePreview,
  ChatSendQueue,
  type QueuedChatPrompt,
} from "./ChatSendQueue";
import type { CollapsedQueuedMessageSummary } from "./chatSendQueueSummary";

export const CHAT_SEND_QUEUE_ITEMS_ID = "chat-send-queue-items";

type EditingQueuedChatItemLike = {
  targetAgentHandles: string[];
  restoreOnly?: boolean;
};

export type ChatSendQueueSurfaceProps = {
  totalQueuedCount: number;
  editingQueuedItem: EditingQueuedChatItemLike | null;
  chatSendQueueExpanded: boolean;
  collapsedQueuedMessageSummary: CollapsedQueuedMessageSummary | null;
  queueCanSendNow: boolean;
  chatSendQueueDisplay: QueuedChatPrompt[];
  sendingAttachment: boolean;
  inputValue: string;
  triggerRef?: Ref<HTMLButtonElement>;
  onToggleExpanded: () => void;
  onSendQueuedMessageNow: (queuedId: string) => void | Promise<void>;
  onRemoveQueuedItem: (id: string) => void;
  onReorderQueuedItem: (id: string, targetIndex: number) => void;
  onEditQueuedMessage: (id: string) => void;
  onCancelQueuedEdit: () => void;
  onRequeueEditedMessage: () => void;
  onSendEditedMessageNow: () => void | Promise<void>;
  mutationDisabled?: boolean;
  reorderDisabled?: boolean;
  onDraggingChange?: (dragging: boolean) => void;
};

export function ChatSendQueueTrigger({
  totalQueuedCount,
  collapsedQueuedMessageSummary,
  expanded,
  onToggleExpanded,
  triggerRef,
}: {
  totalQueuedCount: number;
  collapsedQueuedMessageSummary: CollapsedQueuedMessageSummary | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  if (totalQueuedCount <= 0) {
    return null;
  }

  const preview = buildQueuedMessageAccessiblePreview(collapsedQueuedMessageSummary?.message);
  const title = preview
    ? `Queued messages (${totalQueuedCount}): ${preview}`
    : `Queued messages (${totalQueuedCount})`;

  return (
    <ToolbarCountButton
      count={totalQueuedCount}
      aria-label={title}
      title={title}
      aria-controls={CHAT_SEND_QUEUE_ITEMS_ID}
      expanded={expanded}
      ref={triggerRef}
      onPress={onToggleExpanded}
      data-testid="chat-send-queue-agent-summary"
    >
      <NumberedListLeft aria-hidden="true" className="h-4 w-4" data-testid="chat-send-queue-icon" />
    </ToolbarCountButton>
  );
}

export function ChatSendQueuePanel({
  totalQueuedCount,
  editingQueuedItem,
  chatSendQueueExpanded,
  queueCanSendNow,
  chatSendQueueDisplay,
  sendingAttachment,
  inputValue,
  onSendQueuedMessageNow,
  onRemoveQueuedItem,
  onReorderQueuedItem,
  onEditQueuedMessage,
  onCancelQueuedEdit,
  onRequeueEditedMessage,
  onSendEditedMessageNow,
  mutationDisabled = false,
  reorderDisabled = false,
  onDraggingChange,
}: ChatSendQueueSurfaceProps) {
  if (!chatSendQueueExpanded && !editingQueuedItem) {
    return null;
  }

  const canSaveEditedMessage =
    !mutationDisabled && !sendingAttachment && inputValue.trim().length > 0;

  return (
    <div
      id={CHAT_SEND_QUEUE_ITEMS_ID}
      role="region"
      aria-label="Queued messages"
      className="basis-full"
    >
      <div className={editingQueuedItem ? "w-full" : "ml-auto w-full sm:w-[min(24rem,100%)]"}>
        {totalQueuedCount > 0 && chatSendQueueExpanded ? (
          <Surface tone="subtle" radius="xl" shadow="none" className="mx-1 mb-2 px-3 py-2">
            <Text as="h3" variant="bodyStrong" tone="primary" data-testid="chat-send-queue-panel-header">
              Queued messages
            </Text>
          </Surface>
        ) : null}
        {chatSendQueueDisplay.length > 0 && chatSendQueueExpanded ? (
          <div className="max-h-[min(32rem,60dvh)] overflow-y-auto overscroll-contain">
            <ChatSendQueue
              items={chatSendQueueDisplay}
              onRemove={onRemoveQueuedItem}
              onReorder={onReorderQueuedItem}
              onEdit={onEditQueuedMessage}
              onSendNow={queueCanSendNow ? onSendQueuedMessageNow : undefined}
              editDisabled={sendingAttachment || mutationDisabled}
              sendNowDisabled={!queueCanSendNow || mutationDisabled}
              removeDisabled={mutationDisabled}
              reorderDisabled={mutationDisabled || reorderDisabled}
              onDraggingChange={onDraggingChange}
            />
          </div>
        ) : null}
        {editingQueuedItem ? (
          <div
            className="flex flex-wrap items-center justify-between gap-2 p-1"
          >
            <div className="min-w-0">
              <Text as="div" variant="captionStrong" tone="muted">
                {editingQueuedItem.restoreOnly ? "Restore queued message" : "Editing queued message"}
              </Text>
              <Text as="div" variant="caption" tone="muted" className="truncate">
                {editingQueuedItem.targetAgentHandles.length > 0
                  ? editingQueuedItem.targetAgentHandles.map((handle) => `@${handle}`).join(" ")
                  : "No explicit agent targets"}
              </Text>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                preset="inline"
                onPress={onCancelQueuedEdit}
                isDisabled={sendingAttachment || mutationDisabled}
              >
                {editingQueuedItem.restoreOnly ? "Retry restore" : "Cancel"}
              </Button>
              {!editingQueuedItem.restoreOnly ? <><Button
                type="button"
                variant="outline"
                preset="inline"
                onPress={onRequeueEditedMessage}
                isDisabled={!canSaveEditedMessage}
              >
                Save queue
              </Button>
              <Button
                type="button"
                variant="primary"
                preset="inline"
                onPress={() => {
                  void onSendEditedMessageNow();
                }}
                isDisabled={!canSaveEditedMessage}
              >
                Send now
              </Button>
              </> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ChatSendQueueSurface(props: ChatSendQueueSurfaceProps) {
  const {
    totalQueuedCount,
    editingQueuedItem,
    chatSendQueueExpanded,
    collapsedQueuedMessageSummary,
    onToggleExpanded,
    triggerRef,
  } = props;

  if (totalQueuedCount === 0 && !editingQueuedItem) {
    return null;
  }

  const showQueuePanel = chatSendQueueExpanded || Boolean(editingQueuedItem);
  return (
    <div className="contents" data-testid="chat-send-queue">
      {totalQueuedCount > 0 && !editingQueuedItem ? (
        <ChatSendQueueTrigger
          totalQueuedCount={totalQueuedCount}
          collapsedQueuedMessageSummary={collapsedQueuedMessageSummary}
          expanded={chatSendQueueExpanded}
          onToggleExpanded={onToggleExpanded}
          triggerRef={triggerRef}
        />
      ) : null}
      {showQueuePanel ? (
        <ChatSendQueuePanel {...props} />
      ) : (
        <span id={CHAT_SEND_QUEUE_ITEMS_ID} hidden />
      )}
    </div>
  );
}
