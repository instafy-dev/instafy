import { Send, Trash } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";

export type QueuedChatPrompt = {
  id: string;
  message: string;
  targetHandles: string[];
  browserTargetLabel?: string | null;
  errorMessage?: string | null;
};

export function ChatSendQueue({
  items,
  onRemove,
  onMove: _onMove,
  onEdit,
  onSendNow,
  editDisabled = false,
  sendNowDisabled = false,
  removeDisabled = false,
}: {
  items: QueuedChatPrompt[];
  onRemove: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onEdit?: (id: string) => void;
  onSendNow?: (id: string) => void;
  editDisabled?: boolean;
  sendNowDisabled?: boolean;
  removeDisabled?: boolean;
}) {
  if (items.length === 0) {
    return null;
  }
  void _onMove;

  return (
    <div
      className="divide-y divide-slate-200/70 dark:divide-slate-800/80"
      data-testid="chat-send-queue-list"
    >
      {items.map((item, index) => (
        <div key={item.id} className="flex items-center gap-2.5 px-3 py-2.5">
          <div className="min-w-0 flex-1" title={item.errorMessage ?? undefined}>
            <span className="min-w-0">
              <span className="block truncate text-sm font-normal text-slate-800 dark:text-slate-100">{item.message}</span>
              {item.errorMessage ? (
                <span className="mt-0.5 block truncate text-xs text-rose-600 dark:text-rose-300">
                  {item.errorMessage}
                </span>
              ) : null}
              {item.browserTargetLabel ? (
                <span className="mt-0.5 block truncate text-xxs uppercase tracking-[0.14em] text-primary-600 dark:text-primary-300">
                  Browser: {item.browserTargetLabel}
                </span>
              ) : null}
              {item.errorMessage ? (
                <span className="mt-0.5 block truncate text-xxs text-rose-600 dark:text-rose-300">
                  {item.errorMessage}
                </span>
              ) : null}
            </span>
          </div>
          <div className="flex flex-none items-center gap-0.5">
            {onSendNow ? (
              <IconButton
                aria-label={`Send queued message ${index + 1} now: ${item.message}`}
                variant="ghost"
                size="xs"
                radius="full"
                isDisabled={sendNowDisabled}
                onPress={() => onSendNow(item.id)}
                data-testid="chat-send-queue-send-now"
              >
                <Send aria-hidden="true" className="h-4 w-4" />
              </IconButton>
            ) : null}
            {onEdit ? (
              <Button
                aria-label={`Edit queued message ${index + 1}: ${item.message}`}
                variant="outline"
                size="xs"
                radius="full"
                isDisabled={editDisabled}
                onPress={() => onEdit(item.id)}
                className="h-7 px-2 text-xs"
                data-testid="chat-send-queue-steer"
              >
                Edit
              </Button>
            ) : null}
            <IconButton
              aria-label={`Remove queued message ${index + 1}: ${item.message}`}
              variant="ghost"
              size="xs"
              radius="full"
              isDisabled={removeDisabled}
              onPress={() => onRemove(item.id)}
              data-testid="chat-send-queue-remove"
            >
              <Trash aria-hidden="true" className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
      ))}
    </div>
  );
}
