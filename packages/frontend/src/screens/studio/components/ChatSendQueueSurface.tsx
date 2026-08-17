import { NavArrowDown, Send } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import {
  DARK_DIVIDER_BORDER_CLASS,
  DARK_PANEL_BORDER_CLASS,
  DARK_PANEL_SHADOW_CLASS,
  DARK_PANEL_STRONG_BG_CLASS,
} from "../../../theme/darkSurfaces";
import { ChatSendQueue, type QueuedChatPrompt } from "./ChatSendQueue";
import type { CollapsedQueuedMessageSummary } from "./chatSendQueueSummary";

type QueueStatusAction = {
  label: string;
  disabled: boolean;
  pending: boolean;
};

type EditingQueuedChatItemLike = {
  targetAgentHandles: string[];
};

export function ChatSendQueueSurface({
  totalQueuedCount,
  editingQueuedItem,
  chatSendQueueExpanded,
  collapsedQueuedMessageSummary,
  queueQuickSendItemId,
  queueCanSendNow,
  queueStatusLabel,
  queueStatusAction,
  chatSendQueueDisplay,
  sendingAttachment,
  inputValue,
  onToggleExpanded,
  onSendQueuedMessageNow,
  onRequestRuntimeRecovery,
  onRemoveQueuedItem,
  onMoveQueuedItem,
  onEditQueuedMessage,
  onCancelQueuedEdit,
  onRequeueEditedMessage,
  onSendEditedMessageNow,
  mutationDisabled = false,
}: {
  totalQueuedCount: number;
  editingQueuedItem: EditingQueuedChatItemLike | null;
  chatSendQueueExpanded: boolean;
  collapsedQueuedMessageSummary: CollapsedQueuedMessageSummary | null;
  queueQuickSendItemId: string | null;
  queueCanSendNow: boolean;
  queueStatusLabel: string | null;
  queueStatusAction: QueueStatusAction | null;
  chatSendQueueDisplay: QueuedChatPrompt[];
  sendingAttachment: boolean;
  inputValue: string;
  onToggleExpanded: () => void;
  onSendQueuedMessageNow: (queuedId: string) => void | Promise<void>;
  onRequestRuntimeRecovery: () => void;
  onRemoveQueuedItem: (id: string) => void;
  onMoveQueuedItem: (id: string, direction: -1 | 1) => void;
  onEditQueuedMessage: (id: string) => void;
  onCancelQueuedEdit: () => void;
  onRequeueEditedMessage: () => void;
  onSendEditedMessageNow: () => void | Promise<void>;
  mutationDisabled?: boolean;
}) {
  if (totalQueuedCount === 0 && !editingQueuedItem) {
    return null;
  }

  const canSaveEditedMessage = !mutationDisabled && !sendingAttachment && inputValue.trim().length > 0;
  const canEditCollapsedQueue = !mutationDisabled && !sendingAttachment && totalQueuedCount > 0;
  const handleEditCollapsedQueue = () => {
    if (!canEditCollapsedQueue) {
      return;
    }
    if (totalQueuedCount === 1 && queueQuickSendItemId) {
      onEditQueuedMessage(queueQuickSendItemId);
      return;
    }
    if (!chatSendQueueExpanded) {
      onToggleExpanded();
    }
  };

  return (
    <Surface
      tone="default"
      radius="2xl"
      shadow="none"
      className={`overflow-hidden border border-slate-200/70 bg-white/95 ${DARK_PANEL_STRONG_BG_CLASS} ${DARK_PANEL_BORDER_CLASS} ${DARK_PANEL_SHADOW_CLASS}`}
      data-testid="chat-send-queue"
    >
      {totalQueuedCount > 0 ? (
        <div className="flex items-center gap-2 px-3 py-2.5">
          <button
            type="button"
            onClick={onToggleExpanded}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            data-testid="chat-send-queue-agent-summary"
          >
            {collapsedQueuedMessageSummary ? (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-normal text-slate-800 dark:text-slate-100">
                  {collapsedQueuedMessageSummary.message}
                </span>
              </span>
            ) : (
              <span className="truncate text-sm font-normal text-slate-800 dark:text-slate-100">
                {totalQueuedCount} queued
              </span>
            )}
          </button>
          {!chatSendQueueExpanded ? (
            <Button
              type="button"
              onPress={handleEditCollapsedQueue}
              variant="outline"
              size="xs"
              radius="full"
              isDisabled={!canEditCollapsedQueue}
              className="border-slate-200/70 px-2.5 text-slate-600 hover:bg-slate-50 data-[hovered]:bg-slate-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-900 dark:data-[hovered]:bg-slate-900"
              data-testid="chat-send-queue-steer-collapsed"
            >
              Edit
            </Button>
          ) : null}
          {!mutationDisabled && !chatSendQueueExpanded && queueQuickSendItemId && queueCanSendNow ? (
            <IconButton
              aria-label="Send queued message now"
              variant="outline"
              size="sm"
              radius="full"
              onPress={() => {
                void onSendQueuedMessageNow(queueQuickSendItemId);
              }}
              data-testid="chat-send-queue-send-now"
            >
              <Send aria-hidden="true" className="h-4 w-4" />
            </IconButton>
          ) : null}
          {!mutationDisabled && !chatSendQueueExpanded && !queueCanSendNow && queueStatusAction ? (
            <Button
              type="button"
              onPress={() => {
                if (!queueStatusAction.disabled) {
                  onRequestRuntimeRecovery();
                }
              }}
              variant="outline"
              size="xs"
              radius="full"
              isDisabled={queueStatusAction.disabled}
              className="border-slate-200/70 px-2.5 text-slate-600 hover:bg-slate-50 data-[hovered]:bg-slate-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-900 dark:data-[hovered]:bg-slate-900"
              data-testid="chat-send-queue-runtime-action"
            >
              {queueStatusAction.pending ? (
                <Spinner aria-hidden="true" tone="slate" size="xs" className="mr-1.5 h-3.5 w-3.5" />
              ) : null}
              {queueStatusAction.label}
            </Button>
          ) : null}
          <IconButton
            aria-label={chatSendQueueExpanded ? "Collapse queued messages" : "Expand queued messages"}
            variant="ghost"
            size="xs"
            radius="full"
            onPress={onToggleExpanded}
            data-testid="chat-send-queue-toggle"
          >
            <NavArrowDown
              aria-hidden="true"
              className={`h-4 w-4 text-slate-400 transition-transform dark:text-slate-500 ${
                chatSendQueueExpanded ? "rotate-180" : ""
              }`}
            />
          </IconButton>
        </div>
      ) : null}
      {chatSendQueueDisplay.length > 0 && chatSendQueueExpanded ? (
        <div className={totalQueuedCount > 0 ? `border-t border-slate-200/70 ${DARK_DIVIDER_BORDER_CLASS}` : undefined}>
          {!mutationDisabled && queueStatusAction ? (
            <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
              <span className="truncate">{queueStatusLabel ?? "Runtime attention needed"}</span>
              <Button
                type="button"
                onPress={() => {
                  if (!queueStatusAction.disabled) {
                    onRequestRuntimeRecovery();
                  }
                }}
                variant="outline"
                size="xs"
                radius="full"
                isDisabled={queueStatusAction.disabled}
                className="border-slate-200/70 px-2.5 text-slate-600 hover:bg-slate-50 data-[hovered]:bg-slate-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-900 dark:data-[hovered]:bg-slate-900"
                data-testid="chat-send-queue-runtime-action-expanded"
              >
                {queueStatusAction.pending ? (
                  <Spinner aria-hidden="true" tone="slate" size="xs" className="mr-1.5 h-3.5 w-3.5" />
                ) : null}
                {queueStatusAction.label}
              </Button>
            </div>
          ) : null}
          <ChatSendQueue
            items={chatSendQueueDisplay}
            onRemove={onRemoveQueuedItem}
            onMove={onMoveQueuedItem}
            onEdit={onEditQueuedMessage}
            onSendNow={queueCanSendNow ? onSendQueuedMessageNow : undefined}
            editDisabled={sendingAttachment || mutationDisabled}
            sendNowDisabled={!queueCanSendNow || mutationDisabled}
            removeDisabled={mutationDisabled}
          />
        </div>
      ) : null}
      {editingQueuedItem ? (
        <div
          className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 ${
            totalQueuedCount > 0 || (chatSendQueueDisplay.length > 0 && chatSendQueueExpanded)
              ? `border-t border-slate-200/70 ${DARK_DIVIDER_BORDER_CLASS}`
              : ""
          }`}
        >
          <div className="min-w-0">
            <Text as="div" variant="caption" tone="muted" className="text-xxs">
              Editing queued message
            </Text>
            <Text as="div" variant="caption" tone="muted" className="truncate text-xxs">
              {editingQueuedItem.targetAgentHandles.length > 0
                ? editingQueuedItem.targetAgentHandles.map((handle) => `@${handle}`).join(" ")
                : "No explicit agent targets"}
            </Text>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              radius="full"
              onPress={onCancelQueuedEdit}
              isDisabled={sendingAttachment || mutationDisabled}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              radius="full"
              onPress={onRequeueEditedMessage}
              isDisabled={!canSaveEditedMessage}
            >
              Save queue
            </Button>
            <Button
              type="button"
              variant="primary"
              size="xs"
              radius="full"
              onPress={() => {
                void onSendEditedMessageNow();
              }}
              isDisabled={!canSaveEditedMessage}
            >
              Send now
            </Button>
          </div>
        </div>
      ) : null}
    </Surface>
  );
}
