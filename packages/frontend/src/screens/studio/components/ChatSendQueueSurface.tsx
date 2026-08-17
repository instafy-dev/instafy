import type { Ref } from "react";
import { TaskList } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import {
  DARK_DIVIDER_BORDER_CLASS,
  DARK_PANEL_BORDER_CLASS,
  DARK_PANEL_STRONG_BG_CLASS,
} from "../../../theme/darkSurfaces";
import {
  buildQueuedMessageAccessiblePreview,
  ChatSendQueue,
  type QueuedChatPrompt,
} from "./ChatSendQueue";
import type { CollapsedQueuedMessageSummary } from "./chatSendQueueSummary";

export const CHAT_SEND_QUEUE_ITEMS_ID = "chat-send-queue-items";

type QueueStatusAction = {
  label: string;
  disabled: boolean;
  pending: boolean;
};

type EditingQueuedChatItemLike = {
  targetAgentHandles: string[];
};

export type ChatSendQueueSurfaceProps = {
  totalQueuedCount: number;
  editingQueuedItem: EditingQueuedChatItemLike | null;
  chatSendQueueExpanded: boolean;
  collapsedQueuedMessageSummary: CollapsedQueuedMessageSummary | null;
  queueCanSendNow: boolean;
  queueStatusLabel: string | null;
  queueStatusAction: QueueStatusAction | null;
  chatSendQueueDisplay: QueuedChatPrompt[];
  sendingAttachment: boolean;
  inputValue: string;
  triggerRef?: Ref<HTMLButtonElement>;
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

  const countLabel = totalQueuedCount > 99 ? "99+" : String(totalQueuedCount);
  const preview = buildQueuedMessageAccessiblePreview(collapsedQueuedMessageSummary?.message);
  const title = preview
    ? `Queued messages (${totalQueuedCount}): ${preview}`
    : `Queued messages (${totalQueuedCount})`;

  return (
    <IconButton
      type="button"
      aria-label={title}
      title={title}
      aria-controls={CHAT_SEND_QUEUE_ITEMS_ID}
      aria-expanded={expanded}
      ref={triggerRef}
      variant="outline"
      size="sm"
      radius="full"
      onPress={onToggleExpanded}
      className="relative h-9 w-9 flex-none border-slate-200/70 bg-white/80 text-slate-600 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-raised-control)] dark:text-slate-300"
      data-testid="chat-send-queue-agent-summary"
    >
      <TaskList aria-hidden="true" className="h-4 w-4" data-testid="chat-send-queue-icon" />
      <span
        aria-hidden="true"
        className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary-600 px-1 text-3xs font-semibold leading-none text-white ring-2 ring-white dark:bg-primary-500 dark:ring-[color:var(--color-studio-dark-panel)]"
      >
        {countLabel}
      </span>
    </IconButton>
  );
}

export function ChatSendQueuePanel({
  totalQueuedCount,
  editingQueuedItem,
  chatSendQueueExpanded,
  queueCanSendNow,
  queueStatusLabel,
  queueStatusAction,
  chatSendQueueDisplay,
  sendingAttachment,
  inputValue,
  onSendQueuedMessageNow,
  onRequestRuntimeRecovery,
  onRemoveQueuedItem,
  onMoveQueuedItem,
  onEditQueuedMessage,
  onCancelQueuedEdit,
  onRequeueEditedMessage,
  onSendEditedMessageNow,
  mutationDisabled = false,
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
      <Surface
        tone="default"
        radius="xl"
        shadow="none"
        className={`ml-auto w-full overflow-hidden border border-slate-200/70 bg-white/95 sm:w-[min(24rem,100%)] ${DARK_PANEL_STRONG_BG_CLASS} ${DARK_PANEL_BORDER_CLASS}`}
      >
        {totalQueuedCount > 0 ? (
          <div className="flex min-h-10 items-center gap-2 px-3 py-1.5">
            <TaskList aria-hidden="true" className="h-4 w-4 flex-none text-slate-500 dark:text-slate-400" />
            <span className="min-w-0 flex-1 text-sm font-medium text-slate-800 dark:text-slate-100">
              Queue
            </span>
            <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
              {totalQueuedCount}
            </span>
          </div>
        ) : null}
        {chatSendQueueDisplay.length > 0 && chatSendQueueExpanded ? (
          <div
            className={
              totalQueuedCount > 0
                ? `max-h-[min(16rem,35dvh)] overflow-y-auto overscroll-contain border-t border-slate-200/70 ${DARK_DIVIDER_BORDER_CLASS}`
                : "max-h-[min(16rem,35dvh)] overflow-y-auto overscroll-contain"
            }
          >
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
