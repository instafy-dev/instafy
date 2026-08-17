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
      {items.map((item) => (
        <div key={item.id} className="flex items-center gap-2.5 px-3 py-2.5">
          <Button
            variant="ghost"
            size="sm"
            radius="md"
            className="min-w-0 flex-1 justify-start bg-transparent px-0 py-0 text-left shadow-none hover:bg-transparent data-[hovered]:bg-transparent"
            onPress={() => {
              onEdit?.(item.id);
            }}
            isDisabled={!onEdit || editDisabled}
          >
            <span className="min-w-0" title={item.errorMessage ?? undefined}>
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
            </span>
          </Button>
          <div className="flex flex-none items-center gap-0.5">
            {onSendNow ? (
              <IconButton
                aria-label="Send queued message now"
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
                aria-label="Edit queued message"
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
              aria-label="Remove queued message"
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
